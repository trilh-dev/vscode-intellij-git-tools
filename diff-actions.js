const vscode = require('vscode');
const cp = require('child_process');
const util = require('util');

const execFile = util.promisify(cp.execFile);

/** Must match the scheme registered in extension.js for revision content. */
const SCHEME = 'git-previous';
const MAX_BUFFER = 64 * 1024 * 1024;

/** Read a file's content at a git revision (same source the diff's left side uses). */
async function showFile(repo, rev, relPath) {
  const { stdout } = await execFile('git', ['show', `${rev}:${relPath}`], {
    cwd: repo,
    maxBuffer: MAX_BUFFER
  });
  return stdout;
}

/**
 * Line-level diff via LCS. Returns a flat op list in document order:
 *   { t: 'eq'|'del'|'ins', a, b }
 * where `a` is the left line index and `b` the right line index (for 'del',
 * `b` is the right-side insertion point; for 'ins', `a` is the left-side one).
 */
function lineDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'eq', a: i, b: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: 'del', a: i, b: j });
      i++;
    } else {
      ops.push({ t: 'ins', a: i, b: j });
      j++;
    }
  }
  while (i < n) ops.push({ t: 'del', a: i++, b: j });
  while (j < m) ops.push({ t: 'ins', a: i, b: j++ });
  return ops;
}

/**
 * Group an op list into change hunks. Each hunk records the left line range
 * [leftStart, leftEnd) and the right line range [rightStart, rightEnd) it spans,
 * so the right side can be made to match the left.
 */
function computeHunks(leftLines, rightLines) {
  const ops = lineDiff(leftLines, rightLines);
  const hunks = [];
  let cur = null;

  const finish = () => {
    if (!cur) return;
    const hasLeft = cur.lb > -1;
    const hasRight = cur.rb > -1;
    hunks.push({
      leftStart: hasLeft ? cur.la : cur.leftPos,
      leftEnd: hasLeft ? cur.lb : cur.leftPos,
      rightStart: hasRight ? cur.ra : cur.rpos,
      rightEnd: hasRight ? cur.rb : cur.rpos
    });
    cur = null;
  };

  for (const op of ops) {
    if (op.t === 'eq') {
      finish();
      continue;
    }
    if (!cur) {
      cur = { la: Infinity, lb: -1, ra: Infinity, rb: -1, leftPos: op.a, rpos: op.b };
    }
    if (op.t === 'del') {
      cur.la = Math.min(cur.la, op.a);
      cur.lb = Math.max(cur.lb, op.a + 1);
      cur.rpos = Math.min(cur.rpos, op.b);
    } else {
      cur.ra = Math.min(cur.ra, op.b);
      cur.rb = Math.max(cur.rb, op.b + 1);
      cur.leftPos = Math.min(cur.leftPos, op.a);
    }
  }
  finish();
  return hunks;
}

/** Split text into lines the same way for both sides of the comparison. */
function toLines(text) {
  return text.split(/\r?\n/);
}

/**
 * Locate an open single-file diff tab whose editable (modified) side is this
 * document and whose left side is one of our revision URIs. Returns the left
 * URI, or undefined when the document isn't the right pane of such a diff.
 */
function findRevisionDiff(documentUri) {
  const key = documentUri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputTextDiff &&
        input.original.scheme === SCHEME &&
        input.modified.toString() === key
      ) {
        return input.original;
      }
    }
  }
  return undefined;
}

/** Cache of revision-URI string -> left-side text, to avoid re-running git show. */
const leftCache = new Map();

async function getLeftContent(originalUri) {
  const cacheKey = originalUri.toString();
  if (leftCache.has(cacheKey)) return leftCache.get(cacheKey);
  const info = JSON.parse(decodeURIComponent(originalUri.query));
  const text = await showFile(info.repo, info.rev, info.relPath);
  leftCache.set(cacheKey, text);
  return text;
}

