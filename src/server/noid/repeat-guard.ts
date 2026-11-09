/**
 * noid's repeat guard: a bot (or Noid) that calls the same tool the same way, getting nothing new, is stuck, and with
 * nobody watching (a routine, a webhook, mail from another bot) it would go on until its run timed out. Ported from
 * rakazo's tool-loop guard (26f284c8d, 29cd6da25, af36999b7, eb6613c5c).
 *
 * Within one run, each call is keyed by its tool and its arguments (in a set order), and shaped with the digits of its
 * text blanked (`echo noop-1`, `echo noop-2`). The sixth identical call after five failing answers in a row is stuck,
 * and so is the 25th call in a row of one shape. An answer the run has not had before starts the count over: polling a
 * page or a build that changes is progress. A stuck call is refused with a line that says so, and the run stops, so the
 * bot cannot try once more; the owner gets a notice.
 *
 * Only bots' runs: a person's own session has them watching. Calls a codemode script makes (`parent`) are a program's,
 * not the model going round, and are not counted. State is memory only: a restart starts each count over.
 */
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type ConversationId,
    defineExtension,
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

/** The call with the digits of its text blanked: a numbered run of calls is one shape. */
const shapeOf = (name: string, args: string) => `${name}:${args.replace(/\d+/g, "#")}`;

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

    /** Stop the run, once the refusal is in: the bot does not get one more try. */
    const stop = (id: ConversationId, tool: string) => {
        setImmediate(() => {
            void app
                .conversation(id)
                .then((conversation) => conversation.abort(BACKGROUND_CONTEXT))
                .catch((error: unknown) =>
                    app.log(`repeat guard: stop failed: ${describe(error)}`),
                );
        });
        app.notice(
            "warning",
            `${app.bots.of(id)?.name ?? "A bot"} kept calling ${tool} without getting anywhere: its run was stopped.`,
            id,
        );
    };

    return defineExtension({
        name: "noid-repeat-guard",
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api, context) => {
                    const id = api.conversationId;

                    if (call.parent !== undefined || app.bots.of(id) === undefined) {
                        return undefined;
                    }

                    const streak = await streakOf(id, context);
                    const args = stable(call.arguments ?? {});
                    const key = `${call.name}:${args}`;
                    const shape = shapeOf(call.name, args);

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

                    stop(id, call.name);

                    return {
                        block: stuckText(
                            call.name,
                            failing ? streak.count : streak.shapeCount,
                            failing,
                        ),
                    };
                },
                afterTool: async (call, result, api, context) => {
                    const id = api.conversationId;

                    if (call.parent !== undefined || app.bots.of(id) === undefined) {
                        return undefined;
                    }

                    const streak = await streakOf(id, context);

                    if (streak.key !== `${call.name}:${stable(call.arguments ?? {})}`) {
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
