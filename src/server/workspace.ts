/**
 * A conversation's folder on this machine, as people reach it through the app: which files a person may load or read,
 * the file viewer, the files for `@` mentions, Changes, its git branch, uploads, and new folders from the folder picker. The
 * operations people call directly check who may do them; the path helpers (`conversationPath`, `conversationFile`,
 * `readableFile`, `uploadDirectory`) leave seeing the conversation to their callers.
 */
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import {
    type Branches,
    branchesIn,
    gitDirOf,
    type Head,
    headOf,
    isRemoteBranch,
    localName,
    switchBranch,
    validBranchName,
} from "./branches.ts";
import { type Changes, changesIn, diffOf, revertFile } from "./changes.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { gitIn, type GitPlace, HOST_GIT } from "./git.ts";
import { FileLists, type FileListing, type FileView, viewFile } from "./files.ts";
import { imageIn, listFilesIn, type RemoteImage, resolveIn, viewFileIn } from "./noid/env-files.ts";
import { normalFolder } from "./noid/computer.ts";
import { displayPath, expandHome } from "./paths.ts";

export class Workspace {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The files in each folder, for `@` mentions. */
    readonly #files = new FileLists();

    /**
     * The looks at what a conversation's folder changed that are under way, per reach (its folder only, or its
     * repository). Every tab that shows a session asks (the top bar's count), often together as Pi moves on; those that
     * ask while a look is under way share it, as each reads the whole history for Pi's edits and runs git. One asked
     * after it ends looks again, so what it says is never older than the question.
     */
    readonly #changesUnderWay = new Map<string, Promise<Changes>>();

    /**
     * Where each folder's repository keeps its files, for a minute: views ask on every update. A folder in none is
     * asked about again after a few seconds, so one Pi has just run `git init` in shows its branch soon.
     */
    readonly #gitDirs = new Map<string, { gitDir: string | undefined; at: number }>();

    /**
     * noid: what folders on the shared computer have checked out, as git there said last. Views read it on every
     * update (synchronously), so it is kept, and asked again only when the computer is in use anyway: Changes, the
     * branch sheet, a switch, a run that ended there, and a first look while the computer is up. Never on a timer: an
     * open tab must not keep the computer from stopping when idle, or start it to show a branch.
     */
    readonly #remoteHeads = new Map<string, { head: Head | undefined; asked: number }>();

    #remoteHead(id: ConversationId): Head | undefined {
        const cwd = this.#app.cwdOf(id);
        const known = this.#remoteHeads.get(cwd);

        if (known === undefined && this.#app.computer.awake) {
            void this.#askHead(id);
        }

