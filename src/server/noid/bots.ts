/**
 * noid's bots: persistent teammates, each a session with one continuous thread, a name, a role, a face, and a place to
 * work. A bot is an ordinary session whose meta carries its profile (`SessionMeta.bot`), so the session list, its
 * updates, and a restart's recovery carry bots with no store of their own; its instructions are the session's own
 * (Durable's per-conversation `instructions`). A computer bot works in `bots/<slug>` on the shared computer, a host bot
 * in a folder of this machine. Noid, the main bot, is made on first open and cannot be archived.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, type AgentState, type ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { SessionsDoc } from "../docs.ts";
import { MAX_INSTRUCTIONS } from "../commands.ts";
import { HttpError } from "../errors.ts";
import { COMPUTER_HOME } from "./computer.ts";

/** Faces: the skins and eyes `web/faces/params.js` draws. */
export const SKINS = ["jelly", "clay", "chrome", "holo", "pixel"] as const;
export const EYES = ["capsule", "visor", "dots"] as const;

export type BotProfile = {
    id: string;
    name: string;
    /** What the bot is for, in a line: shown under its name, and told to it. */
    role: string;
    /** `#rrggbb`: its face's color. */
    color: string;
    skin?: (typeof SKINS)[number];
    eyes?: (typeof EYES)[number];
    /** Where it works: the shared computer, or a folder of this machine. */
    kind: "computer" | "host";
    /** Noid, the main bot: made on first open, never archived. */
    main?: true;
};

export type BotRequest = {
    name?: unknown;
    role?: unknown;
    instructions?: unknown;
    color?: unknown;
    skin?: unknown;
    eyes?: unknown;
    kind?: unknown;
    folder?: unknown;
};

const MAX_NAME = 40;
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
    return (
        name
            .normalize("NFKD")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 32) || "bot"
    );
}

export class Bots {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The bots, with their sessions; archived ones only when asked. */
    list({ archived = false }: { archived?: boolean } = {}): {
        conversationId: ConversationId;
        bot: BotProfile;
    }[] {
        return this.#app
            .sessions()
            .filter(
                (session) => session.bot !== undefined && (archived || session.archived !== true),
            )
            .map((session) => ({
                conversationId: session.id as unknown as ConversationId,
                bot: session.bot!,
            }));
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
    ): Promise<{ id: ConversationId; bot: BotProfile }> {
        const app = this.#app;

        app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session and cannot make bots.");
        }

        const name = text(request.name, "name", MAX_NAME, true)!;
        const kind = pick(request.kind, ["computer", "host"] as const, "kind") ?? "computer";

        if (this.list().some((each) => each.bot.name.toLowerCase() === name.toLowerCase())) {
            throw new HttpError(409, `There is a bot called ${name} already.`);
        }

        let cwd: string;

        if (kind === "computer") {
            cwd = `${COMPUTER_HOME}/bots/${this.#freeSlug(slugOf(name))}`;
        } else {
            const folder = text(request.folder, "folder", 4096, true)!;

            if (app.claims(folder)) {
                throw new HttpError(400, "A host bot works in a folder of this machine.");
            }

            cwd = folder;
        }

        const bot: BotProfile = {
            id: crypto.randomUUID().slice(0, 8),
            name,
            role: text(request.role, "role", MAX_ROLE, false) ?? "",
            color: color(request.color) ?? randomColor(name),
            ...optional("skin", pick(request.skin, SKINS, "skin")),
            ...optional("eyes", pick(request.eyes, EYES, "eyes")),
            kind,
            ...(request === NOID_REQUEST ? { main: true as const } : {}),
        };
        const instructions = instructionsOf(request.instructions);
        const { id } = await app.commands.createSession(
            user,
            { cwd, title: name },
            {
                bot,
                extensions: this.#toolsOf(bot),
                ...(instructions === "" ? {} : { instructions }),
            },
        );

        await app.collab.activity(id, user, `made the bot ${name}`);

        return { id, bot };
    }

    /** Change a bot's name, role, face, or instructions. */
    async update(user: User, id: ConversationId, request: BotRequest): Promise<BotProfile> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        const current = app.sessionMeta(id)?.bot;

        if (current === undefined) {
            throw new HttpError(404, "Not a bot.");
        }

        const name = text(request.name, "name", MAX_NAME, false) || current.name;

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
        const { skin: _skin, eyes: _eyes, ...rest } = current;
        const next: BotProfile = {
            ...rest,
            name,
            role: text(request.role, "role", MAX_ROLE, false) ?? current.role,
            color: color(request.color) ?? current.color,
            ...optional("skin", face(request.skin, SKINS, "skin", current.skin)),
            ...optional("eyes", face(request.eyes, EYES, "eyes", current.eyes)),
        };

        // Instructions first: they are the part that can be refused (who drives, their length), and then nothing changed.
        if (request.instructions !== undefined) {
            await app.commands.setInstructions(id, user, request.instructions);
        }

        await app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta !== undefined) {
                meta.bot = next;
                meta.title = name;
                meta.updatedAt = Date.now();
            }
        }, context);

        return next;
    }

    /** Make Noid when there is no main bot: on first open, and after an older store without one. */
    async ensureNoid(): Promise<ConversationId> {
        const found = this.list({ archived: true }).find((each) => each.bot.main === true);

        if (found !== undefined) {
            return found.conversationId;
        }

        const owner = this.#app.config.users.find((user) => user.role === "owner")!;

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
     * Give every bot its tools (bots made before they existed), added to whatever its selection is (pi-pocket's PiP sets
     * its own the same way): nothing else in it changes, and bots that have them are left alone.
     */
    async ensureTools(): Promise<void> {
        for (const { conversationId, bot } of this.list({ archived: true })) {
            const want = this.#toolsOf(bot).map((extension) => extension.name);
            const has = (selection: AgentState["extensions"]) =>
                Array.isArray(selection)
                    ? want.every((name) => selection.includes(name))
                    : want.every(
                          (name) =>
                              (selection?.add ?? []).includes(name) &&
                              !(selection?.remove ?? []).includes(name),
                      );

            if (has((await this.#app.agentState(conversationId))?.extensions)) {
                continue;
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
    }

    /** A folder name under `bots/` that no bot uses yet. */
    #freeSlug(slug: string): string {
        const taken = new Set(
            this.#app
                .sessions()
                .map((session) => session.cwd)
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
