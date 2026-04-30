import { MsaFormat } from "./types";

const EXT_TO_FORMAT: Record<string, MsaFormat> = {
  fas: "fas",
  fasta: "fas",
  fa: "fas",
  afa: "fas",
  afas: "fas",
  afasta: "fas",
  a2m: "a2m",
  a3m: "a3m",
  sto: "sto",
  stockholm: "sto",
  psi: "psi",
  clu: "clu",
  aln: "clu",
};

export function formatFromPath(filePath: string): MsaFormat | null {
  const m = /\.([^.\\/]+)$/.exec(filePath);
  if (!m) return null;
  return EXT_TO_FORMAT[m[1].toLowerCase()] ?? null;
}

/**
 * Cheap content sniff for files with no recognized extension. Looks at
 * the first non-blank line. Conservative — returns null if uncertain.
 */
export function formatFromContent(text: string): MsaFormat | null {
  for (const raw of text.split(/\r?\n/, 50)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# STOCKHOLM")) return "sto";
    if (line.startsWith("CLUSTAL")) return "clu";
    if (line.startsWith(">")) return "fas";
    return null;
  }
  return null;
}
