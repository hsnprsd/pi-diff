# pi-diff

Review uncommitted Git changes inside Pi and send comments on specific lines to your current chat. The viewer is read-only: it does not edit, stage, or discard files.

## Get started

Run `pi install "$PWD"` from the extension checkout. In an interactive Pi session, run `/reload`. Then run `/diff` from anywhere in the repository you want to review.

The viewer shows the net change from the last commit to your working tree, including new files that Git does not ignore. Removed lines use the old file’s line numbers; added and unchanged lines use the new file’s.

## Review and comment

1. Use `↑` or `↓` to select a source line. Press `n` for the next file or `]` for the next hunk.
2. Press `c` to write a comment. **In the editor, `Enter` saves a draft** and `Esc` cancels the edit. A `*` marks a saved comment. Press `c` on that line to edit it, or save it empty to remove it.
3. **In the viewer, `Enter` sends all drafts** to chat as one message, with each comment’s file, line number, and snippet. To close without sending, press `q` or `Esc`. The viewer asks before discarding drafts.

The diff refreshes automatically. If a line changes while you review it, your draft keeps the location and text you originally saw.

## Useful shortcuts

| Action | Keys |
| --- | --- |
| Previous / next file | `N` / `n` |
| Previous / next hunk | `[` / `]` |
| Show more / fewer context lines | `+` / `-` |
| Pan across a long line | `←` / `→` |
| Show all keys and change totals | `?` |

For technical details, see [How `/diff` works](docs/architecture.md).
