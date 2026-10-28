// The cache keeper in noid's own runs, through Pi Durable's real loop: a session whose model has a known cache lifetime
// is warmed while its tool runs, the warms stop when the run ends or is stopped (bots' runs too), and a model with no
// known lifetime, as OpenAI's are in Pi's catalog, is never warmed.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
    type Api,
    type AssistantMessage,
    type AssistantMessageEventStream,
    createAssistantMessageEventStream,
    createProvider,
    type FauxResponseStep,
    type Model,
    type SimpleStreamOptions,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { root } from "./env.ts";

process.env.NOID_DOCKER = "false";

type StreamSimple = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** "sleep N" runs `sleep N` in bash, then answers; anything else is answered at once. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const seconds = /sleep (\d+)/.exec(text)?.[1];

    if (role === "toolResult" || seconds === undefined) {
        return fauxAssistantMessage([fauxText("done")]);
    }

    return fauxAssistantMessage([fauxToolCall("bash", { command: `sleep ${seconds}` })], {
        stopReason: "toolUse",
    });
};

const faux = scriptedModel(route);
let app: App;

/**
 * The faux provider, sending its payload through `onPayload` as a real adapter does (Anthropic's and OpenAI's call it
 * with the request they are about to send; faux does not): the keeper warms only a request whose payload it saw.
 */
function reporting(stream: StreamSimple): StreamSimple {
    return (m, context, options) => {
        const out = createAssistantMessageEventStream();

        void (async () => {
            const payload = {
                model: m.id,
                messages: context.messages,
                max_tokens: options?.maxTokens,
            };

            try {
                await options?.onPayload?.(payload, m);
            } catch (error) {
                // A guard that refused the payload: nothing is sent, as with a real adapter.
                const message = {
                    role: "assistant",
                    content: [],
                    api: m.api,
                    provider: m.provider,
                    model: m.id,
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: "error",
                    errorMessage: String(error),
                    timestamp: Date.now(),
                } as AssistantMessage;

                out.push({ type: "error", reason: "error", error: message });
                out.end(message);

                return;
            }

            const inner = stream(m, context, options);

            for await (const event of inner) {
                out.push(event);
            }

            out.end(await inner.result());
        })();

        return out;
    };
}

const model = {
    ...faux,
    provider: createProvider({
        id: "faux",
        auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
        models: faux.models,
        api: {
            stream: reporting(faux.provider.streamSimple.bind(faux.provider) as StreamSimple),
            streamSimple: reporting(faux.provider.streamSimple.bind(faux.provider) as StreamSimple),
        },
    }),
} as unknown as typeof faux;

// faux-1 caches as Claude does, but for 11 seconds (refreshed after 1); faux-2 is left with no known cache lifetime.
for (const each of faux.models) {
    if (each.id === "faux-1") {
        Object.assign(each, {
            promptCache: { short: 11, long: 3600 },
            cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
        });
    }
}

before(async () => {
    app = await openApp(model, join(root, "cache-keeper-noid"), undefined, { mainBot: true });
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a run is warmed while its tool runs, and the warms stop when the run ends", async () => {
    const id = await newSession(app);
    const before = app.cacheKeeper.status().warms;

    await say(app, id, "sleep 4");
    await until(() => !app.isBusy(id), "the run to end", 20_000);

    const warmed = app.cacheKeeper.status().warms - before;

    assert.ok(warmed >= 2 && warmed <= 4, `about one warm a second while bash slept: ${warmed}`);
    assert.equal(app.cacheKeeper.status().warming, 0, "nothing left warming after the run");

    // Nothing more goes out once the run is over.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(app.cacheKeeper.status().warms - before, warmed);
});

test("stopping a bot's run while its tool waits stops its warms", async () => {
    const { id } = await app.bots.create(owner(app), {
        name: "Warmer",
        kind: "host",
        folder: work,
    });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await app.commands.submit(id, owner(app), { text: "sleep 60", requestId: crypto.randomUUID() });
    await until(
        () => app.cacheKeeper.status().warming === 1,
        "the bot's tool wait to be warmed",
        20_000,
    );

    const before = app.cacheKeeper.status().warms;

    await until(() => app.cacheKeeper.status().warms > before, "a warm", 5000);
    await (await app.conversation(id)).abort(context);
    await until(() => !app.isBusy(id), "the bot's run to stop", 20_000);
    assert.equal(app.cacheKeeper.status().warming, 0);

    const stopped = app.cacheKeeper.status().warms;

    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(app.cacheKeeper.status().warms, stopped, "no warm after the stop");
});

test("a model with no known cache lifetime is never warmed", async () => {
    const id = await newSession(app);

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
        thinkingLevel: "off",
    });

    const before = app.cacheKeeper.status();

    await say(app, id, "sleep 3");
    await until(() => !app.isBusy(id), "the run to end", 20_000);
    assert.deepEqual(app.cacheKeeper.status(), before);
});
