import { Msa, MsaEntry, EntryKind } from "./types";

const RESIDUES_BLOCK = /^\s*(\S+)\s+([ a-zA-Z0-9.\-]+?)(\s+\d+)?\s*$/;

/**
 * Clustal-format parser. Mirrors reformat.pl's `informat eq "clu"`:
 *
 *   - `CLUSTAL...` header line and `#` comments are skipped.
 *   - `//` terminates.
 *   - Blank line marks block boundary; within a block sequences appear in
 *     a fixed order. Block 1 establishes the sequence set; subsequent
 *     blocks append residues to the matching positional slot.
 *   - Optional trailing residue counts (e.g. `60`) are stripped.
 *   - Conservation lines (`*:.` / blanks) are ignored.
 *
 * The SMART output edge case (no whitespace between name and residues)
 * is rare and not handled here; reformat.pl emits a warning anyway.
 */
export function parseClustal(text: string): Msa {
  const order: string[] = [];
  const byName = new Map<string, MsaEntry>();
  let block = 1;
  let kInBlock = 0;
  let blockSize = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r/g, "");
    if (/^\s*$/.test(line)) {
      if (kInBlock > 0) {
        if (blockSize === 0) blockSize = kInBlock;
        block++;
        kInBlock = 0;
      }
      continue;
    }
    if (/^CLUSTAL/i.test(line)) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("//")) break;
    if (/^[*.:\s]*$/.test(line)) continue; // conservation track

    const m = RESIDUES_BLOCK.exec(line);
    if (!m) continue; // tolerate junk lines rather than die

    const name = m[1];
    const residues = m[2].replace(/\s+/g, "");

    if (block === 1) {
      if (!byName.has(name)) {
        const entry: MsaEntry = { id: name, name, seq: residues, kind: classify(name) };
        byName.set(name, entry);
        order.push(name);
      }
      // Duplicate name within block 1 is malformed — silently drop.
    } else {
      // reformat.pl appends by positional index, not by name. Names are
      // expected to repeat in the same order across blocks.
      const ordered = order[kInBlock];
      const entry = ordered ? byName.get(ordered) : undefined;
      if (entry) entry.seq += residues;
    }
    kInBlock++;
  }

  return { format: "clu", entries: order.map((n) => byName.get(n)!) };
}

function classify(name: string): EntryKind {
  if (name.startsWith("ss_")) return "ss";
  if (name.startsWith("sa_")) return "sa";
  return "seq";
}
