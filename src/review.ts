import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Recognize the start of an ordinary or combined Git file patch. */
const isFileHeader = (line: string) => /^diff --(git|cc|combined) /.test(line);

type SourceRow = { row: number; oldLine: number; newLine: number; kind: " " | "+" | "-"; path: string };

/** Walk one patch from its file header, tracking source coordinates that survive changes in hunk context. */
function* sourceRows(lines: string[], file: number): Generator<SourceRow, void> {
    let oldLine = 0, newLine = 0, inHunk = false;
    let oldPath = "", newPath = "";
    for (let row = file + 1; row < lines.length; row++) {
        const line = lines[row];
        if (isFileHeader(line)) break;
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

/** Turn raw patch lines into display rows, retaining raw offsets and comment locations for source lines. */
export function formatReview(lines: string[]) {
    const rows: ReviewRow[] = [];
    let inHunk = false;
    let oldLang: string | undefined, newLang: string | undefined;
    let source: ReturnType<typeof sourceRows> | undefined;
    let anchor: SourceRow | void = undefined;
    for (const [raw, line] of lines.entries()) {
        let text = line, kind: ReviewRow["kind"] = "note";
        if (isFileHeader(line)) {
            kind = "file";
            inHunk = false;
            oldLang = newLang = undefined;
            text = line.replace(/^diff --(?:git|cc|combined) /, "");
            // Metadata-only patches have no ---/+++ paths. For the common
            // same-path header, match both halves (paths may contain spaces).
            const samePath = /^a\/(.+) b\/\1$/.exec(text);
            text = samePath?.[1] ?? text.replace(/^a\/(.+) b\/(.+)$/, "$1 → $2");
            source = sourceRows(lines, raw);
            anchor = source.next().value;
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
            const location = `${path.replace(/^[ab]\//, "")}:${number} (${old ? "old" : "new"})`;
            rows.push({ raw, kind, text: line.slice(1), lineNumber: String(number).padStart(4), location });
            anchor = source.next().value;
            continue;
        } else if (line.startsWith("Binary files ")) text = "Binary contents differ";
        else if (line.startsWith("\\ No newline")) text = line.slice(2);
        if (text || rows.length) rows.push(kind === "hunk" ? { raw, text, kind, oldLang, newLang } : { raw, text, kind });
    }
    return rows;
}

/** Highlight each hunk side separately and index the result by raw offset. Context rows use the new side. */
export function highlightHunks(rows: ReviewRow[]) {
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

/** Map a raw row into a refreshed patch, preferring the same source line in the same file. */
export function restorePosition(before: string[], after: string[], top: number) {
    const file = before.findLastIndex((line, i) => i <= top && isFileHeader(line));
    if (file < 0) return top;
    const nextFile = after.indexOf(before[file]);
    if (nextFile < 0) return 0;
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
