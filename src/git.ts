import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeText } from "./text.js";

/** Load patches for uncommitted changes. */
export async function loadDiff(pi: ExtensionAPI, cwd: string, context: number, signal: AbortSignal) {
    const lines: string[] = [];
    /** Run Git, optionally accepting exit code 1 from a no-index diff. */
    const git = async (args: string[], allowDifference = false) => {
        signal.throwIfAborted();
        const result = await pi.exec("git", args, {
            cwd,
            signal,
            timeout: 15_000,
        });
        signal.throwIfAborted();
        if (result.truncated) throw new Error("Git output exceeded the execution buffer.");
        if (result.killed || (result.code !== 0 && !(allowDifference && result.code === 1 && !result.stderr))) {
            throw new Error(result.killed ? "Git timed out." : safeText(result.stderr.trim() || "Git failed."));
        }
        return result;
    };

    const root = await git(["rev-parse", "--show-toplevel"]);
    cwd = root.stdout.replace(/\r?\n$/, "");
    const review = { lines, root: cwd };
    const diffOptions = [`--unified=${context}`, "--no-ext-diff", "--no-textconv", "--color=never"];
    const append = ({ stdout }: { stdout: string }) => {
        if (!stdout) return;
        for (const line of stdout.replace(/\n$/, "").split("\n")) {
            lines.push(safeText(line));
        }
    };

    // Before the first commit, compare the working tree with an empty tree.
    const head = await git(["rev-parse", "--revs-only", "HEAD"]);
    const base = head.stdout.trim() || (await git(["hash-object", "-t", "tree", "/dev/null"])).stdout.trim();
    append(await git(["diff", ...diffOptions, base, "--"]));
    const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const path of untracked.stdout.split("\0").filter(Boolean)) {
        signal.throwIfAborted();
        const directory = (await lstat(resolve(cwd, path))).isDirectory();
        const result = directory
            ? { stdout: `diff --git a/${safeText(path)} b/${safeText(path)}\nUntracked directory; contents not expanded\n` }
            : await git(["diff", "--no-index", ...diffOptions, "--", "/dev/null", path], true);
        // Git emits no patch for an empty untracked file.
        if (!result.stdout) result.stdout = `diff --git a/${safeText(path)} b/${safeText(path)}\nNew empty file\n`;
        append(result);
    }
    if (!lines.length) lines.push("No uncommitted changes.");
    return review;
}
