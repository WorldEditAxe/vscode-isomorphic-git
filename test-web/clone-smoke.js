const vscode = require("vscode");

async function exists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

exports.run = async function (_testRoot, callback) {
  try {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error("Expected a workspace folder");
    }

    const originalWorkspaceFolders = vscode.workspace.workspaceFolders.length;
    const dirName = `clone-smoke-${Date.now()}`;
    const rootUri = vscode.Uri.revive(await timeout(
      vscode.commands.executeCommand("isomorphic-git.clone", {
        url: "https://github.com/octocat/Hello-World.git",
        dirName,
        depth: 1,
        openAfterClone: false,
      }),
      60000,
      "Timed out waiting for clone"
    ));

    if (
      !rootUri ||
      rootUri.scheme !== "vscode-userdata" ||
      !rootUri.path.startsWith("/isomorphic-git/")
    ) {
      throw new Error("Clone should use VS Code's persistent userdata filesystem");
    }

    const configUri = vscode.Uri.joinPath(rootUri, ".git", "config");
    if (!(await exists(configUri))) {
      throw new Error(`${configUri.toString()} was not created`);
    }
    if (vscode.workspace.workspaceFolders.length !== originalWorkspaceFolders) {
      throw new Error("Clone should not add the cloned repository as a workspace folder");
    }

    callback(undefined, 0);
  } catch (error) {
    callback(error);
  }
};

function timeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
