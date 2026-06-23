const vscode = require("vscode");
const { getBrowserUrls, stopServer } = require("./server-manager.cjs");
const { runSelfCheck } = require("./self-check.cjs");

async function openBrowser(context, target = "root") {
  const { externalUrl } = await getBrowserUrls(vscode, context, target);

  await vscode.env.openExternal(vscode.Uri.parse(externalUrl));
  vscode.window.setStatusBarMessage("Codex Session Browser opened.", 4000);
  return externalUrl;
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("codexSessionRenderer.openBrowser", async () => {
      try {
        await openBrowser(context, "root");
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexSessionRenderer.openLatestPreview", async () => {
      try {
        await openBrowser(context, "latest");
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexSessionRenderer.copyBrowserUrl", async () => {
      try {
        const { externalUrl } = await getBrowserUrls(vscode, context, "root");
        await vscode.env.clipboard.writeText(externalUrl);
        vscode.window.showInformationMessage(`Copied ${externalUrl}`);
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexSessionRenderer.stopServer", async () => {
      try {
        const stopped = await stopServer();
        if (stopped) {
          vscode.window.showInformationMessage("Codex Session Browser stopped.");
        } else {
          vscode.window.showInformationMessage("Codex Session Browser is not running.");
        }
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexSessionRenderer.runSelfCheck", async () => {
      try {
        await runSelfCheck(vscode, context);
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })
  );

  context.subscriptions.push({
    dispose() {
      stopServer().catch(() => {});
    }
  });
}

function deactivate() {
  return stopServer().catch(() => {});
}

module.exports = {
  activate,
  deactivate
};
