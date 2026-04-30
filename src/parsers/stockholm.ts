import { Msa, MsaEntry, EntryKind } from "./types";

/**
 * Stockholm 1.0 parser. Mirrors reformat.pl's `informat eq "sto"` branch:
 *
 *   - lines starting with `#` are comments and skipped, except `#=GC SS_cons`
 *     which becomes a sequence named `ss_dssp`.
 *   - `//` terminates the alignment.
 *   - blank lines separate sequence blocks; within a single block a name
 *     may not appear twice. Across blocks the same name's residues are
 *     concatenated.
 *
 * We don't apply the `-noss`/`-sa` filters here — those are a converter
 * concern. Entry classification (ss/sa/seq) is captured so callers can
 * filter later.
 */
export function parseStockholm(text: string): Msa {
  const order: string[] = [];
  const byName = new Map<string, MsaEntry>();
  const seenInBlock = new Set<string>();
  const notes: string[] = [];
  let refColumns = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r/g, "");
    if (/^\/\//.test(line)) break;

    if (/^\s*$/.test(line)) {
      // Block boundary.
      seenInBlock.clear();
      continue;
    }

    // `#=GC RF` — column annotation marking match (`x`) vs. insert (`.`).
    // Concatenate across blocks before falling through to the generic
    // `#` skip below.
    const rf = /^#=GC\s+RF\s+(\S+)\s*$/.exec(line);
    if (rf) {
      refColumns += rf[1];
      continue;
    }

    let working = line;

    // `#=GC SS_cons` becomes a sequence labelled `ss_dssp`. Other `#` lines
    // are commentary — we keep them in `notes` for completeness.
    const ssCons = /^#=GC\s+SS_cons\s+(.+)$/.exec(working);
    if (ssCons) {
      working = `ss_dssp ${ssCons[1]}`;
    } else if (working.startsWith("#")) {
      notes.push(working);
      continue;
    }

    const m = /^\s*(\S+)\s+(\S+)\s*$/.exec(working);
    if (!m) continue; // tolerate odd lines rather than throwing

    const name = m[1];
    const residues = m[2];

    const existing = byName.get(name);
    if (existing) {
      if (seenInBlock.has(name)) {
        // Duplicate within a block — keep first occurrence to stay tolerant
        // of malformed input; reformat.pl errors out here.
        continue;
      }
      existing.seq += residues;
      seenInBlock.add(name);
    } else {
      const entry: MsaEntry = {
        id: name,
        name,
        seq: residues,
        kind: classify(name),
      };
      byName.set(name, entry);
      order.push(name);
      seenInBlock.add(name);
    }
  }

  return {
    format: "sto",
    entries: order.map((n) => byName.get(n)!),
    notes: notes.length ? notes : undefined,
    refColumns: refColumns.length > 0 ? refColumns : undefined,
  };
}

function classify(name: string): EntryKind {
  if (name.startsWith("ss_")) return "ss";
  if (name.startsWith("sa_")) return "sa";
  return "seq";
}
