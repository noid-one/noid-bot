// What the cache keeper would have done on real history: every tool wait in a noid database, replayed through the real
// `CacheKeeper` with a fake clock, priced as Anthropic models are (the only ones whose cache lifetime Pi knows). Not a
// test (no `.test.ts`): run it on a copy of the data, read only.
//
//     node test/cache-keeper-replay.ts <copy of pocket.sqlite>
//
// For each request that ended in a tool call: the gap to the run's next request (its `pocketTiming`), and the prompt
// it would keep warm (input + cache read + cache write). Without the keeper the next request pays a cache write
// instead of a read when the gap passed the cache's lifetime; with it, warms go out as the keeper decides, each
// costing a cache read of the prompt and one output token, and the next request misses only when the gap passed the
// last warm's lifetime (the keeper stops 30 minutes after the tool call). A tool call with no next request (the run
// was stopped, or ended there) counts against the keeper: it warms until the 30-minute cap, as if no end came.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
    type Api,
    createAssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { CacheKeeper, MAX_AGE_MS } from "../src/server/cache-keeper.ts";

type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Wait = {
    conversation: number;
    prompt: number;
    gap: number | undefined;
    model: string;
    nextRead?: number;
};

const TTL_S = 300;
const PRICED: Record<string, Rates> = {
    // Pi 1.4's catalog (`pi-ai/dist/providers/data/anthropic.json`), dollars per million tokens, 5-minute cache.
    "anthropic/claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    "anthropic/claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};

/** Every tool wait in the database, with the gap to the run's next request. */
function waits(file: string): Wait[] {
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db
        .prepare(
            `select conversation_id as c, record from entries
             where json_extract(record, '$.kind') = 'pi.assistant' order by conversation_id, id`,
        )
        .all() as { c: number; record: string }[];
    const found: Wait[] = [];
    const byConversation = new Map<number, ReturnType<typeof parse>[]>();

    function parse(row: { c: number; record: string }) {
        const message = (JSON.parse(row.record) as { model?: Record<string, unknown>[] })
            .model?.[0];
        const timing = message?.pocketTiming as
            { startedAt?: number; endedAt?: number } | undefined;
        const usage = message?.usage as Record<string, number> | undefined;

        return {
            stop: message?.stopReason as string | undefined,
            started: timing?.startedAt,
            ended: timing?.endedAt,
            prompt: (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
            read: usage?.cacheRead ?? 0,
            model: `${String(message?.provider)}/${String(message?.model)}`,
        };
    }

    for (const row of rows) {
        const list = byConversation.get(row.c) ?? [];

        list.push(parse(row));
        byConversation.set(row.c, list);
    }

    for (const [conversation, list] of byConversation) {
        for (const [index, request] of list.entries()) {
            if (request.stop !== "toolUse" || request.ended === undefined || request.prompt === 0) {
                continue;
            }

            const next = list[index + 1];
            const gap =
                next?.started === undefined ? undefined : Math.max(0, next.started - request.ended);

            found.push({
                conversation,
                prompt: request.prompt,
                gap,
                model: request.model,
                ...(next === undefined ? {} : { nextRead: next.read }),
            });
        }
    }

    db.close();

    return found;
}

/** The real keeper on one wait, with a fake clock: when its warms go out, until the next request (or its cap). */
async function warmsFor(prompt: number, gap: number | undefined, rates: Rates): Promise<number[]> {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const sent: number[] = [];
    const model = {
        id: "replay",
        provider: "anthropic",
        api: "anthropic-messages",
        cost: rates,
        promptCache: { short: TTL_S, long: 3600 },
    } as unknown as Model<Api>;
    const usage = {
        input: 0,
        output: 1,
        cacheRead: prompt,
        cacheWrite: 0,
        totalTokens: prompt + 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    const models = {
        streamSimple(m: Model<Api>, _c: unknown, options?: SimpleStreamOptions) {
            const stream = createAssistantMessageEventStream();
            const warm = options?.maxTokens === 1;

            if (warm) {
                sent.push(now);
            }

            queueMicrotask(async () => {
                await options?.onPayload?.({ model: m.id }, m);
                stream.push({
                    type: "done",
                    reason: warm ? "length" : "toolUse",
                    message: {
                        role: "assistant",
                        content: [],
                        api: m.api,
                        provider: m.provider,
                        model: m.id,
                        usage,
                        stopReason: warm ? "length" : "toolUse",
                        timestamp: now,
                    },
                } as never);
            });

            return stream;
        },
    };
    const keeper = new CacheKeeper({
        now: () => now,
        disabled: () => false,
        setTimer: ((fn: () => void, ms: number) => {
            const timer = { at: now + ms, fn };

            timers.push(timer);

            return timer as never;
        }) as never,
        clearTimer: ((timer: never) => {
            const index = timers.indexOf(timer);

            if (index >= 0) {
                timers.splice(index, 1);
            }
        }) as never,
    });

    keeper.installPayloadObserver(models);
    keeper.install(models);
    await models.streamSimple(model, { messages: [] } as never, { sessionId: "s" }).result();
    await flush();

    const end = gap ?? Number.POSITIVE_INFINITY;

    for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];

        if (next === undefined || next.at > end) {
            break;
        }

        timers.shift();
        now = next.at;
        next.fn();

        for (let i = 0; i < 5; i++) {
            await flush();
        }
    }

    await keeper.close();
    assert.ok(
        sent.every((at) => at <= MAX_AGE_MS),
        "no warm after the cap",
    );

    return sent;
}

