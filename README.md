# Bioinformatics

A VS Code extension for browsing protein **multiple sequence alignments** and **HHsuite hit-list results** without leaving the editor.

## Features

### MSA viewer (`.a3m`, `.a2m`, `.fasta`, `.sto`, `.clu`, `.psi`)

- Per-residue coloring with four palettes — **Chemical** (default), **Clustal X**, **Taylor**, and **Zappo** — switchable from the toolbar.
- **Row virtualization**: only rows in the viewport are in the DOM, so 3,000+ row alignments stay responsive.
- **Sticky header stack**: column ruler · coverage histogram · query row, all pinned to the top while you scroll.
- **Coverage histogram, conservation-tinted** — bar height = coverage, bar color = per-column conservation. Inline `↻` button on the row label cycles `off → entropy (1 − H/ln 20) → BLOSUM62 SP`; current mode + formula shown in the button's tooltip.
- **Zoomable residue cells** (toolbar `+` / `−`, `Ctrl/Cmd + scroll`, click the size label to reset to 10 px). Controls bar stays at UI size; only the alignment grid scales.
- **Drag-resize coverage row** (bottom edge) and **drag-resize the name column** (or pull all the way left to hide).
- **Inserts toggle** for a3m/a2m (show/collapse insert columns). Stockholm files automatically use `#=GC RF` to identify match vs. insert columns.
- **Filter by name** (`Cmd/Ctrl + F`) and **goto column** (`Cmd/Ctrl + L`) inputs.
- **Per-column hover** — column index, query residue, coverage, Shannon entropy (with per-column N_eff), BLOSUM62 sum-of-pairs (raw + normalized), and the **top 5 residues** with counts and percentages.
- **Stats pills**: ungapped query length, depth, **HHblits-style N_eff** (`exp(mean per-column Shannon entropy)`, gaps excluded, restricted to query-residue columns), `log₁₀H̄` and `log₂H̄` of mean Hamming distance to the query.
- **Drag-and-drop import** — drop any supported alignment file onto the viewer to swap content in place.

### HHR pairwise viewer (`.hhr`)

For HHsearch / HHblits / HHpred result files.

- **HitMap** — SVG visualization of every hit's coverage along the query. Hits are packed into rows (non-overlapping share rows), color-coded by probability, labeled with the template name and description (clipped to the rect's right edge), and clickable to scroll to the alignment block.
- **Sortable hit table** — `No / Hit / Prob / E-value / Score / Cols / Q range / T range`. Click any header to sort.
- **Per-hit alignment blocks** — query / consensus / agree-string / template, plus secondary-structure tracks (`Q ss_pred`, `T ss_pred`, `T ss_dssp`) and confidence rows when present.
- **Auto-wrap to window width** — chunks reflow on resize; type a number in the `wrap` input to override.
- **Color toggle** — off by default for pairwise viewing (the agree-string already conveys conservation); flip on for full per-residue coloring.
- **Bidirectional jump**: click a row in the table → scroll to its alignment block; click `No N.` in an alignment header → scroll to the row in the table (with a brief flash).

### Templates view (a3m with `[subseq from]` headers)

When a manifest of templates is detected (e.g. `hmmsearch` output), an extra **Templates** toggle appears in the toolbar. Switching it on:

- Replaces the residue grid with a structured table — `# / Accession / Range / Length / Description`.
- Shows a HitMap above the table built from each row's first/last non-gap residue (click a rect to scroll the matching row).

### Header parsing & database links

Headers in MSA labels, hit-list rows, and template tables are parsed and linkified.

