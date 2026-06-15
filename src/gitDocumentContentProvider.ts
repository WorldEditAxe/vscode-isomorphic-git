import * as git from "isomorphic-git";
import * as path from "path";
import {
  CancellationToken,
  Disposable,
  TextDocumentContentProvider,
  Uri,
} from "vscode";
import { FileSystem } from "./fs";

export const GIT_SCHEME = "isomorphic-git";

export function toGitUri(rootUri: Uri, fileUri: Uri): Uri {
  return fileUri.with({
    scheme: GIT_SCHEME,
    query: encodeURIComponent(rootUri.toString()),
  });
}

export class GitDocumentContentProvider
  implements TextDocumentContentProvider, Disposable {
  constructor(private readonly fs: FileSystem) {}

  dispose(): void {}

  async provideTextDocumentContent(
    uri: Uri,
    token: CancellationToken
  ): Promise<string> {
    if (token.isCancellationRequested) {
      return "";
    }

    const rootUri = Uri.parse(decodeURIComponent(uri.query));
    const dir = rootUri.path;
    const filepath = path.posix.relative(dir, uri.path);
    if (!filepath || filepath.startsWith("..")) {
      return "";
    }

    try {
      const ref =
        (await git.currentBranch({ fs: this.fs, dir, fullname: false })) ||
        "HEAD";
      const oid = await git.resolveRef({ fs: this.fs, dir, ref });
      const { blob } = await git.readBlob({
        fs: this.fs,
        dir,
        oid,
        filepath,
      });
      return new TextDecoder().decode(blob);
    } catch {
      return "";
    }
  }
}
