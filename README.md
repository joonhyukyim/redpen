# Redpen

Redpen is a Claude Code plugin that lets you read and review documents line by line without leaving the terminal.

- Read Claude's last reply or any file, line by line.
- Comment on a single line or a range of lines you want changed.
- Send all your comments back to Claude in a single prompt.

## Installation

**From a Claude Code session**

```sh
/plugin install redpen --marketplace joonhyukyim/redpen
# Answer `y` when asked "Add marketplace?", then choose a scope.
```

**From a shell**

```sh
claude plugin install redpen --marketplace joonhyukyim/redpen
# Use `-s` to choose a scope (defaults to user).
```

## Usage

| Command          | What it does                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/redpen`        | Opens Redpen with a list of Claude's last reply, the files Claude changed in its last turn, and any files you've commented on. |
| `/redpen <path>` | Opens the file at `<path>`. Shows the diff if Claude changed it in its last turn, or the whole file otherwise.        |

Redpen takes keyboard focus when it opens. Press `Esc` to return to the prompt and `Ctrl+X` `Tab` to switch back to Redpen. Press `Ctrl+X` `X` to close it.

### Browsing the list

The list has two sections:
- `최근 수정` (recently changed): files Claude changed in its last turn. Open one to see the diff from that turn.
- `전송 대기` (pending): files with comments, in the order you first commented on them.

The list is cleared after `/clear`, `/resume`, or restarting Claude.

| Hotkey      | Action                       |
| ----------- | ---------------------------- |
| ↑↓, `Enter` | Select an entry and open it  |
| `1`         | Open another file            |
| `0`         | Open the confirmation screen |

Press `1` (파일 열기) to replace the hotkey bar with a path input. Enter a path the same way as with `/redpen <path>` and press Enter to open it. Pressing Enter on an empty input closes it, and paths that aren't files won't open. While the input is empty, it suggests files changed in this session (most recent first, marked `↺`); once you start typing, it suggests matching paths. Use ↓ to move to a suggestion and Enter to select it.

### Reviewing a document

| Hotkey | Action                                                                     |
| ------ | -------------------------------------------------------------------------- |
| `1`    | Back to the list                                                           |
| `2`    | Toggle between changes only (diff) and the whole file                      |
| `3`    | Start a range at the current line. Press Enter to comment on it, or `3` again to cancel |
| `0`    | Open the confirmation screen                                               |

To write a comment, press `Enter` to open the input and `Enter` again to save. Pressing `Enter` on an empty input cancels.

Each line can have one comment. A range comment is attached to the last line of the range. Press `Enter` on a line that already has a comment to edit it.

Comments on lines that aren't visible in the diff appear under `표시되지 않은 코멘트 N개` (N comments not shown). Press Enter on one to edit it.

### Sending

Press `0` on the list or a document to open the confirmation screen.

| Hotkey  | Action                                                       |
| ------- | ------------------------------------------------------------ |
| ↑↓      | Move between comments                                        |
| `Enter` | Edit the selected comment in place                           |
| `1`     | Return to the previous screen without sending                |
| `2`     | Jump to the comment in its document                          |
| `0`     | Send all comments to Claude as one prompt and return to the list |

When you send, Claude receives a prompt like this:

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

## Limitations and caveats

- The list includes files Claude changes with Edit, Write, or NotebookEdit. Files changed earlier in the session, or that have comments, also appear at the end of a turn if they're changed some other way (Bash, an MCP tool, or a subagent). Other files don't appear; open them with `1` or `/redpen <path>`.
- Files larger than 4 MiB can't be opened. Very large changes are shown as a single block of deleted lines followed by a single block of added lines.
- Notebook diffs show the raw `.ipynb` JSON.
- `Esc` doesn't cancel; it moves focus back to the prompt.
- Works in the terminal only. Mobile, the VS Code panel, `claude -p`, and WSL aren't supported.
