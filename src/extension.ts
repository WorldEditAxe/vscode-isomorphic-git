import * as git from "isomorphic-git";
import * as path from "path";
import * as vscode from "vscode";
import { FileSystem } from "./fs";
import {
  GIT_SCHEME,
  GitDocumentContentProvider,
} from "./gitDocumentContentProvider";
import { GitRepository } from "./gitRepository";
import { GitSourceControl } from "./gitSourceControl";
import { http, request as httpRequest } from "./http";

const repositories = new Map<string, GitSourceControl>();
const githubTokenSecret = "github.token";
let fs: FileSystem;
let output: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext;

interface CloneOptions {
  url?: string;
  parentUri?: vscode.Uri;
  dirName?: string;
  depth?: number;
  openAfterClone?: boolean;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  fs = new FileSystem();
  output = vscode.window.createOutputChannel("isomorphic-git");

  context.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(
      GIT_SCHEME,
      new GitDocumentContentProvider(fs)
    )
  );

  registerCommands(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      event.removed.forEach((folder) => unregisterRepository(folder.uri));
      event.added.forEach((folder) => void tryRegisterRepository(folder.uri));
    })
  );

  for (const folder of vscode.workspace.workspaceFolders || []) {
    await tryRegisterRepository(folder.uri);
  }
}

export function deactivate(): void {
  repositories.forEach((repository) => repository.dispose());
  repositories.clear();
}

function registerCommands(context: vscode.ExtensionContext): void {
  const command = (
    id: string,
    callback: (...args: any[]) => unknown | Promise<unknown>
  ) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...args) =>
        runCommand(id, () => callback(...args))
      )
    );

  command("isomorphic-git.init", initRepository);
  command("isomorphic-git.commit", commit);
  command("isomorphic-git.refresh", refresh);
  command("isomorphic-git.stage", (state: vscode.SourceControlResourceState) =>
    repositoryForUri(state.resourceUri)?.stage(state.resourceUri)
  );
  command(
    "isomorphic-git.stageAll",
    (group: vscode.SourceControlResourceGroup) =>
      repositoryForGroup(group)?.stageAll(group.resourceStates)
  );
  command(
    "isomorphic-git.unstage",
    (state: vscode.SourceControlResourceState) =>
      repositoryForUri(state.resourceUri)?.unstage(state.resourceUri)
  );
  command(
    "isomorphic-git.unstageAll",
    (group: vscode.SourceControlResourceGroup) =>
      repositoryForGroup(group)?.unstageAll(group.resourceStates)
  );
  command("isomorphic-git.clean", (state: vscode.SourceControlResourceState) =>
    repositoryForUri(state.resourceUri)?.discard(state.resourceUri)
  );
  command(
    "isomorphic-git.cleanAll",
    (group: vscode.SourceControlResourceGroup) =>
      repositoryForGroup(group)?.discardAll(group.resourceStates)
  );
  command("isomorphic-git.openGitConfig", openGitConfig);
  command("isomorphic-git.addRemote", addRemote);
  command("isomorphic-git.removeRemote", removeRemote);
  command("isomorphic-git.checkout", checkout);
  command("isomorphic-git.deleteBranch", deleteBranch);
  command("isomorphic-git.githubSignIn", githubSignIn);
  command("isomorphic-git.githubSignOut", githubSignOut);
  command("isomorphic-git.clone", cloneRepository);
  command("isomorphic-git.fetch", fetchRepository);
  command("isomorphic-git.pullFrom", pullRepository);
  command("isomorphic-git.pushTo", pushRepository);
  command("isomorphic-git.merge", mergeRepository);
}

