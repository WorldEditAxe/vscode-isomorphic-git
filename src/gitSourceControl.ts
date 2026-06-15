import * as git from "isomorphic-git";
import * as path from "path";
import * as vscode from "vscode";
import { FileSystem } from "./fs";
import { GitRepository, GitResource } from "./gitRepository";

export class GitSourceControl implements vscode.Disposable {
  public readonly scm: vscode.SourceControl;
  private readonly repository: GitRepository;
  private readonly indexGroup: vscode.SourceControlResourceGroup;
  private readonly workingTreeGroup: vscode.SourceControlResourceGroup;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    rootUri: vscode.Uri,
    private readonly fs: FileSystem
  ) {
    this.repository = new GitRepository(rootUri, fs);
    this.scm = vscode.scm.createSourceControl(
      "isomorphic-git",
      "isomorphic-git",
      rootUri
    );
    this.indexGroup = this.scm.createResourceGroup("index", "Staged Changes");
    this.workingTreeGroup = this.scm.createResourceGroup(
      "workingTree",
      "Changes"
    );
    this.scm.quickDiffProvider = this.repository;
    this.scm.inputBox.placeholder = "Message to commit";
    this.scm.acceptInputCommand = {
      command: "isomorphic-git.commit",
      title: "Commit",
      arguments: [this.scm],
    };

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootUri, "**/*")
    );
    this.disposables.push(
      this.scm,
      watcher,
      watcher.onDidChange(() => this.scheduleRefresh()),
      watcher.onDidCreate(() => this.scheduleRefresh()),
      watcher.onDidDelete(() => this.scheduleRefresh())
    );
  }

  get rootUri(): vscode.Uri {
    return this.repository.rootUri;
  }

  get dir(): string {
    return this.repository.dir;
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  async refresh(): Promise<void> {
    const resources = await this.repository.resources();
    this.indexGroup.resourceStates = resources
      .filter((resource) => resource.staged)
      .map((resource) => this.toResourceState(resource));
    this.workingTreeGroup.resourceStates = resources
      .filter((resource) => !resource.staged)
      .map((resource) => this.toResourceState(resource));
    this.scm.count = resources.length;
    await this.refreshStatus();
  }

  async stage(uri: vscode.Uri): Promise<void> {
    await this.stageResource(uri);
    await this.refresh();
  }

  async stageAll(
    resources: readonly vscode.SourceControlResourceState[]
  ): Promise<void> {
    await Promise.all(
      resources.map((resource) => this.stageResource(resource.resourceUri))
    );
    await this.refresh();
  }

  async unstage(uri: vscode.Uri): Promise<void> {
    await this.unstageResource(uri);
    await this.refresh();
  }

  async unstageAll(
    resources: readonly vscode.SourceControlResourceState[]
  ): Promise<void> {
    await Promise.all(
      resources.map((resource) => this.unstageResource(resource.resourceUri))
    );
    await this.refresh();
  }

  async discard(uri: vscode.Uri): Promise<void> {
    await this.discardResource(uri);
    await this.refresh();
  }

  async discardAll(
    resources: readonly vscode.SourceControlResourceState[]
  ): Promise<void> {
    await Promise.all(
      resources.map((resource) => this.discardResource(resource.resourceUri))
    );
    await this.refresh();
  }

  async commit(message?: string): Promise<void> {
    const commitMessage = message || this.scm.inputBox.value;
    if (!commitMessage.trim()) {
      return;
    }

    const { authorName, authorEmail } = authorConfig();
    await git.commit({
      fs: this.fs,
      dir: this.dir,
      message: commitMessage,
      author: {
        name: authorName,
        email: authorEmail,
      },
    });
    this.scm.inputBox.value = "";
    await this.refresh();
  }

  async addRemote(remote: string, url: string): Promise<void> {
    await git.addRemote({ fs: this.fs, dir: this.dir, remote, url });
  }

  async removeRemote(remote: string): Promise<void> {
    await git.deleteRemote({ fs: this.fs, dir: this.dir, remote });
  }

  async remotes(): Promise<Array<{ remote: string; url: string }>> {
    return git.listRemotes({ fs: this.fs, dir: this.dir });
  }

  async branches(includeRemotes = true): Promise<string[]> {
    const localBranches = await git.listBranches({ fs: this.fs, dir: this.dir });
    if (!includeRemotes) {
      return localBranches;
    }

    const remoteBranches = await Promise.all(
      (await this.remotes()).map(async ({ remote }) =>
        (
          await git.listBranches({
            fs: this.fs,
            dir: this.dir,
            remote,
          })
        ).map((branch) => `${remote}/${branch}`)
      )
    );
    return localBranches.concat(...remoteBranches);
  }

  async currentBranch(): Promise<string | undefined> {
    return (
      (await git.currentBranch({
        fs: this.fs,
        dir: this.dir,
        fullname: false,
      })) || undefined
    );
  }

  async checkout(ref: string): Promise<void> {
    await git.checkout({ fs: this.fs, dir: this.dir, ref });
    await this.refresh();
  }

  async createBranch(ref: string, checkout = true): Promise<void> {
    await git.branch({ fs: this.fs, dir: this.dir, ref, checkout });
    await this.refresh();
  }

  async createBranchFrom(newBranch: string, startPoint: string): Promise<void> {
    await git.checkout({ fs: this.fs, dir: this.dir, ref: startPoint });
    await this.createBranch(newBranch, true);
  }

  async deleteBranch(ref: string): Promise<void> {
    await git.deleteBranch({ fs: this.fs, dir: this.dir, ref });
    await this.refresh();
  }

  async merge(theirs: string): Promise<void> {
    const { authorName, authorEmail } = authorConfig();
    await git.merge({
      fs: this.fs,
      dir: this.dir,
      theirs,
      abortOnConflict: false,
      author: {
        name: authorName,
        email: authorEmail,
      },
    });
    await this.refresh();
  }

  private async stageResource(uri: vscode.Uri): Promise<void> {
    const filepath = this.relativePath(uri);
    try {
      await this.fs.promises.stat(uri.path);
      await git.add({ fs: this.fs, dir: this.dir, filepath });
    } catch {
      await git.remove({ fs: this.fs, dir: this.dir, filepath });
    }
  }

  private async unstageResource(uri: vscode.Uri): Promise<void> {
    await git.resetIndex({
      fs: this.fs,
      dir: this.dir,
      filepath: this.relativePath(uri),
    });
  }

  private async discardResource(uri: vscode.Uri): Promise<void> {
    const filepath = this.relativePath(uri);
    if (await this.isUntracked(filepath)) {
      await this.fs.promises.unlink(uri.path);
      return;
    }

    await git.checkout({
      fs: this.fs,
      dir: this.dir,
      force: true,
      filepaths: [filepath],
    });
  }

  private async isUntracked(filepath: string): Promise<boolean> {
    const row = (await git.statusMatrix({ fs: this.fs, dir: this.dir })).find(
      ([candidate]) => candidate === filepath
    );
    return row?.[1] === 0;
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 300);
  }

  private async refreshStatus(): Promise<void> {
    try {
      const branch =
        (await this.currentBranch()) ||
        (
          await git.resolveRef({
            fs: this.fs,
            dir: this.dir,
            ref: "HEAD",
          })
        ).slice(0, 8);
      this.scm.statusBarCommands = [
        {
          command: "isomorphic-git.checkout",
          title: `$(git-branch) ${branch}`,
          arguments: [this.scm],
        },
      ];
    } catch {
      this.scm.statusBarCommands = [];
    }
  }

  private toResourceState(resource: GitResource): vscode.SourceControlResourceState {
    const command = resource.deleted
      ? undefined
      : {
          title: "Show Changes",
          command: "vscode.diff",
          arguments: [
            this.repository.provideOriginalResource(resource.uri, undefined),
            resource.uri,
            `${path.posix.basename(resource.uri.path)} (HEAD <-> Working Tree)`,
          ],
        };

    return {
      resourceUri: resource.uri,
      command,
      decorations: resource.deleted
        ? {
            strikeThrough: true,
            tooltip: "Deleted",
          }
        : undefined,
    };
  }

  private relativePath(uri: vscode.Uri): string {
    return path.posix.relative(this.dir, uri.path);
  }
}

function authorConfig() {
  const config = vscode.workspace.getConfiguration("isomorphic-git");
  return {
    authorName: config.get<string>("authorName") || "Anonymous",
    authorEmail: config.get<string>("authorEmail") || "anonymous@git.com",
  };
}