        return known?.head;
    }

    /**
     * Ask git on the computer what a session's folder has checked out now. Only the latest question's answer is kept:
     * one asked before a switch may answer after it. A failure (the computer not reachable) keeps the last answer.
     */
    async #askHead(id: ConversationId): Promise<void> {
        const cwd = this.#app.cwdOf(id);
        const known = this.#remoteHeads.get(cwd) ?? { head: undefined, asked: 0 };
        const asked = ++known.asked;

        this.#remoteHeads.set(cwd, known);

        try {
            const head = await this.#place(id).head(cwd);

            if (known.asked === asked) {
                known.head = head;
            }
        } catch {
            // Kept as it was.
        }
    }

    /** What a look at Changes found checked out in a folder on the computer, as `#askHead` would have. */
    #heardHead(id: ConversationId, changes: Changes): void {
        const cwd = this.#app.cwdOf(id);
        const known = this.#remoteHeads.get(cwd) ?? { head: undefined, asked: 0 };
        const { branch, head } = changes.repo ?? {};

        known.asked += 1;
        known.head =
            changes.repo === undefined
                ? undefined
                : branch !== undefined && branch !== "HEAD"
                  ? { branch }
                  : head !== undefined
                    ? { detached: head.slice(0, 7) }
                    : undefined;
        this.#remoteHeads.set(cwd, known);
    }

    /** A run ended: on the computer, it may have switched branches (git there), so ask. */
    runEnded(id: ConversationId): void {
        if (this.#app.sessionMeta(id) !== undefined && !this.#app.onHost(id)) {
            void this.#askHead(id);
        }
    }

    /** Where a session's git runs: this machine, or its environment (the shared computer). */
    #place(id: ConversationId): GitPlace {
        return this.#app.onHost(id) ? HOST_GIT : gitIn(this.#app.envFor(id), context);
    }

    #gitDir(cwd: string): string | undefined {
        const known = this.#gitDirs.get(cwd);

        if (
            known !== undefined &&
            Date.now() - known.at < (known.gitDir === undefined ? 5000 : 60_000)
        ) {
            return known.gitDir;
        }

        const gitDir = gitDirOf(cwd);

        this.#gitDirs.set(cwd, { gitDir, at: Date.now() });

        return gitDir;
    }

    /** Whether a folder is in a git repository on this machine. */
    inRepository(cwd: string): boolean {
        return !this.#app.claims(cwd) && this.#gitDir(cwd) !== undefined;
    }

    /** What a conversation's folder has checked out, for its view: its repository's HEAD file, read as it is now. */
    head(id: ConversationId): Head | undefined {
        if (!this.#app.onHost(id)) {
            return this.#remoteHead(id);
        }

        const gitDir = this.#gitDir(this.#app.cwdOf(id));

        return gitDir === undefined ? undefined : headOf(gitDir);
    }

    /** The branches of a session's repository, for the branch sheet: for people who can steer, as Changes is. */
    async branches(id: ConversationId, user: User): Promise<Branches> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        const cwd = this.#app.cwdOf(id);
        const place = this.#place(id);
        let inRepository: boolean;

        try {
            inRepository = this.#app.onHost(id)
                ? this.#gitDir(cwd) !== undefined
                : (await place.head(cwd)) !== undefined;
        } catch (error) {
            throw new HttpError(409, describe(error));
        }

        if (!inRepository) {
            throw new HttpError(404, "This session's folder is not in a git repository.");
        }

        return branchesIn(cwd, place).catch((error: unknown) => {
            throw new HttpError(409, describe(error));
        });
    }

    /**
     * Switch a session's folder to another branch: one there already, a new one from what is checked out (`create`),
     * or a new one following a remote branch (`track`). It changes the files under Pi, so as with moving the session to
     * another folder it takes the right to drive, someone not invited to one session only, and Pi not working; Pi is
     * told with its next message.
     */
    async switchBranch(
        id: ConversationId,
        user: User,
        request: { name?: unknown; create?: unknown; track?: unknown },
    ): Promise<{ branch: string }> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session.");
        }

        await this.#app.requireDriver(id, user);

        const place = this.#place(id);
        const track = typeof request.track === "string" ? request.track : undefined;
        const name =
            typeof request.name === "string" ? request.name.trim() : track && localName(track);
        const cwd = this.#app.cwdOf(id);

        if (track !== undefined && !(await isRemoteBranch(cwd, track, place))) {
            throw new HttpError(400, `${track} is not a remote branch here.`);
        }

        if (!name || !(await validBranchName(cwd, name, place))) {
            throw new HttpError(400, `${name ? `“${name}”` : "That"} cannot be a branch name.`);
        }

        if (this.#app.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before switching branches.",
            );
        }

        // On the computer, asked now: what the view has may be from before a switch made in a terminal.
        const before = this.#app.onHost(id)
            ? this.head(id)
            : await place.head(cwd).catch(() => undefined);

        await switchBranch(
            cwd,
            {
                name,
                create: request.create === true,
                ...(track ? { track } : {}),
            },
            place,
        ).catch((error: unknown) => {
            throw new HttpError(409, describe(error));
        });

        // On the computer, the view's branch is what git there said last: ask again now.
        if (!this.#app.onHost(id)) {
            await this.#askHead(id);
        }

        const from = before !== undefined && "branch" in before ? ` from ${before.branch}` : "";
        const what =
            request.create === true || track !== undefined
                ? `made the branch ${name}${track ? `, following ${track},` : ""} and switched to it${from}`
                : `switched the branch${from} to ${name}`;

        await this.#app.commands.note(id, user, what);
        await this.#app.collab.activity(id, user, what);

        return { branch: name };
    }

    /** A folder to work in, as its whole path: a 404 when it is not there, so the folder picker can offer to make it. */
    checkDirectory(path: string): string {
        const absolute = resolve(expandHome(path.trim() === "" ? "~" : path.trim()));
        let found;

        try {
            found = statSync(absolute);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code === "ENOTDIR") {
                throw new HttpError(400, `${absolute} is inside a file, not a folder.`);
            }

            if (code === "ELOOP") {
                throw new HttpError(400, `${absolute} is a link to nothing.`);
            }

            if (code !== "ENOENT") {
                throw new HttpError(400, `Could not open ${absolute}: ${describe(error)}`);
            }

            // Not there, unless it is a link to nowhere: that cannot be made a folder either.
            throw lstatSync(absolute, { throwIfNoEntry: false }) === undefined
                ? new HttpError(404, `${absolute} isn't there.`)
                : new HttpError(400, `${absolute} is a link to nothing.`);
        }

        if (!found.isDirectory()) {
            throw new HttpError(400, `${absolute} is a file, not a folder.`);
        }

        return absolute;
    }

    /**
     * noid: a folder to start a session in or move one to. One an environment runs (the shared computer) is that
     * environment's to make, on its first use, so nothing wakes the computer now; any other is a folder of this
     * machine, which must be there (`checkDirectory`).
     */
    prepareFolder(path: string): string {
        // `..` resolved first: a path that only looks like the computer's must not be made on this machine.
        const folder = normalFolder(path);

        return this.#app.claims(folder) ? folder : this.checkDirectory(path.trim());
    }

    /**
     * Make a folder to start a session in or move one to, with any folders missing above it, for someone who may browse
     * folders (`/api/fs`): who can steer, and was not invited to one session. A folder already there is fine: it is the
     * one asked for. Returns its path.
     */
    makeFolder(user: User, path: string): string {
        this.#app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session.");
        }

        const written = path.trim();

        if (written === "" || written.includes("\0")) {
            throw new HttpError(400, "Name the folder to make.");
        }

        const expanded = expandHome(written);

        if (!isAbsolute(expanded)) {
            throw new HttpError(400, "Give the folder's whole path, from / or ~.");
        }

        const absolute = resolve(expanded);

        try {
            mkdirSync(absolute, { recursive: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            // A file in the way, or a link that leads nowhere (or in a loop): the path cannot be a folder.
            throw new HttpError(
                409,
                code === "EEXIST" || code === "ENOTDIR"
                    ? `${absolute} is a file, or inside one.`
                    : code === "ENOENT" || code === "ELOOP"
                      ? `${absolute} is a broken link, or inside one.`
                      : `Could not make ${absolute}: ${describe(error)}`,
            );
        }

        // Made, or a folder already: either way it must be a folder now.
        return this.checkDirectory(absolute);
    }

    /** A path as a conversation means it: absolute, `~/…`, or relative to the conversation's working directory. */
    conversationPath(id: ConversationId, path: string): string {
        return resolve(this.#app.cwdOf(id), expandHome(path.trim()));
    }

    /**
     * A file a person may load through a conversation. People who can steer reach the whole machine through Pi anyway;
     * viewers and people invited to one session get only files under the conversation's folder or its uploads.
     */
    conversationFile(user: User, id: ConversationId, path: string): string {
        const file = this.conversationPath(id, path);

        if (user.role !== "viewer" && user.sessions === undefined) {
            return file;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return undefined;
            }
        };

        const target = real(file);
        const cwd = this.#app.cwdOf(id);
        // A fork shows the messages it inherited, with the files attached to them in the sessions it came from. Their
        // later uploads are in the same folders, but an upload's name has random bits in it and shows only in its
        // message, so nobody who cannot read that message can name the file.
        const uploads = this.#lineage(id).map((each) =>
            join(this.#app.dataDir, "uploads", String(each)),
        );
        const roots = [cwd, ...uploads]
            .map(real)
            .filter((root): root is string => root !== undefined);

        if (
            target === undefined ||
            !roots.some((root) => target === root || target.startsWith(root + sep))
        ) {
            throw new HttpError(404, "Image not found");
        }

        return target;
    }

    /**
     * A file a person may read whole through a session: the viewer, and files sent along with a message. As
     * `conversationFile`, but Pi's own folder (sign-ins, settings) and this app's data (people, tokens, the database)
     * are the owner's alone. Uploads, worktrees, and PiP's clones (`repos/`), which sessions use, are not kept back.
     */
    readableFile(user: User, id: ConversationId, path: string): string {
        const file = this.conversationFile(user, id, path);

        if (user.role === "owner") {
            return file;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return resolve(target);
            }
        };

        const target = real(file);
        const inside = (root: string) => target === root || target.startsWith(root + sep);
        const data = real(this.#app.dataDir);

        if (
            inside(real(getAgentDir())) ||
            (inside(data) &&
                !inside(join(data, "uploads")) &&
                !inside(join(data, "worktrees")) &&
                !inside(join(data, "repos")))
        ) {
            throw new HttpError(404, "Not found");
        }

        return file;
    }

    /** This session and the sessions it was forked from, nearest first. */
    #lineage(id: ConversationId): ConversationId[] {
        const lineage = [id];

        for (
            let meta = this.#app.sessionMeta(id);
            meta?.forkedFrom !== undefined && lineage.length < 64;
        ) {
            const parent = meta.forkedFrom.id as unknown as ConversationId;

            if (lineage.includes(parent)) {
                break;
            }

            lineage.push(parent);
            meta = this.#app.sessionMeta(parent);
        }

        return lineage;
    }

    /**
     * The files in a conversation's folder, for `@` mentions in the message box: for people who can write to Pi. It lists
     * names under the folder only, so someone invited to one session sees no more than `conversationFile` lets them load.
     */
    async fileList(id: ConversationId, user: User): Promise<FileListing> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        await this.#app.conversation(id);

        if (!this.#app.onHost(id)) {
            return listFilesIn(this.#app.envFor(id), this.#app.cwdOf(id), context);
        }

        return this.#files.get(this.#app.cwdOf(id));
    }

    /**
     * A file or folder for the viewer, as a person who can steer may load it through the session (`conversationFile`):
     * its text, or that it is an image, a folder's entries, or binary.
     */
    async viewFile(
        id: ConversationId,
        user: User,
        path: string,
    ): Promise<{ path: string; display: string } & FileView> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        await this.#app.conversation(id);

        if (!this.#app.onHost(id)) {
            return this.#viewRemote(id, user, path);
        }

        let file: string;

        try {
            file = this.readableFile(user, id, path);

            return {
                path: file,
                display: displayPath(file, this.#app.cwdOf(id)),
                ...(await viewFile(file)),
            };
        } catch (error) {
            if (error instanceof HttpError || (error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new HttpError(404, `${path} is not there.`);
            }

            throw new HttpError(409, describe(error));
        }
    }

    /** noid: a file in a session's folder on the shared computer, as the person may reach it (`conversationFile`). */
    async remotePath(id: ConversationId, user: User, path: string): Promise<string> {
        const env = this.#app.envFor(id);
        const file = await resolveIn(env, path, context);

        // Only the owner reaches the whole computer (its sign-ins and browser profile included); anyone else reaches the
        // session's folder, compared by real path so a link inside it cannot lead out.
        if (user.role !== "owner") {
            const real = await env.canonicalPath(file, context);
            const root = await env.canonicalPath(this.#app.cwdOf(id), context);

            if (
                !real.ok ||
                !root.ok ||
                (real.value !== root.value && !real.value.startsWith(`${root.value}/`))
            ) {
                throw new HttpError(404, "Not found");
            }
        }

        return file;
    }

    /** noid: an image in a session's folder on the shared computer, for the image route. */
    async remoteImage(id: ConversationId, user: User, path: string): Promise<RemoteImage> {
        const file = await this.remotePath(id, user, path);
        const image = await imageIn(this.#app.envFor(id), file, context);

        if (image === undefined) {
            throw new HttpError(404, "Image not found");
        }

        return { file, ...image };
    }

    async #viewRemote(
        id: ConversationId,
        user: User,
        path: string,
    ): Promise<{ path: string; display: string } & FileView> {
        try {
            // Not this person's to see, or not there: the same answer, as on this machine.
            const file = await this.remotePath(id, user, path);

            return {
                path: file,
                display: displayPath(file, this.#app.cwdOf(id)),
                ...(await viewFileIn(this.#app.envFor(id), file, context)),
            };
        } catch (error) {
            if (error instanceof HttpError || (error as { code?: string }).code === "not_found") {
                throw new HttpError(404, `${path} is not there.`);
            }

            throw new HttpError(409, describe(error));
        }
    }

    /**
     * Undo the uncommitted changes to one file of a session's repository. It changes files under Pi, so it takes the
     * right to drive and waits until Pi is not working; Pi is told, with its next message.
     */
    async revertChange(id: ConversationId, user: User, path: string): Promise<void> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        if (this.#app.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before undoing a file.",
            );
        }

        const kind = await revertFile(
            this.#app.cwdOf(id),
            path,
            user.sessions !== undefined,
            this.#place(id),
        ).catch((error: unknown) => {
            throw new HttpError(409, describe(error));
        });
        const what =
            kind === "new" || kind === "added"
                ? `deleted ${path}, which was new since the last commit`
                : `undid the uncommitted changes to ${path}`;

        this.#forgetChanges(id);
        await this.#app.commands.note(id, user, what);
        await this.#app.collab.activity(id, user, what);
    }

    /** What changed in a session's folder: Pi's edits, and the uncommitted changes of its git repository. */
    async changes(id: ConversationId, user: User): Promise<Changes> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        // Someone invited to this session only sees the files in its folder, here as in `conversationFile`.
        const onlyHere = user.sessions !== undefined;
        const key = `${id}:${onlyHere}`;
        const underWay = this.#changesUnderWay.get(key);

        if (underWay !== undefined) {
            return underWay;
        }

        const pending = (async () =>
            changesIn(
                this.#app.cwdOf(id),
                await this.#app.transcripts.allEntries(id, false),
                onlyHere,
                this.#place(id),
            ).then((changes) => {
                // On the computer, what Changes found checked out is the view's branch too.
                if (!this.#app.onHost(id)) {
                    this.#heardHead(id, changes);
                }

                return changes;
            }))().finally(() => {
            if (this.#changesUnderWay.get(key) === pending) {
                this.#changesUnderWay.delete(key);
            }
        });

        this.#changesUnderWay.set(key, pending);

        return pending;
    }

    /** Looks under way began before a file was undone: one asked from now on looks again. */
    #forgetChanges(id: ConversationId): void {
        this.#changesUnderWay.delete(`${id}:true`);
        this.#changesUnderWay.delete(`${id}:false`);
    }

    /** The diff of one changed file in a session's repository. */
    async changeDiff(id: ConversationId, user: User, path: string): Promise<string> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        try {
            return await diffOf(
                this.#app.cwdOf(id),
                path,
                user.sessions !== undefined,
                this.#place(id),
            );
        } catch (error) {
            throw new HttpError(404, describe(error));
        }
    }

    uploadDirectory(id: ConversationId): string {
        const directory = join(this.#app.dataDir, "uploads", String(id));

        mkdirSync(directory, { recursive: true });

        return directory;
    }
}
