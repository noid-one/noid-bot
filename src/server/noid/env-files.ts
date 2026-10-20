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
import { parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import type { FileListing, FileView } from "../files.ts";
import { IMAGE_EXTENSIONS, MAX_FILES, VIEW_BYTES, VIEW_ENTRIES } from "../files.ts";

const gzip = promisify(gzipCallback);

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

        // The computer could not list (waking, or its exec failed): said, not passed off as an empty folder, so the
        // empty list is not kept as the folder's (`FileLists` keeps only lists that were made).
        if (!listing.ok) {
            throw listing.error;
        }

        files = listing.value.entries
            .filter((entry) => entry.kind === "file")
            .map((entry) => entry.path);
        truncated = listing.value.truncated;
    }

    return fileListing(files, truncated);
}

/** A list of files as the `@` list takes it: with its version, its JSON, and that gzipped once when asked. */
export function fileListing(files: string[], truncated: boolean): FileListing {
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

/** Where a session on the computer finds skills, in order: its own folder's, then those every bot shares. */
export const skillFoldersIn = (cwd: string, home: string): string[] => [
    posix.join(cwd, ".pi", "skills"),
    posix.join(cwd, ".agents", "skills"),
    posix.join(home, ".pi", "agent", "skills"),
    posix.join(home, ".agents", "skills"),
];

/** How deep below a skill folder a skill may be, as a folder of folders (`team/report/SKILL.md`). */
const SKILL_DEPTH = 3;

/**
 * Pi's skills in a session's environment, as Pi finds them on this machine: in each skill folder, a `.md` file at its
 * top, and below it every folder with a `SKILL.md` (a folder with one is a skill, and is not looked into further),
 * through symbolic links too; each with a description in its front matter. The first of each name wins. A folder that
 * is not there is skipped; one that cannot be read fails the whole look, so it is not taken for having none.
 */
export async function skillsIn(
    env: ExecutionEnv,
    folders: readonly string[],
    context: Context,
): Promise<Skill[]> {
    const skills = new Map<string, Skill>();

    const read = async (file: string): Promise<string | undefined> => {
        const text = await env.readTextFile(file, context);

        if (text.ok) {
            return text.value;
        }

        if (
            text.error.code === "not_found" ||
            text.error.code === "not_directory" ||
            text.error.code === "is_directory"
        ) {
            return undefined;
        }

        throw text.error;
    };

    const add = (file: string, text: string, fallback: string) => {
        let frontmatter: Record<string, unknown>;

        try {
            frontmatter = parseFrontmatter(text).frontmatter as Record<string, unknown>;
        } catch {
            return;
        }

        const name =
            typeof frontmatter.name === "string" ? frontmatter.name.trim() || fallback : fallback;
        const description =
            typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

        if (description === "" || skills.has(name)) {
            return;
        }

        skills.set(name, {
            name,
            description,
            filePath: file,
            baseDir: posix.dirname(file),
            sourceInfo: { path: file, source: "computer" } as Skill["sourceInfo"],
            disableModelInvocation: frontmatter["disable-model-invocation"] === true,
        });
    };

    const look = async (folder: string, depth: number): Promise<void> => {
        const listing = await env.listDir(folder, context);

        if (!listing.ok) {
            if (listing.error.code === "not_found" || listing.error.code === "not_directory") {
                return;
            }

            throw listing.error;
        }

        for (const entry of [...listing.value].sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith(".")) {
                continue;
            }

            // At the top, a markdown file is a skill (a link to one too).
            if (depth === 0 && entry.kind !== "directory" && entry.name.endsWith(".md")) {
                const text = await read(entry.path);

                if (text !== undefined) {
                    add(entry.path, text, entry.name.slice(0, -3));
                }

                continue;
            }

            // A folder, or a link that may be one: a skill when it has a SKILL.md, else looked into.
            if (entry.kind === "file") {
                continue;
            }

            const file = posix.join(entry.path, "SKILL.md");
            const text = await read(file);

            if (text !== undefined) {
                add(file, text, entry.name);
            } else if (depth + 1 < SKILL_DEPTH) {
                await look(entry.path, depth + 1);
            }
        }
    };

    for (const folder of folders) {
        await look(folder, 0);
    }

    return [...skills.values()];
}
