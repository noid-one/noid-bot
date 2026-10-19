/**
 * Git as Pi Pocket runs it for itself (Changes, branches, worktrees): without a file system monitor, without optional
 * locks so it never gets in the way of Pi's own git commands, with paths taken literally (a file named `*` is that
 * file, not every file), and in English, so a failure can be told from another by what git says. Programs a
 * repository configures, such as clean and smudge filters, still run, as they do for any git command there.
 */
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { execFile } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The settings every git command of Pi Pocket runs with (see the top of this file). */
const GIT_ENV = { GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };

export type GitOptions = {
    /** Exit codes besides 0 that still mean success. */
    allowExit?: number[];
    timeoutMs?: number;
    maxBuffer?: number;
};

/** A git command that failed, with what git said (or why it did not run) as its message. */
export class GitError extends Error {
    /** Git's exit code; undefined when it did not get to exit (a timeout, or no git). */
    readonly exitCode: number | undefined;

    constructor(message: string, exitCode: number | undefined) {
        super(message);
        this.exitCode = exitCode;
    }
}

/** Run git in `cwd` and return what it printed. */
export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
    const { allowExit = [], timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024 } = options;

    return new Promise((resolve, reject) => {
        execFile(
            "git",
            ["-c", "core.fsmonitor=false", ...args],
            {
                cwd,
                timeout: timeoutMs,
                maxBuffer,
                env: { ...process.env, ...GIT_ENV },
            },
            (error, stdout, stderr) => {
                const code = typeof error?.code === "number" ? error.code : undefined;

                if (error === null || (code !== undefined && allowExit.includes(code))) {
                    resolve(stdout);
                } else {
                    reject(new GitError(stderr.trim() || error.message, code));
                }
            },
        );
    });
}

/**
 * noid: where git runs and its files are: this machine, or a session's environment (the shared computer). Changes,
 * branches, and diffs take one, so they work the same in a folder on the computer.
 */
export type GitPlace = {
    git(cwd: string, args: string[], options?: GitOptions): Promise<string>;
    /** What `cwd` has checked out; undefined outside a repository. Throws when git cannot be asked. */
    head(cwd: string): Promise<Head | undefined>;
    /** A file's size and modification time; throws when it is not there. */
    lstat(path: string): Promise<{ size: number; mtimeMs: number }>;
    /** Remove a file; nothing when it is not there. */
    rm(path: string): Promise<void>;
    devNull: string;
    /** Whether paths may be resolved through symbolic links here (this machine's disk only). */
    canonical: boolean;
};

export type Head = { branch: string } | { detached: string };

/**
 * Where a folder's repository keeps its files: `.git` in it or a folder above, or where a worktree's `.git` file says.
 * Never throws: views ask on every update, and a folder that cannot be read (no permission, a link in a loop, a lost
 * mount) is in no repository as far as they can tell.
 */
export function gitDirOf(cwd: string): string | undefined {
    for (let folder = cwd; ; folder = dirname(folder)) {
        const dotGit = join(folder, ".git");

        try {
            const found = statSync(dotGit, { throwIfNoEntry: false });

            if (found?.isDirectory()) {
                return dotGit;
            }

            if (found?.isFile()) {
                const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"));

                return pointer ? resolve(folder, pointer[1]!.trim()) : undefined;
            }
        } catch {
            return undefined;
        }

        if (dirname(folder) === folder) {
            return undefined;
        }
    }
}

/** What a repository has checked out, from its HEAD file, without running git. */
export function headOf(gitDir: string): Head | undefined {
    let head: string;

    try {
        head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    } catch {
        return undefined;
    }

    const ref = /^ref: refs\/heads\/(.+)$/.exec(head);

    if (ref) {
        return { branch: ref[1]! };
    }

    return /^[0-9a-f]{40,64}$/.test(head) ? { detached: head.slice(0, 7) } : undefined;
}

export const HOST_GIT: GitPlace = {
    git,
    // Read from the HEAD file, without running git: views ask on every update.
    head: async (cwd) => {
        const gitDir = gitDirOf(cwd);

        return gitDir === undefined ? undefined : headOf(gitDir);
    },
    lstat: (path) => lstat(path),
    rm: (path) => rm(path, { force: true }),
    devNull,
    canonical: true,
};

/** Git exits with 128 and says so when a folder is in no repository. */
const notARepository = (error: unknown) =>
    error instanceof GitError &&
    error.exitCode === 128 &&
    /not a git repository/i.test(error.message);

/**
 * Git in an environment, as `git` runs it here: the same settings, its failures as GitErrors. Its output comes back
 * as base64, which survives being cut into chunks anywhere (the environment decodes each chunk on its own, which
 * would break a character split between two), and a command past `maxBuffer` is stopped, as execFile stops one here.
 */
export function gitIn(env: ExecutionEnv, context: Context): GitPlace {
    const run: GitPlace["git"] = async (cwd, args, options = {}) => {
        const { allowExit = [], timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024 } = options;
        const out: string[] = [];
        const err: string[] = [];
        let outSize = 0;
        let errSize = 0;
        const result = await env.exec(
            [
                "bash",
                "-c",
                'set -o pipefail; "$@" | base64 -w0',
                "git",
                "git",
                "-c",
                "core.fsmonitor=false",
                ...args,
            ],
            {
                cwd,
                env: GIT_ENV,
                timeout: timeoutMs / 1000,
                onOutput: (text, _context, info) => {
                    if (info.stream === "stdout") {
                        outSize += (text.length * 3) / 4;
                        out.push(text);
                    } else {
                        errSize += text.length;
                        err.push(text);
                    }

                    // Thrown here, it stops the command.
                    if (outSize > maxBuffer || errSize > maxBuffer) {
                        throw new GitError("git printed more than it may", undefined);
                    }
                },
            },
            context,
        );

        if (!result.ok) {
            throw new GitError(
                outSize > maxBuffer || errSize > maxBuffer
                    ? "git printed more than it may"
                    : result.error.message,
                undefined,
            );
        }

        const code = result.value.exitCode;

        if (code !== 0 && !allowExit.includes(code)) {
            throw new GitError(err.join("").trim() || `git exited with code ${code}`, code);
        }

        return Buffer.from(out.join(""), "base64").toString("utf8");
    };

    return {
        git: run,
        head: async (cwd) => {
            let branch: string;

            try {
                // Exits with 1 when nothing is checked out by name (a detached HEAD).
                branch = (
                    await run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
                        allowExit: [1],
                    })
                ).trim();
            } catch (error) {
                if (notARepository(error)) {
                    return undefined;
                }

                throw error;
            }

            if (branch !== "") {
                return { branch };
            }

            const commit = await run(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], {
                allowExit: [1],
            });

            return /^[0-9a-f]{40,64}$/.test(commit.trim())
                ? { detached: commit.trim().slice(0, 7) }
                : undefined;
        },
        lstat: async (path) => {
            const info = await env.fileInfo(path, context);

            if (!info.ok) {
                throw info.error;
            }

            return { size: info.value.size, mtimeMs: info.value.mtimeMs };
        },
        rm: async (path) => {
            const removed = await env.remove(path, { force: true }, context);

            if (!removed.ok) {
                throw removed.error;
            }
        },
        devNull: "/dev/null",
        canonical: false,
    };
}
