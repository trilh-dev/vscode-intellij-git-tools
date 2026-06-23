const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const util = require('util');

const { activateBlame } = require('./blame');

const execFile = util.promisify(cp.execFile);

/** Custom URI scheme used to serve file content from a specific git revision. */
const SCHEME = 'git-previous';

/** Field separator that cannot appear in git author/subject output. */
const SEP = '\x1f';

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Serves the content of a file at a given git revision, so the diff editor can
 * show a read-only "previous version" side-by-side with the working tree.
 */
class GitContentProvider {
  async provideTextDocumentContent(uri) {
    let info;
    try {
      info = JSON.parse(decodeURIComponent(uri.query));
    } catch {
      return '// Unable to parse revision request.';
    }
    try {
      const { stdout } = await execFile(
        'git',
        ['show', `${info.rev}:${info.relPath}`],
        { cwd: info.repo, maxBuffer: MAX_BUFFER }
      );
      return stdout;
    } catch (e) {
      // File may not have existed at that revision (e.g. it was added later).
      return `// This file does not exist at revision ${info.rev.slice(0, 8)}.\n// ${e.message}`;
    }
  }
}

/** Run git and return trimmed stdout. */
async function git(args, cwd) {
  const { stdout } = await execFile('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout.trim();
}

/** Resolve the working-tree root for a file path. */
async function getRepoRoot(filePath) {
  return git(['rev-parse', '--show-toplevel'], path.dirname(filePath));
}

/** Build a virtual URI that the content provider can resolve to a revision. */
function revisionUri(repo, rev, relPath) {
  return vscode.Uri.from({
    scheme: SCHEME,
    // Path keeps the filename + extension so the diff title and syntax
    // highlighting work just like a real file.
    path: '/' + relPath,
    query: encodeURIComponent(JSON.stringify({ repo, rev, relPath }))
  });
}

/**
 * Read the commits that touched a file, newest first.
 * Returns [{ hash, author, email, date, subject }].
 */
async function fileHistory(repo, relPath, limit) {
  const fmt = ['%H', '%an', '%ae', '%ad', '%s'].join(SEP);
  const out = await git(
    ['log', `-n${limit}`, `--format=${fmt}`, '--date=short', '--follow', '--', relPath],
    repo
  );
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [hash, author, email, date, subject] = line.split(SEP);
    return { hash, author, email, date, subject };
  });
}

/** True when the working-tree file differs from its committed (HEAD) version. */
async function isDirty(repo, relPath) {
  try {
    await execFile('git', ['diff', '--quiet', 'HEAD', '--', relPath], {
      cwd: repo,
      maxBuffer: MAX_BUFFER
    });
    return false;
  } catch {
    return true;
  }
}

/** Resolve the target file URI from a context-menu resource or the active editor. */
function resolveFileUri(resource) {
  if (resource instanceof vscode.Uri) return resource;
  const active = vscode.window.activeTextEditor;
  return active ? active.document.uri : undefined;
}

function authorLine(commit) {
  return `${commit.author} <${commit.email}> · ${commit.date} · ${commit.subject}`;
}

/**
 * IntelliJ-style "Compare with Previous Version":
 *  - If the file has uncommitted changes, diff the committed (HEAD) version
 *    against the working tree.
 *  - Otherwise diff the previous commit against the current (HEAD) version.
 * The diff title and status bar both name the author of the older side.
 */
