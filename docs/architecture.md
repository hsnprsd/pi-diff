# How `/diff` works

[`diff.ts`](../diff.ts) registers `/diff` for interactive Pi sessions. The command opens a full-screen overlay and waits for it to return either a review message or `undefined`. Only a review message goes to the current chat. The extension does not write to the working tree or the Git index.

## Build the patch

[`loadDiff` in `src/git.ts`](../src/git.ts) finds the repository root with `git rev-parse --show-toplevel`. It runs the remaining commands there, so a review opened from a subdirectory still covers the entire repository.

- **Tracked files:** `git diff --unified=<context> <base> --` compares the working tree with `HEAD`, or with the empty tree before the first commit. This shows the net change. For example, if an unstaged edit reverses a staged edit, the two edits do not appear as separate changes.
- **Untracked files:** `git ls-files --others --exclude-standard -z` lists paths that Git does not ignore. The loader splits this list at NUL characters, not spaces or newlines. For each file, it runs `git diff --no-index` against `/dev/null`. Exit code 1 with no standard error means the files differ. If Git returns no patch, the loader adds an empty-file note. If a listed path is a directory, the loader adds a note instead of opening it.

The loader disables external diff programs, text conversion, and Git colors. It splits patch output into lines and passes each line through [`safeText`](../src/text.ts), which expands tabs to four spaces and replaces control characters for terminal display. Each Git command has a 15-second timeout. Truncated output is an error; the viewer does not present a partial patch as a complete review.

## Map patch rows to source lines

[`formatReview` in `src/review.ts`](../src/review.ts) converts patch lines into display rows. Each row keeps its index in the sanitized patch (`raw`). This index differs from the display index because the viewer hides metadata such as `---` and `+++`. It also differs from the source line number used in a comment.

For an ordinary `@@ -old +new @@` hunk, the parser starts two counters at the line numbers in the header. It assigns a location **before** it advances the counters:

| Patch marker | Location used for comments | Counters advanced |
| --- | --- | --- |
| `-` | Old path and old line | Old |
| `+` | New path and new line | New |
| Space | New path and new line | Both |

For example, if both counters start at 12, a removal followed by an addition produces two distinct locations: `file.ts:12 (old)` and `file.ts:12 (new)`. File dividers, hunk headers, and notes have no source location. Binary patches can therefore be visible without any line that accepts a comment.

`highlightHunks` reconstructs each side of a hunk separately. This prevents removed code from changing the syntax colors of added code. Context lines use the new side's colors. A side stays plain if its language is unknown or its text exceeds the size limit (65,536 UTF-16 code units, counting one separator per line).

## Keep the selection across refreshes

[`src/overlay.ts`](../src/overlay.ts) schedules the next background load two seconds after the current load finishes. If the repository root and patch lines have not changed since the last successful load, it skips the rebuild. A context change starts a new load and aborts the previous one. Closing the overlay cancels the timer and aborts any active load.

When a rebuild is necessary, `restorePosition` looks for the same file header, then the nearest source line number on the selected side. It prefers the same patch marker when line numbers match. This lets the selection follow a line even when a change in context merges two hunks. If the file header disappears, the search falls back to the start of the patch.

[`src/viewport.ts`](../src/viewport.ts) maps the result back to a display row and tries to keep the cursor at its previous vertical offset. It indexes file and hunk headers for navigation. It caches syntax colors separately from rendered rows, so horizontal scrolling can clip the text again without repeating syntax highlighting.

## Keep comments attached to the reviewed text

The overlay stores drafts in memory. Each key contains the source location, a NUL separator, and the original sanitized patch line, including its marker. Unlike the cursor, a draft does **not** move to the nearest line on refresh. If different text appears at the same location, it does not inherit the comment marker. The original draft remains available for submission.

`Enter` in the comment editor saves the draft; an empty value removes it. `Enter` in the review returns all saved drafts as one message with their original locations and snippets. The command sends that message with `deliverAs: "followUp"`. Closing with pending drafts requires confirmation and sends nothing.
