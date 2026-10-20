/**
 * noid's bots: persistent teammates, each a session with one continuous thread, a name, a role, a face, and a place to
 * work. A bot is an ordinary session whose meta carries its profile (`SessionMeta.bot`), so the session list, its
 * updates, and a restart's recovery carry bots with no store of their own; its instructions are the session's own
 * (Durable's per-conversation `instructions`). A computer bot works in `bots/<slug>` on the shared computer, a host bot
 * in a folder of this machine. Noid, the main bot, is made on first open and cannot be archived.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SESSION_TOOLS_EXTENSION } from "../session-tools.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, type AgentState, type ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { SessionsDoc } from "../docs.ts";
import { MAX_INSTRUCTIONS } from "../commands.ts";
import { describe, HttpError } from "../errors.ts";
import { ownerOf, requireOwner } from "./owner.ts";
import { COMPUTER_HOME } from "./computer.ts";
import { nameBot, type Naming } from "./naming.ts";
import { recordUsage } from "../titles.ts";
import {
    type AgentFile,
    agentFilesSignature,
    agentFolders,
    loadAgentFiles,
    MAX_AGENT_NAME,
} from "./agent-files.ts";

/** Faces: the skins, eyes, and shapes `web/faces/params.js` draws. */
export const SKINS = ["jelly", "clay", "chrome", "holo", "pixel"] as const;
export const EYES = ["capsule", "visor", "dots"] as const;
export const SHAPES = [
    "blob",
    "rectangle",
    "triangle",
    "diamond",
    "pentagon",
    "hexagon",
    "octagon",
    "star",
    "flower",
    "pumpkin",
    "cat",
    "dog",
    "drop",
    "cloud",
    "ghost",
] as const;

export type BotProfile = {
    id: string;
    name: string;
    /** What the bot is for, in a line: shown under its name, and told to it. */
    role: string;
    /** `#rrggbb`: its face's color. */
    color: string;
    skin?: (typeof SKINS)[number];
    eyes?: (typeof EYES)[number];
    shape?: (typeof SHAPES)[number];
    /** Where it works: the shared computer, or a folder of this machine. */
    kind: "computer" | "host";
    /** Noid, the main bot: made on first open, never archived. */
    main?: true;
    /** The agent file it is made from (`agent-files.ts`): its name, role, and instructions are the file's. */
    file?: string;
    /** Archived because its file is gone: it comes back with the file. */
    fileGone?: true;
};

export type BotRequest = {
    name?: unknown;
    role?: unknown;
    instructions?: unknown;
    color?: unknown;
    skin?: unknown;
    eyes?: unknown;
    shape?: unknown;
    kind?: unknown;
    folder?: unknown;
    /** The id the sheet drew its face from, so the bot looks as it did there; another is made when it is taken. */
    id?: unknown;
};

const MAX_NAME = MAX_AGENT_NAME;
const MAX_ROLE = 160;

export const NOID: Omit<BotProfile, "id"> = {
    name: "Noid",
    role: "Chief of staff: keeps an eye on the other bots, and does work itself",
    color: "#7aa2f7",
    skin: "holo",
    eyes: "capsule",
    kind: "computer",
    main: true,
};

const NOID_INSTRUCTIONS =
    "You are the owner's main bot. When a job belongs to another bot, say which one; otherwise do it yourself.";

function text(value: unknown, what: string, max: number, required: boolean): string | undefined {
    if (value === undefined || value === null) {
        if (required) {
            throw new HttpError(400, `Give the bot a ${what}.`);
        }

        return undefined;
    }

    if (typeof value !== "string") {
        throw new HttpError(400, `The ${what} must be text.`);
    }

    const trimmed = value.replace(/\s+/g, " ").trim();

    if (required && trimmed === "") {
        throw new HttpError(400, `Give the bot a ${what}.`);
    }

    if (trimmed.length > max) {
        throw new HttpError(400, `A bot's ${what} is at most ${max} characters.`);
    }

    return trimmed;
}

function pick<T extends string>(
    value: unknown,
    allowed: readonly T[],
    what: string,
): T | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
        throw new HttpError(400, `Unknown ${what}: ${String(value)}.`);
    }

    return value as T;
}

function color(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
        throw new HttpError(400, "A bot's color is #rrggbb.");
    }

    return value.toLowerCase();
}

