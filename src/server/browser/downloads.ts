/**
 * noid: the files a bot's page downloads, moved from the shared browser's downloads folder into the bot's own
 * Downloads folder, so the call that downloaded them can say where each one is (after rakazo 5c99a28d4). The shared
 * browser saves every download in one folder, people's own too; a bot's page tells its downloads apart by their page.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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

const sourceOf = (download: PageDownload, source: string) =>
    download.path ?? posix.join(source, download.name);

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

    for (const download of downloads.slice(0, MAX_DOWNLOADS)) {
        const name = downloadName(download.name);

        if (!ready) {
            saved.push({ name, error: DOWNLOADS_UNUSABLE });
            continue;
        }

        if (stopped.has(download.guid) || download.state === "canceled") {
            saved.push({ name, error: stopped.get(download.guid) ?? DOWNLOAD_FAILED });
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
            saved.push({ name, error: DOWNLOAD_FAILED });
        }
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

/** Move the downloads still going when their call ended once the browser finishes them; one too large is stopped. */
async function finishLater(
    page: BrowserPage,
    pending: { download: PageDownload; name: string }[],
    options: { env: ExecutionEnv; folder: string; source: string },
): Promise<void> {
    const until = Date.now() + FINISH_LATER_MS;
    const left = [...pending];

    while (left.length > 0 && Date.now() < until && !page.closed) {
        await page.downloadChange(5000);

        for (const item of [...left]) {
            const now = page
                .downloads(item.download.seq - 1)
                .find((each) => each.guid === item.download.guid);

            if (now === undefined || now.state === "canceled") {
                left.splice(left.indexOf(item), 1);
            } else if (overLimit(now, 0) !== undefined) {
                left.splice(left.indexOf(item), 1);
                void page.cancelDownload(now.guid);
            } else if (now.state === "completed") {
                left.splice(left.indexOf(item), 1);
                await place(
                    options.env,
                    sourceOf(now, options.source),
                    options.folder,
                    item.name,
                    new Set(),
                    BACKGROUND_CONTEXT,
                ).catch(() => {});
            }
        }
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
