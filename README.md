# Compare with Previous Version

An IntelliJ-style Git compare for VS Code. Right-click a file and pick a
**Compare** action to diff it against an earlier revision — the commit
**author**, date and message are shown the whole time.

## Features

Right-click a file in the **Explorer**, the **editor**, or an **editor tab** →
**Compare** submenu:

- **Compare with Previous Version** — one click.
  - If the file has unsaved/uncommitted changes, diffs the committed version
    (`HEAD`) against your working tree.
  - If it's clean, diffs the previous commit against the current (`HEAD`)
    version.
  - The older side's author + date appears in the diff title; the full author,
    email and commit subject appear in the status bar.
- **Compare with Revision…** — opens a picker listing every commit that touched
  the file, each row showing the **author**, date, short hash and message. Pick
  one to diff that revision against the current file.

Both commands are also available from the Command Palette (`Git: Compare …`).

### Compare a whole folder

Right-click a **folder** in the **Explorer** → **Compare** submenu:

- **Compare Folder with Previous Version** — every changed file under the folder
  opens together in VS Code's **multi-file diff editor**.
  - If the folder has uncommitted changes, diffs `HEAD` against the working tree.
  - If it's clean, diffs the previous commit that touched the folder against the
    latest one.
- **Compare Folder with Revision…** — pick any commit that touched the folder
  (author, date, hash, message) and diff that revision's folder state against the
  working tree.

Untracked (never-committed) files are not included in folder diffs.

### Git Blame annotations

Right-click the **line-number gutter** → **Annotate with Git Blame (Toggle)**
(just like IntelliJ's "Annotate"). Each line gets an inline author + date
annotation from `git blame`; **hover** a line to see the commit message, full
author and short hash. Uncommitted lines show *You · Uncommitted*. Run it again
to toggle the annotations off. Also on the Command Palette as
`Git: Annotate with Git Blame (Toggle)`.

While annotations are on, **click any blamed line** to open the **File History**
panel (bottom panel, IntelliJ-style) — a list of every commit that touched the
file, newest first, each row showing the author, date and message. The commit
for the clicked line is selected and **expanded automatically** to reveal every
file that commit changed (IntelliJ-style), each marked added / modified /
deleted / renamed. **Click a changed file** to open its diff for that commit
(parent revision ↔ commit) in the editor. Focus stays in your file so you can
keep clicking line to line; clicking only triggers on mouse selection, not
arrow-key navigation, and uncommitted lines are skipped.

## How it works

A `git-previous:` virtual document provider streams `git show <rev>:<path>` into
a read-only left pane, and `vscode.diff` renders it beside the live file. No
files are written; nothing is staged or modified.

## Run it

1. Open this folder in VS Code.
2. Press **F5** ("Run Extension") to launch an Extension Development Host.
3. In that window, open any Git repository, right-click a tracked file →
   **Compare → Compare with Previous Version**.

## Package / install permanently

```bash
npm install -g @vscode/vsce
vsce package          # produces compare-with-previous-0.5.0.vsix
code --install-extension compare-with-previous-0.5.0.vsix
```

## Requirements

- `git` on your `PATH`.
- VS Code 1.85+ (the multi-file diff editor used by folder compares).