/**
 * Shows "◂ Accept" / "⧉ Copy" CodeLenses above each changed hunk on the
 * editable side of a revision diff — the closest VS Code equivalent to
 * IntelliJ's per-change apply arrows.
 */
class DiffActionsProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChange.event;
  }

  refresh() {
    this._onDidChange.fire();
  }

  async provideCodeLenses(document) {
    // Only the working-tree / editable side ever carries apply actions.
    if (document.uri.scheme !== 'file') return [];
    const originalUri = findRevisionDiff(document.uri);
    if (!originalUri) return [];

    let leftText;
    try {
      leftText = await getLeftContent(originalUri);
    } catch {
      return [];
    }

    const leftLines = toLines(leftText);
    const rightLines = toLines(document.getText());
    const hunks = computeHunks(leftLines, rightLines);
    const max = document.lineCount - 1;
    const lenses = [];

    hunks.forEach((hunk, index) => {
      const line = Math.min(Math.max(hunk.rightStart, 0), max < 0 ? 0 : max);
      const range = new vscode.Range(line, 0, line, 0);
      const args = [document.uri, originalUri.toString(), index];
      lenses.push(
        new vscode.CodeLens(range, {
          title: '◂ Accept',
          tooltip: 'Replace this change with the previous version',
          command: 'cwp.applyHunk',
          arguments: args
        }),
        new vscode.CodeLens(range, {
          title: '⧉ Copy',
          tooltip: 'Copy the previous version of this change to the clipboard',
          command: 'cwp.copyHunk',
          arguments: args
        })
      );
    });
    return lenses;
  }
}

/** Resolve the current document, left lines and the requested hunk afresh. */
async function resolveHunk(documentUri, originalUriString) {
  const document = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === documentUri.toString()
  );
  if (!document) return undefined;
  let leftText;
  try {
    leftText = await getLeftContent(vscode.Uri.parse(originalUriString));
  } catch {
    return undefined;
  }
  const leftLines = toLines(leftText);
  const hunks = computeHunks(leftLines, toLines(document.getText()));
  return { document, leftLines, hunks };
}

/** The line separator the document currently uses, so edits preserve its EOL. */
function eolOf(document) {
  return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

let provider;

function activateDiffActions(context) {
  provider = new DiffActionsProvider();

  const applyHunk = async (documentUri, originalUriString, index) => {
    const ctx = await resolveHunk(documentUri, originalUriString);
    if (!ctx) return;
    const hunk = ctx.hunks[index];
    if (!hunk) {
      // Document changed since the lens was drawn; just refresh.
      provider.refresh();
      return;
    }
    const { document } = ctx;
    // Splice in the same line-array space the hunks were computed in, then
    // rebuild the document text — this is provably the inverse of toLines and
    // sidesteps every Position/Range edge case at end-of-file.
    const eol = eolOf(document);
    const rightLines = toLines(document.getText());
    rightLines.splice(
      hunk.rightStart,
      hunk.rightEnd - hunk.rightStart,
      ...ctx.leftLines.slice(hunk.leftStart, hunk.leftEnd)
    );
    const newText = rightLines.join(eol);

    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    provider.refresh();
  };

  const copyHunk = async (documentUri, originalUriString, index) => {
    const ctx = await resolveHunk(documentUri, originalUriString);
    if (!ctx) return;
    const hunk = ctx.hunks[index];
    if (!hunk) return;
    const eol = eolOf(ctx.document);
    const text = ctx.leftLines.slice(hunk.leftStart, hunk.leftEnd).join(eol) + eol;
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage('$(clippy) Previous version copied to clipboard', 4000);
  };

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider),
    vscode.commands.registerCommand('cwp.applyHunk', applyHunk),
    vscode.commands.registerCommand('cwp.copyHunk', copyHunk),
    // A diff opening/closing doesn't change the document, so nudge the lenses.
    vscode.window.tabGroups.onDidChangeTabs(() => provider.refresh())
  );
}

module.exports = { activateDiffActions };
