// MSA viewer — pure module. Exposes window.MsaViewer.create(opts).
//
// No host-environment dependencies (no acquireVsCodeApi, no postMessage).
// Persistence is delegated to opts.storage (a Storage-shaped object;
// localStorage works directly). The same module ships in:
//   • this VS Code extension via media/viewer.adapter.js
//   • plmMSA's public/ via a 5-line wrapper in app.js
//
// Multiple instances may co-exist on a page — every piece of mutable
// state is captured in the create() closure. The tooltip element and
// document/window listeners are owned per-instance and removed on
// destroy().

(function () {
  "use strict";

  const FONT_MIN = 6;
  const FONT_MAX = 32;
  const FONT_DEFAULT = 10;
  const HIST_MIN = 30;
  const HIST_MAX = 240;
  const HIST_DEFAULT = 30;
  const LABEL_MIN = 0;
  const LABEL_MAX = 600;
  const LABEL_DEFAULT = 192;
  const LABEL_HIDE_THRESHOLD = 24;
  const VLIST_OVERSCAN = 8;
  const ROW_LINE_HEIGHT = 1.25;
  const VALID_PALETTES = new Set(["chemical", "clustalx", "taylor", "zappo"]);
  // Coverage histogram coloring: off | entropy | blosum.
  const VALID_COVER_COLORS = new Set(["off", "entropy", "blosum"]);
  const COVER_COLOR_DEFAULT = "blosum";

  // BLOSUM62 — used to color coverage bars by per-column conservation.
  // Self-pair max = 11 (W↔W); off-diagonal min = -4.
  const BLOSUM62_AA = "ARNDCQEGHILKMFPSTWYV";
  const BLOSUM62_ROWS = [
    [ 4,-1,-2,-2, 0,-1,-1, 0,-2,-1,-1,-1,-1,-2,-1, 1, 0,-3,-2, 0],
    [-1, 5, 0,-2,-3, 1, 0,-2, 0,-3,-2, 2,-1,-3,-2,-1,-1,-3,-2,-3],
    [-2, 0, 6, 1,-3, 0, 0, 0, 1,-3,-3, 0,-2,-3,-2, 1, 0,-4,-2,-3],
    [-2,-2, 1, 6,-3, 0, 2,-1,-1,-3,-4,-1,-3,-3,-1, 0,-1,-4,-3,-3],
    [ 0,-3,-3,-3, 9,-3,-4,-3,-3,-1,-1,-3,-1,-2,-3,-1,-1,-2,-2,-1],
    [-1, 1, 0, 0,-3, 5, 2,-2, 0,-3,-2, 1, 0,-3,-1, 0,-1,-2,-1,-2],
    [-1, 0, 0, 2,-4, 2, 5,-2, 0,-3,-3, 1,-2,-3,-1, 0,-1,-3,-2,-2],
    [ 0,-2, 0,-1,-3,-2,-2, 6,-2,-4,-4,-2,-3,-3,-2, 0,-2,-2,-3,-3],
    [-2, 0, 1,-1,-3, 0, 0,-2, 8,-3,-3,-1,-2,-1,-2,-1,-2,-2, 2,-3],
    [-1,-3,-3,-3,-1,-3,-3,-4,-3, 4, 2,-3, 1, 0,-3,-2,-1,-3,-1, 3],
    [-1,-2,-3,-4,-1,-2,-3,-4,-3, 2, 4,-2, 2, 0,-3,-2,-1,-2,-1, 1],
    [-1, 2, 0,-1,-3, 1, 1,-2,-1,-3,-2, 5,-1,-3,-1, 0,-1,-3,-2,-2],
    [-1,-1,-2,-3,-1, 0,-2,-3,-2, 1, 2,-1, 5, 0,-2,-1,-1,-1,-1, 1],
    [-2,-3,-3,-3,-2,-3,-3,-3,-1, 0, 0,-3, 0, 6,-4,-2,-2, 1, 3,-1],
    [-1,-2,-2,-1,-3,-1,-1,-2,-2,-3,-3,-1,-2,-4, 7,-1,-1,-4,-3,-2],
    [ 1,-1, 1, 0,-1, 0, 0, 0,-1,-2,-2, 0,-1,-2,-1, 4, 1,-3,-2,-2],
    [ 0,-1, 0,-1,-1,-1,-1,-2,-2,-1,-1,-1,-1,-2,-1, 1, 5,-2,-2, 0],
    [-3,-3,-4,-4,-2,-2,-3,-2,-2,-3,-2,-3,-1, 1,-4,-3,-2,11, 2,-3],
    [-2,-2,-2,-3,-2,-1,-2,-3, 2,-1,-1,-2,-1, 3,-3,-2,-2, 2, 7,-1],
    [ 0,-3,-3,-3,-1,-2,-2,-3,-3, 3, 1,-2, 1,-1,-2,-2, 0,-3,-1, 4],
  ];
  const BLOSUM62_INDEX = new Map();
  for (let i = 0; i < BLOSUM62_AA.length; i++) BLOSUM62_INDEX.set(BLOSUM62_AA[i], i);
  // Practical normalization range for mean SP scores on protein columns:
  // [-2, +6]. Clamped on both sides for the histogram color ramp.
  const BLOSUM62_NORM_LO = -2;
  const BLOSUM62_NORM_HI = 6;
  const LN20 = Math.log(20);
  /** breakAfter = 0 → auto-fit to window width on every resize. Manual
   *  override clamps to [_MIN, _MAX]. */
  const BREAK_AFTER_MIN = 30;
  const BREAK_AFTER_MAX = 240;
  const BREAK_AFTER_AUTO = 0;
  const BREAK_AFTER_DEFAULT = BREAK_AFTER_AUTO;
  // Hit-table columns we let the user sort by (clicked TH).
  const HHR_SORT_KEYS = new Set([
    "num", "desc", "prob", "evalue", "score", "cols", "qStart", "tStart",
  ]);

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /**
   * Default DB link resolver — accession-shape heuristics. Returns
   * { url, label } for the first matching database, or null.
   *
   * Patterns are intentionally conservative: a token like "P12345"
   * matches UniProt, but "Endo-1,4" does not match anything. The
   * caller can override via opts.linkResolver(name) to integrate
   * with internal directories.
   */
  function defaultLinkResolver(name) {
    if (!name) return null;
    const text = String(name).trim();
    let m;
    // PDB with chain (e.g. "2DFB_A"). 4-char alnum starting with a digit.
    if ((m = /^([0-9][A-Za-z0-9]{3})_[A-Za-z0-9]+$/.exec(text))) {
      const id = m[1].toUpperCase();
      return { url: `https://www.rcsb.org/structure/${id}`, label: "PDB", kind: "pdb", id };
    }
    // PDB without chain ("2dfb").
    if ((m = /^([0-9][A-Za-z0-9]{3})$/.exec(text))) {
      const id = m[1].toUpperCase();
      return { url: `https://www.rcsb.org/structure/${id}`, label: "PDB", kind: "pdb", id };
    }
    // UniProt accession (Swiss-Prot + TrEMBL) — link to AlphaFold DB,
    // which has a predicted structure for ~all UniProt entries and is
    // more useful than the UniProt page when browsing MSA hits.
    if (/^([OPQ][0-9][A-Z0-9]{3}[0-9])$/.test(text)
      || /^([A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/.test(text)) {
      return { url: `https://alphafold.ebi.ac.uk/entry/${text}`, label: "AFDB" };
    }
    // UniRef cluster (e.g. "UniRef90_P12345").
    if ((m = /^(UniRef\d+_[\w.-]+)$/.exec(text))) {
      return { url: `https://www.uniprot.org/uniref/${m[1]}`, label: "UniRef" };
    }
    // MGnify protein (e.g. "MGYP000510094044", optionally with a /start-end suffix).
    if ((m = /^(MGYP\d+)(?:\/.*)?$/.exec(text))) {
      return { url: `https://www.ebi.ac.uk/metagenomics/sequence/${m[1]}`, label: "MGnify" };
    }
    // Pfam family.
    if ((m = /^(PF\d{5})$/.exec(text))) {
      return { url: `https://www.ebi.ac.uk/interpro/entry/pfam/${m[1]}`, label: "Pfam" };
    }
    // InterPro entry.
    if ((m = /^(IPR\d{6})$/.exec(text))) {
      return { url: `https://www.ebi.ac.uk/interpro/entry/InterPro/${m[1]}`, label: "InterPro" };
    }
    // NCBI RefSeq protein (e.g. NP_001234.1, XP_004567890).
    if ((m = /^([NXY]P_\d+(?:\.\d+)?)$/.exec(text))) {
      return { url: `https://www.ncbi.nlm.nih.gov/protein/${m[1]}`, label: "NCBI" };
    }
    return null;
  }

  /**
   * Create an MSA viewer instance bound to `opts.container`.
   *
   *   opts.container  HTMLElement (required)
   *   opts.storage    Storage-shaped object (default: localStorage)
   *   opts.storageKey string (default: 'msa-viewer.state')
   *
   * Returns { load(viewerMsa), destroy() }.
   */
  function create(opts) {
    if (!opts || !opts.container) throw new Error("MsaViewer.create: opts.container is required");
    const container = opts.container;
    const storage = opts.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const storageKey = opts.storageKey || "msa-viewer.state";
    // Optional caller-supplied link resolver (Phase 3, item 3.4). Takes
    // a single string (a sequence name / hit accession) and returns
    // {url, label} or null. The built-in fallback handles common
    // protein databases — PDB / UniProt / UniRef / MGYP / Pfam /
    // InterPro / NCBI — based on accession-shape heuristics.
    const linkResolver = typeof opts.linkResolver === "function"
      ? opts.linkResolver
      : defaultLinkResolver;
    // Optional: open a PDB structure inside the host (VS Code download
    // + open, or whatever the host wires up). When unset, the inline
    // "Code" button next to PDB links is hidden.
    const onPdbOpen = typeof opts.onPdbOpen === "function" ? opts.onPdbOpen : null;

    // ---- per-instance state ----
    let state = loadState();
    if (typeof state.showInserts !== "boolean") state.showInserts = false;
    if (typeof state.fontPx !== "number") state.fontPx = FONT_DEFAULT;
    if (typeof state.histPx !== "number") state.histPx = HIST_DEFAULT;
    if (typeof state.filter !== "string") state.filter = "";
    if (typeof state.labelWidth !== "number") state.labelWidth = LABEL_DEFAULT;
    if (typeof state.palette !== "string") state.palette = "chemical";
    if (!VALID_PALETTES.has(state.palette)) state.palette = "chemical";
    if (typeof state.msaColorOn !== "boolean") state.msaColorOn = true;
    if (typeof state.hhrColorOn !== "boolean") state.hhrColorOn = false;
    if (typeof state.breakAfter !== "number") state.breakAfter = BREAK_AFTER_DEFAULT;
    // Migration: a previous version defaulted to 80 (manual). Anyone
    // who never explicitly set a value should now flip to auto.
    if (state.breakAfter === 80) state.breakAfter = BREAK_AFTER_AUTO;
    if (typeof state.hhrSortKey !== "string") state.hhrSortKey = "num";
    if (typeof state.hhrSortDir !== "string") state.hhrSortDir = "asc";
    if (typeof state.msaTemplatesMode !== "boolean") state.msaTemplatesMode = false;
    if (typeof state.msaCoverColor !== "string") state.msaCoverColor = COVER_COLOR_DEFAULT;
    if (!VALID_COVER_COLORS.has(state.msaCoverColor)) state.msaCoverColor = COVER_COLOR_DEFAULT;
    state.fontPx = clamp(state.fontPx, FONT_MIN, FONT_MAX);
    state.histPx = clamp(state.histPx, HIST_MIN, HIST_MAX);
    state.labelWidth = clamp(state.labelWidth, LABEL_MIN, LABEL_MAX);
    if (state.breakAfter !== BREAK_AFTER_AUTO) {
      state.breakAfter = clamp(state.breakAfter, BREAK_AFTER_MIN, BREAK_AFTER_MAX);
    }
    if (!HHR_SORT_KEYS.has(state.hhrSortKey)) state.hhrSortKey = "num";
    if (state.hhrSortDir !== "asc" && state.hhrSortDir !== "desc") state.hhrSortDir = "asc";

    // Per-column info populated by load() and read by the tooltip handler.
    let currentColumnInfo = null;

    // Error display lives inside the container so the module owns its DOM.
    container.innerHTML = "";
    const errorEl = document.createElement("div");
    errorEl.className = "msa-error";
    errorEl.hidden = true;
    container.appendChild(errorEl);

    // Floating tooltip — one per instance, parented to document.body so it
    // can escape overflow:hidden ancestors.
    const tipEl = document.createElement("div");
    tipEl.className = "msa-tooltip";
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
    let currentTipTarget = null;

    // Listeners registered per-instance; tracked for destroy().
    const disposers = [];
    function on(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      disposers.push(() => target.removeEventListener(type, fn, options));
    }

    // ---- drag-and-drop ----
    // The module shows a visual highlight on dragover and calls
    // opts.onFileDrop(file) on drop. The host owns parsing — for VS
    // Code the adapter forwards file bytes to the extension via
    // postMessage; for plmMSA the wrapper can do anything (parse
    // client-side, submit as a new job, etc.). If onFileDrop is not
    // provided we still show feedback but no-op on drop.
    let dragDepth = 0;
    on(container, "dragenter", (ev) => {
      // Only react to file drags — drag of a text selection from
      // within the page should not trigger the import overlay.
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      dragDepth++;
      if (dragDepth === 1) container.classList.add("msa-drag-over");
    });
    on(container, "dragover", (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    });
    on(container, "dragleave", (ev) => {
      if (!hasFiles(ev)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) container.classList.remove("msa-drag-over");
    });
    on(container, "drop", async (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      dragDepth = 0;
      container.classList.remove("msa-drag-over");
      const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (!file) return;
      if (typeof opts.onFileDrop !== "function") return;
      try {
        await opts.onFileDrop(file);
      } catch (e) {
        showError(`Failed to load dropped file: ${e && e.message ? e.message : e}`);
      }
    });

    function hasFiles(ev) {
      const dt = ev.dataTransfer;
      if (!dt) return false;
      // `types` is a DOMStringList in older browsers; coerce to array.
      const types = Array.from(dt.types || []);
      return types.indexOf("Files") !== -1;
    }

    // ---- tooltip wiring (scoped to container; document for blur) ----
    on(container, "mouseover", (ev) => {
      const t = ev.target.closest("[data-tip], [data-col]");
      if (!t || !container.contains(t)) return;
      let text = t.dataset.tip;
      if (!text && t.dataset.col != null) text = formatColInfo(+t.dataset.col);
      if (!text) return;
      tipEl.textContent = text;
      tipEl.hidden = false;
      positionTip(t);
      currentTipTarget = t;
    });
    on(container, "mouseout", (ev) => {
      const t = ev.target.closest("[data-tip], [data-col]");
      if (t && currentTipTarget === t) {
        tipEl.hidden = true;
        currentTipTarget = null;
      }
    });
    on(document, "scroll", () => {
      if (currentTipTarget) positionTip(currentTipTarget);
    }, true);
    on(window, "blur", () => {
      if (currentTipTarget) {
        tipEl.hidden = true;
        currentTipTarget = null;
      }
    });

    function positionTip(target) {
      const r = target.getBoundingClientRect();
      const tipR = tipEl.getBoundingClientRect();
      let left = r.left;
      let top = r.bottom + 6;
      const maxLeft = window.innerWidth - tipR.width - 8;
      if (left > maxLeft) left = Math.max(8, maxLeft);
      if (top + tipR.height > window.innerHeight - 8) {
        top = Math.max(8, r.top - tipR.height - 6);
      }
      tipEl.style.left = `${left}px`;
      tipEl.style.top = `${top}px`;
    }

    function formatColInfo(idx) {
      if (!currentColumnInfo) return null;
      const info = currentColumnInfo[idx];
      if (!info) return null;
      const cov = info.total > 0 ? (info.nonGap / info.total) * 100 : 0;
      const consE = info.consEntropy == null ? "—" : info.consEntropy.toFixed(2);
      const blosumStr = info.blosum == null
        ? "—"
        : `${info.blosum.toFixed(2)} (norm ${info.consBlosum.toFixed(2)})`;
      const head =
        `col ${idx + 1} · query = ${info.queryRes}\n` +
        `coverage: ${info.nonGap} / ${info.total} (${cov.toFixed(1)}%)\n` +
        `entropy: ${info.entropy.toFixed(2)} nats (N_eff = ${Math.exp(info.entropy).toFixed(2)}, cons ${consE})\n` +
        `BLOSUM62 SP: ${blosumStr}`;
      if (!info.top || info.top.length === 0) return head;
      const countWidth = String(info.top[0].count).length;
      const lines = info.top.map((t) => {
        const pct = info.total > 0 ? (t.count / info.total) * 100 : 0;
        const c = String(t.count).padStart(countWidth, " ");
        return `  ${t.res}  ${c}/${info.total} (${pct.toFixed(1)}%)`;
      });
      const label = info.top.length === 1 ? "top residue:" : `top ${info.top.length} residues:`;
      return `${head}\n${label}\n${lines.join("\n")}`;
    }

    // ---- public API ----
    function load(payload) {
      // Clear any prior render except errorEl, which we replace.
      container.innerHTML = "";
      errorEl.hidden = true;
      container.appendChild(errorEl);

      // Discriminated payload (Phase 2). Back-compat: a bare ViewerMsa
      // (no `kind`) is treated as an MSA payload — that shape is what
      // the original VS Code adapter and plmMSA still send.
      if (payload && payload.kind === "pairwise") {
        if (!payload.hhr) {
          const empty = document.createElement("div");
          empty.className = "static-msa-empty";
          empty.textContent = "No HHR data to display.";
          container.appendChild(empty);
          return;
        }
        renderPairwiseInstance(payload.hhr);
        return;
      }

      const viewer =
        payload && payload.kind === "msa" ? payload.viewer : payload;
      if (!viewer || !Array.isArray(viewer.entries) || viewer.entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "static-msa-empty";
        empty.textContent = "No sequences to display.";
        container.appendChild(empty);
        return;
      }

      renderInstance(viewer);
    }

    function showError(message) {
      // Empty the container except the error element, then surface the message.
      container.innerHTML = "";
      errorEl.hidden = false;
      errorEl.textContent = message || "";
      container.appendChild(errorEl);
    }

    function destroy() {
      while (disposers.length) {
        try { disposers.pop()(); } catch (e) { /* ignore */ }
      }
      if (tipEl.parentNode) tipEl.parentNode.removeChild(tipEl);
      container.innerHTML = "";
    }

    function loadState() {
      if (!storage) return {};
      try {
        const raw = storage.getItem(storageKey);
        return raw ? JSON.parse(raw) : {};
      } catch { return {}; }
    }

    function persist() {
      if (!storage) return;
      try { storage.setItem(storageKey, JSON.stringify(state)); } catch { /* ignore */ }
    }

    // Per-instance render scope. Builds the wrapper, controls, table, list
    // and registers all the inner event listeners (each tracked via `on`).
    function renderInstance(viewer) {
      const supportsInserts = viewer.format === "a2m" || viewer.format === "a3m";
      const query = viewer.entries.find((e) => e.isQuery) || viewer.entries[0];
      const hits = viewer.entries.filter((e) => e !== query);

      const coverage = computeCoverage(viewer.entries, viewer.matchLen);
      const meanH = meanHammingToQuery(viewer.entries, query, viewer.matchLen);
      currentColumnInfo = computeColumnInfo(viewer, query);
      const stats = {
        seqLen: query.matchSeq.replace(/[-.]/g, "").length,
        depth: viewer.entries.length,
        nEff: computeNeff(currentColumnInfo, query),
        meanH,
        log10H: meanH > 0 ? Math.log10(meanH) : null,
        log2H: meanH > 0 ? Math.log2(meanH) : null,
      };

      const wrapper = document.createElement("div");
      wrapper.className = "static-msa-viewer";
      applyFont(wrapper);
      applyHistHeight(wrapper);
      applyLabelWidth(wrapper);
      applyPalette(wrapper);

      const controls = document.createElement("div");
      controls.className = "static-msa-controls";

      const prevBtn = makeBtn("msa-page-btn", "↑");
      prevBtn.dataset.tip = "Page up";
      const pageLabel = document.createElement("span");
      pageLabel.className = "msa-page-label";
      const nextBtn = makeBtn("msa-page-btn", "↓");
      nextBtn.dataset.tip = "Page down";

      const filterInput = document.createElement("input");
      filterInput.type = "search";
      filterInput.className = "msa-filter";
      filterInput.placeholder = "filter names…";
      filterInput.value = state.filter || "";
      filterInput.spellcheck = false;
      filterInput.dataset.tip = "Filter by name (Cmd/Ctrl+F)";
      on(filterInput, "input", () => {
        state.filter = filterInput.value.trim();
        table.scrollTop = 0;
        persist();
        drawAll();
      });

      const gotoInput = document.createElement("input");
      gotoInput.type = "number";
      gotoInput.min = "1";
      gotoInput.max = String(viewer.matchLen);
      gotoInput.className = "msa-goto";
      gotoInput.placeholder = "col";
      gotoInput.dataset.tip = `Jump to column 1–${viewer.matchLen} (Cmd/Ctrl+L · Enter to jump)`;
      on(gotoInput, "keydown", (ev) => {
        if (ev.key !== "Enter") return;
        const n = parseInt(gotoInput.value, 10);
        if (!isFinite(n) || n < 1 || n > viewer.matchLen) return;
        scrollToColumn(n);
      });

      function scrollToColumn(col) {
        const queryRow = wrapper.querySelector(".static-msa-query .static-msa-seq");
        if (!queryRow) return;
        const cells = queryRow.children;
        let matchIdx = 0;
        let target = null;
        for (const c of cells) {
          if (c.classList.contains("msa-residue") && !c.classList.contains("msa-insert")) {
            matchIdx++;
            if (matchIdx === col) { target = c; break; }
          }
        }
        if (!target) return;
        const tableRect = table.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const center =
          table.scrollLeft +
          (targetRect.left - tableRect.left) -
          tableRect.width / 2 +
          targetRect.width / 2;
        table.scrollTo({ left: Math.max(0, center), behavior: "smooth" });
        target.classList.add("msa-flash");
        setTimeout(() => target.classList.remove("msa-flash"), 900);
      }

      const paletteSel = document.createElement("select");
      paletteSel.className = "msa-palette-sel";
      paletteSel.dataset.tip = "Color palette";
      for (const [v, lbl] of [
        ["chemical", "Chemical"],
        ["clustalx", "Clustal X"],
        ["taylor", "Taylor"],
        ["zappo", "Zappo"],
      ]) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = lbl;
        paletteSel.appendChild(opt);
      }
      paletteSel.value = state.palette;
      on(paletteSel, "change", () => {
        state.palette = paletteSel.value;
        applyPalette(wrapper);
        persist();
      });

      const zoomOut = makeBtn("msa-zoom-btn", "−");
      zoomOut.dataset.tip = "Zoom out (Ctrl/Cmd + scroll)";
      zoomOut.setAttribute("aria-label", "Zoom out");
      const zoomLabel = document.createElement("span");
      zoomLabel.className = "msa-zoom-label";
      zoomLabel.dataset.tip = `Click to reset zoom to ${FONT_DEFAULT}px`;
      on(zoomLabel, "click", () => {
        if (state.fontPx === FONT_DEFAULT) return;
        state.fontPx = FONT_DEFAULT;
        applyFont(wrapper);
        refreshZoomLabel();
        drawList();
        persist();
      });
      const zoomIn = makeBtn("msa-zoom-btn", "+");
      zoomIn.dataset.tip = "Zoom in (Ctrl/Cmd + scroll)";
      zoomIn.setAttribute("aria-label", "Zoom in");

      let toggleBtn = null;
      if (supportsInserts) {
        toggleBtn = makeBtn("msa-toggle-btn", "Inserts");
        toggleBtn.setAttribute("aria-pressed", String(!!state.showInserts));
        toggleBtn.title = "Toggle insert columns (a2m/a3m)";
        on(toggleBtn, "click", () => {
          state.showInserts = !state.showInserts;
          toggleBtn.setAttribute("aria-pressed", String(state.showInserts));
          persist();
          drawAll();
        });
      }

      // Templates view: shown only when most headers look like a
      // hmmsearch / hhsuite "[subseq from]" template manifest.
      // Switches the body from the residue grid to a structured table
      // (accession / range / length / description). The PDB column
      // links into RCSB the same way as everywhere else.
      const templatesMatch = isTemplatesA3m(viewer);
      let templatesBtn = null;
      if (templatesMatch) {
        templatesBtn = makeBtn("msa-toggle-btn", "Templates");
        templatesBtn.setAttribute("aria-pressed", String(!!state.msaTemplatesMode));
        templatesBtn.dataset.tip = "Switch to templates table view";
        on(templatesBtn, "click", () => {
          state.msaTemplatesMode = !state.msaTemplatesMode;
          templatesBtn.setAttribute("aria-pressed", String(state.msaTemplatesMode));
          persist();
          applyMsaMode();
        });
      } else {
        // Force off when the file isn't templates-shaped, even if
        // saved state has a stale `true` from a previous file.
        state.msaTemplatesMode = false;
      }

      const fullBtn = makeBtn("msa-fullscreen-btn", "");
      fullBtn.title = "Full screen";
      fullBtn.setAttribute("aria-label", "Full screen");
      setFullscreenIcon(fullBtn, false);

      const statsEl = document.createElement("span");
      statsEl.className = "msa-stats";
      appendStat(statsEl, "seqLen", String(stats.seqLen),
        "Ungapped length of the query sequence (gap chars stripped from match columns).");
      appendStat(statsEl, "depth", String(stats.depth),
        "Number of sequences in the alignment, including the query.");
      appendStat(statsEl, "N_eff", stats.nEff.toFixed(2),
        "exp of mean per-column Shannon entropy (nats), gaps excluded — HHblits/HHsuite definition. " +
        "Range ≈ 1 (single sequence) to ~20 (uniform AA usage). " +
        "No Henikoff position weights applied.");
      appendStat(statsEl, "log₁₀H", stats.log10H == null ? "—" : stats.log10H.toFixed(2),
        `log10 of mean Hamming distance from query to each other sequence over match columns.\n` +
        `mean H = ${stats.meanH.toFixed(2)} (over ${Math.max(0, stats.depth - 1)} hits).`);
      appendStat(statsEl, "log₂H", stats.log2H == null ? "—" : stats.log2H.toFixed(2),
        `log2 of mean Hamming distance from query to each other sequence over match columns.\n` +
        `mean H = ${stats.meanH.toFixed(2)} (over ${Math.max(0, stats.depth - 1)} hits).`);

      controls.appendChild(prevBtn);
      controls.appendChild(pageLabel);
      controls.appendChild(nextBtn);
      controls.appendChild(filterInput);
      controls.appendChild(gotoInput);
      if (toggleBtn) controls.appendChild(toggleBtn);
      if (templatesBtn) controls.appendChild(templatesBtn);
      controls.appendChild(statsEl);
      controls.appendChild(paletteSel);
      controls.appendChild(zoomOut);
      controls.appendChild(zoomLabel);
      controls.appendChild(zoomIn);
      controls.appendChild(fullBtn);

      const table = document.createElement("div");
      table.className = "static-msa-table";

      const labelResize = document.createElement("div");
      labelResize.className = "msa-label-resize";
      labelResize.dataset.tip =
        "Drag to resize the name column · pull left to hide · double-click to reset";
      attachLabelResize(labelResize, wrapper);

      wrapper.appendChild(controls);
      wrapper.appendChild(table);
      wrapper.appendChild(labelResize);
      container.appendChild(wrapper);

      function refreshZoomLabel() {
        zoomLabel.textContent = `${state.fontPx}px`;
        zoomOut.disabled = state.fontPx <= FONT_MIN;
        zoomIn.disabled = state.fontPx >= FONT_MAX;
      }

      function applyZoom(delta) {
        const next = clamp(state.fontPx + delta, FONT_MIN, FONT_MAX);
        if (next === state.fontPx) return;
        state.fontPx = next;
        applyFont(wrapper);
        refreshZoomLabel();
        drawList();
        persist();
      }

      on(zoomOut, "click", () => applyZoom(-1));
      on(zoomIn, "click", () => applyZoom(+1));
      on(table, "wheel", (ev) => {
        if (!(ev.ctrlKey || ev.metaKey)) return;
        ev.preventDefault();
        applyZoom(ev.deltaY > 0 ? -1 : +1);
      }, { passive: false });

      const list = document.createElement("div");
      list.className = "static-msa-list";

      function rowHeight() {
        return Math.max(1, Math.ceil(state.fontPx * ROW_LINE_HEIGHT));
      }

      function getFiltered() {
        const needle = state.filter.toLowerCase();
        return needle
          ? hits.filter((h) => (h.name || h.id || "").toLowerCase().includes(needle))
          : hits;
      }

      function getInsertWidths() {
        return state.showInserts && supportsInserts
          ? computeInsertWidths(viewer.entries, viewer.matchLen)
          : null;
      }

      function cycleCoverColor() {
        const order = ["off", "entropy", "blosum"];
        const i = order.indexOf(state.msaCoverColor);
        state.msaCoverColor = order[(i + 1) % order.length];
        persist();
        drawAll();
      }

      function drawAll() {
        if (state.msaTemplatesMode) {
          drawTemplatesTable();
          return;
        }
        labelResize.style.display = "";
        table.innerHTML = "";
        const insertWidths = getInsertWidths();
        renderRulerRow(table, viewer.matchLen, insertWidths);
        renderHistogramRow(
          table,
          coverage,
          insertWidths,
          viewer.entries.length,
          wrapper,
          currentColumnInfo,
          state.msaCoverColor,
          cycleCoverColor,
        );
        renderRow(table, query, "static-msa-query", insertWidths);
        table.appendChild(list);
        drawList(insertWidths);
      }

      function applyMsaMode() {
        // The button click already flipped state; just rebuild.
        drawAll();
      }

      function drawTemplatesTable() {
        // The label-resize handle is for the residue grid only; hide
        // it in templates mode so the table can use the full width.
        labelResize.style.display = "none";
        table.innerHTML = "";

        // HitMap above the table — same per-query coverage plot as
        // the HHR view, derived from each row's first/last non-gap
        // residue in matchSeq. Click a rect → scroll matching row.
        const mapSection = document.createElement("div");
        mapSection.className = "hhr-mapsection msa-templates-mapsection";
        renderTemplatesHitMap(mapSection, viewer);
        table.appendChild(mapSection);

        const tableEl = document.createElement("div");
        tableEl.className = "msa-templates-section";
        renderTemplatesTable(tableEl, viewer);
        table.appendChild(tableEl);

        // Wire HitMap click → scroll matching templates row.
        on(mapSection, "click", (ev) => {
          if (ev.target.closest("a, button")) return;
          const rect = ev.target.closest("[data-num]");
          if (!rect) return;
          const target = tableEl.querySelector(
            `tr[data-num="${CSS.escape(String(rect.dataset.num))}"]`,
          );
          if (!target) return;
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.classList.add("hhr-row-flash");
          setTimeout(() => target.classList.remove("hhr-row-flash"), 900);
        });
      }

      function drawList(insertWidths) {
        if (insertWidths === undefined) insertWidths = getInsertWidths();
        const filtered = getFiltered();
        const rh = rowHeight();
        list.style.height = `${filtered.length * rh}px`;

        const listOffsetTop = list.offsetTop;
        const viewportH = table.clientHeight;
        const visibleTop = Math.max(0, table.scrollTop);
        const visibleHeight = Math.max(0, viewportH - listOffsetTop);

        const startRow = Math.max(0, Math.floor(visibleTop / rh) - VLIST_OVERSCAN);
        const endRow = Math.min(
          filtered.length,
          Math.ceil((visibleTop + visibleHeight) / rh) + VLIST_OVERSCAN,
        );

        list.innerHTML = "";
        const fragment = document.createDocumentFragment();
        for (let i = startRow; i < endRow; i++) {
          fragment.appendChild(buildVirtualRow(filtered[i], i * rh, insertWidths));
        }
        list.appendChild(fragment);

        const total = hits.length;
        const f = filtered.length;
        const startIdx = f === 0 ? 0 : startRow + 1;
        const endIdx = Math.min(endRow, f);
        pageLabel.textContent =
          f === 0
            ? state.filter ? `0 of ${total}` : "query only"
            : state.filter
            ? `${startIdx}–${endIdx} of ${f} (of ${total})`
            : `${startIdx}–${endIdx} of ${total}`;

        prevBtn.disabled = table.scrollTop <= 0;
        nextBtn.disabled = table.scrollTop >= list.offsetTop + list.offsetHeight - viewportH - 1;
      }

      function buildVirtualRow(entry, top, insertWidths) {
        const row = document.createElement("div");
        row.className = "static-msa-row";
        row.style.top = `${top}px`;
        const label = document.createElement("span");
        label.className = "static-msa-label";
        const nameText = entry.name || entry.id || "";
        renderLinkedHeader(label, nameText);
        label.title = nameText;
        const body = document.createElement("span");
        body.className = "static-msa-seq";
        renderSequence(body, entry, insertWidths);
        row.appendChild(label);
        row.appendChild(body);
        return row;
      }

      let scrollPending = false;
      on(table, "scroll", () => {
        if (scrollPending) return;
        scrollPending = true;
        requestAnimationFrame(() => {
          scrollPending = false;
          drawList();
        });
      });

      on(prevBtn, "click", () => {
        table.scrollBy({ top: -table.clientHeight + 50, behavior: "smooth" });
      });
      on(nextBtn, "click", () => {
        table.scrollBy({ top: table.clientHeight - 50, behavior: "smooth" });
      });
      on(fullBtn, "click", () => toggleFullscreen(wrapper));
      on(document, "fullscreenchange", () => {
        const isFs = document.fullscreenElement === wrapper;
        fullBtn.title = isFs ? "Exit full screen" : "Full screen";
        fullBtn.setAttribute("aria-label", fullBtn.title);
        setFullscreenIcon(fullBtn, isFs);
        drawList();
      });
      on(window, "resize", () => drawList());

      function syncLabelResizeTop() {
        labelResize.style.top = `${controls.offsetHeight}px`;
      }
      syncLabelResizeTop();
      on(window, "resize", syncLabelResizeTop);

      // Keyboard shortcuts. Bound on document so they fire regardless of
      // focus, but ignored when an input *outside* this instance has focus.
      on(document, "keydown", (ev) => {
        const mod = ev.metaKey || ev.ctrlKey;
        const tag = (document.activeElement && document.activeElement.tagName) || "";

        if (mod && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "f") {
          ev.preventDefault();
          filterInput.focus();
          filterInput.select();
          return;
        }
        if (mod && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "l") {
          ev.preventDefault();
          gotoInput.focus();
          gotoInput.select();
          return;
        }
        if (ev.key === "Escape") {
          if (document.activeElement === filterInput) {
            if (filterInput.value) {
              filterInput.value = "";
              state.filter = "";
              table.scrollTop = 0;
              persist();
              drawAll();
            } else {
              filterInput.blur();
            }
            ev.preventDefault();
            return;
          }
          if (document.activeElement === gotoInput) {
            gotoInput.blur();
            ev.preventDefault();
            return;
          }
        }
        if (tag !== "INPUT" && tag !== "TEXTAREA" && !mod) {
          if (ev.key === "g") {
            ev.preventDefault();
            table.scrollTo({ top: 0, behavior: "smooth" });
            return;
          }
          if (ev.key === "G") {
            ev.preventDefault();
            table.scrollTo({ top: list.offsetHeight, behavior: "smooth" });
            return;
          }
        }
      });

      refreshZoomLabel();
      drawAll();
    }

    function renderPairwiseInstance(hhr) {
      const wrapper = document.createElement("div");
      wrapper.className = "static-msa-viewer hhr-viewer";
      applyFont(wrapper);
      applyPalette(wrapper);
      applyHhrColor(wrapper);

      const controls = document.createElement("div");
      controls.className = "static-msa-controls";

      const summary = document.createElement("span");
      summary.className = "msa-stats";
      appendStat(summary, "query", hhr.header.query || "—",
        "Query name from the .hhr Query line.");
      appendStat(summary, "matchCols", String(hhr.header.matchColumns || 0),
        "Match_columns from the .hhr header — length of the query HMM.");
      appendStat(summary, "hits", String(hhr.alignments.length),
        "Number of per-hit alignment blocks parsed from the .hhr file.");
      appendStat(summary, "Neff", (hhr.header.neff || 0).toFixed(2),
        "Neff reported by HHsuite for the query MSA. Computed by the profile builder with Henikoff weights — generally higher than our viewer's MSA-side N_eff.");

      // Color-on toggle. Default OFF for pairwise (Toolkit convention —
      // agree-string + consensus rows already convey conservation).
      const colorBtn = makeBtn("msa-toggle-btn", "Color");
      colorBtn.setAttribute("aria-pressed", String(state.hhrColorOn));
      colorBtn.dataset.tip = "Toggle per-residue coloring";
      on(colorBtn, "click", () => {
        state.hhrColorOn = !state.hhrColorOn;
        colorBtn.setAttribute("aria-pressed", String(state.hhrColorOn));
        applyHhrColor(wrapper);
        persist();
      });

      // breakAfter input — wraps each alignment block at this many cols.
      // 0 (or empty) means "auto fit to window width", recomputed on
      // every resize. A typed number overrides auto with a fixed wrap.
      const breakInput = document.createElement("input");
      breakInput.type = "number";
      breakInput.min = "0";
      breakInput.max = String(BREAK_AFTER_MAX);
      breakInput.className = "msa-goto";
      breakInput.value = state.breakAfter === BREAK_AFTER_AUTO ? "" : String(state.breakAfter);
      breakInput.placeholder = "auto";
      breakInput.dataset.tip = `Wrap alignments at N columns (empty / 0 = auto-fit to window)`;
      on(breakInput, "change", () => {
        const raw = breakInput.value.trim();
        let n;
        if (!raw || raw === "0") {
          n = BREAK_AFTER_AUTO;
          breakInput.value = "";
        } else {
          n = clamp(parseInt(raw, 10) || BREAK_AFTER_MIN, BREAK_AFTER_MIN, BREAK_AFTER_MAX);
          breakInput.value = String(n);
        }
        if (n === state.breakAfter) return;
        state.breakAfter = n;
        persist();
        rerenderAlignments();
      });
      const breakLabel = document.createElement("span");
      breakLabel.className = "msa-break-label";
      breakLabel.textContent = "wrap";
      breakLabel.dataset.tip = "Columns per alignment chunk (0 = auto-fit to window)";

      const paletteSel = document.createElement("select");
      paletteSel.className = "msa-palette-sel";
      paletteSel.dataset.tip = "Color palette";
      for (const [v, lbl] of [
        ["chemical", "Chemical"],
        ["clustalx", "Clustal X"],
        ["taylor", "Taylor"],
        ["zappo", "Zappo"],
      ]) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = lbl;
        paletteSel.appendChild(opt);
      }
      paletteSel.value = state.palette;
      on(paletteSel, "change", () => {
        state.palette = paletteSel.value;
        applyPalette(wrapper);
        persist();
      });

      const zoomOut = makeBtn("msa-zoom-btn", "−");
      zoomOut.dataset.tip = "Zoom out (Ctrl/Cmd + scroll)";
      const zoomLabel = document.createElement("span");
      zoomLabel.className = "msa-zoom-label";
      zoomLabel.dataset.tip = `Click to reset zoom to ${FONT_DEFAULT}px`;
      on(zoomLabel, "click", () => {
        if (state.fontPx === FONT_DEFAULT) return;
        state.fontPx = FONT_DEFAULT;
        applyFont(wrapper);
        refreshZoomLabel();
        persist();
      });
      const zoomIn = makeBtn("msa-zoom-btn", "+");
      zoomIn.dataset.tip = "Zoom in (Ctrl/Cmd + scroll)";

      const fullBtn = makeBtn("msa-fullscreen-btn", "");
      fullBtn.title = "Full screen";
      setFullscreenIcon(fullBtn, false);

      controls.appendChild(summary);
      controls.appendChild(colorBtn);
      controls.appendChild(breakLabel);
      controls.appendChild(breakInput);
      controls.appendChild(paletteSel);
      controls.appendChild(zoomOut);
      controls.appendChild(zoomLabel);
      controls.appendChild(zoomIn);
      controls.appendChild(fullBtn);

      // Body: HitMap on top, then hit table, then alignments. Click in
      // either the HitMap or the hit table scrolls to the alignment.
      const body = document.createElement("div");
      body.className = "hhr-body";

      const mapSection = document.createElement("div");
      mapSection.className = "hhr-mapsection";
      renderHitMap(mapSection, hhr);
      body.appendChild(mapSection);

      const hitsSection = document.createElement("div");
      hitsSection.className = "hhr-hits";
      body.appendChild(hitsSection);
      renderHitTable(hitsSection, hhr);

      const alignmentsSection = document.createElement("div");
      alignmentsSection.className = "hhr-alignments";
      body.appendChild(alignmentsSection);

      wrapper.appendChild(controls);
      wrapper.appendChild(body);
      container.appendChild(wrapper);

      // Initial render uses the now-laid-out body width to compute
      // auto-fit. Subsequent resizes re-render only when the computed
      // breakAfter actually changes (avoids needless DOM churn on
      // sub-column resizes).
      let lastBreak = -1;
      function rerenderIfBreakChanged() {
        const next = computeBreakAfter(body);
        if (next === lastBreak) return;
        lastBreak = next;
        alignmentsSection.innerHTML = "";
        renderAlignments(alignmentsSection, hhr, next);
      }
      rerenderIfBreakChanged();

      function rerenderAlignments() {
        lastBreak = computeBreakAfter(body);
        alignmentsSection.innerHTML = "";
        renderAlignments(alignmentsSection, hhr, lastBreak);
      }
      function rerenderHits() {
        hitsSection.innerHTML = "";
        renderHitTable(hitsSection, hhr);
      }

      function refreshZoomLabel() {
        zoomLabel.textContent = `${state.fontPx}px`;
        zoomOut.disabled = state.fontPx <= FONT_MIN;
        zoomIn.disabled = state.fontPx >= FONT_MAX;
      }
      function applyZoom(delta) {
        const next = clamp(state.fontPx + delta, FONT_MIN, FONT_MAX);
        if (next === state.fontPx) return;
        state.fontPx = next;
        applyFont(wrapper);
        refreshZoomLabel();
        persist();
        // Auto-fit depends on per-char width, which scales with zoom.
        rerenderIfBreakChanged();
      }
      on(zoomOut, "click", () => applyZoom(-1));
      on(zoomIn, "click", () => applyZoom(+1));
      on(body, "wheel", (ev) => {
        if (!(ev.ctrlKey || ev.metaKey)) return;
        ev.preventDefault();
        applyZoom(ev.deltaY > 0 ? -1 : +1);
      }, { passive: false });

      on(fullBtn, "click", () => toggleFullscreen(wrapper));
      on(document, "fullscreenchange", () => {
        const isFs = document.fullscreenElement === wrapper;
        fullBtn.title = isFs ? "Exit full screen" : "Full screen";
        setFullscreenIcon(fullBtn, isFs);
        rerenderIfBreakChanged();
      });

      // Auto-wrap on window resize. Debounced so a slow drag doesn't
      // burn cycles, and we only re-render if the computed breakAfter
      // actually changes (sub-column resizes are no-ops).
      let resizeTimer = null;
      on(window, "resize", () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(rerenderIfBreakChanged, 80);
      });

      // Click a row in the hit table OR a rect in the HitMap → scroll
      // that alignment block into view. Click "No N." inside an
      // alignment block → scroll the matching row in the hit table.
      function scrollToBlock(num) {
        const target = wrapper.querySelector(
          `.hhr-block[data-num="${CSS.escape(String(num))}"]`,
        );
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      function scrollToHitRow(num) {
        const target = wrapper.querySelector(
          `.hhr-hit-table tr[data-num="${CSS.escape(String(num))}"]`,
        );
        if (!target) return;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("hhr-row-flash");
        setTimeout(() => target.classList.remove("hhr-row-flash"), 900);
      }
      on(hitsSection, "click", (ev) => {
        // Don't hijack clicks on inline links/buttons — those have
        // their own action (open in new tab, etc.) and should not
        // also scroll the alignment list.
        if (ev.target.closest("a, button")) return;
        // Header click → sort.
        const th = ev.target.closest("th[data-sortkey]");
        if (th) {
          const k = th.dataset.sortkey;
          if (state.hhrSortKey === k) {
            state.hhrSortDir = state.hhrSortDir === "asc" ? "desc" : "asc";
          } else {
            state.hhrSortKey = k;
            state.hhrSortDir = "asc";
          }
          persist();
          rerenderHits();
          return;
        }
        const tr = ev.target.closest("tr[data-num]");
        if (tr) scrollToBlock(tr.dataset.num);
      });
      on(mapSection, "click", (ev) => {
        if (ev.target.closest("a, button")) return;
        const rect = ev.target.closest("[data-num]");
        if (rect) scrollToBlock(rect.dataset.num);
      });
      on(alignmentsSection, "click", (ev) => {
        if (ev.target.closest("a, button")) return;
        const num = ev.target.closest(".hhr-block-num[data-num]");
        if (num) scrollToHitRow(num.dataset.num);
      });

      refreshZoomLabel();
    }

    function applyHhrColor(wrapper) {
      wrapper.dataset.colorOff = state.hhrColorOn ? "false" : "true";
    }

    /**
     * Heuristic: an a3m / a2m / fas where a majority of the first 50
     * headers carry the `[subseq from]` marker that hmmsearch / hhsuite
     * use for template manifests. False for a regular MSA.
     */
    function isTemplatesA3m(viewer) {
      if (!viewer || !Array.isArray(viewer.entries)) return false;
      if (viewer.format !== "a3m" && viewer.format !== "a2m" && viewer.format !== "fas") {
        return false;
      }
      const sample = viewer.entries.slice(0, 50);
      if (sample.length === 0) return false;
      let matches = 0;
      for (const e of sample) {
        if (/\[subseq from\]/i.test(e.name || "")) matches++;
      }
      return matches >= Math.max(2, Math.ceil(sample.length * 0.5));
    }

    /**
     * Parse a templates-style header into structured fields:
     *   "7sch_A/55-703 [subseq from] mol:protein length:720  Exostosin-1"
     *     → { accession: "7sch_A", start: 55, end: 703,
     *         length: 720, description: "Exostosin-1" }
     */
    function parseTemplateName(name) {
      const text = String(name || "");
      const m = /^(\S+?)(?:\/(\d+)-(\d+))?\s+\[subseq from\](?:\s+mol:\S+)?(?:\s+length:(\d+))?\s*(.*)$/i.exec(text);
      if (!m) return null;
      return {
        accession: m[1],
        start: m[2] ? parseInt(m[2], 10) : undefined,
        end: m[3] ? parseInt(m[3], 10) : undefined,
        length: m[4] ? parseInt(m[4], 10) : undefined,
        description: (m[5] || "").trim(),
      };
    }

    /**
     * Per-query coverage HitMap for templates view. Each row's
     * coverage is the [first, last] non-gap residue index of its
     * `matchSeq`. Templates with no aligned residues are skipped.
     */
    function renderTemplatesHitMap(parent, viewer) {
      const matchCols = viewer.matchLen || 0;
      if (!matchCols || !Array.isArray(viewer.entries)) return;
      const items = [];
      for (let i = 0; i < viewer.entries.length; i++) {
        const e = viewer.entries[i];
        const seq = e.matchSeq || "";
        let first = -1;
        let last = -1;
        const lim = Math.min(seq.length, matchCols);
        for (let c = 0; c < lim; c++) {
          const ch = seq.charCodeAt(c);
          // 45 = '-', 46 = '.'
          if (ch !== 45 && ch !== 46) {
            if (first === -1) first = c;
            last = c;
          }
        }
        if (first === -1) continue;
        const num = i + 1;
        const t = parseTemplateName(e.name || "") || null;
        const acc = (t && t.accession) || (e.name || "").split(/\s+/)[0] || `entry ${num}`;
        const desc = (t && t.description) || e.name || "";
        items.push({
          num,
          start: first + 1,
          end: last + 1,
          label: desc ? `${acc} ${desc}` : acc,
          tip:
            `${num}. ${acc}\n` +
            (desc ? `${desc}\n` : "") +
            `Q ${first + 1}–${last + 1}` +
            (t && t.length != null ? ` · template length ${t.length}` : ""),
        });
      }
      renderHitmapSvg(parent, { matchCols, items });
    }

    function renderTemplatesTable(parent, viewer) {
      const tbl = document.createElement("table");
      tbl.className = "msa-templates-table";

      const thead = document.createElement("thead");
      thead.innerHTML =
        "<tr>" +
        "<th class='r'>#</th>" +
        "<th>Accession</th>" +
        "<th class='r'>Range</th>" +
        "<th class='r'>Length</th>" +
        "<th>Description</th>" +
        "</tr>";
      tbl.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (let i = 0; i < viewer.entries.length; i++) {
        const e = viewer.entries[i];
        const t = parseTemplateName(e.name || e.id || "") || {
          accession: e.id || e.name || "",
          description: e.name || "",
        };
        const tr = document.createElement("tr");
        // 1-based num, matches the HitMap rect's data-num so clicks
        // can find this row from either side.
        tr.dataset.num = String(i + 1);

        const numTd = document.createElement("td");
        numTd.className = "r";
        numTd.textContent = String(i + 1);
        tr.appendChild(numTd);

        const accTd = document.createElement("td");
        renderLinkedHeader(accTd, t.accession || "");
        tr.appendChild(accTd);

        const rangeTd = document.createElement("td");
        rangeTd.className = "r";
        rangeTd.textContent =
          t.start != null && t.end != null ? `${t.start}–${t.end}` : "";
        tr.appendChild(rangeTd);

        const lenTd = document.createElement("td");
        lenTd.className = "r";
        lenTd.textContent = t.length != null ? String(t.length) : "";
        tr.appendChild(lenTd);

        const descTd = document.createElement("td");
        descTd.textContent = t.description || "";
        tr.appendChild(descTd);

        tbody.appendChild(tr);
      }
      tbl.appendChild(tbody);
      parent.appendChild(tbl);
    }

    function renderAlignments(parent, hhr, breakAfter) {
      const eff = breakAfter && breakAfter > 0 ? breakAfter : 80;
      for (const al of hhr.alignments) {
        parent.appendChild(renderAlignmentBlock(al, eff));
      }
    }

    /**
     * Decide how many columns each alignment chunk should hold. If
     * the user pinned a value via the input, use that; otherwise fit
     * to the body's clientWidth based on the current zoom font-size.
     *
     * The math: subtract the static columns of `.hhr-line` (label,
     * start, end, three gaps) plus body padding from the available
     * width. What remains is the seq column. Divide by ~0.6 × font-size
     * (a good monospace estimate; Menlo/Monaco are ~0.55, Consolas ~0.6).
     */
    function computeBreakAfter(bodyEl) {
      if (state.breakAfter && state.breakAfter > 0) return state.breakAfter;
      const root =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const labelW = 7 * root;       // .hhr-line grid col 1
      const startW = 2.5 * root;     // .hhr-line grid col 2
      const endW = 2.5 * root;       // .hhr-line grid col 4
      const gaps = 3 * 0.4 * root;   // .hhr-line gap × 3
      const bodyPad = 0.75 * root * 2; // .hhr-body padding-left + right
      const overhead = labelW + startW + endW + gaps + bodyPad + 24; // 24 ≈ scrollbar / safety
      const containerW = (bodyEl && bodyEl.clientWidth) || window.innerWidth;
      const seqW = Math.max(0, containerW - overhead);
      const charW = state.fontPx * 0.6;
      const fit = Math.floor(seqW / Math.max(1, charW));
      return clamp(fit, BREAK_AFTER_MIN, BREAK_AFTER_MAX);
    }

    /**
     * Sortable hit table. The `Hit` column is text (description); the
     * rest are numeric — we coerce sort keys accordingly. Clicking a
     * header toggles ascending → descending → ascending. The active
     * column gets an indicator (▲ ▼).
     */
    function renderHitTable(parent, hhr) {
      const sorted = sortAlignments(hhr.alignments, hhr.hits, state.hhrSortKey, state.hhrSortDir);

      const table = document.createElement("table");
      table.className = "hhr-hit-table";
      const thead = document.createElement("thead");
      const tr = document.createElement("tr");
      const cols = [
        { key: "num", label: "No", cls: "r" },
        { key: "desc", label: "Hit", cls: "" },
        { key: "prob", label: "Prob", cls: "r" },
        { key: "evalue", label: "E-value", cls: "r" },
        { key: "score", label: "Score", cls: "r" },
        { key: "cols", label: "Cols", cls: "r" },
        { key: "qStart", label: "Q range", cls: "r" },
        { key: "tStart", label: "T range", cls: "r" },
      ];
      for (const c of cols) {
        const th = document.createElement("th");
        th.className = c.cls;
        th.dataset.sortkey = c.key;
        const ind = state.hhrSortKey === c.key
          ? (state.hhrSortDir === "asc" ? " ▲" : " ▼")
          : "";
        th.textContent = c.label + ind;
        if (state.hhrSortKey === c.key) th.classList.add("active");
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const al of sorted) {
        const summary = (hhr.hits && hhr.hits.find((h) => h.num === al.num)) || null;
        const row = document.createElement("tr");
        row.dataset.num = String(al.num);
        const desc = (al.description || (summary && summary.hit) || "").slice(0, 80);
        const qRange = `${al.query.start ?? "?"}–${al.query.end ?? "?"}`;
        const tRange = al.template.ref
          ? `${al.template.start ?? "?"}–${al.template.end ?? "?"} (${al.template.ref})`
          : `${al.template.start ?? "?"}–${al.template.end ?? "?"}`;
        const numTd = document.createElement("td");
        numTd.className = "r";
        numTd.textContent = String(al.num);
        const descTd = document.createElement("td");
        renderLinkedHeader(descTd, desc);
        row.appendChild(numTd);
        row.appendChild(descTd);
        const cells = [
          [al.metrics.probab.toFixed(1), "r"],
          [formatExp(al.metrics.evalue), "r"],
          [al.metrics.score.toFixed(1), "r"],
          [String(al.metrics.alignedCols), "r"],
          [qRange, "r"],
          [tRange, "r"],
        ];
        for (const [text, cls] of cells) {
          const td = document.createElement("td");
          if (cls) td.className = cls;
          td.textContent = text;
          row.appendChild(td);
        }
        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      parent.appendChild(table);
    }

    function sortAlignments(alignments, hits, key, dir) {
      const out = alignments.slice();
      const sign = dir === "desc" ? -1 : 1;
      const accessor = sortAccessor(key);
      out.sort((a, b) => {
        const av = accessor(a);
        const bv = accessor(b);
        if (typeof av === "string" || typeof bv === "string") {
          return sign * String(av).localeCompare(String(bv));
        }
        return sign * (av - bv);
      });
      return out;
    }

    function sortAccessor(key) {
      switch (key) {
        case "num":    return (a) => a.num;
        case "desc":   return (a) => (a.description || a.templateName || "").toLowerCase();
        case "prob":   return (a) => a.metrics.probab;
        case "evalue": return (a) => a.metrics.evalue;
        case "score":  return (a) => a.metrics.score;
        case "cols":   return (a) => a.metrics.alignedCols;
        case "qStart": return (a) => a.query.start ?? 0;
        case "tStart": return (a) => a.template.start ?? 0;
        default:       return (a) => a.num;
      }
    }

    /**
     * HitMap — SVG visualization of every hit's coverage along the
     * query. Rows are packed greedily so non-overlapping hits share a
     * row; overlapping hits push down. Each hit's color encodes its
     * probability (red → muted teal as prob falls).
     */
    function renderHitMap(parent, hhr) {
      const matchCols = hhr.header.matchColumns || 0;
      if (!matchCols || hhr.alignments.length === 0) return;
      renderHitmapSvg(parent, {
        matchCols,
        items: hhr.alignments.map((al) => ({
          num: al.num,
          start: al.query.start ?? 1,
          end: al.query.end ?? matchCols,
          color: probColor(al.metrics.probab),
          label: (al.description && al.description.trim()) || al.templateName || "",
          tip:
            `No ${al.num}: ${(al.description || al.templateName || "").slice(0, 60)}\n` +
            `Prob ${al.metrics.probab.toFixed(1)} · E-value ${formatExp(al.metrics.evalue)} · Score ${al.metrics.score.toFixed(1)}\n` +
            `Q ${al.query.start ?? "?"}–${al.query.end ?? "?"}`,
        })),
      });
    }

    /**
     * Generic per-query coverage HitMap. Items are { num, start, end,
     * color?, label?, tip? }. start/end are 1-based query coords.
     * Greedy row-packing; per-rect clipPath so labels never spill.
     * Click on a rect bubbles a click event with `data-num` set; the
     * caller wires its own scroll-to-target handler.
     */
    function renderHitmapSvg(parent, opts) {
      const SVG_NS = "http://www.w3.org/2000/svg";
      const matchCols = opts.matchCols || 0;
      const items = opts.items || [];
      if (!matchCols || items.length === 0) return;

      // Pack rows: greedy first-fit. Sort by start; place each item in
      // the lowest row whose previous end is strictly below its start.
      const sorted = items.slice().sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
      const rowEnds = [];
      const placement = new Map();
      for (const it of sorted) {
        const s = it.start ?? 1;
        const e = it.end ?? matchCols;
        let placed = -1;
        for (let r = 0; r < rowEnds.length; r++) {
          if (rowEnds[r] < s) { placed = r; break; }
        }
        if (placed === -1) { placed = rowEnds.length; rowEnds.push(0); }
        rowEnds[placed] = e;
        placement.set(it.num, placed);
      }

      const rowH = 8;
      const rowGap = 2;
      const margin = { top: 12, right: 8, bottom: 18, left: 8 };
      const width = 800;
      const usable = width - margin.left - margin.right;
      const trackH = rowEnds.length * (rowH + rowGap);
      const height = margin.top + trackH + margin.bottom;

      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "hhr-hitmap");
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label",
        `Hit coverage across query of ${matchCols} match columns`);

      const axis = document.createElementNS(SVG_NS, "line");
      axis.setAttribute("x1", String(margin.left));
      axis.setAttribute("x2", String(margin.left + usable));
      axis.setAttribute("y1", String(margin.top - 2));
      axis.setAttribute("y2", String(margin.top - 2));
      axis.setAttribute("class", "hhr-hitmap-axis");
      svg.appendChild(axis);

      const tickStep = matchCols >= 200 ? 50 : matchCols >= 80 ? 25 : 10;
      for (let c = 0; c <= matchCols; c += tickStep) {
        const x = margin.left + (c / matchCols) * usable;
        const tick = document.createElementNS(SVG_NS, "line");
        tick.setAttribute("x1", String(x));
        tick.setAttribute("x2", String(x));
        tick.setAttribute("y1", String(margin.top - 5));
        tick.setAttribute("y2", String(margin.top - 1));
        tick.setAttribute("class", "hhr-hitmap-tick");
        svg.appendChild(tick);
        const txt = document.createElementNS(SVG_NS, "text");
        txt.setAttribute("x", String(x));
        txt.setAttribute("y", String(margin.top - 7));
        txt.setAttribute("class", "hhr-hitmap-ticklabel");
        txt.setAttribute("text-anchor", "middle");
        txt.textContent = String(c || 1);
        svg.appendChild(txt);
      }

      const LABEL_FONT_PX = 7;
      const charWidthEst = LABEL_FONT_PX * 0.55;
      const clipPrefix = `hm-clip-${Math.floor(Math.random() * 1e6).toString(36)}-`;
      const fallbackColor =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--bio-accent")
          .trim() || "#1f66d1";

      for (const it of items) {
        const s = it.start ?? 1;
        const e = it.end ?? matchCols;
        const rowIdx = placement.get(it.num) ?? 0;
        const x = margin.left + ((s - 1) / matchCols) * usable;
        const w = Math.max(1, ((e - s + 1) / matchCols) * usable);
        const y = margin.top + rowIdx * (rowH + rowGap);

        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", String(x));
        rect.setAttribute("y", String(y));
        rect.setAttribute("width", String(w));
        rect.setAttribute("height", String(rowH));
        rect.setAttribute("rx", "1.5");
        rect.setAttribute("fill", it.color || fallbackColor);
        rect.setAttribute("class", "hhr-hitmap-rect");
        rect.dataset.num = String(it.num);
        if (it.tip) rect.dataset.tip = it.tip;
        svg.appendChild(rect);

        const labelSrc = it.label || "";
        if (labelSrc && w >= charWidthEst * 4 + 4) {
          const clipId = clipPrefix + it.num;
          const clip = document.createElementNS(SVG_NS, "clipPath");
          clip.setAttribute("id", clipId);
          const cr = document.createElementNS(SVG_NS, "rect");
          cr.setAttribute("x", String(x));
          cr.setAttribute("y", String(y));
          cr.setAttribute("width", String(w));
          cr.setAttribute("height", String(rowH));
          clip.appendChild(cr);
          svg.appendChild(clip);

          const txt = document.createElementNS(SVG_NS, "text");
          txt.setAttribute("x", String(x + 3));
          txt.setAttribute("y", String(y + rowH / 2 + 2.5));
          txt.setAttribute("class", "hhr-hitmap-rectlabel");
          txt.setAttribute("clip-path", `url(#${clipId})`);
          txt.textContent = labelSrc.slice(0, 200);
          svg.appendChild(txt);
        }
      }

      parent.appendChild(svg);
    }

    /** Map probability (0..100) to a color: red for high-confidence
     *  hits, fading through orange to muted teal for marginal ones. */
    function probColor(prob) {
      const p = Math.max(0, Math.min(100, prob)) / 100;
      if (p > 0.9) return "#e43d30";
      if (p > 0.7) return "#e8771f";
      if (p > 0.5) return "#d29b00";
      if (p > 0.3) return "#2da44e";
      return "#1f66d1";
    }

    function renderAlignmentBlock(al, breakAfter) {
      const block = document.createElement("div");
      block.className = "hhr-block";
      block.dataset.num = String(al.num);

      const header = document.createElement("div");
      header.className = "hhr-block-header";
      const numSpan = document.createElement("span");
      numSpan.className = "hhr-block-num";
      numSpan.textContent = `No ${al.num}.`;
      // Click → scroll matching row in the hit table into view (the
      // inverse of the existing row-click → block-scroll). Wired by
      // event delegation on alignmentsSection in the parent renderer.
      numSpan.dataset.num = String(al.num);
      numSpan.dataset.tip = `Jump to hit ${al.num} in the table`;
      const descSpan = document.createElement("span");
      descSpan.className = "hhr-block-desc";
      renderLinkedHeader(descSpan, al.description || al.templateName);
      header.appendChild(numSpan);
      header.appendChild(document.createTextNode(" "));
      header.appendChild(descSpan);
      block.appendChild(header);

      const meta = document.createElement("div");
      meta.className = "hhr-block-meta";
      const m = al.metrics;
      const pieces = [
        `Probab=${m.probab.toFixed(2)}`,
        `E-value=${formatExp(m.evalue)}`,
        `Score=${m.score.toFixed(2)}`,
        `Aligned_cols=${m.alignedCols}`,
      ];
      if (m.identities != null) pieces.push(`Identities=${m.identities}%`);
      if (m.similarity != null) pieces.push(`Similarity=${m.similarity}`);
      if (m.templateNeff != null) pieces.push(`Template_Neff=${m.templateNeff}`);
      meta.textContent = pieces.join("  ");
      block.appendChild(meta);

      // Build per-row "lines" from the available tracks. Order mirrors
      // Toolkit's HHpred tab — the most informative tracks go closest
      // to the query/template seqs.
      const lines = [];
      if (al.querySsPred?.seq) lines.push({ label: "Q ss_pred", track: al.querySsPred, kind: "ss" });
      lines.push({ label: `Q ${al.queryName}`, track: al.query, kind: "seq" });
      if (al.queryConsensus?.seq) lines.push({ label: "Q Consensus", track: al.queryConsensus, kind: "consensus" });
      if (al.agree) lines.push({ label: "", track: { seq: al.agree }, kind: "agree" });
      if (al.templateConsensus?.seq) lines.push({ label: "T Consensus", track: al.templateConsensus, kind: "consensus" });
      lines.push({ label: `T ${al.templateName}`, track: al.template, kind: "seq" });
      if (al.templateSsDssp?.seq) lines.push({ label: "T ss_dssp", track: al.templateSsDssp, kind: "ss" });
      if (al.templateSsPred?.seq) lines.push({ label: "T ss_pred", track: al.templateSsPred, kind: "ss" });
      if (al.confidence) lines.push({ label: "Confidence", track: { seq: al.confidence }, kind: "confidence" });
      if (al.pp) lines.push({ label: "PP", track: { seq: al.pp }, kind: "pp" });

      // Wrap by breakAfter columns. A "chunk" is a block of breakAfter
      // columns of every track stacked vertically. Tracks of unequal
      // length pad with spaces so columns stay aligned within a chunk.
      const totalCols = lines.reduce((m, l) => Math.max(m, l.track.seq.length), 0);

      // Pre-compute residue counts per track for the start/end labels.
      // For each "seq" track, the start increments by the number of
      // non-gap residues consumed in prior chunks.
      const seqResidueCounts = lines.map((l) =>
        l.kind === "seq" || l.kind === "consensus"
          ? new Int32Array(Math.ceil(totalCols / breakAfter) + 1)
          : null,
      );
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const counts = seqResidueCounts[li];
        if (!counts) continue;
        let cursor = 0;
        let chunkIdx = 0;
        const seq = line.track.seq;
        for (let c = 0; c < seq.length; c++) {
          if (c > 0 && c % breakAfter === 0) {
            counts[++chunkIdx] = cursor;
          }
          const ch = seq[c];
          if (ch !== "-" && ch !== ".") cursor++;
        }
        // Final cursor for the last chunk's end-position lookup.
        counts[chunkIdx + 1] = cursor;
      }

      for (let off = 0; off < totalCols; off += breakAfter) {
        const chunk = document.createElement("div");
        chunk.className = "hhr-chunk";
        const chunkIdx = Math.floor(off / breakAfter);

        for (let li = 0; li < lines.length; li++) {
          const line = lines[li];
          const seq = line.track.seq;
          const slice = seq.slice(off, off + breakAfter);
          if (line.kind !== "seq" && !slice) continue;

          const row = document.createElement("div");
          row.className = `hhr-line hhr-line-${line.kind}`;

          const labelEl = document.createElement("span");
          labelEl.className = "hhr-label";
          labelEl.textContent = line.label;
          row.appendChild(labelEl);

          const startEl = document.createElement("span");
          startEl.className = "hhr-pos hhr-start";
          if (line.kind === "seq" || line.kind === "consensus") {
            const baseStart = line.track.start;
            const counts = seqResidueCounts[li];
            startEl.textContent = baseStart != null && counts
              ? String(baseStart + counts[chunkIdx])
              : "";
          } else {
            startEl.textContent = "";
          }
          row.appendChild(startEl);

          const seqEl = document.createElement("span");
          seqEl.className = "hhr-seq";
          renderHhrSeqInline(seqEl, slice, line.kind);
          row.appendChild(seqEl);

          const endEl = document.createElement("span");
          endEl.className = "hhr-pos hhr-end";
          if (line.kind === "seq" || line.kind === "consensus") {
            const baseStart = line.track.start;
            const counts = seqResidueCounts[li];
            const endResidueIdx =
              baseStart != null && counts
                ? baseStart + counts[chunkIdx + 1] - 1
                : null;
            endEl.textContent =
              endResidueIdx != null && endResidueIdx >= 0
                ? String(endResidueIdx)
                : "";
          } else {
            endEl.textContent = "";
          }
          row.appendChild(endEl);

          chunk.appendChild(row);
        }
        block.appendChild(chunk);
      }

      return block;
    }

    function renderHhrSeqInline(container, slice, kind) {
      const fragment = document.createDocumentFragment();
      // ss tracks: each char = h/H/e/E/c/C → distinct color via msa-ss-* class.
      // agree / confidence / pp: plain text in a single span.
      // seq / consensus: per-residue spans (palette, hover, etc. apply).
      if (kind === "seq" || kind === "consensus") {
        for (let i = 0; i < slice.length; i++) {
          const ch = slice[i];
          const cell = document.createElement("span");
          cell.className = `msa-residue msa-aa-${residueClass(ch)}`;
          cell.textContent = ch;
          const code = ch.toUpperCase();
          if (code >= "A" && code <= "Z") cell.dataset.aa = code;
          fragment.appendChild(cell);
        }
      } else if (kind === "ss") {
        for (let i = 0; i < slice.length; i++) {
          const ch = slice[i];
          const cell = document.createElement("span");
          cell.className = `msa-residue msa-ss-${ssClass(ch)}`;
          cell.textContent = ch;
          fragment.appendChild(cell);
        }
      } else {
        // agree / confidence / pp — plain monospace block
        const span = document.createElement("span");
        span.className = `hhr-plain hhr-plain-${kind}`;
        span.textContent = slice;
        fragment.appendChild(span);
      }
      container.appendChild(fragment);
    }

    function ssClass(ch) {
      const c = String(ch).toUpperCase();
      if (c === "H") return "h";       // alpha helix
      if (c === "E") return "e";       // beta strand
      if (c === "C") return "c";       // coil
      if (c === "G") return "g";       // 3_10 helix
      if (c === "T") return "t";       // turn
      if (c === "S") return "s";       // bend
      if (c === "B") return "b";       // beta bridge
      if (c === "I") return "i";       // pi helix
      return "other";
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
      ));
    }

    /**
     * Render a header/description string into `target` with the leading
     * accession turned into an external link if the resolver knows it.
     * "2DFB_A Endo-1,4-beta-xylanase…" → <a>2DFB_A</a> + " Endo-1,4-…"
     *
     * Uses createElement (not innerHTML) so URL/label values can't
     * inject markup even if a custom resolver returns garbage.
     */
    function renderLinkedHeader(target, text, opts2 = {}) {
      target.textContent = "";
      if (!text) return;
      const m = /^(\S+)(\s.*)?$/.exec(text);
      const head = m ? m[1] : text;
      const tail = m && m[2] ? m[2] : "";
      const link = linkResolver(head);
      if (link && link.url) {
        const a = document.createElement("a");
        a.className = "msa-dblink";
        a.href = link.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = head;
        a.dataset.tip = `${link.label || "open"} → ${link.url}`;
        target.appendChild(a);
      } else {
        const span = document.createElement("span");
        span.textContent = head;
        target.appendChild(span);
      }
      if (tail) {
        const rest = document.createElement("span");
        rest.textContent = tail;
        target.appendChild(rest);
      }
    }

    function formatExp(n) {
      if (!isFinite(n)) return String(n);
      if (n === 0) return "0";
      if (Math.abs(n) >= 0.001 && Math.abs(n) < 1000) return n.toPrecision(3);
      return n.toExponential(1);
    }

    function applyFont(wrapper) {
      wrapper.style.setProperty("--msa-font-size", `${state.fontPx}px`);
    }
    function applyHistHeight(wrapper) {
      wrapper.style.setProperty("--msa-hist-height", `${state.histPx}px`);
    }
    function applyLabelWidth(wrapper) {
      wrapper.style.setProperty("--msa-label-width", `${state.labelWidth}px`);
      wrapper.dataset.labelCollapsed = state.labelWidth === 0 ? "true" : "false";
    }
    function applyPalette(wrapper) {
      wrapper.dataset.palette = state.palette;
    }

    function attachLabelResize(handle, wrapper) {
      on(handle, "mousedown", (ev) => {
        ev.preventDefault();
        const startX = ev.clientX;
        const startW = state.labelWidth;
        handle.classList.add("dragging");
        const prevCursor = document.body.style.cursor;
        const prevSelect = document.body.style.userSelect;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";

        function onMove(e) {
          const next = clamp(startW + (e.clientX - startX), LABEL_MIN, LABEL_MAX);
          if (next === state.labelWidth) return;
          state.labelWidth = next;
          applyLabelWidth(wrapper);
        }
        function onUp() {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          handle.classList.remove("dragging");
          document.body.style.cursor = prevCursor;
          document.body.style.userSelect = prevSelect;
          if (state.labelWidth > 0 && state.labelWidth < LABEL_HIDE_THRESHOLD) {
            state.labelWidth = 0;
            applyLabelWidth(wrapper);
          }
          persist();
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
      on(handle, "dblclick", () => {
        state.labelWidth = LABEL_DEFAULT;
        applyLabelWidth(wrapper);
        persist();
      });
    }

    function attachHistResize(handle, wrapper) {
      on(handle, "mousedown", (ev) => {
        ev.preventDefault();
        const startY = ev.clientY;
        const startH = state.histPx;
        handle.classList.add("dragging");
        const prevCursor = document.body.style.cursor;
        const prevSelect = document.body.style.userSelect;
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";

        function onMove(e) {
          const next = clamp(startH + (e.clientY - startY), HIST_MIN, HIST_MAX);
          if (next === state.histPx) return;
          state.histPx = next;
          applyHistHeight(wrapper);
        }
        function onUp() {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          handle.classList.remove("dragging");
          document.body.style.cursor = prevCursor;
          document.body.style.userSelect = prevSelect;
          persist();
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }

    // ---- pure helpers (no per-instance state) ----

    function appendStat(parent, key, value, definition) {
      const pill = document.createElement("span");
      pill.className = "msa-stat";
      pill.dataset.tip = `${key} — ${definition}`;
      const k = document.createElement("span");
      k.className = "msa-stat-k";
      k.textContent = key;
      const v = document.createElement("span");
      v.className = "msa-stat-v";
      v.textContent = value;
      pill.appendChild(k);
      pill.appendChild(v);
      parent.appendChild(pill);
    }

    function makeBtn(cls, text) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      if (text) b.textContent = text;
      return b;
    }

    function meanHammingToQuery(entries, query, matchLen) {
      if (entries.length <= 1 || matchLen === 0) return 0;
      const q = query.matchSeq;
      let total = 0;
      let count = 0;
      for (const e of entries) {
        if (e === query) continue;
        const s = e.matchSeq;
        const lim = Math.min(matchLen, q.length, s.length);
        let d = 0;
        for (let i = 0; i < lim; i++) {
          if (q.charCodeAt(i) !== s.charCodeAt(i)) d++;
        }
        total += d;
        count++;
      }
      return count > 0 ? total / count : 0;
    }

    // Reuses per-column entropy from `columnInfo` so we don't re-walk the
    // entries × columns matrix. Restricted to columns where the query has
    // a residue (HHsuite/HHblits convention).
    function computeNeff(columnInfo, query) {
      if (!columnInfo || columnInfo.length === 0) return 1;
      const qSeq = query.matchSeq;
      let sumH = 0;
      let L = 0;
      for (let i = 0; i < columnInfo.length; i++) {
        const qch = qSeq.charCodeAt(i);
        if (qch === 45 || qch === 46) continue;
        L++;
        const col = columnInfo[i];
        if (col && col.nonGap > 0) sumH += col.entropy;
      }
      return L > 0 ? Math.exp(sumH / L) : 1;
    }

    function computeCoverage(entries, matchLen) {
      const counts = new Array(matchLen).fill(0);
      for (const e of entries) {
        const seq = e.matchSeq || "";
        const lim = Math.min(seq.length, matchLen);
        for (let i = 0; i < lim; i++) {
          const ch = seq.charCodeAt(i);
          if (ch !== 45 && ch !== 46) counts[i]++;
        }
      }
      const n = entries.length || 1;
      return counts.map((c) => c / n);
    }

    function computeColumnInfo(viewer, query) {
      const L = viewer.matchLen;
      const N = viewer.entries.length;
      const info = new Array(L);
      const counts = new Map();
      const aaCounts = new Int32Array(20);
      const qSeq = query.matchSeq;
      for (let i = 0; i < L; i++) {
        counts.clear();
        aaCounts.fill(0);
        let nonGap = 0;
        let aaTotal = 0;
        for (const e of viewer.entries) {
          const ch = e.matchSeq[i];
          if (ch && ch !== "-" && ch !== ".") {
            nonGap++;
            counts.set(ch, (counts.get(ch) || 0) + 1);
            const upper = ch >= "a" && ch <= "z" ? ch.toUpperCase() : ch;
            const idx = BLOSUM62_INDEX.get(upper);
            if (idx !== undefined) {
              aaCounts[idx]++;
              aaTotal++;
            }
          }
        }
        let entropy = 0;
        if (nonGap > 0) {
          for (const v of counts.values()) {
            const p = v / nonGap;
            entropy -= p * Math.log(p);
          }
        }
        // Mean BLOSUM62 sum-of-pairs over recognized AAs (gaps + X/B/Z/U/O ignored).
        let blosum = null;
        if (aaTotal >= 2) {
          let T = 0;
          let diag = 0;
          for (let a = 0; a < 20; a++) {
            const ca = aaCounts[a];
            if (ca === 0) continue;
            const row = BLOSUM62_ROWS[a];
            diag += ca * row[a];
            for (let b = 0; b < 20; b++) {
              const cb = aaCounts[b];
              if (cb === 0) continue;
              T += ca * cb * row[b];
            }
          }
          const sumPairs = (T - diag) / 2;
          const nPairs = (aaTotal * (aaTotal - 1)) / 2;
          blosum = sumPairs / nPairs;
        }
        const consEntropy = nonGap > 0 ? 1 - entropy / LN20 : null;
        const consBlosum = blosum == null
          ? null
          : Math.max(0, Math.min(1, (blosum - BLOSUM62_NORM_LO) / (BLOSUM62_NORM_HI - BLOSUM62_NORM_LO)));
        const top = Array.from(counts.entries())
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .slice(0, 5)
          .map(([res, count]) => ({ res, count }));
        info[i] = {
          queryRes: qSeq[i] || "-",
          total: N,
          nonGap,
          entropy,
          consEntropy,
          blosum,
          consBlosum,
          top,
        };
      }
      return info;
    }

    function computeInsertWidths(entries, matchLen) {
      const widths = new Array(matchLen + 1).fill(0);
      for (const e of entries) {
        const inserts = e.inserts || {};
        for (const k of Object.keys(inserts)) {
          const idx = Number(k);
          const len = inserts[k].length;
          if (len > widths[idx]) widths[idx] = len;
        }
      }
      return widths;
    }

    function renderRow(parent, entry, extraClass, insertWidths) {
      const row = document.createElement("div");
      row.className = "static-msa-row";
      if (extraClass) row.classList.add(extraClass);
      const label = document.createElement("span");
      label.className = "static-msa-label";
      const nameText = entry.name || entry.id || "";
      renderLinkedHeader(label, nameText);
      label.title = nameText;
      const body = document.createElement("span");
      body.className = "static-msa-seq";
      renderSequence(body, entry, insertWidths);
      row.appendChild(label);
      row.appendChild(body);
      parent.appendChild(row);
    }

    function coverColorTip(mode) {
      const cycleLine =
        mode === "off"     ? "click → entropy → BLOSUM62 → off" :
        mode === "entropy" ? "click → BLOSUM62 → off → entropy" :
                             "click → off → entropy → BLOSUM62";
      if (mode === "off") {
        return (
          "Coverage bars are uncolored.\n" +
          "Bar height = non-gap residue fraction per match column.\n" +
          cycleLine
        );
      }
      if (mode === "entropy") {
        return (
          "Color: per-column conservation = 1 − H/ln(20)\n" +
          "where H = Shannon entropy in nats (gaps excluded).\n" +
          "0 = uniform (20 residues equally likely); 1 = single residue dominates.\n" +
          cycleLine
        );
      }
      // BLOSUM
      return (
        "Color: per-column mean BLOSUM62 sum-of-pairs (SP)\n" +
        "SP = (Σₐ Σ_b nₐ·n_b·B[a,b] − Σₐ nₐ·B[a,a]) / (2 · N(N−1)/2)\n" +
        "  N = recognized AAs in the column (gaps + X/B/Z/U/O excluded);\n" +
        "  B = BLOSUM62 substitution matrix.\n" +
        "Normalized for the ramp: clamp((SP + 2) / 8, 0, 1).\n" +
        cycleLine
      );
    }

    function renderHistogramRow(parent, coverage, insertWidths, total, wrapper,
                                columnInfo, colorMode, onCycleColor) {
      const row = document.createElement("div");
      row.className = "static-msa-row static-msa-histogram";

      const label = document.createElement("span");
      label.className = "static-msa-label";
      label.title =
        `Non-gap residue frequency per match column (${total} sequences)\n` +
        `Drag bottom edge to resize`;

      // Inline toggle. Cycles off → entropy → BLOSUM. Lives in the row's
      // label slot so the top toolbar stays uncluttered.
      const colorBtn = document.createElement("button");
      colorBtn.type = "button";
      colorBtn.className = "msa-histogram-color-btn";
      colorBtn.dataset.colorMode = colorMode;
      colorBtn.textContent =
        colorMode === "blosum" ? "BLOSUM ↻" :
        colorMode === "entropy" ? "entropy ↻" : "coverage ↻";
      colorBtn.setAttribute("aria-pressed", String(colorMode !== "off"));
      colorBtn.dataset.tip = coverColorTip(colorMode);
      colorBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (typeof onCycleColor === "function") onCycleColor();
      });
      label.appendChild(colorBtn);

      const useColor = colorMode !== "off" && Array.isArray(columnInfo);
      const colorKey = colorMode === "blosum" ? "consBlosum" : "consEntropy";

      const body = document.createElement("span");
      body.className = "static-msa-seq";
      const fragment = document.createDocumentFragment();
      const consAt = (i) => {
        if (!useColor) return null;
        const c = columnInfo[i];
        if (!c) return null;
        const v = c[colorKey];
        return typeof v === "number" ? v : null;
      };
      if (insertWidths) {
        emitInsertGap(fragment, insertWidths[0] || 0);
        for (let i = 0; i < coverage.length; i++) {
          emitBar(fragment, coverage[i], total, i, consAt(i));
          emitInsertGap(fragment, insertWidths[i + 1] || 0);
        }
      } else {
        for (let i = 0; i < coverage.length; i++) emitBar(fragment, coverage[i], total, i, consAt(i));
      }
      body.appendChild(fragment);

      const resizer = document.createElement("div");
      resizer.className = "msa-histogram-resize";
      resizer.title = "Drag to resize coverage row";
      attachHistResize(resizer, wrapper);

      row.appendChild(label);
      row.appendChild(body);
      row.appendChild(resizer);
      parent.appendChild(row);
    }

    function renderRulerRow(parent, matchLen, insertWidths) {
      const row = document.createElement("div");
      row.className = "static-msa-row static-msa-ruler";
      const label = document.createElement("span");
      label.className = "static-msa-label";
      const body = document.createElement("span");
      body.className = "static-msa-seq";

      const cells = new Array(matchLen).fill(" ");
      const ticks = new Set();
      for (let i = 9; i < matchLen; i += 10) {
        ticks.add(i);
        const num = String(i + 1);
        for (let j = 0; j < num.length; j++) {
          const pos = i - num.length + 1 + j;
          if (pos >= 0 && pos < matchLen) cells[pos] = num[j];
        }
      }

      const fragment = document.createDocumentFragment();
      if (insertWidths) {
        emitRulerInsertGap(fragment, insertWidths[0] || 0);
        for (let i = 0; i < matchLen; i++) {
          emitRulerCell(fragment, cells[i], ticks.has(i));
          emitRulerInsertGap(fragment, insertWidths[i + 1] || 0);
        }
      } else {
        for (let i = 0; i < matchLen; i++) emitRulerCell(fragment, cells[i], ticks.has(i));
      }
      body.appendChild(fragment);
      row.appendChild(label);
      row.appendChild(body);
      parent.appendChild(row);
    }

    function emitRulerCell(parent, ch, isTick) {
      const cell = document.createElement("span");
      cell.className = isTick ? "msa-ruler-cell msa-ruler-tick" : "msa-ruler-cell";
      cell.textContent = ch;
      parent.appendChild(cell);
    }

    function emitRulerInsertGap(parent, width) {
      if (width <= 0) return;
      const cell = document.createElement("span");
      cell.className = "msa-ruler-cell msa-ruler-insert";
      cell.style.width = `${width}ch`;
      parent.appendChild(cell);
    }

    function emitBar(parent, frac, total, colIdx, cons) {
      const cell = document.createElement("span");
      cell.className = "msa-histogram-cell";
      if (colIdx != null) cell.dataset.col = String(colIdx);
      const bar = document.createElement("span");
      bar.className = "msa-histogram-bar";
      bar.style.height = frac > 0 ? `max(1px, ${(frac * 100).toFixed(2)}%)` : "0";
      // Conservation tint: light blue at low conservation, saturated blue
      // at high. Alpha runs 0.25 → 0.9 so even uniform columns stay
      // visible against the panel background.
      if (cons != null) {
        const a = 0.25 + 0.65 * cons;
        bar.style.background = `rgba(70, 130, 230, ${a.toFixed(3)})`;
        bar.style.opacity = "1";
      }
      cell.appendChild(bar);
      parent.appendChild(cell);
    }

    function emitInsertGap(parent, width) {
      if (width <= 0) return;
      const cell = document.createElement("span");
      cell.className = "msa-histogram-cell msa-histogram-insert";
      cell.style.width = `${width}ch`;
      parent.appendChild(cell);
    }

    function renderSequence(container, entry, insertWidths) {
      const fragment = document.createDocumentFragment();
      const matchSeq = entry.matchSeq || "";
      const inserts = entry.inserts || {};
      if (insertWidths) {
        emitInsert(fragment, inserts[0] || "", insertWidths[0]);
        for (let i = 0; i < matchSeq.length; i++) {
          emitMatch(fragment, matchSeq[i], i);
          emitInsert(fragment, inserts[i + 1] || "", insertWidths[i + 1] || 0);
        }
      } else {
        for (let i = 0; i < matchSeq.length; i++) emitMatch(fragment, matchSeq[i], i);
      }
      container.appendChild(fragment);
    }

    function emitMatch(fragment, ch, colIdx) {
      const cell = document.createElement("span");
      cell.className = `msa-residue msa-aa-${residueClass(ch)}`;
      cell.textContent = ch;
      const code = String(ch).toUpperCase();
      if (code >= "A" && code <= "Z") cell.dataset.aa = code;
      if (colIdx != null) cell.dataset.col = String(colIdx);
      fragment.appendChild(cell);
    }

    function emitInsert(fragment, text, width) {
      if (width <= 0) return;
      for (const ch of text) {
        const cell = document.createElement("span");
        cell.className = `msa-residue msa-aa-${residueClass(ch)} msa-insert`;
        cell.textContent = ch;
        const code = String(ch).toUpperCase();
        if (code >= "A" && code <= "Z") cell.dataset.aa = code;
        fragment.appendChild(cell);
      }
      const pad = width - text.length;
      if (pad > 0) {
        const padCell = document.createElement("span");
        padCell.className = "msa-residue msa-aa-gap msa-insert msa-insert-pad";
        padCell.textContent = ".".repeat(pad);
        padCell.style.width = `${pad}ch`;
        fragment.appendChild(padCell);
      }
    }

    function residueClass(residue) {
      switch (String(residue).toUpperCase()) {
        case "A": case "I": case "L": case "M":
        case "F": case "W": case "V":
          return "hydrophobic";
        case "D": case "E": return "acidic";
        case "K": case "R": return "basic";
        case "H": case "Y": return "aromatic";
        case "S": case "T": case "N": case "Q": return "polar";
        case "C": return "cysteine";
        case "G": return "glycine";
        case "P": return "proline";
        case "-": case ".": return "gap";
        default: return "other";
      }
    }

    async function toggleFullscreen(wrapper) {
      if (document.fullscreenElement === wrapper) {
        await document.exitFullscreen();
      } else if (wrapper.requestFullscreen) {
        await wrapper.requestFullscreen();
      }
    }

    function setFullscreenIcon(button, isFs) {
      button.innerHTML = isFs
        ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5V3h2M11 3h2v2M13 11v2h-2M5 13H3v-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
        : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3v3M10 3h3v3M13 10v3h-3M3 10v3h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    }

    return { load, showError, destroy };
  }

  if (typeof window !== "undefined") {
    window.MsaViewer = { create };
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { create };
  }
})();