/** A folder name from a bot's name: lowercase letters, digits, and dashes. */
export function slugOf(name: string): string {
    return slug(name, 32, "bot");
}

/** Text as a folder name: accents dropped, lowercase words joined by dashes, at most `max`, never ending in a dash. */
export function slug(text: string, max: number, fallback: string): string {
    return (
        text
            .normalize("NFKD")
            .replace(/\p{M}+/gu, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, max)
            .replace(/^-+|-+$/g, "") || fallback
    );
}

export class Bots {
    readonly #app: PocketApp;
    /** The agent files as last synced (`agentFilesSignature`): none of them changed while it is the same. */
    #synced: string | undefined;
    /** Agent files no bot could be made from, by path, so each is told about once. */
    readonly #refused = new Set<string>();
    #syncing: Promise<void> | undefined;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The bots, with their sessions; archived ones only when asked. */
    list({ archived = false }: { archived?: boolean } = {}): {
        conversationId: ConversationId;
        bot: BotProfile;
    }[] {
        // From the catalogue the app keeps, not the list it builds for the app: bots are looked up often.
        return Object.entries(this.#app.sessionCatalogue()).flatMap(([id, meta]) =>
            meta.bot !== undefined && (archived || meta.archived !== true)
                ? [{ conversationId: Number(id) as unknown as ConversationId, bot: meta.bot }]
                : [],
        );
    }

    /** The bot a conversation works for: its own, or its session's for a subagent. */
    of(id: ConversationId): BotProfile | undefined {
        // A session a bot started (Agent Teams' linked sessions) works for that bot too: it must not escape its rules.
        let meta = this.#app.sessionMeta(this.#app.rootOf(id));

        for (
            let hops = 0;
            meta?.bot === undefined && meta?.linkedFrom !== undefined && hops < 16;
            hops++
        ) {
            meta = this.#app.sessionMeta(meta.linkedFrom.id as unknown as ConversationId);
        }

        return meta?.bot;
    }

    /** Make a bot and its session (one commit). Its model is whatever a new session starts with: people choose models. */
    async create(
        user: User,
        request: BotRequest,
        file?: string,
    ): Promise<{ id: ConversationId; bot: BotProfile }> {
        const app = this.#app;

        // Bots act as the owner (the session tools), so they are the owner's alone.
        requireOwner(user, "Only the owner makes bots.");

        const role = text(request.role, "role", MAX_ROLE, false) ?? "";
        const instructions = instructionsOf(request.instructions);
        // No name: a model names it for what it does, as a teammate's job title reads.
        const given = text(request.name, "name", MAX_NAME, false);
        let naming: Naming | undefined;

        if (!given) {
            if (role === "" && instructions === "") {
                throw new HttpError(400, "Give it a name, or say what it does so it can be named.");
            }

            naming = await nameBot(
                app,
                { role, instructions },
                this.list({ archived: true }).map((each) => each.bot.name),
            );
        }

        const name = given || naming!.name;
        const kind = pick(request.kind, ["computer", "host"] as const, "kind") ?? "computer";

        if (this.list().some((each) => each.bot.name.toLowerCase() === name.toLowerCase())) {
            throw new HttpError(409, `There is a bot called ${name} already.`);
        }

        let cwd: string;

        if (kind === "computer") {
            cwd = `${COMPUTER_HOME}/bots/${this.#freeSlug(slugOf(name))}`;
        } else {
            // A path as given: `text` would fold its runs of spaces into one, and name another folder.
            const folder = typeof request.folder === "string" ? request.folder.trim() : "";

            if (folder === "" || folder.length > 4096) {
                throw new HttpError(400, "Give the bot a folder.");
            }

            if (app.claims(folder)) {
                throw new HttpError(400, "A host bot works in a folder of this machine.");
            }

            cwd = folder;
        }

        const asked = typeof request.id === "string" && /^[0-9a-f]{8}$/.test(request.id);
        const bot: BotProfile = {
            id:
                asked && !this.list({ archived: true }).some((each) => each.bot.id === request.id)
                    ? (request.id as string)
                    : crypto.randomUUID().slice(0, 8),
            name,
            role,
            color: color(request.color) ?? randomColor(name),
            ...optional("skin", pick(request.skin, SKINS, "skin")),
            ...optional("eyes", pick(request.eyes, EYES, "eyes")),
            ...optional("shape", pick(request.shape, SHAPES, "shape")),
            kind,
            ...(request === NOID_REQUEST ? { main: true as const } : {}),
            ...optional("file", file),
        };
        const { id } = await app.commands.createSession(
            user,
            { cwd, title: name },
            {
                bot,
                extensions: this.#toolsOf(bot),
                ...(instructions === "" ? {} : { instructions }),
            },
        );

        // Naming it counts in its spend, as a session's title does.
        if (naming !== undefined) {
            await app.harness.commit(
                (tx) => recordUsage(tx, id, naming.model, naming.usage),
                context,
            );
        }

        // Every bot has the session tools, which a new conversation selects by name, as `ensureTools` does.
        await this.#ensureTools(id, bot);
        await app.collab.activity(id, user, `made the bot ${name}`);

        return { id, bot };
    }

