import { Msa, MsaEntry, EntryKind } from "./types";

const PSI_LINE = /^(\S+)\s+([ a-zA-Z0-9.\-]+?)(\s+\d+)?\s*$/;

/**
 * PSI-BLAST format parser. Mirrors reformat.pl's `informat eq "psi"`:
 * essentially a header-less Clustal — blank line marks block boundary,
 * sequences within a block are positional, residues concatenate across
 * blocks. Does not skip `CLUSTAL` or `#` lines (PSI files don't have
 * them).
 */
export function parsePsi(text: string): Msa {
  const order: string[] = [];
  const byName = new Map<string, MsaEntry>();
  let block = 1;
  let kInBlock = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r/g, "");
    if (/^\s*$/.test(line)) {
      if (kInBlock > 0) {
        block++;
        kInBlock = 0;
      }
      continue;
    }

    const m = PSI_LINE.exec(line);
    if (!m) continue;
    const name = m[1];
    const residues = m[2].replace(/\s+/g, "");

    if (block === 1) {
      if (!byName.has(name)) {
        const entry: MsaEntry = { id: name, name, seq: residues, kind: classify(name) };
        byName.set(name, entry);
        order.push(name);
      }
    } else {
      const ordered = order[kInBlock];
      const entry = ordered ? byName.get(ordered) : undefined;
      if (entry) entry.seq += residues;
    }
    kInBlock++;
  }

  return { format: "psi", entries: order.map((n) => byName.get(n)!) };
}

function classify(name: string): EntryKind {
  if (name.startsWith("ss_")) return "ss";
  if (name.startsWith("sa_")) return "sa";
  return "seq";
}
