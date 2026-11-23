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
numbers; added and unchanged lines use the new file’s. Staged and untracked
patches are labeled in the All changes view; unlabeled patches show unstaged changes. Partially staged
files have a separate divider for each patch. Ignored untracked files are excluded. **All changes**
is the default view and refreshes every two seconds, keeping your place where possible.

Press `v` for **Last prompt**: compare the current working files with their contents when Pi
started processing your latest prompt. This includes manual edits since then, but not earlier
edits or staging-only changes. This view refreshes on entry, not on a timer. In trusted
repositories Pi uses a temporary Git index and object directory; nothing is staged, committed,
or stashed. Snapshots are discarded on the next prompt, session switch, reload, or exit.

| Key | Action |
| --- | --- |
| `?` | Show review keys, change totals, and context size; `?`, `q`, or `Esc` returns to the diff |
| `v` | Switch between All changes and Last prompt |
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
it. Drafts keep their original file, line, patch section, and snippet even if
you change context or the diff refreshes before you submit.

Context starts at 5 lines and can go down to zero. Adjust it to inspect adjacent code without leaving the patch;
nearby hunks merge when their context overlaps.

The viewer respects Pi's configured selection/navigation keys and supports mouse
wheel scrolling in fullscreen mode. Binary changes are identified without
rendering their contents. Reviews are capped at 4 MiB or 100,000 lines, with an
explicit notice when truncated. It never stages, edits, or discards files.