    /**
     * A new name for a bot, written by a model from its role and instructions, and none any other bot has (nor its own
     * now): for someone to use or not. What it costs counts in the bot's spend.
     */
    async suggestName(user: User, id: ConversationId): Promise<{ name: string }> {
        const app = this.#app;

        requireOwner(user, "Only the owner names bots.");
        app.requireSee(user, id);

        const current = app.sessionMeta(id)?.bot;

        if (current === undefined) {
            throw new HttpError(404, "Not a bot.");
        }

        const naming = await nameBot(
            app,
            { role: current.role, instructions: (await app.agentState(id))?.instructions ?? "" },
            this.list({ archived: true }).map((each) => each.bot.name),
        );

        await app.harness.commit((tx) => recordUsage(tx, id, naming.model, naming.usage), context);

        return { name: naming.name };
    }

    /** Change a bot's name, role, face, or instructions. */
    async update(user: User, id: ConversationId, request: BotRequest): Promise<BotProfile> {
        const app = this.#app;

        requireOwner(user, "Only the owner changes bots.");
        app.requireSee(user, id);

        const current = app.sessionMeta(id)?.bot;

        if (current === undefined) {
            throw new HttpError(404, "Not a bot.");
        }

        const name = text(request.name, "name", MAX_NAME, false) || current.name;

        // A bot from an agent file is what its file says; only its face is noid's.
        if (
            current.file !== undefined &&
            (name !== current.name ||
                (text(request.role, "role", MAX_ROLE, false) ?? current.role) !== current.role)
        ) {
            throw new HttpError(
                409,
                `This bot's name and role are its file's: edit ${current.file}.`,
            );
        }

        if (
            name.toLowerCase() !== current.name.toLowerCase() &&
            this.list().some((each) => each.bot.name.toLowerCase() === name.toLowerCase())
        ) {
            throw new HttpError(409, `There is a bot called ${name} already.`);
        }

        // Absent keeps the face's pick; "" goes back to the one from its name.
        const face = <T extends string>(
            value: unknown,
            allowed: readonly T[],
            what: string,
            kept?: T,
        ) => (value === undefined ? kept : pick(value, allowed, what));
        const role = text(request.role, "role", MAX_ROLE, false);
        const newColor = color(request.color);
        const skin = face(request.skin, SKINS, "skin", current.skin);
        const eyes = face(request.eyes, EYES, "eyes", current.eyes);
        const shape = face(request.shape, SHAPES, "shape", current.shape);

        // Onto the profile as it is when written: what changed meanwhile (the agent-file sync's `fileGone`, another
        // edit) stays.
        const changed = (profile: BotProfile): BotProfile => {
            const { skin: _skin, eyes: _eyes, shape: _shape, ...rest } = profile;

            return {
                ...rest,
                name,
                role: role ?? profile.role,
                color: newColor ?? profile.color,
                ...optional("skin", request.skin === undefined ? profile.skin : skin),
                ...optional("eyes", request.eyes === undefined ? profile.eyes : eyes),
                ...optional("shape", request.shape === undefined ? profile.shape : shape),
            };
        };

        let next = changed(current);

        // Instructions first: they are the part that can be refused (who drives, their length), and then nothing changed.
        if (request.instructions !== undefined) {
            await app.commands.setInstructions(id, user, request.instructions);
        }

        await app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta?.bot !== undefined) {
                next = changed(meta.bot);
                meta.bot = next;
                meta.title = name;
                meta.updatedAt = Date.now();
            }
        }, context);

        return next;
    }

    /** Where agent files are looked for (`agent-files.ts`). */
    agentFolders(): string[] {
        return agentFolders(this.#app.home, getAgentDir());
    }

    /** The agent files, the first of each name: bots, and what `subagent` takes as `agent`. */
    agentFiles(): AgentFile[] {
        return loadAgentFiles(this.agentFolders());
    }

    /**
     * Make the agent files' bots match them: a bot for each new file, its name, role, and instructions brought up to
     * date, and archived when its file is gone (and back when it returns). Nothing to do while no file changed. A bot a
     * person archived stays archived. A file whose name another bot has, or whose instructions are too long, makes no
     * bot: the owner is told, once.
     */
    syncAgentFiles(): Promise<void> {
        // One at a time: a look that comes while one runs waits for it.
        this.#syncing ??= this.#syncAgentFiles().finally(() => {
            this.#syncing = undefined;
        });

        return this.#syncing;
    }

    async #syncAgentFiles(): Promise<void> {
        const folders = this.agentFolders();
        const signature = agentFilesSignature(folders);

        if (signature === this.#synced) {
            return;
        }

        const app = this.#app;
        const owner = ownerOf(app);

        if (owner === undefined) {
            return;
        }

        const files = loadAgentFiles(folders);
        const bots = this.list({ archived: true });

        for (const file of files) {
            const name = file.name;
            const role =
                file.description.length > MAX_ROLE
                    ? `${file.description.slice(0, MAX_ROLE - 1).trimEnd()}…`
                    : file.description;

            const refuse = (why: string) => {
                if (!this.#refused.has(file.path)) {
                    this.#refused.add(file.path);

                    app.notice("warning", `No bot from ${file.path}: ${why}`);
                }
            };

            if (file.instructions.length > MAX_INSTRUCTIONS) {
                refuse(`its instructions are over ${MAX_INSTRUCTIONS} characters.`);

                continue;
            }

            const own = bots.find((each) => each.bot.file === file.path);
            const clash = bots.find(
                (each) =>
                    each.bot.file !== file.path &&
                    each.bot.name.toLowerCase() === name.toLowerCase() &&
                    app.sessionMeta(each.conversationId)?.archived !== true,
            );

            if (clash !== undefined) {
                refuse(`there is a bot called ${clash.bot.name} already.`);

                continue;
            }

            if (own === undefined) {
                const made = await this.create(
                    owner,
                    { name, role, instructions: file.instructions },
                    file.path,
                ).catch((error: unknown) => {
                    // One file that cannot be a bot (a name another file took first) leaves the others to sync.
                    refuse(describe(error));
                });

                if (made !== undefined) {
                    this.#refused.delete(file.path);
                    bots.push({ conversationId: made.id, bot: made.bot });
                }

                continue;
            }

            this.#refused.delete(file.path);

            const { conversationId: id, bot } = own;

            if ((await app.agentState(id))?.instructions !== (file.instructions || undefined)) {
                await (
                    await app.conversation(id)
                ).configure(
                    { instructions: file.instructions === "" ? null : file.instructions },
                    context,
                );
            }

            if (bot.name !== name || bot.role !== role || bot.fileGone === true) {
                await app.harness.commit(async (tx) => {
                    const meta = (await tx.doc(SessionsDoc)).items[String(id)];

                    if (meta?.bot !== undefined) {
                        const { fileGone, ...rest } = meta.bot;

                        meta.bot = { ...rest, name, role };
                        meta.title = name;

                        if (fileGone === true) {
                            meta.archived = false;
                        }

                        meta.updatedAt = Date.now();
                    }
                }, context);
            }
        }

        const paths = new Set(files.map((file) => file.path));

        for (const { conversationId: id, bot } of bots) {
            if (
                bot.file !== undefined &&
                !paths.has(bot.file) &&
                bot.fileGone !== true &&
                app.sessionMeta(id)?.archived !== true
            ) {
                await app.harness.commit(async (tx) => {
                    const meta = (await tx.doc(SessionsDoc)).items[String(id)];

                    if (meta?.bot !== undefined) {
                        meta.bot = { ...meta.bot, fileGone: true };
                        meta.archived = true;
                        meta.updatedAt = Date.now();
                    }
                }, context);
            }
        }

        this.#synced = signature;
    }

    /** Make Noid when there is no main bot: on first open, and after an older store without one. */
    async ensureNoid(): Promise<ConversationId> {
        const found = this.list({ archived: true }).find((each) => each.bot.main === true);

        if (found !== undefined) {
            return found.conversationId;
        }

        const owner = ownerOf(this.#app)!;

        return (await this.create(owner, NOID_REQUEST)).id;
    }

    /** A bot's own tools: mail for every bot, the overseer's for Noid, and the desktop for bots on the computer. */
    #toolsOf(bot: BotProfile) {
        const mail = this.#app.botMail;

        return [
            mail.extension,
            ...(bot.main === true ? [mail.overseer] : []),
            ...(bot.kind === "computer" ? [this.#app.desktop.extension] : []),
        ];
    }

    /**
     * Give every bot its tools (bots made before they existed), added to whatever its selection is: nothing else in it
     * changes, and bots that have them are left alone.
     */
    async ensureTools(): Promise<void> {
        for (const { conversationId, bot } of this.list({ archived: true })) {
            await this.#ensureTools(conversationId, bot);
        }
    }

    async #ensureTools(conversationId: ConversationId, bot: BotProfile): Promise<void> {
        // Every bot has the session tools too, acting for the owner (`SessionTools.actsFor`).
        const want = [
            ...this.#toolsOf(bot).map((extension) => extension.name),
            SESSION_TOOLS_EXTENSION,
        ];
        const has = (selection: AgentState["extensions"]) =>
            Array.isArray(selection)
                ? want.every((name) => selection.includes(name))
                : want.every(
                      (name) =>
                          (selection?.add ?? []).includes(name) &&
                          !(selection?.remove ?? []).includes(name),
                  );

        if (has((await this.#app.agentState(conversationId))?.extensions)) {
            return;
        }

        await this.#app.harness.commit(async (tx) => {
            const state = await tx.doc(AgentDoc, conversationId);
            const selection = state.extensions;

            if (Array.isArray(selection)) {
                state.extensions = [
                    ...selection,
                    ...want.filter((name) => !selection.includes(name)),
                ];

                return;
            }

            const add = selection?.add ?? [];
            const remove = (selection?.remove ?? []).filter((name) => !want.includes(name));

            state.extensions = {
                add: [...add, ...want.filter((name) => !add.includes(name))],
                ...(remove.length === 0 ? {} : { remove }),
            };
        }, context);
    }

    /** A folder name under `bots/` that no bot uses yet. */
    #freeSlug(slug: string): string {
        const taken = new Set(
            Object.values(this.#app.sessionCatalogue())
                .map((meta) => meta.cwd)
                .filter((cwd) => cwd.startsWith(`${COMPUTER_HOME}/bots/`))
                .map((cwd) => cwd.slice(`${COMPUTER_HOME}/bots/`.length)),
        );

        for (let count = 1; ; count++) {
            const candidate = count === 1 ? slug : `${slug}-${count}`;

            if (!taken.has(candidate)) {
                return candidate;
            }
        }
    }
}

/** The request that makes Noid: the only one that makes a main bot. */
const NOID_REQUEST: BotRequest = { ...NOID, instructions: NOID_INSTRUCTIONS };

/** A new bot's instructions, checked as `Commands.setInstructions` checks them. */
function instructionsOf(value: unknown): string {
    if (value === undefined || value === null) {
        return "";
    }

    if (typeof value !== "string") {
        throw new HttpError(400, "Instructions must be text.");
    }

    if (value.trim().length > MAX_INSTRUCTIONS) {
        throw new HttpError(413, `Instructions are limited to ${MAX_INSTRUCTIONS} characters`);
    }

    return value.trim();
}

const optional = <K extends string, V>(key: K, value: V | undefined) =>
    (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

/** A steady color from a name, from the faces' defaults, for a bot made without one. */
function randomColor(name: string): string {
    const colors = [
        "#7aa2f7",
        "#9ece6a",
        "#ff9e64",
        "#bb9af7",
        "#7dcfff",
        "#f7768e",
        "#e0af68",
        "#2ac3de",
    ];
    let hash = 0;

    for (const char of name) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }

    return colors[hash % colors.length]!;
}