const file = process.argv[2];

if (file === undefined) {
    throw new Error("Give a copy of pocket.sqlite.");
}

const all = waits(file);
const ttl = TTL_S * 1000;
const known = all.filter((wait) => wait.gap !== undefined);
const gaps = known.map((wait) => wait.gap!).sort((a, b) => a - b);
const quantile = (q: number) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] ?? 0;
const long = known.filter((wait) => wait.gap! > ttl);
const models = new Map<string, number>();

for (const wait of all) {
    models.set(wait.model, (models.get(wait.model) ?? 0) + 1);
}

console.log(
    `Tool waits: ${all.length} (${known.length} followed by a request, ${all.length - known.length} not)`,
);
console.log(`Models: ${[...models].map(([name, n]) => `${name} ${n}`).join(", ")}`);
console.log(
    `Gap to the next request: median ${(quantile(0.5) / 1000).toFixed(1)} s, p90 ${(quantile(0.9) / 1000).toFixed(1)} s, p99 ${(quantile(0.99) / 1000).toFixed(1)} s, max ${(quantile(1) / 1000).toFixed(0)} s`,
);
console.log(
    `Gaps past ${TTL_S} s: ${long.length} of ${known.length} (${((100 * long.length) / Math.max(1, known.length)).toFixed(1)}%), past 30 min: ${known.filter((wait) => wait.gap! > MAX_AGE_MS).length}`,
);

// The provider's own cache, as it was: after a gap past 5 minutes, did the next request still read the prompt?
const kept = long.filter((wait) => (wait.nextRead ?? 0) >= 0.5 * wait.prompt).length;

console.log(
    `As it happened (these are not Anthropic requests): after a gap past ${TTL_S} s the next request still read at least half the prompt from cache in ${kept} of ${long.length}`,
);

for (const [name, rates] of Object.entries(PRICED)) {
    let warms = 0;
    let warmCost = 0;
    let missesBefore = 0;
    let missesAfter = 0;
    let missCostBefore = 0;
    let missCostAfter = 0;
    let wasted = 0;

    for (const wait of all) {
        const sent = await warmsFor(wait.prompt, wait.gap, rates);
        const each = (wait.prompt * rates.cacheRead + rates.output) / 1e6;
        const miss = (wait.prompt * (rates.cacheWrite - rates.cacheRead)) / 1e6;
        const touched = sent.at(-1) ?? 0;

        warms += sent.length;
        warmCost += sent.length * each;

        if (wait.gap === undefined) {
            wasted += sent.length * each;
            continue;
        }

        if (wait.gap > ttl) {
            missesBefore++;
            missCostBefore += miss;
        }

        if (wait.gap > touched + ttl) {
            missesAfter++;
            missCostAfter += miss;
        }
    }

    const saved = missCostBefore - missCostAfter;

    console.log(
        `\n${name} (5-minute cache): ${warms} warms costing $${warmCost.toFixed(4)} (of which $${wasted.toFixed(4)} on waits no request followed)`,
    );
    console.log(
        `  cache misses at the next request: ${missesBefore} → ${missesAfter}; their extra cost $${missCostBefore.toFixed(4)} → $${missCostAfter.toFixed(4)}`,
    );
    console.log(
        `  net: saved $${saved.toFixed(4)} − warms $${warmCost.toFixed(4)} = $${(saved - warmCost).toFixed(4)}`,
    );
}

// The harness itself, on waits made up to show each case: a wait inside the cache's lifetime, past it, past the cap,
// one no request follows, and one too small to be worth a warm.
console.log("\nMade-up waits, claude-opus-5-5, to show the keeper at work:");

for (const [label, prompt, gap] of [
    ["4 min, 60k-token prompt", 60_000, 4 * 60_000],
    ["6 min, 60k", 60_000, 6 * 60_000],
    ["12 min, 60k", 60_000, 12 * 60_000],
    ["40 min, 60k", 60_000, 40 * 60_000],
    ["no next request, 60k", 60_000, undefined],
    ["6 min, 20-token prompt", 20, 6 * 60_000],
] as const) {
    const rates = PRICED["anthropic/claude-opus-5-5"]!;
    const sent = await warmsFor(prompt, gap, rates);
    const each = (prompt * rates.cacheRead + rates.output) / 1e6;
    const miss = (prompt * (rates.cacheWrite - rates.cacheRead)) / 1e6;
    const before = gap !== undefined && gap > ttl ? miss : 0;
    const after = gap !== undefined && gap > (sent.at(-1) ?? 0) + ttl ? miss : 0;

    console.log(
        `  ${label}: ${sent.length} warms at ${sent.map((at) => `${Math.round(at / 1000)} s`).join(", ") || "-"}; miss $${before.toFixed(4)} → $${after.toFixed(4)}, warms $${(sent.length * each).toFixed(4)}, net $${(before - after - sent.length * each).toFixed(4)}`,
    );
}
