import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    Input,
    matchesKey,
    ScrollView,
    sliceByColumn,
    truncateToWidth,
    visibleWidth,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";

import { loadDiff } from "./src/git.js";
import { formatReview, highlightHunks, restorePosition } from "./src/review.js";
import { safeText } from "./src/text.js";

const contextStep = 5;
const bodyStart = 2;

export default function (pi: ExtensionAPI) {
    pi.registerCommand("diff", {
        description: "Review all uncommitted Git changes",
        /** Open the interactive review and send submitted comments as one follow-up message. */
        handler: async (args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("/diff requires interactive Pi.", "error");
                return;
            }
            const cwd = ctx.cwd;

            // Each overlay owns its selection, pending comments, and refresh lifecycle.
            const review = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
                let lines = ["Loading changes…"];
                let rows = formatReview(lines);
                let context = contextStep;
                let root = cwd;
                let cursor = 0;
                let firstSource = -1, lastSource = -1;
                let focused = false;
                let input: Input | undefined;
                let discard = false;
                let help = false;
                /** Look up the original display line, including its diff marker. */
                const snippetAt = (row: number) => lines[rows[row]?.raw];
                const comments = new Map<string, { location: string; snippet: string; text: string }>();
                /** Tie a draft to both its source location and its contents across refreshes. */
                const keyFor = (row: number) => rows[row]?.location + "\0" + snippetAt(row);
                let files: number[] = [];
                let hunks: number[] = [];
                let loading = false;
                let failed = false;
                let closed = false;
                let controller: AbortController | undefined;
                let column = 0;
                let maxColumn = 0;
                let cached: string[] | undefined;
                let cachedWidth = 0;
                let added = 0;
                let removed = 0;
                let syntax: Map<number, string> | undefined;
                /** Drop the rendered rows and syntax colors so the next render rebuilds both. */
                const invalidate = () => { cached = syntax = undefined; };
                /** Invalidate the content and schedule a terminal redraw. */
                const repaint = () => { invalidate(); tui.requestRender(); };
                const content = {
                    invalidate,
                    /** Render the horizontally clipped patch rows for the scroll view, caching by width. */
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
                /** Move to a selectable line in the requested direction and scroll it into view. */
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
                /** Open the selected source line's draft without changing it until submission. */
                const editComment = () => {
                    const location = rows[cursor]?.location;
                    if (!location) return;
                    const key = keyFor(cursor), snippet = snippetAt(cursor);
                    input = new Input({ prompt: "Comment: " });
                    input.focused = focused;
                    input.setValue(comments.get(key)?.text ?? "");
                    // Saving an empty comment removes an existing draft.
                    input.onSubmit = (value) => {
                        const text = value.trim();
                        if (text) comments.set(key, { location, snippet, text });
                        else comments.delete(key);
                        input = undefined;
                    };
                    // Cancel the edit without touching the saved draft.
                    input.onEscape = () => { input = undefined; };
                };
                /** Rebuild navigation and layout from new lines, optionally restoring the cursor and viewport offset. */
                const updateRows = (next: string[], keepPosition: boolean) => {
                    const offset = cursor - scroll.scrollTop;
                    const anchor = keepPosition ? restorePosition(lines, next, rows[cursor].raw) : 0;
                    lines = next;
                    rows = formatReview(lines);
                    firstSource = rows.findIndex(row => !!row.location);
                    lastSource = rows.findLastIndex(row => !!row.location);
                    files = [];
                    hunks = [];
                    added = removed = maxColumn = 0;
                    rows.forEach(({ kind, lineNumber, text }, i) => {
                        if (kind === "file") files.push(i);
                        else if (kind === "hunk") hunks.push(i);
                        else if (kind === "+") added++;
                        else if (kind === "-") removed++;
                        maxColumn = Math.max(maxColumn, (lineNumber ? lineNumber.length + 3 : 0) + visibleWidth(text));
                    });
                    column = keepPosition ? Math.min(column, maxColumn) : 0;
                    const selected = Math.max(0, rows.findLastIndex(row => row.raw <= anchor));
                    scroll.updateLayout(rows.length, scroll.viewportHeight, () => tui.requestRender());
                    scroll.scrollTo(keepPosition ? selected - offset : 0);
                    select(selected, 1);
                    repaint();
                };
                let poll: ReturnType<typeof setTimeout> | undefined;
                /** Replace any in-flight load; background polls skip unchanged patches and leave the view visible. */
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
                        const next = await loadDiff(pi, cwd, context, current.signal);
                        if (closed || current.signal.aborted) return;
                        if (background && !failed && next.root === root && next.lines.length === lines.length &&
                            next.lines.every((line, i) => line === lines[i])) return;
                        failed = false;
                        root = next.root;
                        updateRows(next.lines, keepPosition);
                    } catch (error) {
                        if (closed || current.signal.aborted) return;
                        failed = true;
                        updateRows([safeText(error instanceof Error ? error.message : String(error))], false);
                    } finally {
                        if (!closed && controller === current) {
                            loading = false;
                            poll = setTimeout(() => void refresh(true, true), 2_000);
                        }
                    }
                };
                /** Jump between file or hunk headers, skipping groups without selectable lines when possible. */
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
                    /** Report whether the overlay has keyboard focus. */
                    get focused() { return focused; },
                    /** Forward overlay focus changes to the active comment editor. */
                    set focused(value: boolean) { focused = value; if (input) input.focused = value; },
                    /** Stop polling and prevent pending loads from updating the closed overlay. */
                    dispose() { closed = true; clearTimeout(poll); controller?.abort(); },
                    /** Route keys to the active editor or dialog before handling review actions. */
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
                        const close = matchesKey(data, "q") || keybindings.matches(data, "tui.select.cancel");
                        if (matchesKey(data, "?") || (help && close)) {
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
                    /** Select clicked source lines or scroll with the wheel when the review is active. */
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
                    /** Draw the help screen or compose the framed viewport, selection markers, and footer. */
                    render(width: number) {
                        const innerWidth = Math.max(0, width - 2);
                        const footer = input ? "Enter save · Esc cancel · save empty to remove"
                            : discard ? "y discard · any other key keep reviewing"
                            : ["? keys", "q/Esc close", !loading && rows[cursor]?.location && "c comment",
                                comments.size > 0 && `Enter submit (${comments.size})`].filter(Boolean).join(" · ");
                        const height = Math.max(1, tui.terminal.rows - bodyStart - 4 - Number(!!input || discard));
                        /** Clip and pad a line to fit between the overlay borders. */
                        const row = (text: string) => {
                            const clipped = truncateToWidth(text, innerWidth, "");
                            return truncateToWidth(theme.fg("border", "│") + clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))) + theme.fg("border", "│"), width, "");
                        };
                        if (help) return [
                            `Review details · context ${context}${loading || failed ? "" : ` · ${files.length} patches · +${added} −${removed}`}`,
                            "Review keys", "↑↓ / k j   Select line", "PgUp PgDown / u d   Page up/down",
                            "Home End / g G   First/last line", "←→ / h l   Pan", "n N / Tab Shift+Tab   Next/previous file (p: previous)",
                            "[ ]   Previous/next hunk", "+ -   Adjust context",
                            "c   Add/edit comment", "Enter   Submit pending comments to chat", "q / Esc   Close review",
                            "? / q / Esc   Back to review",
                        ].map(line => row(` ${line}`));
                        scroll.updateLayout(rows.length, height, () => tui.requestRender());
                        select(cursor);
                        const file = files.length ? Math.max(0, files.findLastIndex((line) => line <= cursor)) : -1;
                        const prefix = " All changes";
                        let title = prefix;
                        if (loading || failed) title += loading ? " · Loading…" : " · Could not load changes";
                        else if (file >= 0) {
                            const count = ` · ${file + 1}/${files.length}`;
                            const pathWidth = Math.max(0, innerWidth - visibleWidth(prefix + " · " + count));
                            title += ` · ${truncateToWidth(rows[files[file]].text, pathWidth)}${count}`;
                        }
                        const bodyWidth = Math.max(1, innerWidth - 1);
                        const body = loading ? [theme.fg("muted", "Loading changes… (q/Esc to close)")] : scroll.render(bodyWidth).slice(scroll.scrollTop, scroll.scrollTop + height);
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
