# pi-diff

A read-only Git diff viewer for interactive Pi sessions.

## Install

From the extension checkout, run:

```sh
pi install "$PWD"
```

### Reviewing changes

Run `/reload` once after installing, then `/diff` to open a read-only, colored
Git diff overlay for the current repository inside Pi. No external viewer or
additional package is needed. Each file patch starts with a labeled divider, followed by numbered source
lines and syntax highlighting for recognized file types. Added and removed lines
have distinct backgrounds. A `▶` in the left margin marks the selected source line; press `c` to comment on it. Removed lines use the old file’s line
numbers; added and unchanged lines use the new file’s. The viewer compares the working tree with the last commit. Each file has one patch, regardless of which hunks are staged. New files are included unless Git ignores them.
The diff refreshes every two seconds, keeping your place where possible.

| Key | Action |
| --- | --- |
| `?` | Show review keys, change totals, and context size; `?`, `q`, or `Esc` returns to the diff |
| `↑/↓` or `k/j` | Select the previous / next source line, skipping dividers, hunk headers, and notes |
| `PgUp` / `PgDown` or `u` / `d` | Page up / down |
| `Home/End` or `g/G` | Select the first / last source line |
| `←/→` or `h/l` | Pan long lines horizontally |
| `n` / `N` | Next / previous file patch (`Tab` goes forward; `p` or `Shift+Tab` goes back) |
| `]` / `[` | Next / previous hunk |
| `+` / `-` | Show 5 more / fewer unchanged lines on each side of a change |
| `c` | Add or edit a comment on the selected source line |
| `Enter` | Submit all pending comments as one message to the current Pi chat |
| `q` / `Esc` | Close without sending; confirm before discarding pending comments |

While writing a comment, `Enter` saves the draft and `Esc` cancels the edit.
Commented lines are marked with `*`, highlighted when selected. Edit a comment and save it empty to remove
it. Drafts keep their original file, line, side of the diff, and snippet even if
you change context or the diff refreshes before you submit.

Context starts at 5 lines and can go down to zero. Adjust it to inspect adjacent code without leaving the patch;
nearby hunks merge when their context overlaps.

The viewer respects Pi's configured selection/navigation keys and supports mouse
wheel scrolling in fullscreen mode. Binary changes are identified without
rendering their contents. It never stages, edits, or discards files.
