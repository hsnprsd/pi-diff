import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeText } from "./text.js";

/** Run Git in one directory. A no-index diff can exit with code 1. */
function gitRunner(pi: ExtensionAPI, cwd: string, signal: AbortSignal) {
    return async (args: string[], allowDifference = false) => {
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
        return result.stdout;
    };
}

function describeUntracked(path: string, message: string) {
    const name = safeText(path);
    return `diff --git a/${name} b/${name}\n${message}\n`;
}

/** Load patches for uncommitted changes. */
export async function loadDiff(pi: ExtensionAPI, cwd: string, context: number, signal: AbortSignal) {
    const localGit = gitRunner(pi, cwd, signal);
    const root = (await localGit(["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "");
    const git = gitRunner(pi, root, signal);
    const lines: string[] = [];
    const diffOptions = [`--unified=${context}`, "--no-ext-diff", "--no-textconv", "--color=never"];
    const append = (stdout: string) => {
        if (!stdout) return;
        for (const line of stdout.replace(/\n$/, "").split("\n")) {
            lines.push(safeText(line));
        }
    };

    // Before the first commit, compare the working tree with an empty tree.
    const head = await git(["rev-parse", "--revs-only", "HEAD"]);
    const base = head.trim() || (await git(["hash-object", "-t", "tree", "/dev/null"])).trim();
    append(await git(["diff", ...diffOptions, base, "--"]));
    const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const path of untracked.split("\0").filter(Boolean)) {
        signal.throwIfAborted();
        if ((await lstat(resolve(root, path))).isDirectory()) {
            append(describeUntracked(path, "Untracked directory; contents not expanded"));
            continue;
        }
        const patch = await git(["diff", "--no-index", ...diffOptions, "--", "/dev/null", path], true);
        append(patch || describeUntracked(path, "New empty file"));
    }
    if (!lines.length) lines.push("No uncommitted changes.");
    return { lines, root };
}
