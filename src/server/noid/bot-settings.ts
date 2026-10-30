/**
 * noid: a bot reads and changes its own settings from chat (rakazo's `update_bot`, #2553 and #2865): its name,
 * instructions, model, and thinking level. Every change is kept (`BotChangesDoc`), with what it replaced, and shows in
 * the transcript as a card the owner can undo.
 *
 * Who may change what (approvals.ts holds the card):
 *
 * - Name, model, and thinking only in a run the owner started that took in nothing someone else wrote (`runSoFar`):
 *   elsewhere the call is refused.
 * - Instructions in such a run apply at once; in any other run (a routine, another bot's mail, a page read) they wait
 *   for the owner's yes on an approval card, every time.
 * - Only the bot itself, in its own conversation: not a subagent or a session it started.
 *
 * Noid has the tool too, under the same rules: the owner talks to it most, and its settings are theirs to undo.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Api, clampThinkingLevel, type Model, Type } from "@earendil-works/pi-ai";
import {
    type ConversationId,
    defineDoc,
    defineExtension,
    defineTool,
    type ModelRef,
} from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { MAX_INSTRUCTIONS } from "../commands.ts";
import { rebased } from "../docs.ts";
import { describe, HttpError } from "../errors.ts";
import { modelsNamed } from "../model-names.ts";
import { findModel, isThinkingLevel, THINKING_LEVELS } from "../models.ts";
import { runSoFar } from "./approvals.ts";
import { requireOwner, ownerOf } from "./owner.ts";

export const BOT_SETTINGS_EXTENSION = "noid-bot-settings";
export const BOT_SETTINGS_TOOL = "bot_settings";

/** The settings a bot can change, as they were or became. */
export type BotSettingsValues = {
    name?: string;
    instructions?: string;
    model?: ModelRef;
    thinkingLevel?: ModelThinkingLevel;
};

export type BotChange = {
    /** The call's task and id: a replayed call finds its change. */
    id: string;
    at: number;
    before: BotSettingsValues;
    after: BotSettingsValues;
    undone?: { at: number; by: string };
};

/** The most changes kept per bot: the oldest go first. */
const KEPT = 50;

/** A bot's own changes to its settings, newest last: what each replaced, for the owner's Undo. */
export const BotChangesDoc = defineDoc<{ changes: BotChange[] }>({
    kind: "x.noid.bot-changes",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ changes: [] }),
});

const reply = (text: string, details?: { change: string; summary: string }) => ({
    output: [{ type: "text" as const, text }],
    ...(details === undefined ? {} : { details }),
});

const failed = (text: string) => ({ ...reply(text), isError: true });

/** What changed, in words: "Instructions updated", "Name and model updated". */
export function changeSummary(after: BotSettingsValues): string {
    const parts = [
        ...(after.name === undefined ? [] : ["name"]),
        ...(after.instructions === undefined ? [] : ["instructions"]),
        ...(after.model === undefined ? [] : ["model"]),
        ...(after.thinkingLevel === undefined ? [] : ["thinking"]),
    ];
    const words =
        parts.length <= 1
            ? (parts[0] ?? "nothing")
            : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;

    return `${words[0]!.toUpperCase()}${words.slice(1)} updated`;
}

/**
 * The signed-in model `spec` names: `provider/id`, an id, or a name ("Claude Sonnet"). A name that fits several asks
 * which: the bot never picks one for its person.
 */
export function modelFor(app: PocketApp, spec: string): Model<Api> {
    const exact = findModel(app.models, spec);

    if (exact !== undefined) {
        return exact;
    }

    const available = app.models.getAvailableSnapshot();
    const named = modelsNamed(spec, available, true, app.models.getModels(), false);

    if (named.length === 1) {
        return named[0]!;
    }

    if (named.length > 1) {
        throw new Error(
            `${spec} fits ${named.map((model) => `${model.provider}/${model.id}`).join(", ")}: ask your person which one.`,
        );
    }

    throw new Error(
        `${spec} is not a model signed in here. Ask your person which model they mean.`,
    );
}

