/**
 * The app's file features for a session whose folder is not on this machine (the shared computer): the viewer, the
 * images replies show, and the `@` file list, through the session's ExecutionEnv instead of this machine's disk. They
 * answer as their host versions in `files.ts` do, so the routes and the app need not know where a folder is.
 */
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import type { FileListing, FileView } from "../files.ts";
import { MAX_FILES } from "../files.ts";

const gzip = promisify(gzipCallback);

/** As in `files.ts`: how much of a file and of a folder the viewer shows, and which files are images. */
const VIEW_BYTES = 512 * 1024;
const VIEW_ENTRIES = 1000;

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
/** The largest image served from a remote folder: an image larger than this is not one a reply shows. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Folders the `@` list leaves out (with what git ignores): dependencies and caches. */
const SKIP = ["node_modules", "__pycache__", "bower_components", "venv", "site-packages", "target"];

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: Error }): T => {
    if (!result.ok) {
        throw result.error;
    }

    return result.value;
};

/** A path as a session means it, in its environment: absolute, `~/…` (the environment's home), or relative to cwd. */
export async function resolveIn(
    env: ExecutionEnv,
    path: string,
    context: Context,
): Promise<string> {
    return posix.normalize(unwrap(await env.absolutePath(path.trim(), context)));
}

/** What the viewer shows of a file or folder in an environment. Throws a FileError (`not_found`) when it is not there. */
export async function viewFileIn(
    env: ExecutionEnv,
    file: string,
    context: Context,
): Promise<FileView> {
    let info = unwrap(await env.fileInfo(file, context));

    // As the viewer on this machine (stat): a link shows what it leads to.
    if (info.kind === "symlink") {
        info = unwrap(await env.fileInfo(unwrap(await env.canonicalPath(file, context)), context));
    }

    if (info.kind === "directory") {
        const entries = unwrap(await env.listDir(file, context));
        const listed = entries
            .slice(0, VIEW_ENTRIES)
            .map((entry) => ({ name: entry.name, dir: entry.kind === "directory" }))
            .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));

        return { kind: "folder", entries: listed, truncated: entries.length > VIEW_ENTRIES };
    }

    if (info.kind !== "file") {
        return { kind: "other", size: info.size };
    }

    if (IMAGE_EXTENSIONS.test(file)) {
        return { kind: "image", size: info.size };
    }

    const reader = unwrap(await env.openBinaryReader(file, {}, context));

    try {
        const bytes = unwrap(await reader.read(0, Math.min(info.size, VIEW_BYTES), context));

        // Text files have no NUL bytes; nearly every other kind does, early on.
        if (bytes.subarray(0, 8000).includes(0)) {
            return { kind: "binary", size: info.size };
        }

        return {
            kind: "text",
            size: info.size,
            text: Buffer.from(bytes).toString("utf8"),
            truncated: info.size > bytes.length,
        };
    } finally {
        await reader.close(context);
    }
}

/** An image in an environment, for the image route: an etag from its size and time, and its bytes when wanted. */
export type RemoteImage = { file: string; etag: string; read: () => Promise<Uint8Array> };

/** The image at `file`, or undefined when it is not an image file there (or too large to show). */
export async function imageIn(
    env: ExecutionEnv,
    file: string,
    context: Context,
): Promise<Omit<RemoteImage, "file"> | undefined> {
    if (!IMAGE_EXTENSIONS.test(file)) {
        return undefined;
    }

    const info = await env.fileInfo(file, context);

    if (!info.ok || info.value.kind !== "file" || info.value.size > MAX_IMAGE_BYTES) {
        return undefined;
    }

    const { size, mtimeMs } = info.value;

    return {
        etag: `"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`,
        read: async () => {
            const bytes = await env.readBinaryFile(file, context);

            if (!bytes.ok) {
                throw bytes.error;
            }

            return bytes.value;
        },
    };
}

/** The files under a folder in an environment, for `@` mentions: what git does not ignore, without dependency folders. */
export async function listFilesIn(
    env: ExecutionEnv,
    cwd: string,
    context: Context,
): Promise<FileListing> {
    let files: string[] = [];
    let truncated = false;

    if (env.listFiles !== undefined) {
        const listing = await env.listFiles(
            cwd,
            { hidden: false, exclude: SKIP, maxEntries: MAX_FILES },
            context,
        );

        if (listing.ok) {
            files = listing.value.entries
                .filter((entry) => entry.kind === "file")
                .map((entry) => entry.path);
            truncated = listing.value.truncated;
        }
    }

    const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 16);
    const list = { files, truncated, version };
    const json = JSON.stringify(list);
    let compressed: Promise<Buffer> | undefined;

    return { ...list, json, gzipped: () => (compressed ??= gzip(json, { level: 6 })) };
}

/** The names Pi looks for in each folder, in its order (pi-coding-agent's `loadContextFileFromDir`). */
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/**
 * A session's AGENTS.md files in its environment, as Pi's `loadProjectContextFiles` finds them on this machine: the
 * first context file of each folder from `/` down to `cwd`, outermost first. (Pi's global one, in its own folder on
 * this machine, the caller adds.)
 */
export async function contextFilesIn(
    env: ExecutionEnv,
    cwd: string,
    context: Context,
): Promise<{ path: string; content: string }[]> {
    const found: { path: string; content: string }[] = [];

    for (let folder = posix.normalize(cwd); ; folder = posix.dirname(folder)) {
        for (const name of CONTEXT_FILES) {
            const path = posix.join(folder, name);
            const info = await env.fileInfo(path, context);

            if (info.ok && info.value.kind === "file") {
                const text = await env.readTextFile(path, context);

                if (text.ok) {
                    found.unshift({ path, content: text.value.replace(/^﻿/, "") });
                }

                break;
            }
        }

        if (posix.dirname(folder) === folder) {
            return found;
        }
    }
}
