/**
 * A session's git branch: the one its folder has checked out, read from the repository's HEAD file so a view can show
 * it on every update, and the branches it could switch to, for the branch sheet. Switching is `git switch`: changes
 * not yet committed go along to the other branch, and git refuses when the switch would overwrite them.
 */
import { parseStatus } from "./changes.ts";
import { GitError, type GitPlace, gitDirOf, type Head, headOf, HOST_GIT } from "./git.ts";

export { gitDirOf, type Head, headOf };

/** What a folder has checked out: a branch (one with no commits yet included), or a commit with no branch. */

export type LocalBranch = {
    name: string;
    current: boolean;
    /** When its last commit was made, in milliseconds; absent for a branch with no commits yet. */
    at?: number;
    subject?: string;
    /** The remote branch it follows: how far ahead and behind it is, or `gone` when the remote branch was deleted. */
    upstream?: { name: string; ahead: number; behind: number; gone: boolean };
    /** The folder of another worktree that has it checked out: git switches to it only there. */
    worktree?: string;
};

export type RemoteBranch = { name: string; at: number; subject: string };

export type Branches = {
    head: Head | undefined;
    /** Newest first, at most `MAX_BRANCHES`. */
    local: LocalBranch[];
    /** Remote branches with no local branch of their name: switching to one makes a local branch that follows it. */
    remote: RemoteBranch[];
    /** Branches left out of the lists, past the most each shows. */
    more: number;
    /** Files with changes not yet committed, which go along to the branch switched to. */
    changed: number;
};

/** The most branches each list has, newest first: the picker searches what it has. */
const MAX_BRANCHES = 1000;
const GIT_TIMEOUT_MS = 15_000;
/** Git for branches, where the folder is (this machine, or the shared computer). */
const gitFor = (place: GitPlace) => (cwd: string, args: string[]) =>
    place.git(cwd, args, { timeoutMs: GIT_TIMEOUT_MS });

/** `%(upstream:track,nobracket)`: "ahead 2, behind 1", "gone", or nothing when it is even. */
function readTrack(track: string): { ahead: number; behind: number; gone: boolean } {
    return {
        ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
        gone: track === "gone",
    };
}

/** The branches of the repository `cwd` is in, for the branch sheet. */
export async function branchesIn(cwd: string, place: GitPlace = HOST_GIT): Promise<Branches> {
    const git = gitFor(place);
    const head = await place.head(cwd);
    const checkedOut = head !== undefined && "branch" in head ? head.branch : undefined;
    const fields = [
        "%(refname)",
        "%(committerdate:unix)",
        "%(subject)",
        "%(upstream:short)",
        "%(upstream:track,nobracket)",
        "%(worktreepath)",
    ];
    const [refs, status] = await Promise.all([
        git(cwd, [
            "for-each-ref",
            "--sort=-committerdate",
            // Every field ends in NUL, so a newline in one (a worktree's folder can have one) is just text.
            `--format=${fields.join("%00")}%00`,
            "refs/heads",
            "refs/remotes",
        ]),
        git(cwd, ["status", "--porcelain=v1", "-z"]),
    ]);
    const local: LocalBranch[] = [];
    const remote: RemoteBranch[] = [];

    const values = refs.split("\0");

    for (let index = 0; index + fields.length <= values.length; index += fields.length) {
        const [first = "", at = "", subject = "", upstream = "", track = "", worktree = ""] =
            values.slice(index, index + fields.length);
        // Git ends each ref's line with a newline, which starts the next one's first field.
        const ref = first.replace(/^\n/, "");

        if (ref.startsWith("refs/heads/")) {
            const name = ref.slice("refs/heads/".length);
            const current = name === checkedOut;

            local.push({
                name,
                current,
                at: Number(at) * 1000,
                subject,
                ...(upstream === "" ? {} : { upstream: { name: upstream, ...readTrack(track) } }),
                // Checked out in another worktree, as this folder's own branch is in this one.
                ...(worktree === "" || current ? {} : { worktree }),
            });
        } else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) {
            remote.push({
                name: ref.slice("refs/remotes/".length),
                at: Number(at) * 1000,
                subject,
            });
        }
    }

    // A branch with no commits yet has no ref to list.
    if (checkedOut !== undefined && !local.some((branch) => branch.current)) {
        local.unshift({ name: checkedOut, current: true });
    }

    // A remote branch that a local one follows, or shares its name with, is that branch.
    const known = new Set(local.flatMap((branch) => [branch.name, branch.upstream?.name]));
    const others = remote.filter(
        (branch) => !known.has(branch.name) && !known.has(localName(branch.name)),
    );

    return {
        head,
        local: local.slice(0, MAX_BRANCHES),
        remote: others.slice(0, MAX_BRANCHES),
        more: Math.max(0, local.length - MAX_BRANCHES) + Math.max(0, others.length - MAX_BRANCHES),
        changed: parseStatus(status).length,
    };
}

/** The local name for a remote branch: `origin/fix/login` is `fix/login`. */
export const localName = (remote: string) => remote.slice(remote.indexOf("/") + 1);

/** Whether git takes a name for a branch: no spaces, no `..`, not starting with `-`, and the rest of git's rules. */
export async function validBranchName(
    cwd: string,
    name: string,
    place: GitPlace = HOST_GIT,
): Promise<boolean> {
    const git = gitFor(place);

    if (name === "" || name.startsWith("-")) {
        return false;
    }

    return git(cwd, ["check-ref-format", "--branch", name]).then(
        () => true,
        () => false,
    );
}

/** Whether `name` (such as `origin/fix`) is one of the repository's remote branches. */
export async function isRemoteBranch(
    cwd: string,
    name: string,
    place: GitPlace = HOST_GIT,
): Promise<boolean> {
    const git = gitFor(place);

    if (name === "" || name.startsWith("-")) {
        return false;
    }

    return git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${name}^{commit}`]).then(
        () => true,
        () => false,
    );
}

/**
 * Switch the folder `cwd` to a branch: one there already, a new one made from what is checked out (`create`), or a
 * new one following a remote branch (`track`, such as `origin/fix`, which `isRemoteBranch` has checked). Git's own
 * words say why it could not.
 */
export async function switchBranch(
    cwd: string,
    target: { name: string; create?: boolean; track?: string },
    place: GitPlace = HOST_GIT,
): Promise<void> {
    const git = gitFor(place);
    const args =
        target.track !== undefined
            ? // As a whole ref the remote branch cannot be taken for an option.
              ["switch", "--create", target.name, "--track", `refs/remotes/${target.track}`]
            : target.create === true
              ? ["switch", "--create", target.name]
              : ["switch", "--no-guess", target.name];

    try {
        await git(cwd, args);
    } catch (error) {
        throw new GitError(
            error instanceof Error ? cleanMessage(error.message) : String(error),
            error instanceof GitError ? error.exitCode : undefined,
        );
    }
}

/** Git's message without its hints and its closing "Aborting": what went wrong, and the files it names. */
function cleanMessage(message: string): string {
    return message
        .split("\n")
        .filter((line) => !/^(hint:|Aborting$)/.test(line.trim()))
        .map((line) => line.replace(/^(error|fatal): /, ""))
        .join("\n")
        .trim();
}
