import * as vscode from "vscode";
import { parseFastaLike } from "../parsers/fasta";
import { parseStockholm } from "../parsers/stockholm";
import { parseClustal } from "../parsers/clustal";
import { parsePsi } from "../parsers/psi";
import { parseHhr } from "../parsers/hhr";
import { projectToViewer } from "../parsers/project";
import { formatFromContent, formatFromPath } from "../parsers/detect";
import { Msa, MsaFormat, ViewerPayload } from "../parsers/types";
import { FromExtension, FromWebview } from "./messages";

export class MsaViewerProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "bioinformatics.msaViewer";

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): void {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    webviewPanel.webview.html = this.htmlFor(webviewPanel.webview);

    const post = (msg: FromExtension) => webviewPanel.webview.postMessage(msg);

    const send = () => {
      try {
        const viewer = parseDocument(document);
        post({ type: "load", payload: viewer });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        post({ type: "error", message });
      }
    };

    const sub = webviewPanel.webview.onDidReceiveMessage((msg: FromWebview) => {
      if (msg.type === "ready") send();
      else if (msg.type === "fileDropped") {
        try {
          post({ type: "load", payload: parseDropped(msg.name, msg.content) });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          post({ type: "error", message });
        }
      } else if (msg.type === "openPdb") {
        openPdbInVsCode(this.context, msg.id).catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Open PDB ${msg.id}: ${message}`);
        });
      }
    });

    const watcher = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) send();
    });

    webviewPanel.onDidDispose(() => {
      sub.dispose();
      watcher.dispose();
    });
  }

  private htmlFor(webview: vscode.Webview): string {
    const mediaUri = (name: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "media", name),
      );
    const cssUri = mediaUri("viewer.css");
    const moduleUri = mediaUri("viewer.module.js");
    const adapterUri = mediaUri("viewer.adapter.js");
    const nonce = newNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    // Two scripts: the pure module exposes window.MsaViewer; the adapter
    // wires it to the VS Code webview API. Same nonce on both. The module
    // owns its error UI now, so no <div id="msa-error"> here.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>MSA Viewer</title>
</head>
<body>
  <div id="msa-viewer-container"></div>
  <script nonce="${nonce}" src="${moduleUri}"></script>
  <script nonce="${nonce}" src="${adapterUri}"></script>
</body>
</html>`;
  }
}

function parseDocument(document: vscode.TextDocument): ViewerPayload {
  return parseTextByName(document.uri.fsPath, document.getText());
}

/** Parse content the user dropped onto the webview. Same dispatch as
 *  parseDocument, but driven by the dropped filename rather than the
 *  current document URI — so dropping `foo.hhr` while a `.a3m` is
 *  open still routes to the pairwise viewer. */
function parseDropped(name: string, content: string): ViewerPayload {
  return parseTextByName(name, content);
}

function parseTextByName(name: string, text: string): ViewerPayload {
  if (/\.hhr$/i.test(name)) {
    return { kind: "pairwise", hhr: parseHhr(text) };
  }
  const format = resolveFormat(name, text);
  const msa = parseByFormat(text, format);
  return { kind: "msa", viewer: projectToViewer(msa) };
}

function resolveFormat(filePath: string, text: string): MsaFormat {
  return formatFromPath(filePath) ?? formatFromContent(text) ?? "fas";
}

function parseByFormat(text: string, format: MsaFormat): Msa {
  switch (format) {
    case "fas":
    case "a2m":
    case "a3m":
      return parseFastaLike(text, format);
    case "sto":
      return parseStockholm(text);
    case "clu":
      return parseClustal(text);
    case "psi":
      return parsePsi(text);
  }
}

function newNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * Download a PDB file from RCSB (https://files.rcsb.org/download/<id>.pdb)
 * into the extension's global storage directory and open it in VS Code.
 *
 * Any extension that registers a custom editor for `.pdb` (a structure
 * viewer) will pick it up automatically; otherwise it falls back to the
 * default text editor — still useful for inspecting raw atom records.
 *
 * Files are cached under globalStorage by uppercase ID, so re-opening a
 * structure is instant after the first download.
 */
async function openPdbInVsCode(
  context: vscode.ExtensionContext,
  rawId: string,
): Promise<void> {
  const id = String(rawId).trim().toUpperCase();
  if (!/^[0-9][A-Z0-9]{3}$/.test(id)) {
    throw new Error(`Not a valid PDB ID: ${rawId}`);
  }
  const dir = vscode.Uri.joinPath(context.globalStorageUri, "pdb");
  await vscode.workspace.fs.createDirectory(dir);
  const file = vscode.Uri.joinPath(dir, `${id}.pdb`);

  // Cache: skip the download if we already have a non-empty file.
  let cached = false;
  try {
    const stat = await vscode.workspace.fs.stat(file);
    if (stat.size > 0) cached = true;
  } catch {
    /* not cached */
  }

  if (!cached) {
    const url = `https://files.rcsb.org/download/${id}.pdb`;
    const res = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Fetching PDB ${id}…`,
        cancellable: false,
      },
      async () => fetch(url),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const text = await res.text();
    if (!text || /^<\?xml/i.test(text)) {
      throw new Error(`Unexpected response for ${id}`);
    }
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
  }
  await vscode.commands.executeCommand("vscode.open", file);
}
