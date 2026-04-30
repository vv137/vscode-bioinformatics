import { Msa, ViewerEntry, ViewerMsa } from "./types";

/**
 * Project an Msa onto match columns + per-row insert maps.
 *
 * Format rules (mirror reformat.pl semantics):
 *   - fas: every column is a match column. Lowercase ≡ uppercase, `.` ≡ `-`.
 *   - a2m: uppercase + `-` are match columns, lowercase + `.` are inserts.
 *   - a3m: same as a2m but `.` padding is omitted, so each row has its own
 *     run of inserts between match columns. We re-align them by treating
 *     inserts as "between match columns k and k+1" and let the viewer
 *     decide whether to render them.
 *   - sto/psi/clu: handled by their own parsers, which already deliver
 *     match-only sequences. Routed through `projectMatchOnly`.
 */
export function projectToViewer(msa: Msa): ViewerMsa {
  switch (msa.format) {
    case "fas":
      return projectFas(msa);
    case "a2m":
    case "a3m":
      return projectA2mA3m(msa);
    case "sto":
      // HMMER/jackhmmer files annotate match vs. insert columns with a
      // `#=GC RF` line — when present, use it. Without it, fall back to
      // case-based projection (uppercase/`-` = match, lowercase/`.` =
      // insert) which is the alternative Stockholm convention.
      if (msa.refColumns) return projectStoWithRF(msa);
      return projectA2mA3m({ ...msa, format: "a2m" });
    case "psi":
    case "clu":
      return projectMatchOnly(msa);
  }
}

function projectFas(msa: Msa): ViewerMsa {
  const entries: ViewerEntry[] = msa.entries.map((e, i) => ({
    id: e.id,
    name: e.name,
    matchSeq: e.seq.toUpperCase().replace(/\./g, "-"),
    inserts: {},
    isQuery: i === 0,
    kind: e.kind,
  }));
  const matchLen = entries[0]?.matchSeq.length ?? 0;
  return { format: msa.format, matchLen, entries };
}

function projectA2mA3m(msa: Msa): ViewerMsa {
  const entries: ViewerEntry[] = [];
  for (let i = 0; i < msa.entries.length; i++) {
    const e = msa.entries[i];
    let matchSeq = "";
    const inserts: Record<number, string> = {};
    let pendingInsert = "";
    for (const ch of e.seq) {
      const isInsert = ch === "." || (ch >= "a" && ch <= "z");
      if (isInsert) {
        if (ch !== ".") pendingInsert += ch;
        continue;
      }
      // Match column (uppercase residue or '-')
      if (pendingInsert) {
        inserts[matchSeq.length] = pendingInsert;
        pendingInsert = "";
      }
      matchSeq += ch;
    }
    if (pendingInsert) inserts[matchSeq.length] = pendingInsert;
    entries.push({
      id: e.id,
      name: e.name,
      matchSeq,
      inserts,
      isQuery: i === 0,
      kind: e.kind,
    });
  }
  // Match-column count is the consensus across rows. In well-formed a3m
  // every row has the same match-column count; if not, fall back to the
  // longest so we don't truncate.
  const matchLen = entries.reduce((m, e) => Math.max(m, e.matchSeq.length), 0);
  return { format: msa.format, matchLen, entries };
}

/** Project a Stockholm Msa using its `#=GC RF` reference annotation:
 *  every column where RF is `.` or `-` is an insert, the rest are
 *  match columns. Sequences are split into matchSeq + per-row insert
 *  runs identically to the a2m/a3m case. */
function projectStoWithRF(msa: Msa): ViewerMsa {
  const ref = msa.refColumns!;
  const entries: ViewerEntry[] = [];
  for (let i = 0; i < msa.entries.length; i++) {
    const e = msa.entries[i];
    const seq = e.seq;
    const lim = Math.min(seq.length, ref.length);
    let matchSeq = "";
    const inserts: Record<number, string> = {};
    let pendingInsert = "";
    for (let k = 0; k < lim; k++) {
      const r = ref.charCodeAt(k);
      const isInsertCol = r === 46 /* . */ || r === 45 /* - */;
      const ch = seq[k];
      if (isInsertCol) {
        if (ch !== "-" && ch !== ".") pendingInsert += ch;
        continue;
      }
      if (pendingInsert) {
        inserts[matchSeq.length] = pendingInsert;
        pendingInsert = "";
      }
      // Normalize: uppercase residue or `-` for gap-in-match.
      const c = ch === "." ? "-" : ch.toUpperCase();
      matchSeq += c;
    }
    if (pendingInsert) inserts[matchSeq.length] = pendingInsert;
    entries.push({
      id: e.id,
      name: e.name,
      matchSeq,
      inserts,
      isQuery: i === 0,
      kind: e.kind,
    });
  }
  const matchLen = entries.reduce((m, e) => Math.max(m, e.matchSeq.length), 0);
  return { format: "sto", matchLen, entries };
}

function projectMatchOnly(msa: Msa): ViewerMsa {
  const entries: ViewerEntry[] = msa.entries.map((e, i) => ({
    id: e.id,
    name: e.name,
    matchSeq: e.seq.toUpperCase().replace(/\./g, "-"),
    inserts: {},
    isQuery: i === 0,
    kind: e.kind,
  }));
  const matchLen = entries[0]?.matchSeq.length ?? 0;
  return { format: msa.format, matchLen, entries };
}
