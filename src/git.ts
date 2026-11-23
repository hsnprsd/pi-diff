import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeText } from "./text.js";

const maxOutput = 4 * 1024 * 1024;
export type Snapshot = { root: string; dir: string; tree: string; env: string[] };
/** Delete a private snapshot directory and its temporary index and objects. */
export const removeTemp = (dir: string) => rm(dir, { recursive: true, force: true });

/** Snapshot the working tree without staging changes in the real index. The caller owns the returned directory. */
export async function capture(pi: ExtensionAPI, cwd: string, signal?: AbortSignal, baselineDir?: string): Promise<Snapshot> {
    /** Run a snapshot command with Git hooks disabled; incomplete output cannot identify a snapshot. */
    const git = async (args: string[], env: string[] = []) => {
        signal?.throwIfAborted();
        const result = await pi.exec("env", [...env, "git", "-c", "core.hooksPath=/dev/null", "-c", "core.splitIndex=false", "-c", "core.fsmonitor=false", ...args], { cwd, signal, timeout: 15_000, maxBuffer: maxOutput });
        if (result.code !== 0 || result.killed || result.truncated) throw new Error(result.stderr.trim() || "Could not capture Git snapshot.");
        return result.stdout.replace(/\r?\n$/, "");
    };
    cwd = await git(["rev-parse", "--show-toplevel"]);
    /** Ask Git for repository paths so linked worktrees use the correct index and object store. */
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

/** Load bounded patch sections for uncommitted changes, or compare the working tree with a prompt snapshot. */
export async function loadDiff(pi: ExtensionAPI, cwd: string, context: number, signal: AbortSignal, baseline?: Snapshot) {
    let remaining = maxOutput;
    const lines: string[] = [];
    /** Read within the remaining output budget, optionally accepting exit code 1 from a no-index diff. */
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
