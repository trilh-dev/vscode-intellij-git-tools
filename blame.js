const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const util = require('util');

const execFile = util.promisify(cp.execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const NBSP = ' ';
const ZERO_SHA = '0000000000000000000000000000000000000000';

/** Virtual scheme that serves `git show <sha>` (full commit message + diff). */
const COMMIT_SCHEME = 'git-commit';

/** URIs (as strings) that currently have blame annotations enabled. */
const enabled = new Set();

/** uriString -> { repo, byLine } so a click can look up the commit for a line. */
const blameData = new Map();

/** Single shared decoration type; per-line text lives in each range's options. */
let decorationType;
function getDecorationType() {
  if (!decorationType) {
    decorationType = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      before: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        margin: `0 ${NBSP}1em 0 0`
      }
    });
  }
  return decorationType;
}

async function git(args, cwd) {
  const { stdout } = await execFile('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

/** Serves `git show <sha>` into a read-only editor (the commit "history" view). */
class CommitContentProvider {
  async provideTextDocumentContent(uri) {
    let info;
    try {
      info = JSON.parse(decodeURIComponent(uri.query));
    } catch {
      return '// Unable to parse commit request.';
    }
    try {
      return await git(['show', info.sha], info.repo);
    } catch (e) {
      return `// Unable to show commit ${info.sha.slice(0, 8)}.\n// ${e.message}`;
    }
  }
}

/** Virtual URI the CommitContentProvider resolves; `.diff` gives diff highlighting. */
function commitUri(repo, sha) {
  return vscode.Uri.from({
    scheme: COMMIT_SCHEME,
    path: `/commit-${sha.slice(0, 8)}.diff`,
    query: encodeURIComponent(JSON.stringify({ repo, sha }))
  });
}

/** Open a commit beside the code, keeping focus so the user can keep clicking. */
async function openCommit(repo, sha) {
  const uri = commitUri(repo, sha);
  const alreadyVisible = vscode.window.visibleTextEditors.some(
    (e) => e.document.uri.toString() === uri.toString()
  );
  if (alreadyVisible) return;

  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true
  });
}

/** Parse `git blame --line-porcelain` into a Map of finalLineNumber -> blame info. */
async function blameFile(repo, relPath) {
  const out = await git(['blame', '--line-porcelain', '--', relPath], repo);
  const lines = out.split('\n');
  const byLine = new Map();
  let cur = null;
  const headerRe = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

  for (const line of lines) {
    const header = headerRe.exec(line);
    if (header) {
      cur = { sha: header[1], finalLine: parseInt(header[2], 10), author: '', time: 0, summary: '' };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('author ')) cur.author = line.slice(7);
    else if (line.startsWith('author-time ')) cur.time = parseInt(line.slice(12), 10);
    else if (line.startsWith('summary ')) cur.summary = line.slice(8);
    else if (line.startsWith('\t')) {
      byLine.set(cur.finalLine, cur);
      cur = null;
    }
  }
  return byLine;
}

