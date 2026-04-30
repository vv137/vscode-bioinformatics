import { Msa, MsaEntry, EntryKind, MsaFormat } from "./types";

/**
 * Parse a FASTA-family file (fas / a2m / a3m). Casing and dots are
 * preserved so downstream consumers can distinguish match vs. insert
 * columns. Set `format` so the projection step knows which rules apply.
 */
export function parseFastaLike(text: string, format: MsaFormat): Msa {
  const entries: MsaEntry[] = [];
  let current: MsaEntry | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith(">")) {
      const name = line.slice(1);
      const id = name.split(/\s+/)[0] || `seq_${entries.length + 1}`;
      current = { id, name, seq: "", kind: classify(id) };
      entries.push(current);
    } else if (current) {
      current.seq += line.replace(/\s+/g, "");
    }
  }
  return { format, entries };
}

function classify(id: string): EntryKind {
  if (id.startsWith("ss_")) return "ss";
  if (id.startsWith("sa_")) return "sa";
  return "seq";
}
