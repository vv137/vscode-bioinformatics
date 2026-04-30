import {
  Hhr,
  HhrAlignment,
  HhrAlignmentMetrics,
  HhrHeader,
  HhrHitSummary,
  HhrTrack,
} from "./types";

/**
 * Parse an HHR (HHsuite result) file. Used by HHsearch, HHblits and
 * HHpred — all three emit the same on-disk format. Three sequential
 * sections:
 *
 *   1. Header  — `Key   value` lines (Query / Match_columns / Neff / …)
 *   2. Hit list — fixed-width table (No, prob, E-value, …)
 *   3. Alignments — one block per hit, marked by `No <n>` then
 *                   description, metrics, then chunks of:
 *                     Q ss_pred?, Q <name>, Q Consensus,
 *                     <agree>,
 *                     T Consensus, T <name>, T ss_dssp?, T ss_pred?,
 *                     Confidence?
 *
 *   Multi-chunk alignments (long matches) wrap every ~80 cols. Each
 *   track (Q seq, T seq, agree, …) is concatenated across chunks so
 *   the viewer sees a single contiguous string per track and can wrap
 *   at its own breakAfter setting.
 */
export function parseHhr(text: string): Hhr {
  const lines = text.split(/\r?\n/);
  const header: HhrHeader = {
    query: "",
    matchColumns: 0,
    nSeqs: 0,
    totalSeqs: 0,
    neff: 0,
  };
  const hits: HhrHitSummary[] = [];
  const alignments: HhrAlignment[] = [];

  let i = 0;

  // 1. Header
  i = parseHeader(lines, i, header);

  // 2. Hit-list table
  i = skipBlank(lines, i);
  if (i < lines.length && /^\s*No\s+Hit\b/.test(lines[i])) {
    i++; // skip the table header
    i = parseHitTable(lines, i, hits);
  }

  // 3. Alignment blocks
  while (i < lines.length) {
    const m = /^No\s+(\d+)\s*$/.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const blockStart = i + 1;
    let blockEnd = blockStart;
    while (blockEnd < lines.length && !/^No\s+\d+\s*$/.test(lines[blockEnd])) {
      blockEnd++;
    }
    alignments.push(
      parseAlignmentBlock(parseInt(m[1], 10), lines.slice(blockStart, blockEnd)),
    );
    i = blockEnd;
  }

  return { header, hits, alignments };
}

function skipBlank(lines: string[], i: number): number {
  while (i < lines.length && /^\s*$/.test(lines[i])) i++;
  return i;
}

function parseHeader(lines: string[], i: number, h: HhrHeader): number {
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    if (/^\s*No\s+Hit\b/.test(line)) break;
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const val = m[2].trim();
    switch (key) {
      case "Query":
        h.query = val;
        break;
      case "Match_columns":
        h.matchColumns = parseInt(val, 10) || 0;
        break;
      case "No_of_seqs": {
        const nm = /(\d+)\s+out\s+of\s+(\d+)/.exec(val);
        if (nm) {
          h.nSeqs = parseInt(nm[1], 10);
          h.totalSeqs = parseInt(nm[2], 10);
        }
        break;
      }
      case "Neff":
        h.neff = parseFloat(val) || 0;
        break;
      case "Searched_HMMs":
        h.searchedHmms = parseInt(val, 10);
        break;
      case "Date":
        h.date = val;
        break;
      case "Command":
        h.command = val;
        break;
    }
    i++;
  }
  return i;
}

/**
 * Hit table rows have fixed-ish columns but the description column
 * varies in width. We anchor on the trailing fields:
 *   prob  evalue  pvalue  score  ssScore  cols  qStart-qEnd  tStart-tEnd  (tLen)
 * — all whitespace-delimited.
 */
const HIT_TAIL =
  /^\s*(\d+)\s+(.+?)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)-(\d+)\s+(\d+)-(\d+)\s+\((\d+)\)\s*$/;

function parseHitTable(
  lines: string[],
  i: number,
  hits: HhrHitSummary[],
): number {
  while (i < lines.length) {
    const line = lines[i];
    if (/^No\s+\d+\s*$/.test(line)) break;
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const m = HIT_TAIL.exec(line);
    if (m) {
      hits.push({
        num: parseInt(m[1], 10),
        hit: m[2].trim(),
        prob: parseFloat(m[3]),
        evalue: parseFloat(m[4]),
        pvalue: parseFloat(m[5]),
        score: parseFloat(m[6]),
        ssScore: parseFloat(m[7]),
        cols: parseInt(m[8], 10),
        queryHmm: [parseInt(m[9], 10), parseInt(m[10], 10)],
        templateHmm: [parseInt(m[11], 10), parseInt(m[12], 10)],
        templateLen: parseInt(m[13], 10),
      });
    }
    i++;
  }
  return i;
}

/**
 * Parse one alignment block (the slice between `No N` and `No N+1`).
 * Lines are classified by their leading prefix; sequences are
 * accumulated per track across chunks.
 */
