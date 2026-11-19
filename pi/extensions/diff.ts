import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { getLanguageFromPath, highlightCode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    Input,
    matchesKey,
    replaceControlCharacters,
    ScrollView,
    sliceByColumn,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";

const contextStep = 5;
const bodyStart = 2;
const maxOutput = 4 * 1024 * 1024;
const isFileHeader = (line: string) => /^diff --(git|cc|combined) /.test(line);
const safeText = (text: string) => replaceControlCharacters(text.replaceAll("\t", "    "));

type SourceRow = { row: number; oldLine: number; newLine: number; kind: " " | "+" | "-"; path: string };

// Context changes can merge hunks. Track source lines, not hunk numbers.
function* sourceRows(lines: string[], file: number): Generator<SourceRow, void> {
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
            yield { row, oldLine, newLine, kind: line[0] as SourceRow["kind"], path: line[0] === "-" ? oldPath : newPath };
            if (line[0] !== "+") oldLine++;
            if (line[0] !== "-") newLine++;
        }
    }
}

type ReviewRow = {
    raw: number;
    text: string;
    kind: "file" | "hunk" | "note" | SourceRow["kind"];
    location?: string;
    lineNumber?: string;
    oldLang?: string;
    newLang?: string;
};

function formatReview(lines: string[]) {
    const rows: ReviewRow[] = [];
    let section = "", inHunk = false;
    let oldLang: string | undefined, newLang: string | undefined;
    let source: ReturnType<typeof sourceRows> | undefined;
    let anchor: SourceRow | void = undefined;
    for (const [raw, line] of lines.entries()) {
        let text = line, kind: ReviewRow["kind"] = "note";
        if (!line && /^(──|Review truncated|Untracked file list)/.test(lines[raw + 1] ?? "")) continue;
        if (isFileHeader(line)) {
            kind = "file";
            inHunk = false;
            oldLang = newLang = undefined;
            text = line.replace(/^diff --(?:git|cc|combined) /, "");
            // Metadata-only patches have no ---/+++ paths. For the common
            // same-path header, match both halves (paths may contain spaces).
            const samePath = /^a\/(.+) b\/\1$/.exec(text);
            text = samePath?.[1] ?? text.replace(/^a\/(.+) b\/(.+)$/, "$1 → $2");
            if (section === "Staged" || section === "Untracked") text += ` · ${section}`;
            source = sourceRows(lines, raw);
            anchor = source.next().value;
        } else if (line.startsWith("──")) {
            section = line.slice(3).split(" · ")[0];
            inHunk = false;
            continue;
        } else if (line.startsWith("@@")) {
            kind = "hunk";
            inHunk = true;
            text = line.replace(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s*(.*)$/, (_, old, next, scope) =>
                `Lines ${old} → ${next}${scope ? `  ·  ${scope}` : ""}`);
        } else if (!inHunk && /^(index |--- |\+\+\+ )/.test(line)) {
            if (line.startsWith("--- ")) oldLang = getLanguageFromPath(line.slice(4).trimEnd());
            if (line.startsWith("+++ ")) newLang = getLanguageFromPath(line.slice(4).trimEnd());
            continue;
        } else if (source && anchor && anchor.row === raw) {
            const { oldLine, newLine, path, kind } = anchor;
            const old = kind === "-", number = old ? oldLine : newLine;
            const location = `${path.replace(/^[ab]\//, "")}:${number} (${section}, ${old ? "old" : "new"})`;
            rows.push({ raw, kind, text: line.slice(1), lineNumber: String(number).padStart(4), location });
            anchor = source.next().value;
            continue;
        } else if (line.startsWith("Binary files ")) text = "Binary contents differ";
        else if (line.startsWith("\\ No newline")) text = line.slice(2);
        if (text || rows.length) rows.push(kind === "hunk" ? { raw, text, kind, oldLang, newLang } : { raw, text, kind });
    }
    return rows;
}

