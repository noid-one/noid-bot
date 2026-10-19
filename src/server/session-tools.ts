/**
 * The session tools: what Noid, and every other bot, does with the owner's sessions. Their extension
 * (`extensions/session-tools.ts`) is selected in bots' conversations only, and gives tools to list, read, start,
 * message, stop, archive, and schedule sessions, to see the calls waiting for approval and deny them (never allow: that
 * stays a person's), and to follow a session until its run ends. Every tool acts as the owner, with exactly their
 * rights: the checks are the ones their own requests meet.
 *
 * A follow is a durable task in the bot's conversation: it waits for the message the bot sent (or for the session to go
 * idle), then sends the bot a report. Request ids keep a restart from sending a message or a report twice.
 *
 * A bot checks before it acts: it messages, stops, archives, schedules in, or watches a PR from a session only after it
 * looked at that session lately (read it, started it, or had a report from it). And it never chooses a model: it passes
 * one, or names one in what it sends, only when its person named that model in their own words to it.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    AssistantEntry,
    CompactionEntry,
    type ConversationId,
    type Cursor,
    defineTask,
    InboxDoc,
    LiveDoc,
    ResetEntry,
    type Task,
    type TaskRuntime,
    type Tx,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { AuthorsDoc, FollowsDoc, ProviderAskedDoc } from "./docs.ts";
import { NOTE_ENTRY } from "./entry-format.ts";
import { describe } from "./errors.ts";
import { clip, defang, quoted } from "./fence.ts";
import { git } from "./git.ts";
import { originRepo, parseRepo, requirePush, sameRepo } from "./github.ts";
import { indexed, modelsNamed, personNamed, sharePhrase, words } from "./model-names.ts";
import { findModel } from "./models.ts";
import { homePath } from "./paths.ts";
import { type ClientEntry, projectEntry, snippet } from "./projection.ts";
import type { RepoWatchRequest, RepoWatchView } from "./repo-watches.ts";
import { clientKey, requestFor } from "./requests.ts";
import { describeMoment, describeRepeat } from "./when.ts";

const context = BACKGROUND_CONTEXT;

/** The session tools' extension: the tools, their prompt, and the follow task. Bots' conversations select it. */
export const SESSION_TOOLS_EXTENSION = "noid-sessions";
/** How reports from followed sessions start, so the bot knows what they are. */
export const REPORT_HEAD = "[report] ";
/** What sends for the owner when a conversation is no bot's: Noid, the main bot. */
const NOID_NAME = "Noid";
/** Sessions a bot may start in an hour, so a confused loop cannot fill the list. */
const STARTS_PER_HOUR = 20;
/**
 * Messages, follows, and schedules a bot may make in an hour. Reports start its runs with nobody watching: this keeps
 * a loop (follow, report, follow; or a bot and a session messaging each other) from spending without end.
 */
const ACTIONS_PER_HOUR = 60;
/** How long a clone may take, and how long a folder's repository is kept before git is asked again. */
const CLONE_TIMEOUT_MS = 15 * 60_000;
const ORIGIN_FOR_MS = 5 * 60_000;
/** How long a follow that reported is remembered, so a replayed call that made it does not make another. */
const FOLLOW_MEMORY_MS = 24 * 3_600_000;
/** How long a bot's look at a session (a read, its start, a report from it) counts as knowing what it is doing. */
const CHECKED_FOR_MS = 15 * 60_000;
/**
 * How many of a bot's newest entries are searched for the models its person named, at most, and how many at a time: its
 * context (since its last compaction or new context) is searched whole, up to this many.
 */
const NAMED_IN_ENTRIES = 2_000;
const NAMED_IN_PAGE = 200;
/**
 * How long after a follow reported its session's "Pi finished" stays muted: long enough for the push of the same run's
 * end, which comes a few seconds later, and short enough not to mute the next run's.
 */
const REPORTED_JUST_NOW_MS = 60_000;

/** How what a session said reaches a bot: fenced, so it reads as data, not as instructions. */
export const SESSION_OPEN = "<session-output>";
export const SESSION_CLOSE = "</session-output>";
/** Follows waiting at once, at most. */
const MAX_FOLLOWS = 50;
/** How much of a session's last answer a report and a read carry. */
const ANSWER_CHARS = 3000;
const LINE_CHARS = 600;

type FollowInput = {
    sessionId: ConversationId;
    /** The person the bot acts for: the report is sent for them. */
    userId: string;
    title: string;
    /** The message the bot sent, whose answer the report carries; absent: report when the session is next idle. */
    requestId?: string;
};
type FollowState = { phase: "wait" } | { phase: "report"; text: string };
type FollowRuntime = TaskRuntime<FollowInput, FollowState, null, object>;

/** One session as the sessions tool lists it. */
export type ListedSession = {
    id: number;
    title: string;
    state: "working" | "needs approval" | "idle";
    folder: string;
    archived: boolean;
    model?: string;
    branch?: string;
    updatedAt: number;
    subagents?: string;
};

const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;

/** A session's words, fenced for a bot; a fence inside them cannot end the fence early. */
export function fenced(text: string): string {
    return `${SESSION_OPEN}\n${defang(text)}\n${SESSION_CLOSE}`;
}

/** A tool call's key made into a request id's: short and safe whatever the call ids look like. */
function requestKey(key: string): string {
    return createHash("sha256").update(key).digest("base64url").slice(0, 40);
}

function textOf(message: AssistantMessage | undefined): string {
    return (message?.content ?? [])
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
        .trim();
}

/** A tool call in a few words: its name and its first short argument. */
function callLine(name: string, args: Record<string, unknown>): string {
    const first = Object.values(args).find(
        (value) => typeof value === "string" && value.trim() !== "",
    ) as string | undefined;

    return first === undefined ? name : `${name} ${snippet(first, 120)}`;
}

