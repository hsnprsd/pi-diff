import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, sliceByColumn, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

import { formatReview, highlightHunks, restorePosition } from "./review.js";

export function createViewport(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
    let lines = ["Loading changes…"];
    let rows = formatReview(lines);
    let cursor = 0;
    let firstSource = -1, lastSource = -1;
    let files: number[] = [];
    let hunks: number[] = [];
    let column = 0;
    let maxColumn = 0;
    let cached: string[] | undefined;
    let cachedWidth = 0;
    let added = 0;
    let removed = 0;
    let syntax: Map<number, string> | undefined;
    /** Drop the rendered rows and syntax colors so the next render rebuilds both. */
    const invalidate = () => { cached = syntax = undefined; };
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
                return kind === "hunk" ? theme.fg("muted", body) : body;
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
        invalidate();
        tui.requestRender();
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
    const navigate = (data: string) => {
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
    };

    return {
        scroll, invalidate, updateRows, navigate, select,
        get rows() { return rows; },
        get lines() { return lines; },
        get cursor() { return cursor; },
        get files() { return files; },
        get added() { return added; },
        get removed() { return removed; },
    };
}
