/** The web app's own files and the modules it imports, its content security policy, and image files it shows. */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { APP_ROOT } from "../config.ts";
import { HttpError } from "../errors.ts";
import { send } from "./io.ts";

export const WEB = join(APP_ROOT, "web");
const MODULES = join(APP_ROOT, "node_modules");

export const VENDOR: Record<string, string> = {
    "preact.mjs": join(MODULES, "preact", "dist", "preact.mjs"),
    "preact-hooks.mjs": join(MODULES, "preact", "hooks", "dist", "hooks.mjs"),
    "htm.mjs": join(MODULES, "htm", "dist", "htm.module.js"),
    "marked.mjs": join(MODULES, "marked", "lib", "marked.esm.js"),
    "purify.mjs": join(MODULES, "dompurify", "dist", "purify.es.mjs"),
    // noid: the terminal on the shared computer.
    "xterm.mjs": join(MODULES, "@xterm", "xterm", "lib", "xterm.mjs"),
    "xterm.css": join(MODULES, "@xterm", "xterm", "css", "xterm.css"),
    "addon-fit.mjs": join(MODULES, "@xterm", "addon-fit", "lib", "addon-fit.mjs"),
};

export const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
};

/** File types the image route shows; the bytes must match too (see `sniffImage`). */
const IMAGE_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".bmp",
    ".ico",
    ".svg",
]);
const MAX_IMAGE_FILE = 25 * 1024 * 1024;
/** Opened on its own, an SVG could run script: give it an opaque origin and nothing to load. */
const IMAGE_CSP =
    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** The image type of a file's first bytes, or undefined when it is not an image this app shows. */
export function sniffImage(head: Buffer): string | undefined {
    const ascii = (start: number, text: string) =>
        head.subarray(start, start + text.length).toString("latin1") === text;

    if (head[0] === 0x89 && ascii(1, "PNG\r\n\x1a\n")) {
        return "image/png";
    }

    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
        return "image/jpeg";
    }

    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) {
        return "image/gif";
    }

    if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
        return "image/webp";
    }

    if (ascii(4, "ftypavif") || ascii(4, "ftypavis")) {
        return "image/avif";
    }

    if (ascii(0, "BM")) {
        return "image/bmp";
    }

    if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) {
        return "image/x-icon";
    }

    const text = head
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trimStart();

    if (text.startsWith("<") && /<svg[\s>]/i.test(text)) {
        return "image/svg+xml";
    }

    return undefined;
}

/**
 * The app page's policy. Replies show markdown that Pi wrote, and what Pi writes can be steered by any file or page it
 * reads: nothing on the page may load from, send to, or post to another site. The inline import map is allowed by hash.
 */
function appPolicy(html: string): string {
    // Browsers hash script text after turning CRLF and CR into LF, as their HTML parser does.
    const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
        (match) =>
            `'sha256-${createHash("sha256").update(match[1]!.replace(/\r\n?/g, "\n")).digest("base64")}'`,
    );

    return [
        "default-src 'self'",
        ["script-src 'self'", ...hashes].join(" "),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "connect-src 'self'",
        "frame-src 'self'",
        "worker-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ].join("; ");
}

/** The app page, with its content security policy. */
export function serveApp(response: ServerResponse): void {
    let body: string;

    try {
        body = readFileSync(join(WEB, "index.html"), "utf8");
    } catch {
        send(response, 404, "Not found");

        return;
    }

    send(response, 200, body, "text/html; charset=utf-8", {
        "cache-control": "no-cache",
        "content-security-policy": appPolicy(body),
    });
}

/** The app's files as last read: sent from here while unchanged on disk, gzipped once for browsers that take it. */
const served = new Map<
    string,
    { mtimeMs: number; size: number; etag: string; body: Buffer; gzipped?: Buffer }
>();
/** How many files `served` keeps; the app has about a hundred. */
const SERVED_MAX = 400;
/** Types worth gzipping: text. Fonts and images are compressed already. */
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|manifest\+json|xml)|image\/svg)/;

/**
 * A file of the app. Every request checks the file on disk (the app is edited live, and a reload gets the newest), but
 * one unchanged since the browser had it is answered 304 with nothing, and text goes gzipped: a reload no longer sends
 * the whole app again, and a first load sends a third of it.
 */