async function compareWithPrevious(resource) {
  const fileUri = resolveFileUri(resource);
  if (!fileUri || fileUri.scheme !== 'file') {
    vscode.window.showWarningMessage('Compare: open or select a file first.');
    return;
  }

  const filePath = fileUri.fsPath;
  let repo;
  try {
    repo = await getRepoRoot(filePath);
  } catch {
    vscode.window.showWarningMessage('Compare: this file is not inside a Git repository.');
    return;
  }
  const relPath = path.relative(repo, filePath).split(path.sep).join('/');

  const commits = await fileHistory(repo, relPath, 50);
  if (commits.length === 0) {
    vscode.window.showInformationMessage('Compare: this file has no committed history yet.');
    return;
  }

  const dirty = await isDirty(repo, relPath);
  const name = path.basename(relPath);

  let leftUri, rightUri, olderCommit, rightLabel;
  if (dirty) {
    // Previous version == latest commit; right side == live working tree.
    olderCommit = commits[0];
    leftUri = revisionUri(repo, olderCommit.hash, relPath);
    rightUri = fileUri;
    rightLabel = 'Working Tree';
  } else {
    if (commits.length < 2) {
      vscode.window.showInformationMessage(
        'Compare: only one commit exists for this file — nothing previous to compare.'
      );
      return;
    }
    olderCommit = commits[1];
    leftUri = revisionUri(repo, olderCommit.hash, relPath);
    rightUri = revisionUri(repo, commits[0].hash, relPath);
    rightLabel = `HEAD · ${commits[0].author}`;
  }

  const title = `${name}: ${olderCommit.author} (${olderCommit.date}) ↔ ${rightLabel}`;
  await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
    preview: true
  });

  vscode.window.setStatusBarMessage(`$(git-commit) Previous by ${authorLine(olderCommit)}`, 12000);
}

/**
 * IntelliJ-style "Compare with Revision...": pick any commit that touched the
 * file from a list that shows the author, date and message, then diff that
 * revision against the current working tree.
 */
