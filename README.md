# redpen

redpen is a Claude Code mod for reviewing what Claude changed, line by line, in a pane. You leave comments on single lines or ranges, then send all of them back to Claude as one prompt.

Requires Claude Code 2.1.287 or later.

## Installation

### From the marketplace

In a Claude Code session, run:

```
/plugin install redpen --marketplace joonhyukyim/redpen
```

Answer `y` to the "Add marketplace?" question, then pick a scope.

### From a shell

```sh
claude plugin install redpen --marketplace joonhyukyim/redpen
```

It installs for the user scope; pick another with `-s`.

## Usage

| Command          | What it does |
| ---------------- | ------------ |
| `/redpen`        | Opens a list of Claude's last reply, the files Claude changed in its most recent turn that changed files, and the files with comments waiting to be sent |
| `/redpen <path>` | Opens a file. If Claude changed it in that recent turn, the diff opens; otherwise the whole file. A directory is refused. The path completes in the prompt's typeahead |

The list has two parts. Under `최근 수정` are the files of Claude's most recent turn that changed files, each opening as that turn's diff; a turn that changes nothing leaves them as they are, and a turn you interrupt counts. Under `전송 대기` are the other files with comments, latest comment first, each opening whole. The session's other files are offered by `1` (see below). The list starts empty after `/clear`, a resume or a restart.

The pane takes keyboard focus when it opens. If focus doesn't move to it (the prompt has text in it, a dialog is open, or another pane holds the keys), press `Ctrl+X` `Tab`, or click the pane in the fullscreen terminal. `Esc` returns focus to the prompt, and `Ctrl+X` `Tab` moves it back to the pane. To close the pane, press `Ctrl+X` `X`; `/redpen` opens it again.

### Hotkeys

The hotkey list is shown at the bottom of the pane (it wraps on narrow panes); while you write a comment, the input takes its place. Under it, a second line shows the pane keys described above, on every screen and while you write a comment. In a document a rule above the hotkeys sets them apart from the lines; a pane too short for the rule and that line leaves both out.

List screen

| Hotkey  | Action |
| ------- | ------ |
| ↑↓, `Enter` | Move to an entry (Claude's last reply is always the first) and open it |
| `1`     | Open another file (see below) |
| `0`     | Send all comments |

`1` (파일 열기) opens an input in place of the hotkeys. Type a path as for `/redpen <path>` and press Enter; an empty Enter closes it, and a path that isn't a file keeps it open with the reason. Under it are up to 8 offers, drawn dim. While the input is empty, they are the session's files not in the list, those Claude changed and those you opened by path (latest first, marked `↺`); once you type, the entries of the typed directory that complete it. Move to one with ↓ and press Enter: a directory fills the input, a file opens.

Document screen

| Key                                           | Action                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `↓` / `↑`                                     | Move ▶ to the next / previous line or comment row.                                                                                        |
| `Enter` on a line, or clicking its number     | Comment on the line or the range; on a line that already has a comment, edit that comment                                                 |
| `Enter` on a comment row, or clicking its `└` | Edit that comment                                                                                                                         |

| Hotkey                                        | Action                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `1`                                           | Back to the list                                                                                                                          |
| `2`                                           | On a diff, switch between the changes alone (3 lines around each, the rest folded into `⋯`) and the whole file. Switching cancels a range |
| `3`                                           | Start a range from the ▶ line; Enter to comment or press 3 again to cancel                                                                |
| `0`                                           | Send all comments                                                                                                                         |

Clicking works only in Claude Code's fullscreen layout (the alternate screen), whatever the size of the terminal window. On the main screen (`CLAUDE_CODE_NO_FLICKER=0`, and tmux by default), clicks don't reach the mod.

Writing a comment: Enter opens the input, and Enter again saves. An empty Enter cancels. To edit, the input starts with the current text; clear it and press Enter to delete the comment.

Each line holds one comment. A range's comment goes on its last line; if that line already has a comment, Enter edits it.

Comments whose lines aren't on screen are listed under `표시되지 않은 코멘트 N개` (comments not shown); Enter on one edits it.

### Sending

`0` sends all comments to Claude as one prompt, as if you typed it.

```
다음 리뷰 코멘트를 모두 반영해서 수정해줘. 코멘트가 지적한 부분 외에는 건드리지 마.

1. src/foo.ts:12-18
   > (the lines commented on, up to 8)
   This helper is used only once; inline it.
2. src/bar.ts:40 (삭제된 줄, 변경 전 기준)
   > ...
   Remove the comment.
3. src/baz.ts (위치 불명, 원래 7행)
   > ...
   ...
```

`삭제된 줄, 변경 전 기준`: a deleted line, numbered as in the old version. `위치 불명, 원래 N행`: the lines are no longer in the file; the comment was on line N.

When the file changes, a comment follows the text of its lines. If that text is gone, the comment is marked `위치 불명` and still sent.

## Privacy

redpen reads the files in its list (at the start and end of each turn, and when it shows them) and Claude's last reply, and sends a prompt only when you press `0`. It doesn't write files, run commands or use the network. Comments are kept until the session ends.

## Limitations

- Files Claude changes with Edit, Write or NotebookEdit are listed. A file changed earlier in the session, or with comments, is also listed when it changes any other way (Bash, an MCP tool, a subagent), once the turn ends. Any other file isn't; open it with `1` or `/redpen <path>`.
- A file deleted during a turn leaves the list, unless it has comments.
- If a file was edited several times in one turn, the diff shows the whole turn's change.
- Files over 4 MiB can't be opened. A very large change is shown as one block of deleted lines and one block of added lines.
- A notebook's diff is its raw `.ipynb` JSON.
- In a short pane, rows other than the lines and entries are left out so that ↑↓ keep moving, and a long list shows only the entries around the focus. A pane under 6 rows (a document) or 5 rows (the list) shows only a notice.
- `Esc` doesn't cancel; it returns focus to the prompt. Cancel a range with `3`, a new comment with an empty Enter.
- Works in the terminal. Not supported on mobile, the VS Code panel, `claude -p` or WSL. Not tested in the Desktop app.
