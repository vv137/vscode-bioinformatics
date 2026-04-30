import * as vscode from "vscode";
import { MsaViewerProvider } from "./viewer/provider";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MsaViewerProvider.viewType,
      new MsaViewerProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bioinformatics.msa.openViewer", async () => {
      const uri = activeUri();
      if (!uri) {
        vscode.window.showInformationMessage("No active file to open in the MSA viewer.");
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        MsaViewerProvider.viewType,
      );
    }),
    vscode.commands.registerCommand("bioinformatics.msa.openSource", async () => {
      const uri = activeUri();
      if (!uri) return;
      await vscode.commands.executeCommand("vscode.openWith", uri, "default");
    }),
  );
}

export function deactivate(): void {
  // nothing to clean up
}

function activeUri(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) return editor.document.uri;
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input as { uri?: vscode.Uri } | undefined;
  return input?.uri;
}