/** How long ago, in a word or two. */
export function ago(moment: number, now: number): string {
    const minutes = Math.round((now - moment) / 60_000);

    if (minutes < 1) {
        return "just now";
    }

    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    const hours = Math.round(minutes / 60);

    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export class SessionTools {
    readonly #app: PocketApp;
    /** When each person's bots started their recent sessions, and made their messages and follows: for hourly limits. */
    readonly #recent = new Map<string, number[]>();
    /** Clones under way, by repository, so two asks clone once; and folders' repositories, kept a few minutes. */
    readonly #cloning = new Map<string, Promise<string>>();
    readonly #origins = new Map<string, { repo: string | undefined; at: number }>();
    /**
     * When each bot last looked at each session (`bot:session`): read it, started it, or had a report from it. In
     * memory: after a restart a bot looks again before it acts.
     */
    readonly #checked = new Map<string, number>();
    /** The durable task behind each follow; the session tools' extension installs it. */
    readonly task: Task<FollowInput, FollowState, null, object>;
    /** How long a report waits before it looks again whether the session tools are back on (tests shorten it). */
    holdMs = 60_000;

    constructor(app: PocketApp) {
        this.#app = app;
        this.task = defineTask<FollowInput, FollowState, null>({
            name: "pocket.session-follow",
            version: 1,
            initial: () => ({ phase: "wait" }),
            phases: {
                wait: (task, runtime, context) => this.#wait(task.input, runtime, context),
                report: (task, runtime, context) =>
                    this.#report(task.input, task.state.checkpoint.text, runtime, context),
            },
            abort: (_task, runtime, context) =>
                runtime.commit(async (tx) => {
                    await this.#settleFollow(tx, runtime.conversationId, Number(runtime.taskId));

                    return { status: "terminal", outcome: { status: "aborted" } } as const;
                }, context),
        });
    }

    // ─── Whose tools ────────────────────────────────────────────────────────

    /** Whether this person's bots have the session tools: the owner's do, while their extension is on. */
    available(user: User): boolean {
        return (
            user.role === "owner" &&
            this.#app.loader.extensionNames().includes(SESSION_TOOLS_EXTENSION)
        );
    }

    /** Noid's conversation: the main bot's, the owner's own assistant. */
    noid(): ConversationId | undefined {
        return this.#app.bots.list().find((each) => each.bot.main === true)?.conversationId;
    }

    /** Whether a conversation is Noid's. */
    isNoid(conversationId: ConversationId): boolean {
        const noid = this.noid();

        return noid !== undefined && Number(noid) === Number(conversationId);
    }

    /**
     * The session tools turned off: Noid's run stops, and any compaction of its context, which would go on without its
     * own summary (`noid-compact.ts`) and read what came from outside as it is. Nothing new reaches it until they are
     * back.
     */
    async stopAll(): Promise<void> {
        const app = this.#app;
        const id = this.noid();

        if (id === undefined) {
            return;
        }

        try {
            await (await app.conversation(id)).abort(context);

            for (const compaction of (await app.harness.snapshot(LiveDoc, id, context))
                ?.compactions ?? []) {
                await app.harness.abortTask(compaction.taskId, context);
            }
        } catch (error) {
            app.log(`Noid ${String(id)} was not stopped: ${describe(error)}`);
        }
    }

    /** The person whose own assistant a conversation is: the owner, for Noid's; undefined for every other conversation. */
    ownerOf(conversationId: ConversationId): string | undefined {
        return this.isNoid(conversationId) ? this.#owner() : undefined;
    }

    /**
     * The person a conversation's session tools act for: the owner, for every bot, which has the session tools
     * (`Bots.ensureTools`); undefined for every other conversation.
     */
    actsFor(conversationId: ConversationId): string | undefined {
        // A bot's own, a subagent of it, or a session it started (`Bots.of`): all the owner's, as approvals take them.
        return (
            this.ownerOf(conversationId) ??
            (this.#app.bots.of(conversationId) === undefined ? undefined : this.#owner())
        );
    }

    #owner(): string | undefined {
        return this.#app.config.users.find((user) => user.role === "owner")?.id;
    }

    /** What a bot's messages say they were sent through: its name. */
    #via(conversationId: ConversationId): string {
        return this.#app.bots.of(conversationId)?.name ?? NOID_NAME;
    }

    /** The name of the person a conversation's session tools act for; undefined for every other conversation. */
    ownerName(conversationId: ConversationId): string | undefined {
        const userId = this.actsFor(conversationId);

        return userId === undefined
            ? undefined
            : (this.#app.config.userById(userId)?.name ?? "the owner");
    }

    /** Count one more of the bot's actions of a kind, or refuse when it made `max` in the last hour. */
    #count(user: User, kind: "start" | "act", max: number): void {
        const key = `${user.id}:${kind}`;
        const now = Date.now();
        const recent = (this.#recent.get(key) ?? []).filter((at) => now - at < 3_600_000);

        if (recent.length >= max) {
            throw new Error(
                kind === "start"
                    ? `You started ${String(max)} sessions in the last hour; wait, or ask the person to start more themselves.`
                    : `You made ${String(max)} messages, follows, schedules, and watches in the last hour; wait before making more.`,
            );
        }

        this.#recent.set(key, [...recent, now]);
    }

    /**
     * A schedule set up in `conversationId` under `key` by `make`, counted as one of the bot's actions when the bot
     * sets it up: in its own conversation (its schedule tool), or for `user` in a session. A key already used finds its
     * schedule without counting again; a schedule `make` refuses (a `when` it cannot read) gives its count back.
     */
    async countSchedule<T>(
        conversationId: ConversationId,
        key: string,
        make: () => Promise<T>,
        user?: User,
    ): Promise<T> {
        const app = this.#app;
        const counted =
            user ??
            (this.actsFor(conversationId) === undefined ? undefined : this.#person(conversationId));

        if (
            counted === undefined ||
            (await app.schedules.list(conversationId)).some((item) => item.key === key)
        ) {
            return make();
        }

        return this.#counted(counted, make);
    }

    /** Do `make`, counted as one of the bot's actions (or starts); refused (nothing made), it gives its count back. */
    async #counted<T>(
        user: User,
        make: () => Promise<T>,
        kind: "start" | "act" = "act",
    ): Promise<T> {
        this.#count(user, kind, kind === "start" ? STARTS_PER_HOUR : ACTIONS_PER_HOUR);

        try {
            return await make();
        } catch (error) {
            this.#recent.get(`${user.id}:${kind}`)?.pop();

            throw error;
        }
    }

    /**
     * Send a message for the bot's person, once for a key however often the call runs: a message already sent under it
     * is found, not sent again (nor checked again: a limit reached since does not undo it).
     */
    async #submit(
        botId: ConversationId,
        id: ConversationId,
        user: User,
        text: string,
        key: string,
        steer: boolean,
        checks: () => Promise<void> = async () => {},
    ): Promise<string> {
        const app = this.#app;
        const asked = requestKey(key);
        const requestId = requestFor(user.id, clientKey(asked));
        let sent = false;

        await app.harness.commit(async (tx) => {
            sent = (await tx.submissionByRequest(id, requestId)) !== undefined;
        }, context);

        if (sent) {
            return requestId;
        }

        // Only a message not sent yet: a replayed call finds the one it sent, whatever the bot knows after a restart.
        await checks();
        this.#count(user, "act", ACTIONS_PER_HOUR);

        return (
            await app.commands.submit(
                id,
                user,
                { text, requestId: asked, ...(steer ? { mode: "steer" as const } : {}) },
                this.#via(botId),
            )
        ).requestId;
    }

    /** The bot's person, from its conversation; an error when the conversation is no bot's, or its person is gone. */
    #person(botId: ConversationId): User {
        const userId = this.actsFor(botId);
        const user = userId === undefined ? undefined : this.#app.config.userById(userId);

        if (user === undefined) {
            throw new Error("Only bots have these tools.");
        }

        return user;
    }

    /** A session the bot may act on: one its person can see, and not the bot itself. */
    #session(botId: ConversationId, user: User, sessionId: number): ConversationId {
        const id = sessionId as unknown as ConversationId;

        if (id === botId) {
            throw new Error("That is your own conversation.");
        }

        if (this.#app.sessionMeta(id) === undefined) {
            throw new Error(`There is no session ${sessionId}. List them with the sessions tool.`);
        }

        // noid: bots are reached as bots, with what bot mail keeps track of.
        if (this.#app.sessionMeta(id)?.bot !== undefined) {
            throw new Error(`${String(sessionId)} is a bot: use bot_message or bot_brief.`);
        }

        this.#app.requireSee(user, id);

        return id;
    }

    /** The bot just looked at a session, and knows what it is doing. */
    #looked(botId: ConversationId, sessionId: ConversationId | number): void {
        this.#checked.set(`${String(botId)}:${String(sessionId)}`, Date.now());
    }

    /**
     * Refuse to act on a session the bot has not looked at lately: what it would send or stop may be what the session
     * does not need. `doing` says what in a few words ("message", "stop").
     */
    #requireLooked(botId: ConversationId, sessionId: number, doing: string): void {
        const at = this.#checked.get(`${String(botId)}:${String(sessionId)}`);

        if (at === undefined || Date.now() - at > CHECKED_FOR_MS) {
            throw new Error(
                `Check /s/${String(sessionId)} first with session_read (a few entries may be enough): see what it is doing now, and ${doing} it only if it needs that.`,
            );
        }
    }

    /**
     * What the bot's person said to it in their own words: their messages in its context now, newest first (since its
     * last new context, and those its last compaction kept), and the standing instructions of the watches and webhooks
     * to it that they set up. Never the instructions of a watch the bot set up (its own words, checked against the
     * models signed in then), what was posted to a webhook, what GitHub said, a report, or anything else sent for them.
     * Each message apart: a short name's family word counts in its own message only. `messages`: their messages alone,
     * with their entries, newest first. `newest`: the newest entry of the bot's conversation; `since`: where its
     * context starts, as far as this read (its new context's entry, the oldest its last compaction kept, or the oldest
     * read).
     */
    async #personWords(
        botId: ConversationId,
        user: User,
    ): Promise<{
        words: string[];
        messages: { id: number; text: string }[];
        newest: number | undefined;
        since: number;
    }> {
        const app = this.#app;
        const own = (await app.harness.snapshot(AuthorsDoc, botId, context))?.entries ?? {};
        const conversation = await app.conversation(botId);
        const messages: { id: number; text: string }[] = [];
        // A compaction keeps the newest messages before it as they were: down to its head, they are still in context.
        let keptFrom: number | undefined;
        let cursor: Cursor | undefined;
        let read = 0;
        let newest: number | undefined;
        let since = 0;

        scan: do {
            const page = await conversation.entries({}, NAMED_IN_PAGE, cursor, context);

            for (const entry of page.items) {
                newest ??= Number(entry.id);

                if (entry.kind === ResetEntry.kind) {
                    since = Number(entry.id);

                    break scan;
                }

                if (keptFrom !== undefined && entry.id < keptFrom) {
                    since = keptFrom;

                    break scan;
                }

                since = Number(entry.id);

                if (entry.kind === CompactionEntry.kind) {
                    keptFrom ??= entry.head ?? Number(entry.id);

                    continue;
                }

                const shown = projectEntry(entry);

                if (shown?.kind === "user" && own[String(shown.id)] === user.id) {
                    messages.push({ id: shown.id, text: shown.text });
                }
            }

            read += page.items.length;
            cursor = page.next;
        } while (cursor !== undefined && read < NAMED_IN_ENTRIES);

        const target = Number(botId);
        const standing = [
            ...(await app.repoWatches.list(user)).filter(
                (watch) => watch.by === user.id && !watch.byPi && watch.target === target,
            ),
            ...(await app.hooks.list(user)).filter(
                (hook) => hook.by === user.id && hook.target === target,
            ),
        ];

        return {
            words: [
                ...messages.map((each) => each.text),
                ...standing.map((each) => each.instructions ?? ""),
            ],
            messages,
            newest,
            since,
        };
    }

    /**
     * Whether the person's newest message (`person`'s) answers the question the bot was last told to ask, which
     * provider pays (`ProviderAskedDoc`), with `model`'s: asked in the bot's context now, it is their first message
     * since, and just the whole name or id of the provider of one of the models asked about, `model` among them, and of
     * no other provider asked about. Everyday words ("sure", "go") answer nothing, and no question from before the
     * bot's context began is answered: one from before Start fresh (whenever that came: sent while the bot works, it
     * waits for its next pause), one from before what its last compaction kept, or one an earlier build kept (without
     * `at`).
     */
    async #answered(
        botId: ConversationId,
        model: { provider: string; id: string },
        person: { messages: readonly { id: number; text: string }[]; since: number },
        providerName: (provider: string) => string,
    ): Promise<boolean> {
        const asked = (await this.#app.harness.snapshot(ProviderAskedDoc, botId, context))?.asked;
        const [newest, before] = person.messages;

        if (
            typeof asked?.at !== "number" ||
            asked.at < person.since ||
            newest === undefined ||
            newest.id <= asked.at ||
            (before !== undefined && before.id > asked.at) ||
            !asked.models.some((each) => each.provider === model.provider && each.id === model.id)
        ) {
            return false;
        }

        const answer = words(newest.text).join(" ");
        const answering = [...new Set(asked.models.map((each) => each.provider))].filter(
            (provider) =>
                answer !== "" &&
                [provider, providerName(provider)].some((full) => words(full).join(" ") === answer),
        );

        return answering.length === 1 && answering[0] === model.provider;
    }

    /**
     * The signed-in model the bot may start a session on: one its person named, whose sign-in works now. Anything else
     * is refused, telling the bot to leave the model out or ask, never to pick another.
     */
    async #personsModel(botId: ConversationId, user: User, spec: string) {
        const app = this.#app;
        const model = findModel(app.models, spec);

        if (model === undefined) {
            throw new Error(
                `${spec} is not a model signed in here. Leave model out (the session starts on the default model), or ask your person which model they mean; do not pick another.`,
            );
        }

        // Read once for the checks below: it can be long.
        const person = await this.#personWords(botId, user);
        const said = indexed(person.words);
        const available = app.models.getAvailableSnapshot();
        // Every model Pi knows: words that name one not signed in name no shorter one that is.
        const known = app.models.getModels();
        const providerName = (provider: string) =>
            app.models.getProvider(provider)?.name ?? provider;
        const theirs = modelsNamed(said, [model], true, [...available, ...known]).includes(model);
        const named =
            personNamed(said, model, available, providerName, known) ||
            (theirs && (await this.#answered(botId, model, person, providerName)));

        // Their words name it, but at more than one provider: which one pays is theirs to say. What the bot asks about
        // is kept, for their answer (`#answered`).
        if (!named && theirs) {
            const asked = [
                model,
                ...available.filter(
                    (other) => other.provider !== model.provider && sharePhrase(said, model, other),
                ),
            ];

            await app.harness.commit(async (tx) => {
                (await tx.doc(ProviderAskedDoc, botId)).asked = {
                    models: asked.map((each) => ({ provider: each.provider, id: each.id })),
                    at: person.newest ?? 0,
                };
            }, context);

            throw new Error(
                `Your person named ${model.name}, which more than one signed-in provider has: ${[...new Set(asked.map((each) => providerName(each.provider)))].join(", ")}. Ask them which one to use (their answer may be just its name); do not pick one.`,
            );
        }

        if (!named) {
            throw new Error(
                `Your person did not name ${model.provider}/${model.id}. Models are theirs to choose: leave model out (the session starts on the default model), or ask them which model to use.`,
            );
        }

        const problem = await app.providers.problem(
            { provider: model.provider, modelId: model.id },
            true,
        );

        if (problem !== undefined) {
            throw new Error(
                `${model.provider}/${model.id} cannot be used now: ${problem}. Tell your person; do not pick another model.`,
            );
        }

        return { provider: model.provider, modelId: model.id };
    }

    /**
     * Refuse text from the bot that names a model its person did not name: which model to use is theirs to say. Words
     * that name the same model at two providers pass when the person named either: text picks no provider (a subagent's
     * model must be one the owner allows anyway).
     */
    async #requireNoModelChoice(botId: ConversationId, user: User, text: string): Promise<void> {
        const app = this.#app;
        const available = app.models.getAvailableSnapshot();
        const known = app.models.getModels();
        const written = indexed(text);
        const named = modelsNamed(written, available, true, known, false);

        if (named.length === 0) {
            return;
        }

        const theirs = modelsNamed(
            indexed((await this.#personWords(botId, user)).words),
            available,
            true,
            known,
        );
        const chosen = named.filter(
            (model) =>
                !theirs.includes(model) &&
                !theirs.some((other) => sharePhrase(written, model, other)),
        );

        if (chosen.length > 0) {
            throw new Error(
                `This names ${chosen.map((model) => `${model.provider}/${model.id}`).join(", ")}, which your person did not name. Which model to use is theirs to say: take it out (sessions and their subagents use their own model), or ask them first.`,
            );
        }
    }

    /** A session's state now, in a few words, for the results of the bot's tools that act on it. */
    async status(botId: ConversationId, sessionId: number): Promise<string> {
        const app = this.#app;
        const user = this.#person(botId);
        const id = this.#session(botId, user, sessionId);
        const meta = app.sessionMeta(id)!;
        // Messages not taken yet, the bot's just now among them: a session about to start is not idle.
        const waiting = (await app.harness.snapshot(InboxDoc, id, context))?.items.length ?? 0;
        const state = app.approvals
            .all()
            .some((request) => app.rootOf(request.conversationId) === id)
            ? "needs approval"
            : app.isBusy(id)
              ? "working"
              : waiting > 0
                ? "about to start"
                : "idle";

        return `/s/${String(sessionId)} now: ${state}${waiting > 0 ? `, ${String(waiting)} message${waiting === 1 ? "" : "s"} waiting` : ""}${meta.archived === true ? ", archived" : ""}, last active ${ago(meta.updatedAt, Date.now())}.`;
    }

    // ─── What the bot's tools do ────────────────────────────────────────────────

    /** The sessions the bot's person can see, newest first. */
    sessions(
        botId: ConversationId,
        filter: { query?: string; state?: string; archived?: boolean; limit?: number } = {},
    ): { sessions: ListedSession[]; more: number; folders: string[] } {
        const app = this.#app;
        const user = this.#person(botId);
        const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        // noid: bots are not sessions here; the bots tool lists them.
        const all = app
            .sessions(user)
            .filter((session) => session.bot === undefined)
            .map((session): ListedSession => {
                const counts = session.subagents;

                return {
                    id: session.id,
                    title: session.title ?? "New session",
                    state: session.waiting ? "needs approval" : session.busy ? "working" : "idle",
                    folder: homePath(app.cwdOf(session.id as unknown as ConversationId)),
                    archived: session.archived === true,
                    ...(session.model === undefined ? {} : { model: session.model }),
                    ...(session.worktree === undefined ? {} : { branch: session.worktree.branch }),
                    updatedAt: session.updatedAt,
                    ...(counts === undefined
                        ? {}
                        : {
                              // "2 failed (1 dismissed)": failures a person dealt with need nobody now.
                              subagents: Object.entries(counts)
                                  .filter(
                                      ([kind, count]) =>
                                          kind !== "dealt" &&
                                          typeof count === "number" &&
                                          count > 0,
                                  )
                                  .map(
                                      ([kind, count]) =>
                                          `${String(count)} ${kind}${kind === "failed" && counts.dealt !== undefined ? ` (${String(counts.dealt)} dismissed)` : ""}`,
                                  )
                                  .join(", "),
                          }),
                };
            });
        const folders = [
            ...new Set(all.filter((each) => !each.archived).map((each) => each.folder)),
        ];
        const matching = all.filter(
            (session) =>
                (filter.archived === true ? session.archived : !session.archived) &&
                (filter.state === undefined || session.state === filter.state) &&
                words.every((word) =>
                    `${session.title} ${session.folder} ${session.branch ?? ""}`
                        .toLowerCase()
                        .includes(word),
                ),
        );
        const limit =
            filter.limit !== undefined && Number.isFinite(filter.limit)
                ? Math.max(1, Math.min(Math.round(filter.limit), 100))
                : 25;

        return {
            sessions: matching.slice(0, limit),
            more: Math.max(0, matching.length - limit),
            folders: folders.slice(0, 12),
        };
    }

    /** The newest part of a session, as text for the bot: its state, what waits there, and its last messages. */
    async read(botId: ConversationId, sessionId: number, entries = 40): Promise<string> {
        const app = this.#app;
        const user = this.#person(botId);
        const id = this.#session(botId, user, sessionId);
        const meta = app.sessionMeta(id)!;
        const conversation = await app.conversation(id);
        const page = await conversation.entries(
            {},
            Math.max(4, Math.min(entries, 200)),
            undefined,
            context,
        );
        const projected = page.items
            .map((entry) => projectEntry(entry))
            .filter((entry): entry is ClientEntry => entry !== undefined)
            .reverse();
        const lastAnswer = projected.findLast(
            (entry) =>
                entry.kind === "assistant" && entry.blocks.some((block) => block.type === "text"),
        )?.id;
        const failed = new Set(
            projected.flatMap((entry) =>
                entry.kind === "toolResult" && entry.isError ? [entry.callId] : [],
            ),
        );
        const lines: string[] = [];

        for (const entry of projected) {
            if (entry.kind === "user") {
                lines.push(`▸ ${entry.from ?? "Someone"}: ${clip(entry.text, LINE_CHARS)}`);
            } else if (entry.kind === "assistant") {
                for (const block of entry.blocks) {
                    if (block.type === "text" && block.text.trim() !== "") {
                        lines.push(
                            `Pi: ${clip(block.text, entry.id === lastAnswer ? ANSWER_CHARS : LINE_CHARS)}`,
                        );
                    } else if (block.type === "toolCall") {
                        lines.push(
                            `  · ${callLine(block.name, block.args)}${failed.has(block.id) ? " (failed)" : ""}`,
                        );
                    }
                }

                if (entry.stopReason === "aborted") {
                    lines.push("  (stopped)");
                } else if (entry.error !== undefined) {
                    lines.push(`  (error: ${snippet(entry.error, 200)})`);
                }
            } else if (entry.kind === "note") {
                lines.push(`[note] ${entry.name} ${snippet(entry.text, 300)}`);
            } else if (entry.kind === "shell") {
                lines.push(`$ ${snippet(entry.command, 200)}`);
            } else if (entry.kind === "compaction") {
                lines.push("(earlier messages were summarized)");
            } else if (entry.kind === "reset") {
                lines.push("(a new context started here)");
            }
        }

        const waiting = app.approvals
            .all()
            .filter((request) => app.rootOf(request.conversationId) === id)
            .map((request) => `- ${request.id}: ${request.tool} ${snippet(request.subject, 200)}`);
        const schedules = await app.schedules.list(id);
        const state = app.approvals
            .all()
            .some((request) => app.rootOf(request.conversationId) === id)
            ? "needs approval"
            : app.isBusy(id)
              ? "working"
              : "idle";
        // What waits there and what is scheduled were written by the session's Pi or people: inside the fence too.
        const pending = [
            ...(waiting.length === 0 ? [] : ["Waiting for approval:", ...waiting]),
            ...(schedules.length === 0
                ? []
                : [
                      `Scheduled: ${schedules
                          .map(
                              (item) =>
                                  `${item.every === undefined ? describeMoment(item.next, item.zone) : describeRepeat(item.every)} · ${snippet(item.text, 80)}`,
                          )
                          .join("; ")}`,
                  ]),
        ];

        this.#looked(botId, id);
        const head = [
            `#${String(sessionId)} ${quoted(meta.title ?? "New session")} · ${state}${meta.archived === true ? " · archived" : ""}`,
            `Folder: ${snippet(homePath(app.cwdOf(id)), 300)}${meta.worktree === undefined ? "" : ` (worktree, branch ${snippet(meta.worktree.branch, 120)})`}`,
            "",
            pending.length + lines.length === 0
                ? "(no messages yet)"
                : fenced([...pending, ...lines].join("\n")),
        ];

        return head.join("\n");
    }

    /**
     * Start a session for the bot's person, in a folder (the default one when absent), with a model only when its
     * person named it. Its first message goes with `send`, so a replayed call that made the session sends it once; it
     * is checked here first (`message`), so a message that names a model nobody chose leaves no session behind.
     */
    async start(
        botId: ConversationId,
        request: {
            folder?: string;
            repo?: string;
            title?: string;
            worktree?: boolean;
            model?: string;
            message?: string;
        },
        key?: string,
    ): Promise<ConversationId> {
        const app = this.#app;
        const user = this.#person(botId);
        // A call run again after a restart, which made its session but had not kept it: that one, not a second.
        const made =
            key === undefined
                ? undefined
                : Object.entries(app.sessionCatalogue()).find(
                      ([, meta]) => meta.startedBy === key,
                  )?.[0];

        if (made !== undefined) {
            return Number(made) as unknown as ConversationId;
        }

        // Before anything is made: a model that is not there, or that nobody chose, leaves no session behind.
        const model =
            request.model === undefined
                ? undefined
                : await this.#personsModel(botId, user, request.model);

        await this.#requireNoModelChoice(
            botId,
            user,
            `${request.title ?? ""}\n${request.message ?? ""}`,
        );

        if (request.folder !== undefined && request.repo !== undefined) {
            throw new Error("Give a folder or a repository, not both.");
        }

        const { id } = await this.#counted(
            user,
            async () => {
                const folder =
                    request.repo === undefined
                        ? request.folder
                        : await this.checkout(botId, request.repo);

                return app.commands.createSession(
                    user,
                    {
                        ...(folder === undefined ? {} : { cwd: folder }),
                        ...(request.title === undefined ? {} : { title: request.title }),
                        worktree: request.worktree === true,
                    },
                    {
                        projectDefaults: model === undefined,
                        ...(key === undefined ? {} : { startedBy: key }),
                    },
                );
            },
            "start",
        );

        if (model !== undefined) {
            await app.commands.configure(id, user, { model });
        }

        // The bot made it, and knows what it is doing: nothing yet.
        this.#looked(botId, id);

        return id;
    }

    /**
     * Send a session a message for the bot's person: queued behind its work, or steering it. Once for a key: a replayed
     * call finds the message it sent.
     */
    async send(
        botId: ConversationId,
        sessionId: number,
        message: string,
        steer: boolean,
        key: string,
        options: { started?: boolean } = {},
    ): Promise<{ requestId: string }> {
        const user = this.#person(botId);
        const id = this.#session(botId, user, sessionId);

        return {
            requestId: await this.#submit(botId, id, user, message, key, steer, async () => {
                // The first message of a session the same call started (`started`) needs no look, there being nothing to
                // see, and was checked for model names as the session started.
                if (options.started !== true) {
                    this.#requireLooked(botId, sessionId, "message");
                    await this.#requireNoModelChoice(botId, user, message);
                }
            }),
        };
    }

    // ─── GitHub ─────────────────────────────────────────────────────────────

    /**
     * Where the bot's person works on a GitHub repository: the checkout a session they started works in (its `origin`
     * is the repository), or else a clone, made now, in the data folder's `repos/`. Only their own sessions' folders:
     * one a guest made could hold the guest's instructions (an AGENTS.md). Only a repository gh's account can push to:
     * someone else's would bring its own instructions into a session that can run commands. A clone is made beside its
     * place and moved there once complete, so a clone cut off midway is never taken for one.
     */
    async checkout(botId: ConversationId, repo: string): Promise<string> {
        const app = this.#app;
        const user = this.#person(botId);
        const named = parseRepo(repo);

        if (named === undefined) {
            throw new Error(`${repo} is not a repository: say owner/name, or its address.`);
        }

        const info = await requirePush(app.watches.gh, named);

        // What GitHub answered becomes a path: nothing in it may climb out of `repos/`.
        if (parseRepo(info.repo) !== info.repo) {
            throw new Error(`${info.repo} is not a repository name this server can clone.`);
        }

        const clone = join(app.dataDir, "repos", ...info.repo.split("/"));
        const folders = new Set<string>();

        for (const meta of Object.values(app.sessionCatalogue())) {
            if (meta.createdBy === user.id) {
                folders.add(meta.worktree?.source ?? meta.cwd);
            }
        }

        folders.add(app.defaultCwd);

        // A few at a time, in order: each folder not yet known asks git for its origin.
        const candidates = [clone, ...[...folders].slice(0, 200)].filter((each) =>
            existsSync(each),
        );

        for (let at = 0; at < candidates.length; at += 8) {
            const batch = candidates.slice(at, at + 8);
            const origins = await Promise.all(batch.map((folder) => this.#origin(folder)));
            const found = batch.find((_folder, index) => sameRepo(origins[index], info.repo));

            if (found !== undefined) {
                return (
                    await git(found, ["rev-parse", "--show-toplevel"]).catch(() => found)
                ).trim();
            }
        }

        let cloning = this.#cloning.get(info.repo);

        if (cloning === undefined) {
            // Not the repository's checkout, or the loop above had taken it: never clone into it.
            if (existsSync(clone)) {
                throw new Error(
                    `${clone} is there but is not a checkout of ${info.repo}: move it away, then ask again.`,
                );
            }

            mkdirSync(dirname(clone), { recursive: true });
            this.#clearParts(clone);
            // `~` is in no GitHub repository's name: no clone of another repository is ever taken for a part.
            const part = `${clone}~part-${randomUUID().slice(0, 8)}`;

            cloning = app.watches
                .gh(["repo", "clone", info.repo, part], undefined, CLONE_TIMEOUT_MS)
                .then(() => {
                    renameSync(part, clone);
                    this.#origins.delete(clone);

                    return clone;
                })
                .catch((error: unknown) => {
                    // A git still writing there after a timeout fails once the folder is gone: harmless.
                    rmSync(part, { recursive: true, force: true });

                    throw error;
                })
                .finally(() => this.#cloning.delete(info.repo));
            this.#cloning.set(info.repo, cloning);
        }

        try {
            return await cloning;
        } catch (error) {
            throw new Error(`${info.repo} could not be cloned: ${describe(error)}`);
        }
    }

    /**
     * Remove what clones of this repository left behind when the server stopped midway: their `~part-*` folders, once
     * older than a clone may take (a git cut off by a restart may still write to a newer one).
     */
    #clearParts(clone: string): void {
        const folder = dirname(clone);
        const prefix = `${basename(clone)}~part-`;
        const before = Date.now() - CLONE_TIMEOUT_MS;

        for (const name of readdirSync(folder)) {
            const part = join(folder, name);

            try {
                if (name.startsWith(prefix) && statSync(part).mtimeMs < before) {
                    rmSync(part, { recursive: true, force: true });
                }
            } catch (error) {
                this.#app.log(`could not remove ${part}: ${describe(error)}`);
            }
        }
    }

    /** A folder's GitHub repository, kept a few minutes: the bot asks of many folders. */
    async #origin(folder: string): Promise<string | undefined> {
        const now = Date.now();
        const known = this.#origins.get(folder);

        if (known !== undefined && now - known.at < ORIGIN_FOR_MS) {
            return known.repo;
        }

        const repo = await originRepo(folder);

        this.#origins.set(folder, { repo, at: now });

        return repo;
    }

    /** Watch a session's pull request for the owner: its branch's, or `pr` (a number, address, or owner/name#12). */
    async watchPr(botId: ConversationId, sessionId: number, pr: string | undefined, key: string) {
        const user = this.#person(botId);
        const id = this.#session(botId, user, sessionId);

        // A replayed call finds the watch it started; anything else is looked at first.
        if ((await this.#app.watches.get(id))?.key !== key) {
            this.#requireLooked(botId, sessionId, "watch a pull request from");
        }

        // Counted even when refused: it asked GitHub, which the hourly count also keeps in bounds.
        this.#count(user, "act", ACTIONS_PER_HOUR);

        return this.#app.watches.start(id, user.id, {
            ...(pr === undefined || pr.trim() === "" ? {} : { pr }),
            byPi: true,
            key,
        });
    }

    /** A session's PR watch, or stopping it. */
    async prWatch(botId: ConversationId, sessionId: number, stop: boolean) {
        const user = this.#person(botId);
        const id = this.#session(botId, user, sessionId);

        if (stop) {
            this.#requireLooked(botId, sessionId, "stop the PR watch of");
        }

        return stop ? this.#app.watches.stop(id) : this.#app.watches.get(id);
    }

    /** Watch a repository for the bot's person: what happens there comes to the bot, or to session `to`. */
    async addRepoWatch(
        botId: ConversationId,
        request: Omit<RepoWatchRequest, "target" | "byPi" | "key"> & { to?: number },
        key: string,
    ): Promise<RepoWatchView> {
        const user = this.#person(botId);
        const { to, ...rest } = request;

        // Strangers' issues and pull requests are let in by a person, in the hooks sheet, never by the bot.
        if (rest.anyone === true) {
            throw new Error(
                "Only your person can let a watch take issues and pull requests from anyone: ask them to turn it on in Settings → Webhooks and watches once the watch is made.",
            );
        }

        const target = to === undefined ? botId : this.#session(botId, user, to);

        // What each event will have done: no model in it that its person did not name.
        await this.#requireNoModelChoice(botId, user, rest.instructions ?? "");

        // Counted even when refused: it asked GitHub, which the hourly count also keeps in bounds.
        this.#count(user, "act", ACTIONS_PER_HOUR);

        return this.#app.repoWatches.add(user, { ...rest, target, byPi: true, key });
    }

    /** The bot's person's repository watches, each with where it sends. */
    async repoWatches(botId: ConversationId): Promise<(RepoWatchView & { to: string })[]> {
        const app = this.#app;
        const user = this.#person(botId);

        return (await app.repoWatches.list(user))
            .filter((watch) => watch.by === user.id)
            .map((watch) => ({
                ...watch,
                to:
                    watch.target === Number(botId)
                        ? "you"
                        : `session ${watch.target} (${quoted(app.sessionMeta(watch.target as unknown as ConversationId)?.title ?? "untitled", 80)})`,
            }));
    }

    async removeRepoWatch(botId: ConversationId, id: string): Promise<RepoWatchView> {
        return this.#app.repoWatches.remove(this.#person(botId), id);
    }

    /** Stop a session's run. */
    async stop(botId: ConversationId, sessionId: number): Promise<boolean> {
        const user = this.#person(botId);
        const id = this.#session(botId, user, sessionId);

        this.#requireLooked(botId, sessionId, "stop");
        const busy = this.#app.isBusy(id);

        await this.#app.commands.abort(id, this.#through(user, botId));

        return busy;
    }

    /** Archive a session, or bring it back. */
    async archive(botId: ConversationId, sessionId: number, archived: boolean): Promise<void> {
        const user = this.#person(botId);
        const id = this.#session(botId, user, sessionId);

        // Bringing one back hides nothing; archiving it hides what may still need its person.
        if (archived && this.#app.sessionMeta(id)?.archived !== true) {
            this.#requireLooked(botId, sessionId, "archive");
        }

        await this.#app.commands.updateSession(id, this.#through(user, botId), { archived });
    }

    /** The calls waiting for approval in the sessions the bot's person can see. */
    approvals(botId: ConversationId) {
        const app = this.#app;
        const user = this.#person(botId);

        return app.approvals
            .all()
            .filter((request) => app.canSee(user, request.conversationId))
            .map((request) => {
                const root = app.rootOf(request.conversationId);

                return {
                    id: request.id,
                    session: Number(root),
                    // Written by the session's Pi or people: quoted, as data.
                    title: quoted(app.sessionMeta(root)?.title ?? "New session"),
                    subagent: root !== request.conversationId,
                    tool: request.tool,
                    subject: quoted(request.subject, 300),
                    reason: quoted(request.reason, 200),
                };
            });
    }

    /** Deny a waiting call. The bot never allows one: that stays a person's decision. */
    async deny(botId: ConversationId, approvalId: string): Promise<boolean> {
        const user = this.#person(botId);

        return this.#app.answerApproval(approvalId, false, this.#through(user, botId));
    }

    /** A session's scheduled messages; or one set up there, for the bot's person, marked as sent through the bot. */
    async schedules(botId: ConversationId, sessionId: number) {
        const user = this.#person(botId);

        return this.#app.schedules.list(this.#session(botId, user, sessionId));
    }

    async schedule(
        botId: ConversationId,
        sessionId: number,
        when: string,
        message: string,
        key: string,
    ) {
        const app = this.#app;
        const user = this.#person(botId);
        const id = this.#session(botId, user, sessionId);

        await app.requireDriver(id, user);

        // A replayed call finds the schedule it made; a new one is for a session the bot looked at, naming no model
        // nobody chose.
        if (!(await app.schedules.list(id)).some((item) => item.key === key)) {
            this.#requireLooked(botId, sessionId, "schedule messages in");
            await this.#requireNoModelChoice(botId, user, message);
        }

        // A schedule is work to come, counted like a message.
        return this.countSchedule(
            id,
            key,
            () =>
                app.schedules.add(id, {
                    when,
                    text: `[via ${this.#via(botId)}] ${message}`,
                    requestedBy: user.id,
                    key,
                }),
            user,
        );
    }

    async cancelSchedule(botId: ConversationId, sessionId: number, scheduleId: string) {
        const app = this.#app;
        const user = this.#person(botId);
        const id = this.#session(botId, user, sessionId);

        await app.requireDriver(id, user);
        this.#requireLooked(botId, sessionId, "cancel schedules in");

        return app.schedules.cancel(id, scheduleId);
    }

    /**
     * Report to the bot when a session's run ends: the answer to the message the bot sent under `requestId`, or,
     * without one, what the session says once its run ends. A session that is idle now, with no message to wait for, is
     * answered at once in `now`, rather than by a report: a report starts a run of the bot's. `key` makes the follow
     * once, however often its call runs, also after it reported.
     */
    async follow(
        botId: ConversationId,
        sessionId: number,
        requestId: string | undefined,
        key: string,
    ): Promise<{ now?: string }> {
        const app = this.#app;
        const user = this.#person(botId);
        const id = this.#session(botId, user, sessionId);
        const title = app.sessionMeta(id)?.title ?? "New session";

        if (requestId === undefined && !app.isBusy(id)) {
            const now = await this.#lastWords(id, title, "is idle");

            this.#looked(botId, id);

            return { now };
        }

        // Following a run of its own (no message of the bot's to wait for) is for a session the bot looked at: a report
        // starts a run of the bot's. A replayed call finds the follow it made.
        if (
            requestId === undefined &&
            (await app.harness.snapshot(FollowsDoc, botId, context))?.items[key] === undefined
        ) {
            this.#requireLooked(botId, sessionId, "follow");
        }

        // Counted once, however often the commit runs its callback.
        let counted = false;

        await app.harness.commit(async (tx) => {
            const follows = (await tx.doc(FollowsDoc, botId)).items;

            if (follows[key] !== undefined) {
                return;
            }

            // Forget follows that reported long ago, and any whose task ended without saying so. Reads first: a commit
            // reads the tables only before it writes one.
            const now = Date.now();
            const forget: string[] = [];

            for (const [each, follow] of Object.entries(follows)) {
                if (follow.doneAt !== undefined) {
                    if (now - follow.doneAt > FOLLOW_MEMORY_MS) {
                        forget.push(each);
                    }

                    continue;
                }

                const status = (await tx.task(follow.taskId as never))?.state.status;

                if (status === undefined || status === "terminal") {
                    forget.push(each);
                }
            }

            for (const each of forget) {
                delete follows[each];
            }

            if (
                Object.values(follows).filter((each) => each.doneAt === undefined).length >=
                MAX_FOLLOWS
            ) {
                throw new Error(
                    `You follow ${String(MAX_FOLLOWS)} runs already; wait for some to report.`,
                );
            }

            if (!counted) {
                this.#count(user, "act", ACTIONS_PER_HOUR);
                counted = true;
            }

            const taskId = await tx.createTask(
                this.task,
                {
                    sessionId: id,
                    userId: user.id,
                    title,
                    ...(requestId === undefined ? {} : { requestId }),
                },
                { ownership: { kind: "conversation" }, background: true, conversationId: botId },
            );

            follows[key] = { taskId: Number(taskId), session: sessionId, at: now };
        }, context);

        return {};
    }

    /**
     * Whether a session's person hears of its run's end from Noid: a live follow waits on it, or one reported just now.
     * Its own "Pi finished" would say the same twice. Not while the session tools are off or a spend limit holds it
     * back: its report would then start no run, and push nothing.
     */
    async reportsOn(sessionId: ConversationId, userId: string): Promise<boolean> {
        const app = this.#app;
        const user = app.config.userById(userId);
        const noid = user?.role === "owner" ? this.noid() : undefined;

        if (
            user === undefined ||
            noid === undefined ||
            !this.available(user) ||
            app.spend.heldBack(noid, userId) !== undefined
        ) {
            return false;
        }

        const now = Date.now();
        const follows = Object.values(
            (await app.harness.snapshot(FollowsDoc, noid, context))?.items ?? {},
        ).filter((follow) => follow.session === Number(sessionId));

        if (
            follows.some(
                (follow) =>
                    follow.doneAt !== undefined && now - follow.doneAt < REPORTED_JUST_NOW_MS,
            )
        ) {
            return true;
        }

        const waiting = follows.filter((follow) => follow.doneAt === undefined);
        let live = false;

        if (waiting.length > 0) {
            // Only a follow whose task still runs reports: one that faulted, or is gone, never will.
            await app.harness.commit(async (tx) => {
                for (const follow of waiting) {
                    const status = (await tx.task(follow.taskId as never))?.state.status;

                    live ||= status !== undefined && status !== "terminal";
                }
            }, context);
        }

        return live;
    }

    /** What the bot's person does through the bot, so activity lines and decisions say so. */
    #through(user: User, botId: ConversationId): User {
        return { ...user, name: `${user.name} via ${this.#via(botId)}` };
    }

    // ─── Follows ────────────────────────────────────────────────────────────

    /** A session's last words, for the bot: how its run ended, and Pi's last answer, fenced. */
    async #lastWords(id: ConversationId, title: string, state: string): Promise<string> {
        const name = `${quoted(title, 80)} (/s/${String(id)})`;
        const page = await (await this.#app.conversation(id)).entries({}, 16, undefined, context);
        const last = page.items
            .map((entry) => projectEntry(entry))
            .find((entry) => entry?.kind === "assistant");

        if (last?.kind !== "assistant") {
            return `${name} ${state}, with no answer from Pi yet.`;
        }

        if (last.stopReason === "aborted") {
            return `${name} was stopped.`;
        }

        if (last.error !== undefined) {
            return `${name} stopped with an error: ${snippet(last.error, 300)}`;
        }

        const text = last.blocks
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");

        return `${name} ${state}. Pi's last answer:\n${fenced(clip(text, ANSWER_CHARS))}`;
    }

    /**
     * Wait for the session's run to end, then go on to report what came of it. A follow that cannot wait (the session
     * is gone, a read fails) reports that instead, so the bot is never left waiting for nothing.
     */
    async #wait(input: FollowInput, runtime: FollowRuntime, context: Context): Promise<void> {
        let text: string;

        try {
            text = await this.#outcome(input, runtime, context);
        } catch (error) {
            // Stopped or closing: not a failure to report. The abort, or the next process, takes it from here.
            if (runtime.signal.aborted) {
                throw error;
            }

            text = `Could not follow ${quoted(input.title, 80)} (/s/${String(input.sessionId)}): ${snippet(describe(error), 300)}`;
        }

        await runtime.commit(
            () =>
                ({
                    status: "running",
                    checkpoint: { phase: "report", text: `${REPORT_HEAD}${text}` },
                }) as const,
            context,
        );
    }

    /** What came of the run the bot follows, once it ended. */
    async #outcome(input: FollowInput, runtime: FollowRuntime, context: Context): Promise<string> {
        const session = await runtime.conversation(input.sessionId, context);
        const name = `${quoted(input.title, 80)} (/s/${String(input.sessionId)})`;

        if (session === undefined) {
            return `${name} is gone.`;
        }

        if (input.requestId === undefined) {
            await session.waitForIdle(context);

            return this.#lastWords(input.sessionId, input.title, "finished");
        }

        const requestId = input.requestId;
        let known = false;

        await runtime.commit(async (tx) => {
            known = (await tx.submissionByRequest(input.sessionId, requestId)) !== undefined;

            return undefined;
        }, context);

        if (!known) {
            return `Your message to ${name} never arrived.`;
        }

        // The submission the bot made: a request id already known finds it without sending anything.
        const submission = await session.submit({ type: "input", content: "", requestId }, context);
        // Pi Durable leaves a failed run's queue alone, so a queued message waits for a boundary that never comes: once
        // the session is idle with it still queued, withdraw it, which ends the wait below.
        const watch = await runtime.watchDoc(LiveDoc, input.sessionId, context);
        let withdrawn = false;
        let withdrawing: Promise<unknown> = Promise.resolve();
        let settled: Awaited<ReturnType<typeof submission.wait>>;

        try {
            if (watch !== undefined) {
                const strand = async (live: NonNullable<typeof watch>["value"]) => {
                    if (live !== null && live.run === undefined) {
                        const abort = submission.abort(context);

                        withdrawing = abort;

                        if ((await abort) === "aborted") {
                            withdrawn = true;
                        }
                    }
                };

                await strand(watch.value);
                watch.start(strand);
            }

            settled = await submission.wait(context);
        } finally {
            await watch?.stop();
            await withdrawing.catch(() => {});
        }

        if (settled.status === "unanswered") {
            return withdrawn
                ? `${name} went idle without taking your message; send it again if it still matters.`
                : settled.reason === "aborted"
                  ? `${name} was stopped before it answered your message.`
                  : `${name} could not answer your message: ${snippet(String(settled.detail ?? settled.reason), 300)}`;
        }

        if (settled.type !== "input") {
            return `${name} took your message.`;
        }

        const answerId = settled.answer;
        let text = "";

        await runtime.commit(async (tx) => {
            text = textOf(
                (await tx.entry(AssistantEntry, answerId))?.model?.[0] as
                    AssistantMessage | undefined,
            );

            return undefined;
        }, context);

        return `${name} answered your message:\n${fenced(clip(text, ANSWER_CHARS) || "(no text)")}`;
    }

    /** Mark this follow as reported in the bot's list, where it stays a while so a replayed call follows once. */
    async #settleFollow(tx: Tx, botId: ConversationId, taskId: number): Promise<void> {
        const follows = (await tx.doc(FollowsDoc, botId)).items;

        for (const follow of Object.values(follows)) {
            if (follow.taskId === taskId && follow.doneAt === undefined) {
                follow.doneAt = Date.now();
            }
        }
    }

    /**
     * Give the bot the report: as a message that it answers, or, while a spend limit holds work back, as a note it sees
     * with its next message. Either way under a request id of its own, so a restart does not send it twice.
     */
    async #report(
        input: FollowInput,
        text: string,
        runtime: FollowRuntime,
        context: Context,
    ): Promise<void> {
        const botId = runtime.conversationId;

        // The session tools turned off keep the bot's follows: a report waits until they are on again, as its
        // schedules, do, so no run starts in its conversation without its rules and tools.
        for (;;) {
            const person = this.#app.config.userById(input.userId);

            if (person === undefined || this.available(person)) {
                break;
            }

            await runtime.sleep(runtime.now() + this.holdMs, context);
        }

        const bot = await this.#app.harness.conversation(botId, context);
        const requestId = requestFor(input.userId, `follow-report-${String(runtime.taskId)}`);

        // The report says what the session did: the bot has looked at it.
        this.#looked(botId, input.sessionId);

        if (bot !== undefined) {
            try {
                if (this.#app.spend.heldBack(botId, input.userId) === undefined) {
                    await bot.submit(
                        { type: "input", content: text, whenBusy: "followUp", requestId },
                        context,
                    );
                } else {
                    await bot.submit(
                        {
                            type: "write",
                            entry: {
                                kind: NOTE_ENTRY,
                                data: { text, by: "bot", name: this.#via(botId) },
                                model: [
                                    {
                                        role: "user",
                                        content: [{ type: "text", text }],
                                        timestamp: Date.now(),
                                    },
                                ],
                            },
                            requestId,
                        },
                        context,
                    );
                }
            } catch (error) {
                runtime.report(new Error(`The report was not delivered: ${describe(error)}`));
            }
        }

        await runtime.commit(async (tx) => {
            await this.#settleFollow(tx, botId, Number(runtime.taskId));

            return finished;
        }, context);
    }
}
