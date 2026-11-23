import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeText } from "./text.js";

const maxOutput = 4 * 1024 * 1024;

/** Load bounded patch sections for uncommitted changes. */
export async function loadDiff(pi: ExtensionAPI, cwd: string, context: number, signal: AbortSignal) {
    let remaining = maxOutput;
    const lines: string[] = [];
    /** Read within the remaining output budget, optionally accepting exit code 1 from a no-index diff. */
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
            throw new Error(result.killed ? "Git timed out." : safeText(result.stderr.trim() || "Git failed."));
        }
        return result;
    };

    const root = await git(["rev-parse", "--show-toplevel"]);
    cwd = root.stdout.replace(/\r?\n$/, "");
    const review = { lines, root: cwd };
    const diffOptions = [`--unified=${context}`, "--no-ext-diff", "--no-textconv", "--color=never", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"];
    /** Append sanitized patch lines; return false when the caller should stop collecting sections. */
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
