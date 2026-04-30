// VS Code adapter for the pure MSA viewer module.
//
//   1. Wraps webview.getState/setState in a Storage-shaped object
//      so the module can persist UI state without knowing about VS Code.
//   2. Bridges the extension <-> webview postMessage protocol:
//        host posts {type:'load', payload}        → instance.load(payload)
//        host posts {type:'error', message}       → instance.showError(...)
//      and we acknowledge readiness with {type:'ready'} on init.
//
// The pure renderer lives in viewer.module.js and exposes window.MsaViewer.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const storage = {
    getItem: () => {
      const s = vscode.getState();
      return s == null ? null : JSON.stringify(s);
    },
    setItem: (_k, value) => {
      try { vscode.setState(JSON.parse(value)); } catch { /* ignore */ }
    },
    removeItem: () => vscode.setState(null),
  };

  const inst = window.MsaViewer.create({
    container: document.getElementById("msa-viewer-container"),
    storage,
    storageKey: "msa",
    // Drag-and-drop bridge: read the file's text in the webview, then
    // ship name + content to the extension. The extension parses with
    // the same TS parsers it uses for opened documents and replies
    // with {type:'load', payload}, which we already handle below.
    onFileDrop: async (file) => {
      const content = await file.text();
      vscode.postMessage({
        type: "fileDropped",
        name: file.name,
        content,
      });
    },
    // The "code" button next to PDB links asks VS Code to download
    // the .pdb from RCSB and open it in this editor. Any installed
    // structure-viewer extension that registers a custom editor for
    // .pdb will pick it up; otherwise it opens as text.
    onPdbOpen: (pdbId) => {
      vscode.postMessage({ type: "openPdb", id: pdbId });
    },
  });

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === "load") inst.load(msg.payload);
    else if (msg.type === "error") inst.showError(msg.message);
  });

  vscode.postMessage({ type: "ready" });
})();