**UniProt FASTA headers** (per the [UniProt spec](https://www.uniprot.org/help/fasta-headers)) are recognized in their canonical shapes, including the optional HHsuite `/start-end` subseq suffix:

- **UniProtKB**: `>sp|P12345|FOO_HUMAN Protein name OS=Organism OX=NCBI_taxID GN=Gene PE=1 SV=2` (also `tr|…`)
- **UniRef**: `>UniRef90_A0A2L2TCV1 Cluster name n=N Tax=Taxon TaxID=ID RepID=Rep` (or `…/start-end`)
- **UniParc**: `>UPI0000000001 status=active`

The structured fields (entry name · protein · organism + taxID · gene · cluster size · representative · range · …) are surfaced as a multi-line tooltip on the head link.

**Auto-linked accessions** (head text → canonical entry page):

| Accession pattern | Database | URL |
|-------------------|----------|-----|
| `2DFB_A`, `1abc` | PDB | `rcsb.org/structure/{id}` |
| `sp\|P12345\|FOO_HUMAN`, bare `P04637` | UniProt | `uniprot.org/uniprotkb/{acc}/entry` |
| `UniRef90_P12345` (± `/start-end`) | UniRef | `uniprot.org/uniref/{id}` |
| `UPI0000000001` | UniParc | `uniprot.org/uniparc/{id}/entry` |
| `MGYP000510094044` | MGnify | `ebi.ac.uk/metagenomics/sequence/{id}` |
| `PF12345` | Pfam | `ebi.ac.uk/interpro/entry/pfam/{id}` |
| `IPR001234` | InterPro | `ebi.ac.uk/interpro/entry/InterPro/{id}` |
| `NP_001234.1` | NCBI Protein | `ncbi.nlm.nih.gov/protein/{id}` |

A small **AFDB** chip renders next to UniProt-kind links and after UniRef rep accessions, taking you straight to `alphafold.ebi.ac.uk/entry/{acc}` for the structural alternative.

### Source-view syntax highlighting

TextMate grammars ship for the FASTA family (`.fasta` / `.fas` / `.fa` / `.afa` / `.afas` / `.afasta` / `.a2m` / `.a3m`), Stockholm (`.sto` / `.stockholm`), and Clustal (`.clu` / `.aln`). The FASTA grammar distinguishes match (uppercase), insert (lowercase), gap (`-`), and gap-vs-insert (`.`) per the a2m/a3m casing convention; Stockholm gets structured `#=GF` / `#=GS` / `#=GR` / `#=GC` annotations.

## Install

From the **VS Code Marketplace**:

```sh
code --install-extension vv137xyz.vscode-bioinformatics
```

Or search for **Bioinformatics** in the Extensions sidebar (publisher: `vv137xyz`).

To install a specific build, download `vscode-bioinformatics-X.Y.Z.vsix` from the [Releases](https://github.com/vv137/vscode-bioinformatics/releases) page and either run `code --install-extension <file>.vsix`, or use **Extensions** sidebar → `…` menu → **Install from VSIX…**.

## Usage

Open any supported file. The viewer is registered with `priority: "option"`, so the regular text editor opens by default. Switch to the viewer either way:

- Click the **MSA** button in the editor title bar.
- Run **Bioinformatics: Open in MSA Viewer** from the Command Palette (`Cmd/Ctrl + Shift + P`).
- Right-click the file → **Open With…** → **MSA Viewer**.
- Pin the viewer as the default for an extension by adding to `settings.json`:
  ```json
  "workbench.editorAssociations": {
    "*.hhr": "bioinformatics.msaViewer",
    "*.a3m": "bioinformatics.msaViewer"
  }
  ```

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + F` | Focus the name filter |
| `Cmd/Ctrl + L` | Focus the goto-column input |
| `Esc` | Clear the filter (when focused) |
| `g` / `G` | Smooth-scroll to top / bottom of the hit list |
| `Ctrl/Cmd + scroll` | Zoom residues in / out |

## Development

```sh
git clone https://github.com/vv137/vscode-bioinformatics
cd vscode-bioinformatics
npm install
npm run compile
code --extensionDevelopmentPath=$(pwd)
```

The repo layout:

```
src/                     # extension (TypeScript)
  parsers/               # fas / a2m / a3m / sto / clu / psi / hhr
  viewer/                # CustomTextEditorProvider + message protocol
media/                   # webview assets (pure DOM)
  viewer.module.js       # window.MsaViewer.create — no host deps
  viewer.adapter.js      # VS Code wiring (~30 lines)
  viewer.css             # shared
syntaxes/                # TextMate grammars (fasta, stockholm, clustal)
references/Toolkit-audit.md  # feature audit + plan reference
```

The renderer in [`media/viewer.module.js`](media/viewer.module.js) has no VS Code dependencies — state persists via a `Storage`-shaped object passed in by the host. The same module ships into [plmMSA](https://github.com/DeepFoldProtein/plmMSA)'s `public/` folder with a 5-line wrapper using `localStorage`.

## Acknowledgments

- Renderer originally ported from [plmMSA](https://github.com/DeepFoldProtein/plmMSA).
- File-format conventions follow [hh-suite](https://github.com/soedinglab/hh-suite)'s `reformat.pl`.
- Hit-list / pairwise viewer design inspired by [proteinevolution/Toolkit](https://github.com/proteinevolution/Toolkit) (HHblits / HHpred / HMMER result tabs).
- Example fixtures from [aqlaboratory/openfold](https://github.com/aqlaboratory/openfold) (`examples/6KWC_1/`).

## License

[MIT](LICENSE) © 2026 Minsoo Kim
