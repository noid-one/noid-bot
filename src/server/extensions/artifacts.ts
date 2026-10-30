/**
 * Artifacts: HTML pages, Markdown documents, and SVG images the agent publishes for the user to open in the app.
 * Every call with the same id adds a version. The index and the bodies are durable documents committed together with
 * the call, so a replayed call finds the version it already wrote instead of writing another.
 */
import { extname } from "node:path";
import type { Context } from "@earendil-works/chord";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { ArtifactBodyDoc, type ArtifactMeta, ArtifactsDoc, type ArtifactType } from "../docs.ts";
import type { PocketHost } from "../host.ts";

const MAX_BYTES = 2_000_000;

export function slugify(value: string): string {
    return value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}

/**
 * A snapshot of a file in the session's environment (this machine, or the shared computer for its sessions): a regular
 * file, not a final link (parent links are fine), UTF-8 text of at most `MAX_BYTES`. noid: through the call's
 * environment, not this machine's file system, so a computer session reads the computer's file and never this one's.
 */
async function readArtifact(env: ExecutionEnv, path: string, context: Context): Promise<string> {
    const opened = await env.openBinaryReader(path, { noFollow: true }, context);

    if (!opened.ok) {
        throw new Error(
            opened.error.code === "invalid" || opened.error.code === "is_directory"
                ? "Artifact paths must name a regular file."
                : `Could not read ${path}: ${opened.error.message}`,
        );
    }

    const reader = opened.value;

    try {
        const info = await reader.info(context);

        if (!info.ok || info.value.kind !== "file") {
            throw new Error("Artifact paths must name a regular file.");
        }

        if (info.value.size > MAX_BYTES) {
            throw new Error(`Artifacts are limited to ${MAX_BYTES} bytes.`);
        }

        // At most one byte beyond the limit, even when the file grows after its size was read.
        const read = await reader.read(0, MAX_BYTES + 1, context);

        if (!read.ok) {
            throw new Error(`Could not read ${path}: ${read.error.message}`);
        }

        const bytes = read.value;

        if (bytes.length > MAX_BYTES) {
            throw new Error(`Artifacts are limited to ${MAX_BYTES} bytes.`);
        }

        try {
            if (bytes.includes(0)) {
                throw new Error("Binary data");
            }

            return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
            throw new Error("Artifact paths must contain UTF-8 text, not binary data.");
        }
    } finally {
        await reader.close(context);
    }
}

function pathType(path: string): ArtifactType | undefined {
    switch (extname(path).toLowerCase()) {
        case ".html":
            return "html";
        case ".md":
        case ".markdown":
            return "markdown";
        case ".svg":
            return "svg";
        default:
            return undefined;
    }
}

function applyEdits(
    content: string,
    edits: readonly { oldText: string; newText: string }[],
): string {
    let next = content;

    for (const [index, edit] of edits.entries()) {
        if (edit.oldText === "") {
            throw new Error(`Edit ${index + 1}: oldText is empty.`);
        }

        const first = next.indexOf(edit.oldText);

        if (first === -1) {
            throw new Error(`Edit ${index + 1}: oldText was not found in the latest version.`);
        }

        if (next.indexOf(edit.oldText, first + 1) !== -1) {
            throw new Error(
                `Edit ${index + 1}: oldText matches more than once; include more context.`,
            );
        }

        next = next.slice(0, first) + edit.newText + next.slice(first + edit.oldText.length);
    }

    return next;
}

// Short: the tool schema says the rest (pp 1f1b1243).
const GUIDE = `Use the artifact tool for results the user should see rendered rather than read as text: interactive demos, games, visualizations, charts, diagrams, formatted reports. Not for plain answers or project files (write those with write).
- HTML artifacts open in a sandboxed frame on the user's device (often a phone) and cannot reach this app, its cookies, or the parent page. Make them self-contained, responsive (a viewport meta tag), and touch-friendly, with visible loading and error states (window.onerror).
- Load libraries from a CDN with full URLs (https://esm.sh, https://cdn.jsdelivr.net). For ES modules that import bare specifiers (three.js addons import "three"), add an import map.
- For small fixes, send edits instead of the whole content.
- To publish an existing local file without repeating it, give path. Everyone who can see the conversation can open the copy.`;

