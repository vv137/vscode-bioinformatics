export type MsaFormat =
  | "fas"
  | "a2m"
  | "a3m"
  | "sto"
  | "psi"
  | "clu";

export type EntryKind = "seq" | "ss" | "sa";

export interface MsaEntry {
  /** First whitespace-delimited token of the header. */
  id: string;
  /** Full header line without the leading `>`. */
  name: string;
  /** Sequence string. Insert/match casing is preserved for a2m/a3m. */
  seq: string;
  /** Special-row classification (hh-suite uses `>ss_`, `>sa_` prefixes). */
  kind: EntryKind;
}

export interface Msa {
  format: MsaFormat;
  entries: MsaEntry[];
  /**
   * Raw notes/lines that aren't entries (e.g. Stockholm `#=GC` rows or a
   * Clustal consensus line). Preserved verbatim so callers can choose to
   * surface them.
   */
  notes?: string[];
  /**
   * Stockholm `#=GC RF` (reference annotation) concatenated across
   * blocks. Each character marks a column: `x` (or any non-gap) = match
   * column, `.`/`-` = insert column. When present this is the canonical
   * way to project Stockholm output produced by HMMER/jackhmmer onto
   * match columns + inserts.
   */
  refColumns?: string;
}

/**
 * Result of projecting an a2m/a3m onto match-columns-only — this is what
 * the viewer renders as the aligned grid. Insert columns appear in
 * `inserts` keyed by the match-column index they sit *before*.
 */
export interface ViewerEntry {
  id: string;
  name: string;
  /** Match-column residues only (uppercase / `-`). Equal length across rows. */
  matchSeq: string;
  /**
   * Inserts keyed by the *next* match column index (0..matchLen). An entry
   * at key `k` was emitted before match column `k` in the source.
   */
  inserts: Record<number, string>;
  isQuery: boolean;
  kind: EntryKind;
}

export interface ViewerMsa {
  format: MsaFormat;
  /** Number of match columns (each row's `matchSeq` has this length). */
  matchLen: number;
  entries: ViewerEntry[];
}

/* ============================================================
 * HHR (HHsuite result) — pairwise hit-list viewer payloads.
 * Emitted by HHsearch / HHblits / HHpred (same on-disk format).
 * ============================================================ */

export interface HhrHeader {
  query: string;
  matchColumns: number;
  nSeqs: number;
  totalSeqs: number;
  neff: number;
  searchedHmms?: number;
  date?: string;
  command?: string;
}

export interface HhrHitSummary {
  num: number;
  hit: string;                       // truncated description from the table
  prob: number;
  evalue: number;
  pvalue: number;
  score: number;
  ssScore: number;
  cols: number;
  queryHmm: [number, number];
  templateHmm: [number, number];
  templateLen: number;
}

/** Per-hit alignment metrics from the `Probab=... E-value=...` line. */
export interface HhrAlignmentMetrics {
  probab: number;
  evalue: number;
  score: number;
  alignedCols: number;
  identities?: number;               // percentage 0–100
  similarity?: number;
  sumProbs?: number;
  templateNeff?: number;
}

export interface HhrTrack {
  /** Concatenated sequence/track string across all chunks. */
  seq: string;
  start?: number;
  end?: number;
  ref?: number;                      // total length of the source (e.g. "(190)")
}

export interface HhrAlignment {
  num: number;
  description: string;               // line after `>` for this hit
  metrics: HhrAlignmentMetrics;
  queryName: string;
  templateName: string;
  query: HhrTrack;
  queryConsensus?: HhrTrack;
  querySsPred?: HhrTrack;
  template: HhrTrack;
  templateConsensus?: HhrTrack;
  templateSsDssp?: HhrTrack;
  templateSsPred?: HhrTrack;
  agree?: string;                    // match indicator string (concatenated)
  confidence?: string;               // per-column confidence digits
  pp?: string;                       // HMMER-only posterior probability
}

export interface Hhr {
  header: HhrHeader;
  hits: HhrHitSummary[];
  alignments: HhrAlignment[];
}

/** Webview payload — the discriminator chooses MSA mode vs. pairwise mode. */
export type ViewerPayload =
  | { kind: "msa"; viewer: ViewerMsa }
  | { kind: "pairwise"; hhr: Hhr };

