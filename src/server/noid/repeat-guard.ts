/**
 * noid's repeat guard: a bot (or Noid) that calls the same tool the same way, getting nothing new, is stuck, and with
 * nobody watching (a routine, a webhook, mail from another bot) it would go on until its run timed out. Ported from
 * rakazo's tool-loop guard (26f284c8d, 29cd6da25, af36999b7, eb6613c5c).
 *
 * Within one run, each call is keyed by its tool and its arguments (in a set order), and shaped with the digits of its
 * text blanked (`echo noop-1`, `echo noop-2`; numbers such as a read's `offset` stay). The sixth identical call after
 * five failing answers in a row is stuck, and so is the 25th call in a row of one shape. An answer the run has not had
 * before starts the count over: polling a page or a build that changes is progress. So does the model's own text: it
 * said what it is doing. Calls of one shape from one model answer are one step: reading 30 files at once is not a
 * loop. A stuck call is refused with a line that says so, and the run stops, so the bot cannot try once more; the owner
 * gets one notice, and any call the run still makes is refused too.
 *
 * Only bots' runs: a person's own session has them watching. Calls a codemode script makes (`parent`) are a program's,
 * not the model going round, and are not counted. State is memory only: a restart starts each count over.
 */
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type ConversationId,
    defineExtension,
    GenerationTask,
    hook,
    LiveDoc,
    ToolTask,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import { describe } from "../errors.ts";

/** Identical calls whose answers keep failing: the sixth is stuck (five failures before it). */
export const MAX_IDENTICAL_FAILING = 6;
/** Calls in a row of one shape (or identical ones that keep getting answers seen before): the 25th is stuck. */
export const MAX_SIMILAR = 25;

type Streak = {
    run: number;
    key?: string;
    shape?: string;
    count: number;
    shapeCount: number;
    /** The distinct answers the identical calls had, newest last. */
    results: string[];
    /** Identical calls in a row whose answer failed. */
    failures: number;
    /** The streak's last counted call, whose answer `afterTool` reads, and the model answer it came from. */
    callId?: string;
    response?: number;
    /** Once the run is stopped, what every later call of it is refused with, and the stop, settled once it is done. */
    stopped?: string;
    stopping?: Promise<void>;
};

/** JSON with object keys in order, so `{a, b}` and `{b, a}` are the same call. */
function stable(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stable).join(",")}]`;
    }

    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
            )
            .join(",")}}`;
    }

    return JSON.stringify(value) ?? "null";
}

/** The call with the digits in its text arguments blanked: numbered calls are one shape, pages of a read are not. */
const shapeOf = (name: string, args: unknown) => `${name}:${stable(blankDigits(args))}`;

function blankDigits(value: unknown): unknown {
    if (typeof value === "string") {
        return value.replace(/\d+/g, "#");
    }

    if (Array.isArray(value)) {
        return value.map(blankDigits);
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, each]) => [key, blankDigits(each)]),
        );
    }

    return value;
}

/** What the model got back: failed or not, and its content, hashed (details can carry timings). */
function fingerprint(result: { output?: unknown; isError?: boolean }): string {
    const hash = createHash("sha256")
        .update(JSON.stringify(result.output ?? null))
        .digest("hex");

    return `${result.isError === true ? "failed:" : ""}${hash}`;
}

export function stuckText(tool: string, count: number, failing: boolean): string {
    return failing
        ? `Stopped: you called ${tool} with the same input ${count} times in a row, and it failed each time. Do not call it again this way: tell your person what is stuck, and what you would try instead.`
        : `Stopped: you called ${tool} ${count} times in a row with nearly the same input, without getting anything new. Tell your person what you were trying to do, and what is in the way.`;
}

