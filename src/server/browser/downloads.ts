/**
 * noid: the files a bot's page downloads, moved from the shared browser's downloads folder into the bot's own
 * Downloads folder, so the call that downloaded them can say where each one is (after rakazo 5c99a28d4). The shared
 * browser saves every download in one folder, people's own too, each under its guid so none writes over another; a
 * bot's page tells its downloads apart by their page. One a bot's call does not place is deleted, not left there.
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { posix } from "node:path";
import type { BrowserPage, PageDownload } from "./page.ts";

/** The most files one call saves, and the largest one: as for uploads. */
export const MAX_DOWNLOADS = 10;
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
/** How long a call waits for its downloads to finish. One still going then is moved once it is done. */
const WAIT_MS = 15_000;
/** How long a download still going after its call is waited for. */
const FINISH_LATER_MS = 15 * 60_000;

export const DOWNLOAD_FAILED = "The download failed.";
export const DOWNLOADS_UNUSABLE = "Downloads cannot be saved: your Downloads folder is not usable.";

/** A file a call's page downloaded, as the bot is told: where it is, or why it is not. */
export type SavedDownload = {
    name: string;
    path?: string;
    /** Bytes saved, or so far while it still downloads. */
    size?: number;
    /** Still downloading when the call ended: the file is at `path` once it is done. */
    state?: "downloading";
    error?: string;
};

/**
 * A site's name for a file as one short, plain path segment: it is untrusted text the bot reads and puts in its shell,
 * so shell characters such as `$`, backticks, quotes and `;` become `_` too.
 */