async function runCommand(
  id: string,
  callback: () => unknown | Promise<unknown>
): Promise<unknown> {
  try {
    return await callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[${id}] ${message}`);
    vscode.window.showErrorMessage(message);
  }
}

async function initRepository(): Promise<void> {
  const root = await pickWorkspaceFolder("Pick workspace folder to initialize");
  if (!root) {
    return;
  }

  await git.init({ fs, dir: root.path, defaultBranch: "main" });
  await registerRepository(root);
}

async function commit(sourceControl?: vscode.SourceControl): Promise<void> {
  const repository = await pickRepository(sourceControl);
  if (!repository) {
    return;
  }

  const message =
    repository.scm.inputBox.value ||
    (await vscode.window.showInputBox({
      prompt: "Commit message",
      placeHolder: "Message",
    }));
  if (message) {
    await repository.commit(message);
  }
}

async function refresh(sourceControl?: vscode.SourceControl): Promise<void> {
  const repository = await pickRepository(sourceControl);
  await repository?.refresh();
}

async function openGitConfig(): Promise<void> {
  const repository = await pickRepository();
  if (repository) {
    await vscode.commands.executeCommand(
      "vscode.open",
      repository.rootUri.with({
        path: path.posix.join(repository.dir, ".git", "config"),
      }),
      vscode.ViewColumn.Active
    );
  }
}

async function addRemote(): Promise<void> {
  const repository = await pickRepository();
  if (!repository) {
    return;
  }

  const url = await vscode.window.showInputBox({
    prompt: "Remote URL",
    placeHolder: "https://github.com/user/repo.git",
  });
  if (!url || !/^https?:\/\//.test(url)) {
    return;
  }

  const remote = await vscode.window.showInputBox({
    prompt: "Remote name",
    value: "origin",
  });
  if (remote) {
    await repository.addRemote(remote, url);
  }
}

async function removeRemote(): Promise<void> {
  const repository = await pickRepository();
  if (!repository) {
    return;
  }

  const remote = await pickRemote(repository, "Pick remote to remove");
  if (remote) {
    await repository.removeRemote(remote.remote);
  }
}

async function checkout(sourceControl?: vscode.SourceControl): Promise<void> {
  const repository = await pickRepository(sourceControl);
  if (!repository) {
    return;
  }

  const createBranch = "$(plus) Create new branch";
  const createFrom = "$(plus) Create new branch from";
  const branches = await repository.branches();
  const pick = await vscode.window.showQuickPick(
    [
      { label: createBranch },
      { label: createFrom },
      ...branches.map((branch) => ({ label: branch })),
    ],
    { placeHolder: "Select branch" }
  );
  if (!pick) {
    return;
  }

  if (pick.label === createBranch) {
    const branch = await vscode.window.showInputBox({ prompt: "Branch name" });
    if (branch) {
      await repository.createBranch(branch);
    }
    return;
  }

  if (pick.label === createFrom) {
    const branch = await vscode.window.showInputBox({ prompt: "Branch name" });
    const startPoint = await vscode.window.showQuickPick(branches, {
      placeHolder: "Start point",
    });
    if (branch && startPoint) {
      await repository.createBranchFrom(branch, startPoint);
    }
    return;
  }

  await repository.checkout(pick.label);
}

async function deleteBranch(): Promise<void> {
  const repository = await pickRepository();
  const currentBranch = await repository?.currentBranch();
  if (!repository || !currentBranch) {
    return;
  }

  const branch = await vscode.window.showQuickPick(
    (await repository.branches(false)).filter(
      (candidate) => candidate !== currentBranch
    ),
    { placeHolder: "Branch to delete" }
  );
  if (branch) {
    await repository.deleteBranch(branch);
  }
}

async function githubSignIn(): Promise<void> {
  const token = await signInWithGitHubOAuth();
  if (!token) {
    return;
  }

  await extensionContext.secrets.store(githubTokenSecret, token);
  vscode.window.showInformationMessage("GitHub token saved for isomorphic-git.");
}

async function githubSignOut(): Promise<void> {
  await extensionContext.secrets.delete(githubTokenSecret);
  vscode.window.showInformationMessage("GitHub token removed from isomorphic-git.");
}

async function cloneRepository(
  options: CloneOptions = {}
): Promise<vscode.Uri | undefined> {
  const url =
    options.url ||
    (await vscode.window.showInputBox({
      prompt: "Repository URL",
      placeHolder: "https://github.com/user/repo.git",
    }));
  if (!url || !/^https?:\/\//.test(url)) {
    return;
  }

  const parent =
    options.parentUri ||
    vscode.Uri.from({ scheme: "vscode-userdata", path: "/isomorphic-git" });
  const root = parent.with({
    path: path.posix.join(parent.path, options.dirName || repoName(url)),
  });
  fs.addRoot(root);
  await vscode.workspace.fs.createDirectory(root);

  output.show();
  output.appendLine(`Cloning ${url}`);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Cloning ${url}`,
    },
    (progress) =>
      git.clone({
        fs,
        http,
        dir: root.path,
        url,
        depth: options.depth || 1,
        ...authCallbacks(),
        onMessage: (message) => output.appendLine(message),
        onProgress: ({ loaded, total, phase }) =>
          progress.report({
            increment: total ? (loaded / total) * 100 : undefined,
            message: phase,
          }),
      })
  );

  await registerRepository(root);
  if (options.openAfterClone !== false) {
    await vscode.commands.executeCommand("vscode.openFolder", root, false);
  }
  return root;
}

