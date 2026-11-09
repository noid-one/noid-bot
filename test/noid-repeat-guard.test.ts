// noid's repeat guard: a bot that keeps making the same call, getting nothing new, is stopped; polling something that
// changes is not, nor is a person's own session.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { MAX_SIMILAR } from "../src/server/noid/repeat-guard.ts";

/** How far a model goes round before it gives up by itself: past every limit the guard has. */
const GIVES_UP = MAX_SIMILAR + 10;
const polled = join(work, "polled.txt");

/**
 * "loop failing" calls `cat` on a missing file again and again; "loop numbered" echoes noop-1, noop-2, …; "loop poll"
 * reads a file that changes before each read. Each goes until it is stopped, or gives up after `GIVES_UP` calls.
 */
const route: FauxResponseStep = (request) => {
    const { messages } = request as { messages: { role: string; content: unknown }[] };
    const asked = lastText({ messages: messages.filter((each) => each.role === "user") }).text;
    const calls = messages.filter((each) => each.role === "toolResult").length;
    const kind = /loop (\w+)/.exec(asked)?.[1];

    if (kind === undefined || calls >= GIVES_UP) {
        return fauxAssistantMessage([fauxText(`done after ${calls}`)]);
    }

    if (kind === "poll") {
        writeFileSync(polled, `state ${calls}\n`);
    }

    const command =
        kind === "failing"
            ? "cat /no/such/file"
            : kind === "numbered"
              ? `echo noop-${calls}`
              : `cat ${polled}`;

    return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "repeat-guard-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function hostBot(name: string): Promise<ConversationId> {
    const { id } = await app.bots.create(owner(app), {
        name,
        role: "Works here",
        kind: "host",
        folder: work,
    });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

async function send(id: ConversationId, text: string): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
}

/** The bash results in `id`: how many ran, and the text of the last. */
async function results(id: ConversationId) {
    const entries = await app.transcripts.allEntries(id, true);
    const bash = entries.filter(
        (entry) => entry.kind === "toolResult" && entry.name === "bash",
    ) as unknown as { text?: string }[];

    return { count: bash.length, last: bash.at(-1)?.text ?? "" };
}

test("a bot that makes the same failing call is stopped at the sixth", async () => {
    const id = await hostBot("Stuck");

    await send(id, "loop failing");
    const { count, last } = await results(id);

    assert.equal(count, 6, "five that failed, and the sixth refused");
    assert.match(last, /same input 6 times in a row, and it failed each time/);
    assert.equal(app.isBusy(id), false, "its run stopped");
});

test("a bot that numbers the same call is stopped at the 25th", async () => {
    const id = await hostBot("Counter");

    await send(id, "loop numbered");
    const { count, last } = await results(id);

    assert.equal(count, MAX_SIMILAR);
    assert.match(last, new RegExp(`bash ${MAX_SIMILAR} times in a row with nearly the same input`));
});

test("a bot polling something that changes is not stopped", async () => {
    const id = await hostBot("Patient");

    await send(id, "loop poll");
    const { count, last } = await results(id);

    assert.equal(count, GIVES_UP, "every read ran");
    assert.doesNotMatch(last, /Stopped/);
});

test("a person's own session is never stopped: they are watching", async () => {
    const id = await newSession(app);

    await send(id, "loop failing");
    const { count, last } = await results(id);

    assert.equal(count, GIVES_UP);
    assert.doesNotMatch(last, /Stopped/);
});
