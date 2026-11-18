import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    Input,
    matchesKey,
    replaceControlCharacters,
    ScrollView,
    sliceByColumn,
    truncateToWidth,
    visibleWidth,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";

const contextStep = 5;
const maxOutput = 4 * 1024 * 1024;
const isFileHeader = (line: string) => /^diff --(git|cc|combined) /.test(line);
const safeText = (text: string) => replaceControlCharacters(text.replaceAll("\t", "    "));

// Context changes can merge hunks. Track source lines, not hunk numbers.
function* sourceRows(lines: string[], file: number) {
    let oldLine = 0, newLine = 0, inHunk = false;
    let oldPath = "", newPath = "";
    for (let row = file + 1; row < lines.length; row++) {
        const line = lines[row];
        if (isFileHeader(line) || line.startsWith("──")) break;
        if (!inHunk && line.startsWith("--- ")) oldPath = line.slice(4).trimEnd();
        if (!inHunk && line.startsWith("+++ ")) newPath = line.slice(4).trimEnd();
        if (line.startsWith("@@")) {
            const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
            inHunk = !!range;
            if (range) { oldLine = Number(range[1]); newLine = Number(range[2]); }
        } else if (inHunk && /^[ +\-]/.test(line)) {
            yield { row, oldLine, newLine, kind: line[0], path: line[0] === "-" ? oldPath : newPath };
            if (line[0] !== "+") oldLine++;
            if (line[0] !== "-") newLine++;
        }
    }
}

function restorePosition(before: string[], after: string[], top: number) {
    // A partially staged file has two patches with the same Git header.
    const section = before.findLastIndex((line, i) => i <= top && line.startsWith("──"));
    if (section < 0) return top;
    let file = before.findLastIndex((line, i) => i <= top && isFileHeader(line));
    if (file < section) file = section + 1; // The section title precedes its first patch.
    let group = "";
    const nextFile = after.findIndex((line) => {
        if (line.startsWith("──")) group = line;
        return group === before[section] && line === before[file];
    });
    if (nextFile < 0) return Math.max(0, after.indexOf(before[section]));
    const fallback = nextFile + top - file;
    for (const anchor of sourceRows(before, file)) {
        if (anchor.row < top) continue;
        // Patch metadata stays relative to the file header; a hunk header
        // follows its first source line even when two hunks become one.
        if (anchor.row !== top && !before[top].startsWith("@@")) return fallback;
        const side = anchor.kind === "-" ? "oldLine" : "newLine";
        let nearest = nextFile, distance = Infinity;
        for (const candidate of sourceRows(after, nextFile)) {
            // At context zero the original line may be hidden. Prefer an
            // exact match, otherwise keep the nearest surviving change.
            const delta = 2 * Math.abs(candidate[side] - anchor[side]) + Number(candidate.kind !== anchor.kind);
            if (delta < distance) { nearest = candidate.row; distance = delta; }
            if (delta === 0) break;
        }
        return Math.max(nextFile, nearest - (anchor.row - top));
    }
    return fallback;
}