export default function createArtifacts(_host: PocketHost) {
    const artifact = defineTool({
        name: "artifact",
        description:
            "Publish an HTML page, Markdown document, or SVG image that the user opens in the app's artifact viewer. The same id publishes a new version. Give exactly one of content, edits, or path (up to 2,000,000 bytes).",
        parameters: Type.Object({
            id: Type.String({ description: "Stable kebab-case id; reuse it for a new version." }),
            title: Type.String({ description: "Short title." }),
            type: Type.Optional(
                StringEnum(["html", "markdown", "svg"] as const, {
                    description:
                        "Default: html, or from a new path's extension. A path cannot change an existing type.",
                }),
            ),
            content: Type.Optional(Type.String({ description: "The whole new version." })),
            path: Type.Optional(
                Type.String({
                    description:
                        "A UTF-8 file where this session runs, to copy as this version (a snapshot, not a live link, without the files beside it): absolute, ~/…, or relative to the session folder.",
                }),
            ),
            edits: Type.Optional(
                Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), {
                    description: "Exact, unique replacements on the latest version.",
                }),
            ),
        }),
        // The commit below is idempotent per call, so a rerun after a crash is harmless.
        replay: "safe",
        execute: async (args, api, context) => {
            const id = slugify(args.id);

            if (id === "") {
                throw new Error("The id must contain letters or digits.");
            }

            const index = (await api.snapshot(ArtifactsDoc, api.conversationId, context)) ?? {
                items: {},
            };
            const previous = Object.hasOwn(index.items, id)
                ? (index.items[id] as ArtifactMeta)
                : undefined;
            // A replay of this very call, not another call of the same task (codemode makes several in one).
            const mine = (version: { taskId: unknown; callId?: string }) =>
                version.taskId === api.taskId && (version.callId ?? api.callId) === api.callId;
            const replayed = previous?.versions.find(mine);
            let version = replayed?.version;

            if (version === undefined) {
                const inputs = [args.content, args.edits, args.path].filter(
                    (value) => value !== undefined,
                ).length;

                if (inputs !== 1 || args.edits?.length === 0) {
                    throw new Error("Give exactly one of content, nonempty edits, or path.");
                }

                let content: string;
                let type: ArtifactType = args.type ?? previous?.type ?? "html";

                if (args.path !== undefined) {
                    if (args.path.trim() === "") {
                        throw new Error("Give a local file path.");
                    }

                    if (
                        previous !== undefined &&
                        args.type !== undefined &&
                        args.type !== previous.type
                    ) {
                        throw new Error("A path cannot change an existing artifact's type.");
                    }

                    const inferred = args.type ?? previous?.type ?? pathType(args.path);

                    if (inferred === undefined) {
                        throw new Error(
                            "Set type for a path without a .html, .md, .markdown, or .svg extension.",
                        );
                    }

                    type = inferred;

                    if (api.env === undefined) {
                        throw new Error(
                            "This conversation's files cannot be read here: give content.",
                        );
                    }

                    // Absolute, ~/ (the environment's home), or relative to the session's folder, where it runs.
                    const path = await api.env.absolutePath(args.path.trim(), context);

                    if (!path.ok) {
                        throw new Error(`Could not read ${args.path}: ${path.error.message}`);
                    }

                    content = await readArtifact(api.env, path.value, context);
                } else if (args.content !== undefined) {
                    content = args.content;
                } else if (args.edits !== undefined && args.edits.length > 0) {
                    const latest = previous?.versions.at(-1);

                    if (latest === undefined) {
                        throw new Error(`There is no artifact ${id} to edit yet; send content.`);
                    }

                    const body = await api.snapshot(
                        ArtifactBodyDoc,
                        api.conversationId,
                        `${id}@${latest.version}`,
                        context,
                    );

                    content = applyEdits(body?.content ?? "", args.edits);
                } else {
                    throw new Error("Give either content or edits.");
                }

                if (Buffer.byteLength(content) > MAX_BYTES) {
                    throw new Error(`Artifacts are limited to ${MAX_BYTES} bytes.`);
                }

                version = await api.commit(async (tx) => {
                    const doc = await tx.doc(ArtifactsDoc, api.conversationId);
                    const current = Object.hasOwn(doc.items, id) ? doc.items[id] : undefined;
                    const again = current?.versions.find(mine);

                    if (again !== undefined) {
                        return again.version;
                    }

                    if (args.path !== undefined && current !== undefined) {
                        if (args.type !== undefined && args.type !== current.type) {
                            throw new Error("A path cannot change an existing artifact's type.");
                        }

                        type = current.type;
                    }

                    const next = (current?.versions.at(-1)?.version ?? 0) + 1;
                    const record = {
                        version: next,
                        taskId: api.taskId,
                        callId: api.callId,
                        size: Buffer.byteLength(content),
                        createdAt: Date.now(),
                    };

                    if (current === undefined) {
                        doc.items[id] = { title: args.title, type, versions: [record] };
                    } else {
                        current.title = args.title;
                        current.type = type;
                        current.versions.push(record);
                    }

                    const body = await tx.doc(
                        ArtifactBodyDoc,
                        api.conversationId,
                        `${id}@${next}`,
                        { content },
                    );

                    if (body.content !== content) {
                        body.content = content;
                    }

                    return next;
                }, context);
            }

            return {
                output: [
                    {
                        type: "text",
                        text: `Published "${args.title}" as artifact ${id}, version ${version}. The user opens it from the artifact card.`,
                    },
                ],
                details: { id, title: args.title, version },
            };
        },
    });

    return defineExtension({
        name: "pocket-artifacts",
        tools: [artifact],
        sections: [section("artifacts", () => GUIDE)],
    });
}