function parseAlignmentBlock(num: number, lines: string[]): HhrAlignment {
  let description = "";
  let metricsLine = "";
  // Find the first `>...` line and the metrics line.
  let i = 0;
  while (i < lines.length && /^\s*$/.test(lines[i])) i++;
  if (i < lines.length && lines[i].startsWith(">")) {
    description = lines[i].slice(1).trim();
    i++;
  }
  if (i < lines.length && /Probab\s*=/.test(lines[i])) {
    metricsLine = lines[i];
    i++;
  }
  const metrics = parseMetrics(metricsLine);
  const templateName = description.split(/\s+/)[0] || `hit_${num}`;

  // Track accumulators.
  const accum: Record<string, { seq: string; start?: number; end?: number; ref?: number }> = {};
  let queryName = "";
  let agree = "";
  let confidence = "";
  let pp = "";

  // We classify each line by its leading prefix. The key insight:
  // tokens [name, secondToken, possibly-start, seq, possibly-end, possibly-ref].
  // For Q/T lines we always have a name token; for "Q Consensus" / "T Consensus"
  // the second token is "Consensus" rather than the query/template name.
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const qm = /^Q\s+(\S+)(\s.*)$/.exec(line);
    const tm = /^T\s+(\S+)(\s.*)$/.exec(line);
    if (qm) {
      const sub = qm[1];
      const rest = qm[2];
      if (sub === "Consensus") {
        appendTrack(accum, "qCons", rest);
      } else if (sub === "ss_pred") {
        appendTrack(accum, "qSsPred", rest);
      } else {
        if (!queryName) queryName = sub;
        appendTrack(accum, "q", rest);
      }
    } else if (tm) {
      const sub = tm[1];
      const rest = tm[2];
      if (sub === "Consensus") {
        appendTrack(accum, "tCons", rest);
      } else if (sub === "ss_dssp") {
        appendTrack(accum, "tSsDssp", rest);
      } else if (sub === "ss_pred") {
        appendTrack(accum, "tSsPred", rest);
      } else {
        appendTrack(accum, "t", rest);
      }
    } else if (/^Confidence\s/.test(line)) {
      confidence += extractTrailingSeq(line.replace(/^Confidence\s+/, " "));
    } else if (/^PP\s/i.test(line)) {
      // HMMER posterior-probability track (not in HHR but defensive)
      pp += extractTrailingSeq(line.replace(/^PP\s+/i, " "));
    } else if (/^\s+\S/.test(line)) {
      // No leading prefix word → agree string. Trim leading whitespace
      // up to the seq column. Best heuristic: the agree line aligns
      // with the seq column of nearby Q/T lines, so just strip the
      // longest run of leading whitespace shared with those columns.
      // For simplicity we take everything after the leading whitespace.
      agree += line.replace(/^\s+/, "");
    }
    i++;
  }

  return {
    num,
    description,
    metrics,
    queryName: queryName || "Query",
    templateName,
    query: trackOrEmpty(accum["q"]),
    queryConsensus: accum["qCons"] ? trackOrEmpty(accum["qCons"]) : undefined,
    querySsPred: accum["qSsPred"] ? trackOrEmpty(accum["qSsPred"]) : undefined,
    template: trackOrEmpty(accum["t"]),
    templateConsensus: accum["tCons"] ? trackOrEmpty(accum["tCons"]) : undefined,
    templateSsDssp: accum["tSsDssp"] ? trackOrEmpty(accum["tSsDssp"]) : undefined,
    templateSsPred: accum["tSsPred"] ? trackOrEmpty(accum["tSsPred"]) : undefined,
    agree: agree || undefined,
    confidence: confidence || undefined,
    pp: pp || undefined,
  };
}

function parseMetrics(line: string): HhrAlignmentMetrics {
  const out: HhrAlignmentMetrics = {
    probab: 0,
    evalue: 0,
    score: 0,
    alignedCols: 0,
  };
  const num = (k: string): number | undefined => {
    const m = new RegExp(`${k}\\s*=\\s*([0-9eE+\\-.]+)`).exec(line);
    return m ? parseFloat(m[1]) : undefined;
  };
  const pct = (k: string): number | undefined => {
    const m = new RegExp(`${k}\\s*=\\s*([0-9.]+)%`).exec(line);
    return m ? parseFloat(m[1]) : undefined;
  };
  out.probab = num("Probab") ?? 0;
  out.evalue = num("E-value") ?? 0;
  out.score = num("Score") ?? 0;
  out.alignedCols = Math.round(num("Aligned_cols") ?? 0);
  out.identities = pct("Identities");
  out.similarity = num("Similarity");
  out.sumProbs = num("Sum_probs");
  out.templateNeff = num("Template_Neff");
  return out;
}

/**
 * `rest` is "<spaces>[start]<spaces><seq><spaces>[end]<spaces>[(ref)]"
 * for sequence-bearing lines, or just "<spaces><seq>" for ss_pred /
 * ss_dssp / Consensus-without-numbers lines. We detect the format by
 * presence of a leading integer and a trailing `(N)`.
 */
function appendTrack(
  accum: Record<string, { seq: string; start?: number; end?: number; ref?: number }>,
  key: string,
  rest: string,
): void {
  const t = accum[key] || (accum[key] = { seq: "" });
  // Try numeric form: " <start> <seq> <end> (<ref>)"
  const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+\((\d+)\)\s*$/.exec(rest);
  if (m) {
    if (t.start === undefined) t.start = parseInt(m[1], 10);
    t.end = parseInt(m[3], 10);
    t.ref = parseInt(m[4], 10);
    t.seq += m[2];
    return;
  }
  // Plain form: just a sequence on the rest of the line.
  t.seq += extractTrailingSeq(rest);
}

function extractTrailingSeq(rest: string): string {
  // Strip surrounding whitespace; if a trailing token is a number or
  // "(N)", strip that too. Rare for ss tracks but defensive.
  const trimmed = rest.trim();
  return trimmed.replace(/\s+\d+(\s+\(\d+\))?$/, "");
}

function trackOrEmpty(t: { seq: string; start?: number; end?: number; ref?: number } | undefined): HhrTrack {
  return {
    seq: t?.seq ?? "",
    start: t?.start,
    end: t?.end,
    ref: t?.ref,
  };
}