export function serveFile(
    request: IncomingMessage,
    response: ServerResponse,
    file: string,
    fallbackType?: string,
): void {
    let entry = served.get(file);

    try {
        const stat = statSync(file);

        if (entry === undefined || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
            const body = readFileSync(file);

            entry = {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                etag: `"${createHash("sha1").update(body).digest("base64url").slice(0, 20)}"`,
                body,
            };
            served.delete(file);
            served.set(file, entry);

            for (const key of served.keys()) {
                if (served.size <= SERVED_MAX) {
                    break;
                }

                served.delete(key);
            }
        }
    } catch {
        served.delete(file);
        send(response, 404, "Not found");

        return;
    }

    const type = fallbackType ?? TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = {
        "cache-control": "no-cache",
        etag: entry.etag,
        vary: "accept-encoding",
    };

    if (request.headers["if-none-match"] === entry.etag) {
        response.writeHead(304, headers);
        response.end();

        return;
    }

    if (
        COMPRESSIBLE.test(type) &&
        entry.body.length > 1024 &&
        /\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""))
    ) {
        entry.gzipped ??= gzipSync(entry.body, { level: 6 });
        headers["content-encoding"] = "gzip";
        send(response, 200, entry.gzipped, type, headers);

        return;
    }

    send(response, 200, entry.body, type, headers);
}

/**
 * noid: an image from a session's folder elsewhere (the shared computer): answered from its etag when the browser has
 * it, else read, checked, and sent as `serveImage` sends a file of this machine.
 */
export async function serveRemoteImage(
    request: IncomingMessage,
    response: ServerResponse,
    image: { file: string; etag: string; read: () => Promise<Uint8Array> },
): Promise<void> {
    if (!IMAGE_EXTENSIONS.has(extname(image.file).toLowerCase())) {
        throw new HttpError(415, "Only image files can be shown");
    }

    const headers = {
        etag: image.etag,
        "cache-control": "private, no-cache",
        "content-security-policy": IMAGE_CSP,
    };

    if (request.headers["if-none-match"] === image.etag) {
        response.writeHead(304, headers);
        response.end();

        return;
    }

    const bytes = await image.read().catch(() => {
        throw new HttpError(404, "Image not found");
    });
    const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = sniffImage(body.subarray(0, 1024));

    if (type === undefined) {
        throw new HttpError(415, "That file is not an image");
    }

    if (body.length > MAX_IMAGE_FILE) {
        throw new HttpError(413, "Image too large to show");
    }

    response.writeHead(200, {
        ...headers,
        "content-type": type,
        "content-length": String(body.length),
    });
    response.end(body);
}

/** An image file from this machine, for `![alt](path)` in replies and for uploaded attachments. */
export function serveImage(request: IncomingMessage, response: ServerResponse, file: string): void {
    if (!IMAGE_EXTENSIONS.has(extname(file).toLowerCase())) {
        throw new HttpError(415, "Only image files can be shown");
    }

    let size: number;
    let mtime: number;
    let type: string | undefined;

    try {
        const stats = statSync(file);

        if (!stats.isFile()) {
            throw new Error("not a file");
        }

        size = stats.size;
        mtime = stats.mtimeMs;
        const head = Buffer.alloc(1024);
        const fd = openSync(file, "r");

        try {
            type = sniffImage(head.subarray(0, readSync(fd, head, 0, head.length, 0)));
        } finally {
            closeSync(fd);
        }
    } catch {
        throw new HttpError(404, "Image not found");
    }

    if (type === undefined) {
        throw new HttpError(415, "That file is not an image");
    }

    if (size > MAX_IMAGE_FILE) {
        throw new HttpError(413, "Image too large to show");
    }

    const etag = `"${size.toString(36)}-${Math.floor(mtime).toString(36)}"`;
    const headers = {
        etag,
        "cache-control": "private, no-cache",
        "content-security-policy": IMAGE_CSP,
    };

    if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, headers);
        response.end();

        return;
    }

    response.writeHead(200, {
        ...headers,
        "content-type": type,
        "content-length": String(size),
    });
    createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
}