async function loadDiff(pi: ExtensionAPI, cwd: string, context: number, signal: AbortSignal) {
    let remaining = maxOutput;
    const lines: string[] = [];
    const git = async (args: string[], allowDifference = false) => {
        signal.throwIfAborted();
        const result = await pi.exec("git", ["--no-optional-locks", "-c", "core.quotePath=false", ...args], {
            cwd,
            signal,
            timeout: 15_000,
            maxBuffer: remaining,
        });
        signal.throwIfAborted();
        if (!result.truncated && (result.killed || (result.code !== 0 && !(allowDifference && result.code === 1 && !result.stderr)))) {
            throw new Error(result.killed ? "Git timed out. Press r to retry." : safeText(result.stderr.trim() || "Git failed."));
        }
        return result;
    };

    const root = await git(["rev-parse", "--show-toplevel"]);
    cwd = root.stdout.replace(/\r?\n$/, "");
    const review = { lines, root: cwd };
    const diffOptions = [`--unified=${context}`, "--no-ext-diff", "--no-textconv", "--color=never", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"];
    const append = (title: string, result: { stdout: string; truncated?: boolean }) => {
        remaining -= Buffer.byteLength(result.stdout);
        if (result.stdout) {
            lines.push("", `── ${title} ──`);
            for (const line of result.stdout.replace(/\n$/, "").split("\n")) {
                if (lines.length >= 100_000) break;
                lines.push(safeText(line));
            }
        }
        if (result.truncated || remaining <= 0 || lines.length >= 100_000) {
            lines.push("", "Review truncated at 4 MiB or 100,000 lines; remaining changes are not shown.");
            return false;
        }
        return true;
    };

    if (!append("Staged · HEAD → index", await git(["diff", "--cached", ...diffOptions, "--"]))) return review;
    if (!append("Unstaged · index → working tree", await git(["diff", ...diffOptions, "--"]))) return review;
    const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (untracked.truncated) {
        lines.push("", "Untracked file list is too large; untracked files are not shown.");
        return review;
    }
    for (const path of untracked.stdout.split("\0").filter(Boolean)) {
        signal.throwIfAborted();
        const directory = (await lstat(resolve(cwd, path))).isDirectory();
        const result = directory
            ? { stdout: `diff --git a/${safeText(path)} b/${safeText(path)}\nUntracked directory; contents not expanded\n` }
            : await git(["diff", "--no-index", ...diffOptions, "--", "/dev/null", path], true);
        // Git emits no patch for an empty untracked file.
        if (!result.stdout) result.stdout = `diff --git a/${safeText(path)} b/${safeText(path)}\nNew empty file\n`;
        if (!append("Untracked · new file", result)) return review;
    }
    if (!lines.length) lines.push("No uncommitted changes.");
    return review;
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("diff", {
        description: "Review all uncommitted Git changes inside Pi: /diff [directory]",
        handler: async (args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("/diff requires interactive Pi.", "error");
                return;
            }
            let directory = args.trim();
            if (/^(["']).*\1$/.test(directory)) directory = directory.slice(1, -1);
            if (directory === "~" || directory.startsWith("~/")) directory = homedir() + directory.slice(1);
            const cwd = resolve(ctx.cwd, directory || ".");

            const review = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
                let lines = ["Loading changes…"];
                let context = contextStep;
                let root = cwd;
                let cursor = 0;
                let focused = false;
                let input: Input | undefined;
                let discard = false;
                const locations = new Map<number, string>();
                const comments = new Map<string, { location: string; snippet: string; text: string }>();
                const keyFor = (row: number) => locations.get(row) + "\0" + lines[row];
                let files: number[] = [];
                let hunks: number[] = [];
                let loading = false;
                let failed = false;
                let limited = false;
                let closed = false;
                let controller: AbortController | undefined;
                let column = 0;
                let maxColumn = 0;
                let cached: string[] | undefined;
                let cachedWidth = 0;
                let added = 0;
                let removed = 0;
                const invalidate = () => { cached = undefined; };
                const repaint = () => { invalidate(); tui.requestRender(); };
                const content = {
                    invalidate,
                    render(width: number) {
                        if (cached && cachedWidth === width) return cached;
                        cachedWidth = width;
                        cached = lines.map((line) => {
                            const text = sliceByColumn(line, column, width, true);
                            if (isFileHeader(line) || line.startsWith("──")) return theme.fg("accent", theme.bold(text));
                            if (line.startsWith("@@")) return theme.fg("accent", text);
                            if (line.startsWith("+")) return theme.fg("toolDiffAdded", text);
                            if (line.startsWith("-")) return theme.fg("toolDiffRemoved", text);
                            return theme.fg("toolDiffContext", text);
                        });
                        return cached;
                    },
                };
                const scroll = new ScrollView(content, { overscroll: "contain" });
                const select = (row: number) => {
                    cursor = Math.max(0, Math.min(row, lines.length - 1));
                    if (cursor < scroll.scrollTop) scroll.scrollTo(cursor);
                    else if (cursor >= scroll.scrollTop + scroll.viewportHeight) scroll.scrollTo(cursor - scroll.viewportHeight + 1);
                };
                const editComment = () => {
                    const location = locations.get(cursor);
                    if (!location) return;
                    const key = keyFor(cursor), snippet = lines[cursor];
                    input = new Input({ prompt: "Comment: " });
                    input.focused = focused;
                    input.setValue(comments.get(key)?.text ?? "");
                    input.onSubmit = (value) => {
                        const text = value.trim();
                        if (text) comments.set(key, { location, snippet, text });
                        else comments.delete(key);
                        input = undefined;
                    };
                    input.onEscape = () => { input = undefined; };
                };
                const refresh = async (keepPosition = false) => {
                    controller?.abort();
                    const current = new AbortController();
                    controller = current;
                    loading = true;
                    failed = false;
                    repaint();
                    try {
                        const next = await loadDiff(pi, cwd, context, current.signal);
                        if (closed || current.signal.aborted) return;
                        const offset = cursor - scroll.scrollTop;
                        const selected = keepPosition ? restorePosition(lines, next.lines, cursor) : 0;
                        lines = next.lines;
                        root = next.root;
                        scroll.updateLayout(lines.length, scroll.viewportHeight, () => tui.requestRender());
                        scroll.scrollTo(keepPosition ? selected - offset : 0);
                        select(selected);
                        locations.clear();
                        files = [];
                        hunks = [];
                        added = removed = 0;
                        let section = "", inHunk = false;
                        lines.forEach((line, i) => {
                            if (isFileHeader(line)) {
                                files.push(i);
                                inHunk = false;
                                for (const anchor of sourceRows(lines, i)) {
                                    const old = anchor.kind === "-";
                                    const path = anchor.path.replace(/^[ab]\//, "");
                                    locations.set(anchor.row, `${path}:${old ? anchor.oldLine : anchor.newLine} (${section}, ${old ? "old" : "new"})`);
                                }
                            } else if (line.startsWith("──")) {
                                section = line.slice(3).split(" · ")[0];
                                inHunk = false;
                            } else if (line.startsWith("@@")) { hunks.push(i); inHunk = true; }
                            else if (inHunk && line.startsWith("+")) added++;
                            else if (inHunk && line.startsWith("-")) removed++;
                        });
                        limited = lines.some((line) => /^(Review truncated|Untracked file list)/.test(line));
                        maxColumn = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
                    } catch (error) {
                        if (closed || current.signal.aborted) return;
                        failed = true;
                        limited = false;
                        lines = [safeText(error instanceof Error ? error.message : String(error)), "", `Directory: ${safeText(cwd)}`, "Start Pi in a Git repository, or use /diff /path/to/project."];
                        files = [];
                        hunks = [];
                        added = removed = 0;
                        maxColumn = cursor = 0;
                        locations.clear();
                        scroll.scrollToStart();
                    } finally {
                        if (!closed && controller === current) {
                            loading = false;
                            column = keepPosition ? Math.min(column, maxColumn) : 0;
                            repaint();
                        }
                    }
                };
                const jump = (positions: number[], backwards: boolean) => {
                    const position = backwards
                        ? positions.findLast((line) => line < cursor)
                        : positions.find((line) => line > cursor);
                    if (position !== undefined) { scroll.scrollTo(position); select(position); }
                };
                void refresh();

                return {
                    invalidate,
                    get focused() { return focused; },
                    set focused(value: boolean) { focused = value; if (input) input.focused = value; },
                    dispose() { closed = true; controller?.abort(); },
                    handleInput(data: string) {
                        if (input) {
                            input.handleInput(data);
                            tui.requestRender();
                            return;
                        }
                        if (discard) {
                            if (matchesKey(data, "y")) done(undefined);
                            discard = false;
                            tui.requestRender();
                            return;
                        }
                        if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
                            if (!comments.size) done(undefined);
                            else { discard = true; tui.requestRender(); }
                            return;
                        }
                        if (matchesKey(data, "enter")) {
                            if (comments.size) done([
                                `My diff review for ${safeText(root)}:`,
                                ...Array.from(comments.values(), ({ location, snippet, text }) => `${location}\n  ${snippet}\n  Comment: ${text}`),
                            ].join("\n\n"));
                            return;
                        }
                        if (matchesKey(data, "r")) { void refresh(); return; }
                        if (loading) return;
                        if (matchesKey(data, "c")) { editComment(); tui.requestRender(); return; }
                        if (matchesKey(data, "+") || matchesKey(data, "-")) {
                            const next = Math.max(0, context + (matchesKey(data, "+") ? contextStep : -contextStep));
                            if (context !== next) { context = next; void refresh(true); }
                            return;
                        }
                        const previousColumn = column;
                        if (keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) select(cursor + 1);
                        else if (keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) select(cursor - 1);
                        else if (keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, "space")) select(cursor + scroll.viewportHeight);
                        else if (keybindings.matches(data, "tui.select.pageUp")) select(cursor - scroll.viewportHeight);
                        else if (matchesKey(data, "home") || matchesKey(data, "g")) select(0);
                        else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) select(lines.length - 1);
                        else if (matchesKey(data, "n") || matchesKey(data, "tab")) jump(files, false);
                        else if (matchesKey(data, "p") || matchesKey(data, "shift+tab")) jump(files, true);
                        else if (matchesKey(data, "]")) jump(hunks, false);
                        else if (matchesKey(data, "[")) jump(hunks, true);
                        else if (matchesKey(data, "right") || matchesKey(data, "l")) column = Math.min(maxColumn, column + 8);
                        else if (matchesKey(data, "left") || matchesKey(data, "h")) column = Math.max(0, column - 8);
                        if (column !== previousColumn) invalidate();
                        tui.requestRender();
                    },
                    handleMouse(event: TuiMouseEvent) {
                        if (input || discard || loading) return undefined;
                        if (event.type === "press" && event.button === "left" && event.y >= 4 && event.y < 4 + scroll.viewportHeight) {
                            select(scroll.scrollTop + event.y - 4);
                            tui.requestRender();
                            return { handled: true };
                        }
                        if (event.type === "wheel") {
                            const offset = cursor - scroll.scrollTop;
                            scroll.scrollBy(event.wheelDelta ?? 0);
                            select(scroll.scrollTop + offset);
                            tui.requestRender();
                            return { handled: true };
                        }
                        return undefined;
                    },
                    render(width: number) {
                        const height = Math.max(1, tui.terminal.rows - 10);
                        const innerWidth = Math.max(0, width - 2);
                        const row = (text: string) => {
                            const clipped = truncateToWidth(text, innerWidth, "");
                            return truncateToWidth(theme.fg("border", "│") + clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))) + theme.fg("border", "│"), width, "");
                        };
                        scroll.updateLayout(lines.length, height, () => tui.requestRender());
                        select(cursor);
                        const file = files.length ? Math.max(0, files.findLastIndex((line) => line <= cursor)) : -1;
                        const status = loading ? "Loading…" : failed ? "Could not load changes" : `${files.length} patches · +${added} −${removed}${limited ? " · PARTIAL" : ""}`;
                        const title = ` Diff · context ${context} · ${status}`;
                        const filename = file >= 0 ? lines[files[file]].replace(/^diff --(git|cc|combined) /, "") : safeText(cwd);
                        const position = ` ${file >= 0 ? `Patch ${file + 1}/${files.length} · ` : ""}Line ${cursor + 1}/${lines.length} · column ${column + 1}`;
                        const body = loading ? [theme.fg("muted", "Loading changes… (Esc to cancel)")] : scroll.render(Math.max(1, innerWidth - 2)).slice(scroll.scrollTop, scroll.scrollTop + height);
                        return [
                            truncateToWidth(theme.fg("border", "╭" + "─".repeat(innerWidth) + "╮"), width, ""),
                            row(theme.fg("accent", theme.bold(title))),
                            row(theme.fg("muted", ` ${loading ? safeText(cwd) : filename}`)),
                            row(theme.fg("dim", locations.get(cursor) ?? position)),
                            ...Array.from({ length: height }, (_, i) => {
                                const index = scroll.scrollTop + i;
                                const marker = (index === cursor ? "›" : " ") + (comments.has(keyFor(index)) ? "*" : " ");
                                return row(theme.fg("accent", marker) + (body[i] ?? ""));
                            }),
                            input ? row(input.render(Math.max(1, innerWidth))[0]) : row(theme.fg("accent", discard
                                ? ` Discard ${comments.size} pending comment(s)? y: discard · any other key: keep reviewing`
                                : ` ${locations.has(cursor) && !loading ? "c: add/edit comment" : "Select a source line to comment"} · Enter: submit to chat (${comments.size})`)),
                            row(theme.fg("muted", input ? " Enter: save comment · Esc: cancel edit · save empty to remove" : " ↑↓/jk select · n/p file · PgUp/PgDn page · ←→ pan · [ ] hunk")),
                            row(theme.fg("muted", " +/- context · q/Esc close · r refresh")),
                            truncateToWidth(theme.fg("border", "╰" + "─".repeat(innerWidth) + "╯"), width, ""),
                        ];
                    },
                };
            }, {
                overlay: true,
                overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
                blocked: { kind: "question", message: "Reviewing Git changes" },
            });
            if (review) pi.sendUserMessage(review, { deliverAs: "followUp" });
        },
    });
}