async function fetchRepository(sourceControl?: vscode.SourceControl): Promise<void> {
  const repository = await pickRepository(sourceControl);
  const remote =
    repository && (await pickRemote(repository, "Pick remote to fetch"));
  if (!repository || !remote) {
    return;
  }

  output.show();
  await git.fetch({
    fs,
    http,
    dir: repository.dir,
    remote: remote.remote,
    url: remote.url,
    singleBranch: false,
    tags: false,
    ...authCallbacks(),
    onMessage: (message) => output.appendLine(message),
  });
  await repository.refresh();
}

async function pullRepository(sourceControl?: vscode.SourceControl): Promise<void> {
  const repository = await pickRepository(sourceControl);
  const remote =
    repository && (await pickRemote(repository, "Pick remote to pull from"));
  if (!repository || !remote) {
    return;
  }

  const branch = await pickRemoteBranch(repository, remote.remote, "Pick branch to pull");
  if (!branch) {
    return;
  }

  const { authorName, authorEmail } = authorConfig();
  await git.pull({
    fs,
    http,
    dir: repository.dir,
    remote: remote.remote,
    remoteRef: branch,
    url: remote.url,
    author: { name: authorName, email: authorEmail },
    ...authCallbacks(),
    onMessage: (message) => output.appendLine(message),
  });
  await repository.refresh();
}

async function pushRepository(sourceControl?: vscode.SourceControl): Promise<void> {
  const repository = await pickRepository(sourceControl);
  const remote = repository && (await pickRemote(repository, "Pick remote to push to"));
  const ref = repository && (await repository.currentBranch());
  if (!repository || !remote || !ref) {
    return;
  }

  await git.push({
    fs,
    http,
    dir: repository.dir,
    remote: remote.remote,
    ref,
    ...authCallbacks(),
    onMessage: (message) => output.appendLine(message),
  });
  await repository.refresh();
}

async function mergeRepository(sourceControl?: vscode.SourceControl): Promise<void> {
  const repository = await pickRepository(sourceControl);
  if (!repository) {
    return;
  }

  const branch = await vscode.window.showQuickPick(await repository.branches(), {
    placeHolder: "Branch to merge",
  });
  if (branch) {
    await repository.merge(branch);
  }
}