export function downloadName(name: string): string {
    const text = [...name.normalize("NFC")]
        .map((char) =>
            /[/\\$`;|&<>!"']/.test(char) ? "_" : /[\p{C}\p{Z}]/u.test(char) ? " " : char,
        )
        .join("");
    const plain = text
        .split(/\s+/)
        .filter(Boolean)
        .join(" ")
        .replace(/^[. ]+|[. ]+$/g, "");
    let ext = posix.extname(plain);
    let stem = plain.slice(0, plain.length - ext.length);

    if (ext.length > 12 || ext.includes(" ")) {
        stem += ext;
        ext = "";
    }

    while (stem !== "" && (stem.length + ext.length > 80 || Buffer.byteLength(stem + ext) > 200)) {
        stem = [...stem].slice(0, -1).join("");
    }

    stem = stem.replace(/[. ]+$/, "");

    return stem === "" ? `download${ext}` : stem + ext;
}

/** `name`, or `name (1)` and so on, that nothing in the folder (a link included) or `taken` already has. */
async function freeName(
    env: ExecutionEnv,
    folder: string,
    name: string,
    taken: Set<string>,
    context: Context,
): Promise<string> {
    const ext = posix.extname(name);
    const stem = name.slice(0, name.length - ext.length);

    for (let number = 0; number < 1000; number++) {
        const candidate = number === 0 ? name : `${stem} (${number})${ext}`;

        if (taken.has(candidate)) {
            continue;
        }

        const info = await env.fileInfo(posix.join(folder, candidate), context);

        if (!info.ok && info.error.code === "not_found") {
            return candidate;
        }
    }

    throw new Error(DOWNLOAD_FAILED);
}

/** The Downloads folder, made if it is not there; false when it is reached through a link (into another bot's folder). */
async function usable(env: ExecutionEnv, folder: string, context: Context): Promise<boolean> {
    const made = await env.createDir(folder, { recursive: true }, context);
    const real = made.ok ? await env.canonicalPath(folder, context) : made;
    const info = real.ok ? await env.fileInfo(folder, context) : real;

    return real.ok && info.ok && real.value === folder && info.value.kind === "directory";
}

/** Move a finished download into the folder under a free name; the name it got. A file there is never replaced. */
async function place(
    env: ExecutionEnv,
    from: string,
    folder: string,
    name: string,
    taken: Set<string>,
    context: Context,
): Promise<{ name: string; size: number }> {
    const info = await env.fileInfo(from, context);

    if (!info.ok || info.value.kind !== "file" || info.value.size > MAX_DOWNLOAD_BYTES) {
        throw new Error(DOWNLOAD_FAILED);
    }

    const chosen = await freeName(env, folder, name, taken, context);
    const moved = await env.renameFile(from, posix.join(folder, chosen), context);

    if (!moved.ok) {
        throw new Error(DOWNLOAD_FAILED);
    }

    taken.add(chosen);

    return { name: chosen, size: info.value.size };
}

/** Where the browser saved a download: under its guid (`allowAndName`), so no two downloads share a file. */
const sourceOf = (download: PageDownload, source: string) =>
    download.path ?? posix.join(source, download.guid);

/** Delete a bot's download that is not placed from the shared folder, where every bot could read it. */
export async function discardDownload(
    env: ExecutionEnv,
    path: string,
    context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
    await env.remove(path, { force: true }, context).catch(() => {});
}

/**
 * A bot's download no call places: stopped while it goes, or deleted once finished (one stopped may have finished
 * before the browser was told to stop it). A canceled one the browser deleted itself.
 */
async function drop(
    page: BrowserPage,
    download: PageDownload,
    options: { env: ExecutionEnv; source: string },
    context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
    if (download.state === "inProgress") {
        await page.cancelDownload(download.guid);
    } else if (download.state === "completed") {
        await discardDownload(options.env, sourceOf(download, options.source), context);
    }
}

/** The owner's downloads being named, one after another. */
let naming: Promise<void> = Promise.resolve();

/**
 * noid: a download that is no page's of Pi's (the owner's own, on the computer's desktop) under the name the site gave
 * it, made safe as a bot's is (bots read the shared folder): the browser saved it under its guid. A name taken gets
 * ` (1)` and so on. One that cannot be renamed stays as it is.
 */
export function nameDownload(
    env: ExecutionEnv,
    from: string,
    name: string,
    context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
    // One after another: two of the same name at once would pick the same free name, and one would write over the other.
    naming = naming.then(async () => {
        const folder = posix.dirname(from);
        const chosen = await freeName(env, folder, downloadName(name), new Set(), context).catch(
            () => undefined,
        );

        if (chosen !== undefined) {
            await env.renameFile(from, posix.join(folder, chosen), context).catch(() => {});
        }
    });

    return naming;
}

/** Why a download is to be stopped: past the call's count, or too large. */
function overLimit(download: PageDownload, index: number): string | undefined {
    if (index >= MAX_DOWNLOADS) {
        return `Not saved: a call saves at most ${MAX_DOWNLOADS} files.`;
    }

    if (Math.max(download.total, download.received) > MAX_DOWNLOAD_BYTES) {
        return `Not saved: larger than ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB.`;
    }

    return undefined;
}

export type SaveOptions = {
    env: ExecutionEnv;
    /** The bot's Downloads folder, absolute. */
    folder: string;
    /** Where the browser saves downloads. */
    source: string;
    /** The downloads already told of: those that began after it are this call's. */
    after: number;
    /** When the call began: its downloads are waited for until `WAIT_MS` after. */
    startedAt: number;
    signal?: AbortSignal;
    context: Context;
};

/**
 * The page's downloads since `after`, once they finished (or the call's time is up), moved into the bot's folder. One
 * still going is listed as downloading under the name it will get, and moved when it is done. `seq` is the last
 * download told of.
 */
export async function saveDownloads(
    page: BrowserPage,
    options: SaveOptions,
): Promise<{ saved: SavedDownload[]; seq: number }> {
    const { env, folder, source, after, context } = options;
    const stopped = new Map<string, string>();
    let downloads = page.downloads(after);

    for (;;) {
        downloads.forEach((download, index) => {
            const why = download.state === "canceled" ? undefined : overLimit(download, index);

            if (why !== undefined && !stopped.has(download.guid)) {
                stopped.set(download.guid, why);
                void page.cancelDownload(download.guid);
            }
        });

        const running = downloads.some(
            (download) => download.state === "inProgress" && !stopped.has(download.guid),
        );
        const left = options.startedAt + WAIT_MS - Date.now();

        if (!running || left <= 0 || options.signal?.aborted === true || page.closed) {
            break;
        }

        await page.downloadChange(Math.min(left, 1000), options.signal);
        downloads = page.downloads(after);
    }

    if (downloads.length === 0) {
        return { saved: [], seq: after };
    }

    const seq = downloads.at(-1)!.seq;
    const ready = await usable(env, folder, context).catch(() => false);
    const taken = new Set<string>();
    const saved: SavedDownload[] = [];
    const later: { download: PageDownload; name: string }[] = [];

    // Every download this call does not place or leave to `finishLater` is dropped from the shared folder.
    for (const download of downloads.slice(0, MAX_DOWNLOADS)) {
        const name = downloadName(download.name);
        const error = !ready
            ? DOWNLOADS_UNUSABLE
            : stopped.has(download.guid) || download.state === "canceled"
              ? (stopped.get(download.guid) ?? DOWNLOAD_FAILED)
              : undefined;

        if (error !== undefined) {
            await drop(page, download, options, context);
            saved.push({ name, error });
            continue;
        }

        if (download.state === "inProgress") {
            // Not in the folder until it is done: a file given this name meanwhile makes it `name (1)`.
            const chosen = await freeName(env, folder, name, taken, context).catch(() => name);

            taken.add(chosen);
            later.push({ download, name: chosen });
            saved.push({
                name: chosen,
                path: posix.join(folder, chosen),
                size: download.received,
                state: "downloading",
            });
            continue;
        }

        try {
            const placed = await place(
                env,
                sourceOf(download, source),
                folder,
                name,
                taken,
                context,
            );

            saved.push({
                name: placed.name,
                path: posix.join(folder, placed.name),
                size: placed.size,
            });
        } catch {
            await drop(page, download, options, context);
            saved.push({ name, error: DOWNLOAD_FAILED });
        }
    }

    for (const download of downloads.slice(MAX_DOWNLOADS)) {
        await drop(page, download, options, context);
    }

    if (downloads.length > MAX_DOWNLOADS) {
        saved.push({
            name: `${downloads.length - MAX_DOWNLOADS} more`,
            error: `Not saved: a call saves at most ${MAX_DOWNLOADS} files.`,
        });
    }

    if (later.length > 0) {
        void finishLater(page, later, { env, folder, source });
    }

    return { saved, seq };
}

/**
 * Move the downloads still going when their call ended once the browser finishes them; one too large is stopped. One
 * not placed (it failed, or this gave up on it) is stopped or deleted: it is not left in the shared folder.
 */
async function finishLater(
    page: BrowserPage,
    pending: { download: PageDownload; name: string }[],
    options: { env: ExecutionEnv; folder: string; source: string },
): Promise<void> {
    const until = Date.now() + FINISH_LATER_MS;
    const left = [...pending];
    const current = (item: { download: PageDownload }) =>
        page.downloads(item.download.seq - 1).find((each) => each.guid === item.download.guid);

    while (left.length > 0 && Date.now() < until && !page.closed) {
        await page.downloadChange(5000);

        for (const item of [...left]) {
            const now = current(item);
            const allowed = now !== undefined && overLimit(now, 0) === undefined;

            if (now?.state === "inProgress" && allowed) {
                continue;
            }

            left.splice(left.indexOf(item), 1);

            if (now?.state === "completed" && allowed) {
                await place(
                    options.env,
                    sourceOf(now, options.source),
                    options.folder,
                    item.name,
                    new Set(),
                    BACKGROUND_CONTEXT,
                ).catch(() => drop(page, now, options));
            } else if (now !== undefined) {
                await drop(page, now, options);
            }
        }
    }

    // Given up on: out of time, or the page closed (the shared browser deletes one that finishes after that).
    for (const item of left) {
        await drop(page, current(item) ?? item.download, options);
    }
}

/** Bytes in words: "14 bytes", "1.2 MB". */
function size(bytes: number): string {
    return bytes < 1024
        ? `${bytes} bytes`
        : bytes < 1024 * 1024
          ? `${(bytes / 1024).toFixed(1)} KB`
          : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The lines a call's result tells its downloads in. */
export function downloadLines(saved: readonly SavedDownload[]): string[] {
    if (saved.length === 0) {
        return [];
    }

    return [
        "Downloaded, into your Downloads folder:",
        ...saved.map((file) =>
            file.error !== undefined
                ? `- ${file.name}: ${file.error}`
                : file.state === "downloading"
                  ? `- ${file.path}: still downloading (${size(file.size ?? 0)} so far); the file is there once it is done.`
                  : `- ${file.path} (${size(file.size ?? 0)})`,
        ),
    ];
}
