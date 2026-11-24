import type { ExtensionAPI, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

import { loadDiff } from "./git.js";
import { safeText } from "./text.js";
import { createViewport } from "./viewport.js";

const contextStep = 5;
const bodyStart = 2;

export function createReviewOverlay(
    pi: ExtensionAPI, cwd: string, tui: TUI, theme: Theme,
    keybindings: KeybindingsManager, done: (review: string | undefined) => void,
) {
    const view = createViewport(tui, theme, keybindings);
    const { scroll, invalidate, select, updateRows } = view;
    let context = contextStep;
    let root = cwd;
    let focused = false;
    let input: Input | undefined;
    let discard = false;
    let help = false;
    /** Look up the original display line, including its diff marker. */
    const snippetAt = (row: number) => view.lines[view.rows[row]?.raw];
    const comments = new Map<string, { location: string; snippet: string; text: string }>();
    /** Tie a draft to both its source location and its contents across refreshes. */
    const keyFor = (row: number) => view.rows[row]?.location + "\0" + snippetAt(row);
    let loading = false;
    let failed = false;
    let closed = false;
    let controller: AbortController | undefined;

    /** Open the selected source line's draft without changing it until submission. */
    const editComment = () => {
        const { rows, cursor } = view;
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

    let poll: ReturnType<typeof setTimeout> | undefined;
    /** Replace any in-flight load; background polls skip unchanged patches and leave the view visible. */
    const refresh = async (keepPosition = false, background = false) => {
        clearTimeout(poll);
        controller?.abort();
        const current = new AbortController();
        controller = current;
        if (!background) {
            loading = true;
            tui.requestRender();
        }
        try {
            const next = await loadDiff(pi, cwd, context, current.signal);
            if (closed || current.signal.aborted) return;
            if (background && !failed && next.root === root && next.lines.length === view.lines.length &&
                next.lines.every((line, i) => line === view.lines[i])) return;
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
            view.navigate(data);
            tui.requestRender();
        },
        /** Select clicked source lines or scroll with the wheel when the review is active. */
        handleMouse(event: TuiMouseEvent) {
            if (help || input || discard || loading) return undefined;
            const { cursor, rows } = view;
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
        /** Draw the help screen or compose the framed viewport, row highlights, and footer. */
        render(width: number) {
            const { cursor, rows, files, added, removed } = view;
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
            let title = "";
            if (loading || failed) title = loading ? " Loading…" : " Could not load changes";
            else if (file >= 0) {
                const count = ` · ${file + 1}/${files.length}`;
                const pathWidth = Math.max(0, innerWidth - visibleWidth(" " + count));
                title = ` ${truncateToWidth(rows[files[file]].text, pathWidth)}${count}`;
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
                    const marker = commented ? theme.fg("accent", "*") : " ";
                    const line = marker + (body[i] ?? "");
                    const kind = !loading && rows[index]?.kind;
                    const bg = selected ? "selectedBg" : kind === "+" ? "toolSuccessBg" : kind === "-" ? "toolErrorBg" : undefined;
                    return row(bg ? theme.bg(bg, line) : line);
                }),
                ...(input ? [row(input.render(Math.max(1, innerWidth))[0])] : discard
                    ? [row(theme.fg("accent", ` Discard ${comments.size} pending comment(s)?`))] : []),
                row(theme.fg("muted", ` ${footer}`)),
                truncateToWidth(theme.fg("border", "╰" + "─".repeat(innerWidth) + "╯"), width, ""),
            ];
        },
    };
}