async function tryRegisterRepository(rootUri: vscode.Uri): Promise<void> {
  const repository = new GitRepository(rootUri, fs);
  try {
    if (await repository.exists()) {
      registerRepository(rootUri);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Skipping ${rootUri.toString()}: ${message}`);
  }
}

async function registerRepository(rootUri: vscode.Uri): Promise<GitSourceControl> {
  const key = rootUri.toString();
  repositories.get(key)?.dispose();
  const repository = new GitSourceControl(rootUri, fs);
  repositories.set(key, repository);
  await repository.refresh();
  return repository;
}

function unregisterRepository(rootUri: vscode.Uri): void {
  const key = rootUri.toString();
  repositories.get(key)?.dispose();
  repositories.delete(key);
}

function repositoryForUri(uri: vscode.Uri): GitSourceControl | undefined {
  return [...repositories.values()]
    .sort((a, b) => b.rootUri.path.length - a.rootUri.path.length)
    .find(
      (repository) =>
        repository.rootUri.scheme === uri.scheme &&
        (uri.path === repository.rootUri.path ||
          uri.path.startsWith(repository.rootUri.path.replace(/\/+$/, "") + "/"))
    );
}

function repositoryForGroup(
  group: vscode.SourceControlResourceGroup
): GitSourceControl | undefined {
  return group.resourceStates[0]
    ? repositoryForUri(group.resourceStates[0].resourceUri)
    : undefined;
}

async function pickRepository(
  sourceControl?: vscode.SourceControl
): Promise<GitSourceControl | undefined> {
  if (sourceControl?.rootUri) {
    return repositories.get(sourceControl.rootUri.toString());
  }

  const all = [...repositories.values()];
  if (all.length === 1) {
    return all[0];
  }

  const pick = await vscode.window.showQuickPick(
    all.map((repository) => ({
      label: path.posix.basename(repository.rootUri.path),
      description: repository.rootUri.toString(),
      repository,
    })),
    { placeHolder: "Choose repository" }
  );
  return pick?.repository;
}

async function pickWorkspaceFolder(
  placeHolder: string
): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    vscode.window.showErrorMessage("Open a workspace folder first");
    return;
  }
  if (folders.length === 1) {
    return folders[0].uri;
  }

  const pick = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.toString(),
      uri: folder.uri,
    })),
    { placeHolder }
  );
  return pick?.uri;
}

async function pickRemote(repository: GitSourceControl, placeHolder: string) {
  const remotes = await repository.remotes();
  if (remotes.length === 1) {
    return remotes[0];
  }
  const pick = await vscode.window.showQuickPick(
    remotes.map((remote) => ({
      label: remote.remote,
      description: remote.url,
      remote,
    })),
    { placeHolder }
  );
  return pick?.remote;
}

async function pickRemoteBranch(
  repository: GitSourceControl,
  remote: string,
  placeHolder: string
): Promise<string | undefined> {
  const branch = await vscode.window.showQuickPick(
    (await repository.branches(true))
      .filter((candidate) => candidate.startsWith(remote + "/"))
      .map((candidate) => candidate.slice(remote.length + 1)),
    { placeHolder }
  );
  return branch;
}

function authorConfig() {
  const config = vscode.workspace.getConfiguration("isomorphic-git");
  return {
    authorName: config.get<string>("authorName") || "Anonymous",
    authorEmail: config.get<string>("authorEmail") || "anonymous@git.com",
  };
}

function repoName(url: string): string {
  return path.posix.basename(url.replace(/\/+$/, "").replace(/\.git$/, ""));
}

interface Credential {
  url: string;
  username: string;
  password: string;
}

function authCallbacks(allowedFailures = 3): {
  onAuth: git.AuthCallback;
  onAuthFailure: git.AuthFailureCallback;
} {
  let failures = 0;
  return {
    onAuth: (url) => authForRemote(url, false),
    onAuthFailure: async (url) => {
      failures++;
      if (failures >= allowedFailures) {
        return { cancel: true };
      }
      return authForRemote(url, true);
    },
  };
}

async function authForRemote(
  url: string,
  retrying: boolean
): Promise<git.GitAuth> {
  const configured = !retrying && configuredCredential(url);
  if (configured) {
    return configured;
  }

  if (isGitHubUrl(url)) {
    const token = await gitHubToken(retrying);
    if (!token) {
      return { cancel: true };
    }
    return { username: token };
  }

  return promptForCredentials();
}

async function gitHubToken(retrying: boolean): Promise<string | undefined> {
  const existing = !retrying
    ? await extensionContext.secrets.get(githubTokenSecret)
    : undefined;
  if (existing) {
    return existing;
  }

  const signIn = "Sign in";
  const pick = await vscode.window.showInformationMessage(
    retrying
      ? "GitHub rejected the saved credentials. Sign in again?"
      : "GitHub authentication is required.",
    signIn
  );
  if (pick !== signIn) {
    return;
  }
  return refreshGitHubToken();
}

async function refreshGitHubToken(): Promise<string | undefined> {
  const token = await signInWithGitHubOAuth();
  if (token) {
    await extensionContext.secrets.store(githubTokenSecret, token);
  }
  return token;
}

async function signInWithGitHubOAuth(): Promise<string | undefined> {
  const clientId = await githubOAuthClientId();
  if (!clientId) {
    return;
  }

  const device = await requestGitHubDeviceCode(clientId);
  await vscode.env.clipboard.writeText(device.userCode);
  await vscode.env.openExternal(vscode.Uri.parse(device.verificationUri));

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitHub authorization code: ${device.userCode}`,
      cancellable: true,
    },
    (progress, token) => {
      progress.report({
        message: "Code copied. Enter it in the GitHub browser window.",
      });
      return pollGitHubAccessToken(clientId, device, token);
    }
  );
}

