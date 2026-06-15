import * as git from "isomorphic-git";
import * as path from "path";
import * as vscode from "vscode";
import { FileSystem } from "./fs";
import { toGitUri } from "./gitDocumentContentProvider";

export interface GitResource {
  uri: vscode.Uri;
  deleted: boolean;
  staged: boolean;
}

export class GitRepository implements vscode.QuickDiffProvider {
  constructor(
    public readonly rootUri: vscode.Uri,
    private readonly fs: FileSystem
  ) {}

  get dir(): string {
    return this.rootUri.path;
  }

  provideOriginalResource(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Uri> {
    return toGitUri(this.rootUri, uri);
  }

  async exists(): Promise<boolean> {
    return this.fs.exists(path.posix.join(this.dir, ".git", "config"));
  }

  async resources(): Promise<GitResource[]> {
    const matrix = await git.statusMatrix({
      fs: this.fs,
      dir: this.dir,
    });

    return matrix
      .filter(([_filepath, head, workdir]) => head === 0 || workdir !== 1)
      .map(([filepath, head, workdir, stage]) => ({
        uri: this.rootUri.with({ path: path.posix.join(this.dir, filepath) }),
        deleted: head === 1 && workdir === 0,
        staged: stage === 2 || stage === 3 || (workdir === 0 && stage === 0),
      }));
  }
}
