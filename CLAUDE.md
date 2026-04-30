# vscode-bioinformatics

VS Code extension providing viewers and tooling for bioinformatics file formats.

**First milestone:** multiple sequence alignment (MSA) viewer compatible with the formats supported by hh-suite's `reformat.pl`.

## Reference implementations

- **Renderer (web)** — [plmMSA app.js](https://github.com/DeepFoldProtein/plmMSA/blob/main/src/plmmsa/api/public/app.js). Source of `parseA3mForViewer`, `renderMsaViewer`, `renderMsaRow`, `renderColoredSequence`, `residueClass`. Port to a webview.
- **Format & conversion spec** — [hh-suite reformat.pl](https://github.com/soedinglab/hh-suite/blob/master/scripts/reformat.pl). Canonical I/O contract; behavioral oracle for our converter.

## Supported formats

| Format | Extensions | Conventions |
|--------|-----------|-------------|
| fas (aligned FASTA) | `.fas .fasta .fa .afa .afas .afasta` | upper/lower equivalent; `.`/`-` equivalent |
| a2m | `.a2m` | lowercase = insert, uppercase = match, `-` = delete, `.` = gap-vs-insert |
| a3m | `.a3m` | a2m but gaps-vs-insert MAY be omitted (compact form) |
| Stockholm | `.sto .stockholm` | block format, `# STOCKHOLM 1.0` header, `//` terminator |
| PSI-BLAST | `.psi` | one `name<ws>seq` per line |
| Clustal | `.clu .aln` | block format with conservation line |

Output-only: `ufas` (unaligned FASTA, gaps stripped).

## Architecture

```
src/
  extension.ts            # activate(): register custom editor + commands
  parsers/
    types.ts              # Msa = { entries: Entry[], format, columns? }
                          # Entry = { name, desc, seq, kind: "ss"|"sa"|"seq" }
    fasta.ts              # fas + ufas
    a2m.ts                # a2m + a3m (match/insert state machine)
    stockholm.ts
    psi.ts
    clustal.ts
    detect.ts             # extension → format; content-sniff fallback
  converters/
    index.ts              # toFormat(msa, target, opts) — mirrors reformat.pl
    matchColumns.ts       # -M first / -M <gap%>
    filters.ts            # -r, -r N, -g, -uc, -lc, -noss, -sa
  viewer/
    provider.ts           # CustomTextEditorProvider
    messages.ts           # extension ↔ webview protocol
media/
  viewer.module.js        # pure renderer (window.MsaViewer.create) — no host deps
  viewer.adapter.js       # VS Code wiring (acquireVsCodeApi, postMessage, getState)
  viewer.css              # shared
syntaxes/
  fasta.tmLanguage.json   # source-view syntax highlight
  stockholm.tmLanguage.json
  clustal.tmLanguage.json
test/fixtures/            # round-trip pairs vs. reformat.pl
references/               # cloned upstreams used as design references
  Toolkit/                #   proteinevolution/Toolkit
  Toolkit-audit.md        #   feature audit; spec for what we adopt
```

**Module split**: the viewer's pure rendering is in [media/viewer.module.js](media/viewer.module.js) — exposes `window.MsaViewer.create({container, storage, storageKey})` returning `{load(viewerMsa), showError(msg), destroy()}`. No `acquireVsCodeApi()` or `postMessage` dependencies. State is persisted via the injected `Storage`-shaped object. The same module is dropped into plmMSA's `public/` folder with a 5-line wrapper using `localStorage` as storage. The VS Code-specific glue lives in [media/viewer.adapter.js](media/viewer.adapter.js) (~30 lines).

## Custom editor

One `CustomTextEditorProvider` (`bioinformatics.msaViewer`) bound to all MSA extensions, registered with `priority: "option"`. The text editor stays the default; users open the viewer via the command "MSA: Open in Viewer", "Open With… → MSA Viewer", or by pinning a per-extension default in `workbench.editorAssociations`. This is the conservative choice — `.fasta` files in the wild are often unaligned, and silently hijacking the text editor would surprise users.

Webview reuses plmMSA's render path:
- per-format parser → `{ name, seq, isQuery }[]`
- pagination (199 hits/page) + fullscreen toggle (carry plmMSA's behavior)
- `residueClass` palette: hydrophobic / acidic / basic / aromatic / polar / cysteine / glycine / proline / gap
- query = entry 0 by convention; context menu lets the user re-pin

Additions over plmMSA:
- inserts toggle (a3m/a2m): show insert columns vs. collapse to match-only ✓
- column ruler every 10 ✓ (sticky above histogram)
- coverage histogram (per-column non-gap fraction across the full alignment, not the visible page) ✓
- filter rows by name substring ✓
- goto column ✓ (Enter in the col field scrolls to and flashes that match column)
- zoom (residue cells only; controls/coverage stay at UI size) ✓
- click zoom label to reset to default ✓
- drag-resize coverage row ✓
- stats pills with per-pill tooltips ✓
- row virtualization (replaces pagination) ✓

## Commands

- `bioinformatics.msa.openViewer` — active text doc → MSA viewer
- `bioinformatics.msa.openSource` — MSA file → text editor
- `bioinformatics.msa.convert` — QuickPick target format → save-as
- `bioinformatics.msa.removeInserts` — `-r` equivalent
- `bioinformatics.msa.assignMatchColumns` — `-M first` / `-M N` QuickPick

## Conversion semantics (oracle: reformat.pl)

- `-M first` — every column with a residue in seq[0] is a match column.
- `-M <N>` — columns with `< N%` gaps are match columns.
- `a3m → a2m` — re-insert `.` at missing gap-vs-insert positions.
- `a2m → a3m` — drop `.` characters.
- `* → fas` — uppercase, `.` → `-`, pad insert columns with `-` for seqs lacking them.
- `* → sto / clu / psi` — match columns only; preserve input order.
- `-noss` drops `>ss_*`. `-sa` toggles the default-ON `>sa_*` drop.

Round-trip tests run reformat.pl over Pfam seed alignments + an HHblits A3M and snapshot `(input, expected)` pairs.

## Milestones

1. **M1 — done.** Parsers for fas / a2m / a3m + viewer (port of plmMSA's `renderMsaViewer`). Custom editor registered.
2. **M2 — done.** Stockholm + Clustal + PSI parsers; extension + content-sniff detection.
3. **M3 — dropped.** Converter command surface deferred per scope decision; `reformat.pl` stays the recommended tool for cross-format conversion. If reinstated later, fixture round-trips against `reformat.pl` are the test plan.
4. **M4 — done.** Inserts toggle (a2m/a3m) ✓ · coverage histogram ✓ · column ruler ✓ · name filter ✓ · goto column ✓
5. **M5 — done.** Row virtualization for the hits list. Pagination is gone; only rows in the viewport (± `VLIST_OVERSCAN = 8` rows) are in the DOM at any time. Scroll redraws are coalesced via `requestAnimationFrame`. The 3,308-row × 960-col uniref90 fixture now keeps the active DOM down to ~50 rows × 960 cols ≈ 48 k spans regardless of total alignment size.
6. **Module split — done.** The viewer renderer is now [media/viewer.module.js](media/viewer.module.js) — pure DOM + closures, no host APIs. [media/viewer.adapter.js](media/viewer.adapter.js) wires it to the VS Code webview via a `Storage`-shaped wrapper around `getState`/`setState` and the `postMessage` bridge. Same module ships into plmMSA with a 5-line wrapper using `localStorage`.
7. **HHR pairwise viewer — Phase 2 (in progress).** [src/parsers/hhr.ts](src/parsers/hhr.ts) parses HHsuite result files (HHsearch / HHblits / HHpred — same format). [media/viewer.module.js](media/viewer.module.js)'s `load()` now branches on a discriminated payload: `{kind:'msa', viewer}` keeps the existing MSA path; `{kind:'pairwise', hhr}` renders the HHR layout — hit table on top + per-hit alignment blocks below, wrapping at 80 columns. Each block stacks `Q ss_pred?`, `Q <name>`, `Q Consensus`, `agree`, `T Consensus`, `T <accession>`, `T ss_dssp?`, `T ss_pred?`, `Confidence?`, `PP?`. SS chars (`H` / `E` / `C` / etc.) get a dedicated `msa-ss-*` palette (helix red, strand yellow, coil grey). [examples/6KWC_1/hhsearch_output.hhr](examples/6KWC_1/hhsearch_output.hhr) parses to 60 hits / 60 alignment blocks in ~6 ms.

   **Still to do** (Phase 3): sortable hit table columns, HitMap (SVG per-query coverage), `breakAfter` user setting, color-toggle off-by-default for pairwise.

### Bonus features shipped beyond the plan

- **Zoom** for residue cells (toolbar `+`/`−`, `Ctrl/Cmd + scroll`). Default 10 px, range 6–32. State persists per file via `webview.setState`. Zoom is scoped to `.msa-residue` + `.msa-histogram-cell` so the controls bar and labels don't grow with it.
- **Drag-resize coverage row.** Bottom edge of the `coverage` row resizes between 30–240 px; persists.
- **Stats pills.** seqLen · depth · N_eff (HHblits: `exp(mean per-column Shannon entropy)`, gaps excluded, restricted to query-residue columns) · log₁₀H̄ · log₂H̄ where H̄ = mean Hamming distance from query to each other sequence. Each pill has its own definition tooltip.
- **Custom tooltip.** VS Code webviews suppress native `title`; replaced with a single floating `.msa-tooltip` element wired via `data-tip` and event delegation.

## Open questions

- Webview persistence: M1 already persists `{ page, showInserts }` via `setState`. Decide whether to also persist scroll position.
- Alternative palettes: Clustal X / Taylor / Zappo alongside plmMSA's chemical-class default.
- For `.fasta` opened from a workspace with mixed aligned/unaligned files: keep one viewer regardless, or detect equal-length and refuse to render unaligned input?