export function createRepeatGuard(app: PocketApp) {
    const streaks = new Map<ConversationId, Streak>();
    /** The newest model answer of each bot's conversation, numbered: its tool calls are one step. */
    const responses = new Map<ConversationId, number>();
    let answered = 0;

    /** The run `id` is in now, as its live document says: the streak of an earlier run is over. */
    const streakOf = async (id: ConversationId, context: Context): Promise<Streak> => {
        // The run is its first input: the task that carries it changes from round to round.
        const run = Number((await app.harness.snapshot(LiveDoc, id, context))?.run?.inputs[0] ?? 0);
        let streak = streaks.get(id);

        if (streak === undefined || streak.run !== run) {
            streak = { run, count: 0, shapeCount: 0, results: [], failures: 0 };
            streaks.set(id, streak);
        }

        return streak;
    };

    /**
     * Stop the run, once the refusal is in: the bot does not get one more try. Until the stop lands, `beforeRequest`
     * holds the model's next request, so none is sent (and paid for) after the refusal.
     */
    const stop = (id: ConversationId, streak: Streak, tool: string) => {
        streak.stopping = new Promise<void>((resolve) => setImmediate(resolve))
            .then(() => app.conversation(id))
            .then((conversation) => conversation.abort(BACKGROUND_CONTEXT))
            .then(
                () => undefined,
                (error: unknown) => app.log(`repeat guard: stop failed: ${describe(error)}`),
            );
        app.notice(
            "warning",
            `${app.bots.of(id)?.name ?? "A bot"} kept calling ${tool} without getting anywhere: its run was stopped.`,
            id,
        );
    };

    return defineExtension({
        name: "noid-repeat-guard",
        hooks: [
            hook(GenerationTask, {
                // A stopped run's next request waits for the stop, which cancels it.
                beforeRequest: async (_request, api, context) => {
                    const stopping = streaks.get(api.conversationId)?.stopping;

                    if (stopping !== undefined) {
                        await awaitWithContext(stopping, context);
                    }

                    return undefined;
                },
                afterResponse: (message, api) => {
                    const id = api.conversationId;

                    if (app.bots.of(id) === undefined) {
                        return;
                    }

                    responses.set(id, ++answered);
                    const streak = streaks.get(id);
                    const wrote = message.content.some(
                        (part) => part.type === "text" && part.text.trim() !== "",
                    );

                    // The model said what it is doing: what it calls next is a new step, not more of the same.
                    if (streak !== undefined && wrote) {
                        Object.assign(streak, {
                            key: undefined,
                            shape: undefined,
                            count: 0,
                            shapeCount: 0,
                            results: [],
                            failures: 0,
                            callId: undefined,
                        });
                    }
                },
            }),
            hook(ToolTask, {
                beforeTool: async (call, api, context) => {
                    const id = api.conversationId;

                    if (call.parent !== undefined || app.bots.of(id) === undefined) {
                        return undefined;
                    }

                    const streak = await streakOf(id, context);

                    if (streak.stopped !== undefined) {
                        return { block: streak.stopped };
                    }

                    const key = `${call.name}:${stable(call.arguments ?? {})}`;
                    const shape = shapeOf(call.name, call.arguments ?? {});
                    const response = responses.get(id);

                    // Another call of the same shape from the same answer: one step, already counted.
                    if (
                        response !== undefined &&
                        response === streak.response &&
                        shape === streak.shape
                    ) {
                        return undefined;
                    }

                    streak.callId = call.id;
                    streak.response = response;

                    if (key === streak.key) {
                        streak.count++;
                    } else {
                        Object.assign(streak, { key, count: 1, results: [], failures: 0 });
                    }

                    streak.shapeCount = shape === streak.shape ? streak.shapeCount + 1 : 1;
                    streak.shape = shape;

                    const failing = streak.failures >= MAX_IDENTICAL_FAILING - 1;

                    if (!failing && streak.shapeCount < MAX_SIMILAR) {
                        return undefined;
                    }

                    streak.stopped = stuckText(
                        call.name,
                        failing ? streak.count : streak.shapeCount,
                        failing,
                    );
                    stop(id, streak, call.name);

                    return { block: streak.stopped };
                },
                afterTool: async (call, result, api, context) => {
                    const id = api.conversationId;

                    if (call.parent !== undefined || app.bots.of(id) === undefined) {
                        return undefined;
                    }

                    const streak = await streakOf(id, context);

                    if (
                        streak.callId !== call.id ||
                        streak.key !== `${call.name}:${stable(call.arguments ?? {})}`
                    ) {
                        return undefined;
                    }

                    const seen = fingerprint(result);

                    // Something new: whatever it waits on is moving, so the count starts over from this call.
                    if (!streak.results.includes(seen)) {
                        if (streak.results.length > 0) {
                            Object.assign(streak, { count: 1, shapeCount: 1, failures: 0 });
                        }

                        streak.results = [...streak.results, seen].slice(-MAX_SIMILAR);
                    }

                    streak.failures = result.isError === true ? streak.failures + 1 : 0;

                    return undefined;
                },
            }),
        ],
    });
}