async function compareWithRevision(resource) {
  const fileUri = resolveFileUri(resource);
  if (!fileUri || fileUri.scheme !== 'file') {
    vscode.window.showWarningMessage('Compare: open or select a file first.');
    return;
  }

  const filePath = fileUri.fsPath;
  let repo;
  try {
    repo = await getRepoRoot(filePath);
  } catch {
    vscode.window.showWarningMessage('Compare: this file is not inside a Git repository.');
    return;
  }
  const relPath = path.relative(repo, filePath).split(path.sep).join('/');

  const commits = await fileHistory(repo, relPath, 200);
  if (commits.length === 0) {
    vscode.window.showInformationMessage('Compare: this file has no committed history yet.');
    return;
  }

  const items = commits.map((c) => ({
    label: `$(git-commit) ${c.subject}`,
    description: `${c.author} · ${c.date}`,
    detail: `${c.hash.slice(0, 8)}  <${c.email}>`,
    commit: c
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Select a revision of ${path.basename(relPath)} to compare with the current file`,
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!pick) return;

  const name = path.basename(relPath);
  const leftUri = revisionUri(repo, pick.commit.hash, relPath);
  const title = `${name}: ${pick.commit.author} (${pick.commit.date}) ↔ Working Tree`;

  await vscode.commands.executeCommand('vscode.diff', leftUri, fileUri, title, { preview: true });
  vscode.window.setStatusBarMessage(`$(git-commit) ${authorLine(pick.commit)}`, 12000);
}

/**
 * IntelliJ-style "Show History" panel: a flat tree of the commits that touched
 * the current file (newest first). Selecting a row opens that commit's full
 * message + diff via `cwp.openCommit`.
 */
class FileHistoryProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.repo = null;
    this.commits = [];
  }

  /** Replace the panel's contents with a file's history and refresh. */
  setHistory(repo, commits) {
    this.repo = repo;
    this.commits = commits;
    this._onDidChangeTreeData.fire();
  }

  // reveal() is only ever called on commit rows (roots), so a flat parent chain
  // is enough — file rows never need revealing.
  getParent() {
    return undefined;
  }

  getChildren(element) {
    // Roots come from setHistory synchronously, so reveal() can't race them.
    if (!element) return this.commits;
    // File rows are leaves.
    if (element.kind === 'file') return [];
    // A commit row — lazily load (and cache) the files it changed.
    return this.getCommitFiles(element);
  }

  async getCommitFiles(commit) {
    if (commit._files) return commit._files;
    let out = '';
    try {
      out = await git(
        ['diff-tree', '--no-commit-id', '--name-status', '-M', '-r', '--root', commit.hash],
        this.repo
      );
    } catch {
      out = '';
    }
    commit._files = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t');
        const status = parts[0];
        const renamed = /^[RC]/.test(status);
        return {
          kind: 'file',
          repo: this.repo,
          sha: commit.hash,
          status,
          path: renamed ? parts[2] : parts[1],
          oldPath: renamed ? parts[1] : undefined
        };
      });
    return commit._files;
  }

  getTreeItem(element) {
    return element.kind === 'file' ? fileTreeItem(element) : commitTreeItem(element);
  }
}

function commitTreeItem(commit) {
  const item = new vscode.TreeItem(
    commit.subject || '(no message)',
    vscode.TreeItemCollapsibleState.Collapsed
  );
  item.description = `${commit.author} · ${commit.date}`;
  item.tooltip = new vscode.MarkdownString(
    `**${commit.subject || '(no message)'}**\n\n` +
      `${commit.author} <${commit.email}> · ${commit.date} · \`${commit.hash.slice(0, 8)}\``
  );
  item.iconPath = new vscode.ThemeIcon('git-commit');
  return item;
}

function fileStatusIcon(status) {
  switch (status[0]) {
    case 'A':
      return new vscode.ThemeIcon('diff-added');
    case 'D':
      return new vscode.ThemeIcon('diff-removed');
    case 'R':
    case 'C':
      return new vscode.ThemeIcon('diff-renamed');
    default:
      return new vscode.ThemeIcon('diff-modified');
  }
}

function fileTreeItem(node) {
  const dir = path.posix.dirname(node.path);
  const item = new vscode.TreeItem(
    path.posix.basename(node.path),
    vscode.TreeItemCollapsibleState.None
  );
  item.description = dir === '.' ? node.status : `${node.status}  ${dir}`;
  item.tooltip = node.oldPath ? `${node.oldPath} → ${node.path}` : node.path;
  item.iconPath = fileStatusIcon(node.status);
  item.command = {
    command: 'cwp.openCommitFile',
    title: 'Open File Diff',
    arguments: [node]
  };
  return item;
}

/** Diff one file's change within a commit (its parent revision ↔ this commit). */
async function openCommitFile(node) {
  const name = path.posix.basename(node.path);
  const left = revisionUri(node.repo, `${node.sha}^`, node.oldPath || node.path);
  const right = revisionUri(node.repo, node.sha, node.path);
  const title = `${name} @ ${node.sha.slice(0, 8)} (${node.status})`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

let historyProvider;
let historyView;

/**
 * Populate the File History panel for a file and select a given commit.
 * Invoked when a blamed line is clicked. Focus stays in the editor on
 * subsequent clicks; the panel is only force-focused the first time, to
 * open it.
 */
async function showFileHistory(resource, sha) {
  const fileUri = resolveFileUri(resource);
  if (!fileUri || fileUri.scheme !== 'file') return;

  let repo;
  try {
    repo = await getRepoRoot(fileUri.fsPath);
  } catch {
    return;
  }
  const relPath = path.relative(repo, fileUri.fsPath).split(path.sep).join('/');

  const commits = await fileHistory(repo, relPath, 200);
  historyProvider.setHistory(repo, commits);
  if (commits.length === 0) return;

  // Open the panel the first time it's needed; afterwards just reveal so we
  // don't yank focus out of the editor on every click.
  if (!historyView.visible) {
    await vscode.commands.executeCommand('cwpFileHistory.focus');
  }

  const target = (sha && commits.find((c) => c.hash === sha)) || commits[0];
  try {
    await historyView.reveal(target, { select: true, focus: false, expand: true });
  } catch {
    // reveal can reject if the view isn't ready yet; the list is still populated.
  }
}

function activate(context) {
  historyProvider = new FileHistoryProvider();
  historyView = vscode.window.createTreeView('cwpFileHistory', {
    treeDataProvider: historyProvider
  });

  context.subscriptions.push(
    historyView,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider()),
    vscode.commands.registerCommand('cwp.compareWithPrevious', compareWithPrevious),
    vscode.commands.registerCommand('cwp.compareWithRevision', compareWithRevision),
    vscode.commands.registerCommand('cwp.showFileHistory', showFileHistory),
    vscode.commands.registerCommand('cwp.openCommitFile', openCommitFile)
  );

  activateBlame(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