/** The `bot_settings` tool, its changes, and their Undo. */
export class BotSettings {
    readonly #app: PocketApp;
    readonly extension;

    constructor(app: PocketApp) {
        this.#app = app;
        this.extension = defineExtension({
            name: BOT_SETTINGS_EXTENSION,
            tools: [this.#tool()],
        });
    }

    /** A bot's changes, newest last, for the cards: the owner's alone. */
    async changes(user: User, id: ConversationId): Promise<BotChange[]> {
        requireOwner(user, "Only the owner sees a bot's changes.");
        this.#app.requireSee(user, id);

        return (await this.#app.harness.snapshot(BotChangesDoc, id, context))?.changes ?? [];
    }

    /**
     * Put back what a change replaced, as the owner: through the same checks as the bot's settings. Only while the bot's
     * settings still hold what the change made them: a later change is not silently thrown away.
     */
    async undo(user: User, id: ConversationId, changeId: string): Promise<BotChange> {
        const app = this.#app;

        requireOwner(user, "Only the owner undoes a bot's changes.");
        app.requireSee(user, id);

        const change = (await this.changes(user, id)).find((each) => each.id === changeId);

        if (change === undefined) {
            throw new HttpError(404, "No such change.");
        }

        if (change.undone !== undefined) {
            throw new HttpError(409, "That change was undone already.");
        }

        const { before, after } = change;

        if (after.model !== undefined && before.model === undefined) {
            throw new HttpError(409, "The bot had no model before: choose one in its settings.");
        }

        const moved = await this.#changedSince(id, after);

        if (moved !== undefined) {
            throw new HttpError(
                409,
                `The bot's ${moved} changed since: change it in the bot's settings.`,
            );
        }

        // Claimed first, in one commit: two quick taps, or two tabs, undo it once.
        const claimed = await this.#mark(id, changeId, { at: Date.now(), by: user.id });

        if (claimed === undefined) {
            throw new HttpError(409, "That change was undone already.");
        }

        try {
            if (before.name !== undefined || before.instructions !== undefined) {
                await app.bots.update(user, id, {
                    ...(before.name === undefined ? {} : { name: before.name }),
                    ...(before.instructions === undefined
                        ? {}
                        : { instructions: before.instructions }),
                });
            }

            if (before.model !== undefined || before.thinkingLevel !== undefined) {
                await app.commands.configure(id, user, {
                    ...(before.model === undefined ? {} : { model: before.model }),
                    ...(before.thinkingLevel === undefined
                        ? {}
                        : { thinkingLevel: before.thinkingLevel }),
                });
            }
        } catch (error) {
            await this.#mark(id, changeId, undefined);

            throw error;
        }

        return claimed;
    }

    /** Which of `after`'s settings the bot no longer has, if any. */
    async #changedSince(id: ConversationId, after: BotSettingsValues): Promise<string | undefined> {
        const agent = await this.#app.agentState(id);

        if (after.name !== undefined && this.#app.sessionMeta(id)?.bot?.name !== after.name) {
            return "name";
        }

        if (
            after.instructions !== undefined &&
            (agent?.instructions ?? "") !== after.instructions
        ) {
            return "instructions";
        }

        if (
            after.model !== undefined &&
            (agent?.model?.provider !== after.model.provider ||
                agent.model.modelId !== after.model.modelId)
        ) {
            return "model";
        }

        if (
            after.thinkingLevel !== undefined &&
            (agent?.thinkingLevel ?? "off") !== after.thinkingLevel
        ) {
            return "thinking";
        }

        return undefined;
    }

    /**
     * Mark a change undone (or not, to give it back after a failed Undo), in one commit; a copy of it once marked, and
     * undefined when it was marked so already or is gone.
     */
    async #mark(
        id: ConversationId,
        changeId: string,
        undone: BotChange["undone"],
    ): Promise<BotChange | undefined> {
        let marked: BotChange | undefined;

        await this.#app.harness.commit(async (tx) => {
            const stored = (await tx.doc(BotChangesDoc, id)).changes.find(
                (each) => each.id === changeId,
            );

            if (stored === undefined || (undone !== undefined && stored.undone !== undefined)) {
                return;
            }

            if (undone === undefined) {
                delete stored.undone;
            } else {
                stored.undone = undone;
            }

            // A copy: the stored one is gone once the commit ends.
            marked = JSON.parse(JSON.stringify(stored)) as BotChange;
        }, context);

        return marked;
    }

    /** The settings now, for a call with no fields. */
    async #read(id: ConversationId): Promise<string> {
        const app = this.#app;
        const bot = app.sessionMeta(id)?.bot;
        const agent = await app.agentState(id);
        const model =
            agent?.model === undefined
                ? undefined
                : app.models.getModel(agent.model.provider, agent.model.modelId);

        return [
            `Name: ${bot?.name ?? ""}`,
            `Role: ${bot?.role || "none"}`,
            `Model: ${agent?.model === undefined ? "none" : `${model?.name ?? agent.model.modelId} (${agent.model.provider}/${agent.model.modelId})`}`,
            `Thinking: ${agent?.thinkingLevel ?? "off"}`,
            ...(bot?.file === undefined
                ? []
                : [`Name and instructions are ${bot.file}'s: they change there, not here.`]),
            `Instructions:\n${agent?.instructions ?? "(none)"}`,
        ].join("\n");
    }

    #tool() {
        return defineTool({
            name: BOT_SETTINGS_TOOL,
            description:
                "Read your own settings (call with no fields), or change them when your person asks. Instructions are replaced whole: keep what should stay. Never claim a change without calling this.",
            parameters: Type.Object({
                name: Type.Optional(Type.String()),
                instructions: Type.Optional(Type.String()),
                model: Type.Optional(
                    Type.String({ description: 'A name like "Claude Sonnet", or provider/id' }),
                ),
                thinkingLevel: Type.Optional(
                    Type.Union(
                        THINKING_LEVELS.map((level) => Type.Literal(level)),
                        { description: "How hard you reason: raise it when asked to think harder" },
                    ),
                ),
            }),
            replay: "safe",
            execute: async (args, api) => {
                const app = this.#app;
                const id = api.conversationId;
                const bot = app.bots.of(id);

                if (bot === undefined) {
                    return failed("Only bots have settings.");
                }

                if (app.sessionMeta(id)?.bot?.id !== bot.id) {
                    return failed(
                        "Only the bot itself, in its own conversation, changes its settings.",
                    );
                }

                const changeId = `${api.taskId}:${api.callId}`;
                const done = (await app.harness.snapshot(BotChangesDoc, id, context))?.changes.find(
                    (each) => each.id === changeId,
                );

                try {
                    // Kept before it applies: a call cut off by a restart in between applies it again, and the same.
                    if (done !== undefined) {
                        if (done.undone === undefined) {
                            await this.#apply(id, done.after);
                        }

                        return reply(`${changeSummary(done.after)}.`, {
                            change: done.id,
                            summary: changeSummary(done.after),
                        });
                    }

                    if (
                        args.name === undefined &&
                        args.instructions === undefined &&
                        args.model === undefined &&
                        args.thinkingLevel === undefined
                    ) {
                        return reply(await this.#read(id));
                    }

                    const change = await this.#change(id, String(api.callId), args);

                    if (change === undefined) {
                        return reply("Nothing changed: those are your settings already.");
                    }

                    change.id = changeId;
                    await app.harness.commit(async (tx) => {
                        const doc = await tx.doc(BotChangesDoc, id);

                        doc.changes.push(change);
                        doc.changes.splice(0, Math.max(0, doc.changes.length - KEPT));
                    }, context);

                    try {
                        await this.#apply(id, change.after);
                    } catch (error) {
                        await app.harness.commit(async (tx) => {
                            const doc = await tx.doc(BotChangesDoc, id);

                            doc.changes = doc.changes.filter((each) => each.id !== changeId);
                        }, context);

                        throw error;
                    }

                    const summary = changeSummary(change.after);

                    return reply(`${summary}. The owner can undo it from the card in the chat.`, {
                        change: change.id,
                        summary,
                    });
                } catch (error) {
                    return failed(describe(error));
                }
            },
        });
    }

    /** The asked changes, after every check, not yet applied; undefined when nothing differs. */
    async #change(
        id: ConversationId,
        callId: string,
        args: { name?: string; instructions?: string; model?: string; thinkingLevel?: string },
    ): Promise<BotChange | undefined> {
        const app = this.#app;
        const bot = app.sessionMeta(id)!.bot!;
        const agent = await app.agentState(id);
        const before: BotSettingsValues = {};
        const after: BotSettingsValues = {};

        // Name, model, and thinking: only where the owner asked, and nothing else spoke since. Instructions are guarded
        // by the approval card instead (approvals.ts), which this run already passed.
        if (
            args.name !== undefined ||
            args.model !== undefined ||
            args.thinkingLevel !== undefined
        ) {
            const run = await runSoFar(app, id, callId);

            if (!run.byOwner || run.outside || callId.includes("/")) {
                throw new Error(
                    "Your name, model, and thinking change only when the owner asks you in their own message, before you read anything else. Tell them what you would change.",
                );
            }
        }

        if (args.instructions !== undefined) {
            const text = args.instructions.trim();

            if (text.length > MAX_INSTRUCTIONS) {
                throw new Error(`Instructions are at most ${MAX_INSTRUCTIONS} characters.`);
            }

            if (text !== (agent?.instructions ?? "")) {
                before.instructions = agent?.instructions ?? "";
                after.instructions = text;
            }
        }

        if (args.name !== undefined && args.name.trim() !== bot.name) {
            before.name = bot.name;
            after.name = args.name.trim();
        }

        let model = agent?.model;

        if (args.model !== undefined) {
            const chosen = modelFor(app, args.model);
            const problem = await app.providers.problem(
                { provider: chosen.provider, modelId: chosen.id },
                true,
            );

            if (problem !== undefined) {
                throw new Error(`${chosen.provider}/${chosen.id} cannot be used now: ${problem}.`);
            }

            if (chosen.provider !== model?.provider || chosen.id !== model?.modelId) {
                model = { provider: chosen.provider, modelId: chosen.id };
                after.model = model;

                if (agent?.model !== undefined) {
                    before.model = agent.model;
                }
            }
        }

        const level = agent?.thinkingLevel ?? "off";
        const wanted = args.thinkingLevel ?? level;

        if (!isThinkingLevel(wanted)) {
            throw new Error(`thinkingLevel is one of ${THINKING_LEVELS.join(", ")}.`);
        }

        const resolved =
            model === undefined ? undefined : app.models.getModel(model.provider, model.modelId);
        const thinkingLevel =
            resolved === undefined ? wanted : clampThinkingLevel(resolved, wanted);

        if (thinkingLevel !== level) {
            before.thinkingLevel = level;
            after.thinkingLevel = thinkingLevel;
        }

        if (Object.keys(after).length === 0) {
            return undefined;
        }

        return { id: "", at: Date.now(), before, after };
    }

    /**
     * Give the bot `after`'s settings: name and instructions through the bot's own edit, which checks them (a file's bot,
     * a name taken); then the model, which nothing there can refuse. The same again changes nothing.
     */
    async #apply(id: ConversationId, after: BotSettingsValues): Promise<void> {
        const app = this.#app;

        if (after.name !== undefined || after.instructions !== undefined) {
            await app.bots.update(ownerOf(app)!, id, {
                ...(after.name === undefined ? {} : { name: after.name }),
                ...(after.instructions === undefined ? {} : { instructions: after.instructions }),
            });
        }

        if (after.model !== undefined || after.thinkingLevel !== undefined) {
            await (
                await app.conversation(id)
            ).configure(
                {
                    ...(after.model === undefined ? {} : { model: after.model }),
                    ...(after.thinkingLevel === undefined
                        ? {}
                        : { thinkingLevel: after.thinkingLevel }),
                },
                context,
            );
        }
    }
}