// Each side is a separate source fragment. Context participates in both parses,
// but is displayed using the new side's syntax (and line number).
function highlightHunks(rows: ReviewRow[]) {
    const colored = new Map<number, string>();
    for (let i = 0; i < rows.length; i++) {
        const hunk = rows[i];
        if (hunk.kind !== "hunk" || (!hunk.oldLang && !hunk.newLang)) continue;
        let end = i + 1;
        while (end < rows.length && rows[end].kind !== "hunk" && rows[end].kind !== "file") end++;
        const source = rows.slice(i + 1, end).filter(row => row.lineNumber);
        for (const old of [false, true]) {
            const lang = old ? hunk.oldLang : hunk.newLang;
            if (!lang || (old && !source.some(row => row.kind === "-"))) continue;
            const side = source.filter(row => row.kind !== (old ? "+" : "-"));
            // Keep generated files and minified bundles from blocking the overlay.
            if (!side.length || side.reduce((n, row) => n + row.text.length + 1, 0) > 64 * 1024) continue;
            const code = side.map(row => row.text).join("\n");
            const highlighted = wrapTextWithAnsi(highlightCode(code, lang).join("\n"), Infinity);
            side.forEach((row, index) => {
                if (!old || row.kind === "-") colored.set(row.raw, highlighted[index]);
            });
        }
        i = end - 1;
    }
    return colored;
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

type Snapshot = { root: string; dir: string; tree: string; env: string[] };
const removeTemp = (dir: string) => rm(dir, { recursive: true, force: true });

async function capture(pi: ExtensionAPI, cwd: string, signal?: AbortSignal, baselineDir?: string): Promise<Snapshot> {
    const git = async (args: string[], env: string[] = []) => {
        signal?.throwIfAborted();
        const result = await pi.exec("env", [...env, "git", "-c", "core.hooksPath=/dev/null", "-c", "core.splitIndex=false", "-c", "core.fsmonitor=false", ...args], { cwd, signal, timeout: 15_000, maxBuffer: maxOutput });
        if (result.code !== 0 || result.killed || result.truncated) throw new Error(result.stderr.trim() || "Could not capture Git snapshot.");
        return result.stdout.replace(/\r?\n$/, "");
    };
    cwd = await git(["rev-parse", "--show-toplevel"]);
    const gitPath = (name: string) => git(["rev-parse", "--path-format=absolute", "--git-path", name]);
    const [index, objects] = await Promise.all([gitPath("index"), gitPath("objects")]);
    const dir = await mkdtemp(join(tmpdir(), "pi-diff-"));
    try {
        if (dir.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep)) throw new Error("Snapshot directory must be outside the working tree.");
        const privateIndex = join(dir, "index");
        try { await copyFile(index, privateIndex); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } // Unborn repository
        const env = [`GIT_INDEX_FILE=${privateIndex}`, `GIT_OBJECT_DIRECTORY=${dir}`];
        const alternates = [baselineDir && JSON.stringify(baselineDir), JSON.stringify(objects), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(delimiter);
        env.push(`GIT_ALTERNATE_OBJECT_DIRECTORIES=${alternates}`);
        await git(["add", "-A", "--", "."], env);
        return { root: cwd, dir, env, tree: await git(["write-tree"], env) };
    } catch (error) {
        await removeTemp(dir);
        throw error;
    }
}

async function loadDiff(pi: ExtensionAPI, cwd: string, context: number, signal: AbortSignal, baseline?: Snapshot) {
    let remaining = maxOutput;
    const lines: string[] = [];
    const git = async (args: string[], allowDifference = false, env: string[] = []) => {
        signal.throwIfAborted();
        const result = await pi.exec("env", [...env, "git", "--no-optional-locks", "-c", "core.quotePath=false", ...args], {
            cwd,
            signal,
            timeout: 15_000,
            maxBuffer: remaining,
        });
        signal.throwIfAborted();
        if (!result.truncated && (result.killed || (result.code !== 0 && !(allowDifference && result.code === 1 && !result.stderr)))) {
            throw new Error(result.killed ? "Git timed out." : safeText(result.stderr.trim() || "Git failed."));
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

    if (baseline) {
        if (cwd !== baseline.root) throw new Error("The last prompt was in a different repository.");
        const current = await capture(pi, cwd, signal, baseline.dir);
        try {
            append("Last prompt · prompt start → working tree", await git(["diff", ...diffOptions, baseline.tree, current.tree, "--"], false, current.env));
            if (!lines.length) lines.push("No changes since the last prompt.");
            return review;
        } finally { await removeTemp(current.dir); }
    }
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
    let baseline: Snapshot | undefined;
    let unavailable = "No prompt snapshot yet. Send a prompt in this session first.";
    const clear = async () => {
        const previous = baseline;
        baseline = undefined;
        if (previous) await removeTemp(previous.dir);
    };
    pi.on("session_shutdown", clear);
    pi.on("message_start", async ({ message }, ctx) => {
        if (message.role !== "user" || ctx.mode !== "tui") return;
        await clear();
        try {
            if (!ctx.isProjectTrusted()) throw new Error("Project is not trusted.");
            baseline = await capture(pi, ctx.cwd, ctx.signal);
        } catch (error) {
            unavailable = `Last prompt snapshot unavailable: ${safeText(String(error))}`;
        }
    });
    pi.registerCommand("diff", {
        description: "Review all uncommitted Git changes or changes since the last prompt",
        handler: async (args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("/diff requires interactive Pi.", "error");
                return;
            }
            if (args.trim()) {
                ctx.ui.notify("/diff does not accept arguments. It uses the current repository.", "error");
                return;
            }
            const cwd = ctx.cwd;

            const review = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
                let lines = ["Loading changes…"];
                let rows = formatReview(lines);
                let lastPrompt = false;
                let context = contextStep;
                let root = cwd;
                let cursor = 0;
                let firstSource = -1, lastSource = -1;
                let focused = false;
                let input: Input | undefined;
                let discard = false;
                let help = false;
                const snippetAt = (row: number) => lines[rows[row]?.raw];
                const comments = new Map<string, { location: string; snippet: string; text: string }>();
                const keyFor = (row: number) => rows[row]?.location + "\0" + snippetAt(row);
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
                let syntax: Map<number, string> | undefined;
                const invalidate = () => { cached = syntax = undefined; };
                const repaint = () => { invalidate(); tui.requestRender(); };
                const content = {
                    invalidate,
                    render(width: number) {
                        if (cached && cachedWidth === width) return cached;
                        cachedWidth = width;
                        syntax ??= highlightHunks(rows);
                        cached = rows.map(({ kind, text, raw, lineNumber }) => {
                            if (kind === "file") {
                                const label = truncateToWidth(`─ ${text} `, width);
                                return theme.fg("accent", label) + theme.fg("border", "─".repeat(width - visibleWidth(label)));
                            }
                            const fg = kind === "+" ? "toolDiffAdded" : kind === "-" ? "toolDiffRemoved" : "toolDiffContext";
                            const content = lineNumber ? theme.fg("muted", lineNumber) + theme.fg(fg, ` ${kind} `) + (syntax?.get(raw) ?? text) : text;
                            const value = sliceByColumn(content, column, width, true);
                            const body = value + " ".repeat(Math.max(0, width - visibleWidth(value)));
                            return kind === "+" ? theme.bg("toolSuccessBg", body)
                                : kind === "-" ? theme.bg("toolErrorBg", body)
                                : kind === "hunk" ? theme.fg("muted", body) : body;
                        });
                        return cached;
                    },
                };
                const scroll = new ScrollView(content, { overscroll: "contain" });
                const select = (row: number, direction = row < cursor ? -1 : 1) => {
                    if (firstSource >= 0) {
                        cursor = Math.max(firstSource, Math.min(row, lastSource));
                        while (!rows[cursor].location) cursor += direction;
                    } else {
                        // No selectable lines (e.g. binary-only patches). Keep scrolling available.
                        cursor = Math.max(0, Math.min(row, rows.length - 1));
                    }
                    if (cursor < scroll.scrollTop) scroll.scrollTo(cursor);
                    else if (cursor >= scroll.scrollTop + scroll.viewportHeight) scroll.scrollTo(cursor - scroll.viewportHeight + 1);
                };
                const editComment = () => {
                    const location = rows[cursor]?.location;
                    if (!location) return;
                    const key = keyFor(cursor), snippet = snippetAt(cursor);
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
                let poll: ReturnType<typeof setTimeout> | undefined;
                const refresh = async (keepPosition = false, background = false) => {
                    clearTimeout(poll);
                    controller?.abort();
                    const current = new AbortController();
                    controller = current;
                    if (!background) {
                        loading = true;
                        repaint();
                    }
                    try {
                        const next = lastPrompt && !baseline ? { lines: [unavailable], root: cwd }
                            : await loadDiff(pi, cwd, context, current.signal, lastPrompt ? baseline : undefined);
                        if (closed || current.signal.aborted) return;
                        if (background && !failed && next.root === root && next.lines.length === lines.length &&
                            next.lines.every((line, i) => line === lines[i])) return;
                        failed = false;
                        const offset = cursor - scroll.scrollTop;
                        const anchor = keepPosition ? restorePosition(lines, next.lines, rows[cursor].raw) : 0;
                        lines = next.lines;
                        rows = formatReview(lines);
                        firstSource = rows.findIndex(row => !!row.location);
                        lastSource = rows.findLastIndex(row => !!row.location);
                        const selected = Math.max(0, rows.findLastIndex(row => row.raw <= anchor));
                        root = next.root;
                        scroll.updateLayout(rows.length, scroll.viewportHeight, () => tui.requestRender());
                        scroll.scrollTo(keepPosition ? selected - offset : 0);
                        select(selected, 1);
                        files = [];
                        hunks = [];
                        added = removed = 0;
                        rows.forEach(({ kind }, i) => {
                            if (kind === "file") files.push(i);
                            else if (kind === "hunk") hunks.push(i);
                            else if (kind === "+") added++;
                            else if (kind === "-") removed++;
                        });
                        limited = lines.some((line) => /^(Review truncated|Untracked file list)/.test(line));
                        maxColumn = rows.reduce((max, row) => Math.max(max, (row.lineNumber ? row.lineNumber.length + 3 : 0) + visibleWidth(row.text)), 0);
                        column = keepPosition ? Math.min(column, maxColumn) : 0;
                        repaint();
                    } catch (error) {
                        if (closed || current.signal.aborted) return;
                        failed = true;
                        limited = false;
                        lines = [safeText(error instanceof Error ? error.message : String(error))];
                        files = [];
                        hunks = [];
                        added = removed = 0;
                        firstSource = lastSource = -1;
                        maxColumn = cursor = 0;
                        rows = formatReview(lines);
                        scroll.scrollToStart();
                        column = 0;
                        repaint();
                    } finally {
                        if (!closed && controller === current) {
                            loading = false;
                            if (!lastPrompt) poll = setTimeout(() => void refresh(true, true), 2_000);
                        }
                    }
                };
                const jump = (positions: number[], backwards: boolean) => {
                    const step = backwards ? -1 : 1;
                    const current = positions.findLastIndex(row => row <= cursor);
                    for (let i = current + step; i >= 0 && i < positions.length; i += step) {
                        const header = positions[i];
                        let target = header;
                        if (firstSource >= 0) {
                            const end = positions[i + 1] ?? rows.length;
                            while (target < end && !rows[target].location) target++;
                            if (target === end) continue;
                        }
                        scroll.scrollTo(header);
                        select(target);
                        break;
                    }
                };
                void refresh();

                return {
                    invalidate,
                    get focused() { return focused; },
                    set focused(value: boolean) { focused = value; if (input) input.focused = value; },
                    dispose() { closed = true; clearTimeout(poll); controller?.abort(); },
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
                        const close = matchesKey(data, "q");
                        if (matchesKey(data, "?") || (help && (close || keybindings.matches(data, "tui.select.cancel")))) {
                            help = !help;
                            tui.requestRender();
                            return;
                        }
                        if (help) return;
                        if (close) {
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
                        if (matchesKey(data, "v")) { lastPrompt = !lastPrompt; void refresh(); return; }
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
                        else if (matchesKey(data, "d") || matchesKey(data, "pageDown")) select(cursor + scroll.viewportHeight);
                        else if (matchesKey(data, "u") || matchesKey(data, "pageUp")) select(cursor - scroll.viewportHeight);
                        else if (matchesKey(data, "home") || matchesKey(data, "g")) select(0);
                        else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) select(rows.length - 1);
                        else if (matchesKey(data, "n") || matchesKey(data, "tab")) jump(files, false);
                        else if (matchesKey(data, "shift+n") || matchesKey(data, "p") || matchesKey(data, "shift+tab")) jump(files, true);
                        else if (matchesKey(data, "]")) jump(hunks, false);
                        else if (matchesKey(data, "[")) jump(hunks, true);
                        else if (matchesKey(data, "right") || matchesKey(data, "l")) column = Math.min(maxColumn, column + 8);
                        else if (matchesKey(data, "left") || matchesKey(data, "h")) column = Math.max(0, column - 8);
                        if (column !== previousColumn) cached = undefined;
                        tui.requestRender();
                    },
                    handleMouse(event: TuiMouseEvent) {
                        if (help || input || discard || loading) return undefined;
                        const y = event.y - bodyStart;
                        if (event.type === "press" && event.button === "left" && y >= 0 && y < scroll.viewportHeight) {
                            const row = scroll.scrollTop + y;
                            if (rows[row]?.location) select(row);
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
                        const innerWidth = Math.max(0, width - 2);
                        const footer = input ? "Enter save · Esc cancel · save empty to remove"
                            : discard ? "y discard · any other key keep reviewing"
                            : ["? keys", "q close", !loading && rows[cursor]?.location && "c comment",
                                comments.size > 0 && `Enter submit (${comments.size})`].filter(Boolean).join(" · ");
                        const height = Math.max(1, tui.terminal.rows - bodyStart - 4 - Number(!!input || discard));
                        const row = (text: string) => {
                            const clipped = truncateToWidth(text, innerWidth, "");
                            return truncateToWidth(theme.fg("border", "│") + clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))) + theme.fg("border", "│"), width, "");
                        };
                        if (help) return [
                            `Review details · context ${context}${loading || failed ? "" : ` · ${files.length} patches · +${added} −${removed}${limited ? " · PARTIAL" : ""}`}`,
                            "Review keys", "↑↓ / k j   Select line", "PgUp PgDown / u d   Page up/down",
                            "Home End / g G   First/last line", "←→ / h l   Pan", "n N / Tab Shift+Tab   Next/previous file (p: previous)",
                            "[ ]   Previous/next hunk", "+ -   Adjust context", "v   Switch review view",
                            "c   Add/edit comment", "Enter   Submit pending comments to chat", "q   Close review",
                            "? / q / Esc   Back to review",
                        ].map(line => row(` ${line}`));
                        scroll.updateLayout(rows.length, height, () => tui.requestRender());
                        select(cursor);
                        const file = files.length ? Math.max(0, files.findLastIndex((line) => line <= cursor)) : -1;
                        const view = lastPrompt ? "Last prompt" : "All changes";
                        const prefix = ` ${limited && !loading ? "PARTIAL · " : ""}${view}`;
                        let title = prefix;
                        if (loading || failed) title += loading ? " · Loading…" : " · Could not load changes";
                        else if (file >= 0) {
                            const count = ` · ${file + 1}/${files.length}`;
                            const pathWidth = Math.max(0, innerWidth - visibleWidth(prefix + " · " + count));
                            title += ` · ${truncateToWidth(rows[files[file]].text, pathWidth)}${count}`;
                        }
                        const bodyWidth = Math.max(1, innerWidth - 1);
                        const body = loading ? [theme.fg("muted", "Loading changes… (q to close)")] : scroll.render(bodyWidth).slice(scroll.scrollTop, scroll.scrollTop + height);
                        return [
                            truncateToWidth(theme.fg("border", "╭" + "─".repeat(innerWidth) + "╮"), width, ""),
                            row(theme.fg("accent", theme.bold(title))),
                            ...Array.from({ length: height }, (_, i) => {
                                const index = scroll.scrollTop + i;
                                const selected = !loading && index === cursor && !!rows[index]?.location;
                                const commented = !loading && comments.has(keyFor(index));
                                const marker = commented ? "*" : selected ? "▶" : " ";
                                const styled = selected ? theme.fg("accent", theme.bold(marker)) : theme.fg("muted", marker);
                                return row(styled + (body[i] ?? ""));
                            }),
                            ...(input ? [row(input.render(Math.max(1, innerWidth))[0])] : discard
                                ? [row(theme.fg("accent", ` Discard ${comments.size} pending comment(s)?`))] : []),
                            row(theme.fg("muted", ` ${footer}`)),
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