async function githubOAuthClientId(): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("isomorphic-git");
  const configured = config.get<string>("githubOAuthClientId");
  if (configured) {
    return configured;
  }

  const clientId = await vscode.window.showInputBox({
    title: "GitHub OAuth Client ID",
    prompt: "Enter a GitHub OAuth App client ID with Device Flow enabled.",
    ignoreFocusOut: true,
  });
  if (clientId) {
    await config.update(
      "githubOAuthClientId",
      clientId,
      vscode.ConfigurationTarget.Global
    );
  }
  return clientId;
}

interface GitHubDeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval?: number;
}

interface GitHubAccessTokenResponse {
  accessToken?: string;
  error?: string;
  errorDescription?: string;
}

async function requestGitHubDeviceCode(
  clientId: string
): Promise<GitHubDeviceCodeResponse> {
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("scope", "repo");

  const response = await libcurlJsonRequest("https://github.com/login/device/code", {
    method: "POST",
    headers: githubOAuthHeaders(),
    body: body.toString(),
  });
  const result = response as Record<string, unknown>;
  return {
    deviceCode: String(result.device_code || ""),
    userCode: String(result.user_code || ""),
    verificationUri: String(result.verification_uri || ""),
    expiresIn: Number(result.expires_in || 0),
    interval: Number(result.interval || 0) || undefined,
  };
}

async function pollGitHubAccessToken(
  clientId: string,
  device: GitHubDeviceCodeResponse,
  cancellation: vscode.CancellationToken
): Promise<string | undefined> {
  let intervalMs = (device.interval || 5) * 1000;
  const expiresAt = Date.now() + device.expiresIn * 1000;

  while (!cancellation.isCancellationRequested && Date.now() < expiresAt) {
    await delay(intervalMs);
    const body = new URLSearchParams();
    body.set("client_id", clientId);
    body.set("device_code", device.deviceCode);
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");

    const result = toGitHubAccessTokenResponse(
      await libcurlJsonRequest("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: githubOAuthHeaders(),
        body: body.toString(),
      })
    );
    if (result.accessToken) {
      return result.accessToken;
    }
    if (result.error === "authorization_pending") {
      continue;
    }
    if (result.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (result.error === "access_denied") {
      return;
    }
    throw new Error(result.errorDescription || result.error || "GitHub OAuth failed");
  }

  if (!cancellation.isCancellationRequested) {
    throw new Error("GitHub OAuth timed out");
  }
}

function githubOAuthHeaders(): Record<string, string> {
  return Object.fromEntries([
    ["Accept", "application/json"],
    ["Content-Type", "application/x-www-form-urlencoded"],
  ]);
}

async function libcurlJsonRequest(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
): Promise<unknown> {
  const response = await httpRequest({
    url,
    method: init.method,
    headers: init.headers,
    body: stringBody(init.body),
  });
  const text = new TextDecoder().decode(
    await collectHttpBody(response.body)
  );
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`GitHub OAuth failed: HTTP ${response.statusCode}`);
  }
  return JSON.parse(text);
}

function toGitHubAccessTokenResponse(value: unknown): GitHubAccessTokenResponse {
  const result = value as Record<string, unknown>;
  return {
    accessToken: result.access_token
      ? String(result.access_token)
      : undefined,
    error: result.error ? String(result.error) : undefined,
    errorDescription: result.error_description
      ? String(result.error_description)
      : undefined,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* stringBody(value: string): AsyncIterableIterator<Uint8Array> {
  yield new TextEncoder().encode(value);
}

async function collectHttpBody(
  body: AsyncIterable<Uint8Array> | undefined
): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function configuredCredential(url: string): git.GitAuth | undefined {
  const config = vscode.workspace.getConfiguration("isomorphic-git");
  const remoteUrl = normalizeRemoteUrl(url);
  const configured = (config.get<Credential[]>("credentials") || []).find(
    (credential) => normalizeRemoteUrl(credential.url) === remoteUrl
  );
  return configured
    ? { username: configured.username, password: configured.password }
    : undefined;
}

async function promptForCredentials(): Promise<git.GitAuth> {
  const username = await vscode.window.showInputBox({ prompt: "Username" });
  if (!username) {
    return { cancel: true };
  }

  const password = await vscode.window.showInputBox({
    prompt: "Password or token",
    password: true,
  });
  if (!password) {
    return { cancel: true };
  }

  return { username, password };
}

function isGitHubUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

function normalizeRemoteUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\.git$/, "");
}
