# Redpen

Redpen is a Claude Code plugin for reading documents and reviewing them line by line, right in the terminal.

- View Claude's last reply or a file line by line.
- Leave a comment on a line you want changed, or on a range of lines.
- Send all your comments to Claude as one prompt.

## Installation

**From a Claude Code session**

```sh
/plugin install redpen --marketplace joonhyukyim/redpen
# Answer `y` to the "Add marketplace?" question, then pick a scope.
```

**From a shell**

```sh
claude plugin install redpen --marketplace joonhyukyim/redpen
# Set the scope with the `-s` option (default: user scope).
```

## Usage

| Command          | What it does                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/redpen`        | Opens Redpen. The list shows Claude's last reply, the files Claude changed in the last conversation, and the files with comments. |
| `/redpen <path>` | Opens a file by path. If Claude changed it in the last conversation, the diff opens; otherwise the whole file.                 |

Redpen takes keyboard focus when it opens. `Esc` returns focus to the prompt, and `Ctrl+X` `Tab` moves it back to Redpen. To close Redpen, press `Ctrl+X` `X`.

### List screen

The list screen has two parts.
- `최근 수정` shows the files Claude changed in the last conversation; open one to see that conversation's diff.
- `전송 대기` shows the files with comments, in the order they got their first comment.
- The file list is empty after `/clear`, `/resume`, or restarting Claude.

| Hotkey      | Action                        |
| ----------- | ----------------------------- |
| ↑↓, `Enter` | Move to an entry and open it  |
| `1`         | Open another file (see below) |
| `0`         | Send all comments             |

`1` (파일 열기) opens an input in place of the hotkeys. Type a path as for `/redpen <path>` and press Enter to pick the file. An empty Enter closes the input, and a path that isn't a file doesn't open. While the input is empty, it shows the files changed in this session (latest first, marked `↺`); once you type, it suggests directory paths. Move to a suggestion with ↓ and press Enter to pick it. (Left/right arrows and `Esc` don't work in the input.)

### Document screen

| Hotkey | Action                                                                                  |
| ------ | --------------------------------------------------------------------------------------- |
| `1`    | Back to the list screen                                                                 |
| `2`    | Toggle between the changes alone (diff) and the whole file. When ▶'s line folds away in the changes alone, ▶ moves to the nearest changed line |
| `3`    | Start a range from the current line. Enter to comment, or press `3` again to cancel the range |
| `0`    | Send all comments                                                                       |

Writing a comment: `Enter` opens the input, and `Enter` again saves. An empty `Enter` cancels.

Each line holds one comment. A range's comment goes on its last line. On a line that already has a comment, `Enter` edits it.

Comments not shown in the diff are listed under `표시되지 않은 코멘트 N개` (comments not shown). Press Enter on one to edit it.

### Sending

`0` sends all comments to Claude as one prompt.

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

## Limitations and notes

- Files Claude changes with Edit, Write or NotebookEdit are listed. A file changed earlier in the session, or with comments, is also listed when it changes any other way (Bash, an MCP tool, a subagent), once the turn ends. Any other file isn't; open it with `1` or `/redpen <path>`.
- Files over 4 MiB can't be opened. A very large change is shown as one block of deleted lines and one block of added lines.
- A notebook's diff is its raw `.ipynb` JSON.
- `Esc` doesn't cancel; it returns focus to the prompt.
- Works only in the terminal. Not supported on mobile, the VS Code panel, `claude -p` or WSL.