function fmtDate(epochSec) {
  if (!epochSec) return '';
  const d = new Date(epochSec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Compute the annotation gutter and apply it to the editor as decorations. */
async function applyBlame(editor) {
  const uri = editor.document.uri;
  const repo = (await git(['rev-parse', '--show-toplevel'], path.dirname(uri.fsPath))).trim();
  const relPath = path.relative(repo, uri.fsPath).split(path.sep).join('/');
  const byLine = await blameFile(repo, relPath);

  // Remember the per-line commits so a click can open the matching commit.
  blameData.set(uri.toString(), { repo, byLine });

  // First pass: build the raw "date author" string per line and find the width.
  const raw = new Map();
  let width = 0;
  for (const [lineNo, info] of byLine) {
    const uncommitted = info.sha === ZERO_SHA;
    const author = uncommitted ? 'You · Uncommitted' : truncate(info.author, 18);
    const date = uncommitted ? '' : fmtDate(info.time);
    const text = date ? `${date}${NBSP}${author}` : author;
    raw.set(lineNo, text);
    if (text.length > width) width = text.length;
  }

  const muted = new vscode.ThemeColor('editorCodeLens.foreground');
  const decorations = [];
  for (const [lineNo, info] of byLine) {
    const idx = lineNo - 1;
    if (idx >= editor.document.lineCount) continue;

    const padded = raw.get(lineNo).padEnd(width, NBSP);
    const range = new vscode.Range(idx, 0, idx, 0);

    const hover = new vscode.MarkdownString();
    if (info.sha === ZERO_SHA) {
      hover.appendMarkdown('**Uncommitted changes** — not yet committed.');
    } else {
      hover.appendMarkdown(`**${info.summary || '(no message)'}**\n\n`);
      hover.appendMarkdown(`${info.author} · ${fmtDate(info.time)} · \`${info.sha.slice(0, 8)}\``);
    }

    decorations.push({
      range,
      hoverMessage: hover,
      renderOptions: { before: { contentText: padded, color: muted } }
    });
  }

  editor.setDecorations(getDecorationType(), decorations);
}

function clearBlame(editor) {
  editor.setDecorations(getDecorationType(), []);
}

function visibleEditorsFor(uri) {
  return vscode.window.visibleTextEditors.filter(
    (e) => e.document.uri.toString() === uri.toString()
  );
}

/** Toggle blame annotations for the active editor's file. */
async function toggleBlame() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    vscode.window.showWarningMessage('Git Blame: open a file first.');
    return;
  }
  const key = editor.document.uri.toString();

  if (enabled.has(key)) {
    enabled.delete(key);
    blameData.delete(key);
    for (const e of visibleEditorsFor(editor.document.uri)) clearBlame(e);
    vscode.window.setStatusBarMessage('$(git-commit) Git Blame off', 4000);
    return;
  }

  try {
    enabled.add(key);
    await applyBlame(editor);
    vscode.window.setStatusBarMessage('$(git-commit) Git Blame on — hover a line for commit details', 6000);
  } catch (e) {
    enabled.delete(key);
    vscode.window.showWarningMessage(`Git Blame failed: ${e.message}`);
  }
}

function activateBlame(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('cwp.toggleBlame', toggleBlame),

    // Open a commit's full message + diff (invoked by the File History tree).
    vscode.commands.registerCommand('cwp.openCommit', (repo, sha) => openCommit(repo, sha)),

    // Re-apply when the file is re-focused.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && enabled.has(editor.document.uri.toString())) {
        applyBlame(editor).catch(() => {});
      }
    }),

    // Refresh after a save so annotations track the new commit/line state.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!enabled.has(doc.uri.toString())) return;
      for (const e of visibleEditorsFor(doc.uri)) applyBlame(e).catch(() => {});
    }),

    // Stop tracking a file once it is closed.
    vscode.workspace.onDidCloseTextDocument((doc) => {
      enabled.delete(doc.uri.toString());
      blameData.delete(doc.uri.toString());
    }),

    // Serve commit contents for the read-only commit view.
    vscode.workspace.registerTextDocumentContentProvider(
      COMMIT_SCHEME,
      new CommitContentProvider()
    ),

    // Click a blamed line → reveal that commit in the File History panel.
    // Mouse (and any non-keyboard) selection only, so arrow-key navigation
    // through the file doesn't trigger it.
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.kind === vscode.TextEditorSelectionChangeKind.Keyboard) return;
      const uriStr = e.textEditor.document.uri.toString();
      if (!enabled.has(uriStr)) return;
      const data = blameData.get(uriStr);
      if (!data) return;
      const info = data.byLine.get(e.selections[0].active.line + 1);
      if (!info || info.sha === ZERO_SHA) return;
      vscode.commands.executeCommand(
        'cwp.showFileHistory',
        e.textEditor.document.uri,
        info.sha
      );
    })
  );
}

module.exports = { activateBlame };
