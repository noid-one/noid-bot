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
const book = join(work, "book.txt");
/** A batch: this many calls in one answer. */
const BATCH = 30;

writeFileSync(book, Array.from({ length: 500 }, (_, n) => `line ${n}`).join("\n"));

/** Each request the model got, as `<kind>:<results so far>`. */
const requests: string[] = [];

/**
 * "loop failing" calls `cat` on a missing file again and again; "loop numbered" echoes noop-1, noop-2, …; "loop poll"
 * reads a file that changes before each read; "loop page" reads a file ten lines at a time, by offset; "loop told"
 * echoes noop-1, noop-2, … saying each time what it does. Each goes until it is stopped, or gives up after `GIVES_UP`
 * calls. "loop batch" echoes part-0 … part-29 in one answer; "loop jammed" cats a missing file five times in each answer.
 */
const route: FauxResponseStep = (request) => {
    const { messages } = request as { messages: { role: string; content: unknown }[] };
    const asked = lastText({ messages: messages.filter((each) => each.role === "user") }).text;
    const calls = messages.filter((each) => each.role === "toolResult").length;
    const kind = /loop (\w+)/.exec(asked)?.[1];

    requests.push(`${kind}:${calls}`);

    if (kind === undefined || calls >= GIVES_UP || (kind === "batch" && calls > 0)) {
        return fauxAssistantMessage([fauxText(`done after ${calls}`)]);
    }

    if (kind === "batch" || kind === "jammed") {
        const each = (n: number) => (kind === "batch" ? `echo part-${n}` : "cat /no/such/file");

        return fauxAssistantMessage(
            Array.from({ length: kind === "batch" ? BATCH : 5 }, (_, n) =>
                fauxToolCall("bash", { command: each(n) }),
            ),
            { stopReason: "toolUse" },
        );
    }

    if (kind === "page") {
        return fauxAssistantMessage(
            [fauxToolCall("read", { path: book, offset: calls * 10 + 1, limit: 10 })],
            { stopReason: "toolUse" },
        );
    }

    if (kind === "told") {
        return fauxAssistantMessage(
            [
                fauxText(`Echoing ${calls}.`),
                fauxToolCall("bash", { command: `echo noop-${calls}` }),
            ],
            { stopReason: "toolUse" },
        );
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
/** The notices the app posted. */
const notices: string[] = [];

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "repeat-guard-data"));
    const notice = app.notice.bind(app);

    app.notice = (level, message, conversationId) => {
        notices.push(message);
        notice(level, message, conversationId);
    };
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

/** The `tool` results in `id`: how many ran, how many were refused, and the text of the last. */
async function results(id: ConversationId, tool = "bash") {
    const entries = await app.transcripts.allEntries(id, true);
    const found = entries.filter(
        (entry) => entry.kind === "toolResult" && entry.name === tool,
    ) as unknown as { text?: string }[];

    return {
        count: found.length,
        refused: found.filter((each) => /Stopped:/.test(each.text ?? "")).length,
        last: found.at(-1)?.text ?? "",
    };
}

test("a bot that makes the same failing call is stopped at the sixth", async () => {
    const id = await hostBot("Stuck");

    await send(id, "loop failing");
    const { count, last } = await results(id);

    assert.equal(count, 6, "five that failed, and the sixth refused");
    assert.match(last, /same input 6 times in a row, and it failed each time/);
    assert.equal(app.isBusy(id), false, "its run stopped");
    assert.deepEqual(
        requests.filter((each) => each.startsWith("failing:")).map((each) => each.slice(8)),
        ["0", "1", "2", "3", "4", "5"],
        "the model is not asked again after the refusal",
    );
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

test("a bot paging through a file by offset is not stopped: its numbers are not text", async () => {
    const id = await hostBot("Reader");

    await send(id, "loop page");
    const { count, refused } = await results(id, "read");

    assert.equal(count, GIVES_UP, "every page was read");
    assert.equal(refused, 0);
});

test("a bot that says what it does between calls is not stopped", async () => {
    const id = await hostBot("Teller");

    await send(id, "loop told");
    const { count, refused } = await results(id);

    assert.equal(count, GIVES_UP);
    assert.equal(refused, 0);
});

test("many calls of one shape in one answer are one step", async () => {
    const id = await hostBot("Batcher");
    const before = notices.length;

    await send(id, "loop batch");
    const { count, refused } = await results(id);

    assert.equal(count, BATCH, "every call ran");
    assert.equal(refused, 0);
    assert.equal(notices.length, before, "no notice");
    assert.equal(requests.at(-1), `batch:${BATCH}`, "the model had every answer");
});

test("a stuck batch is stopped once: one notice, and every call left refused", async () => {
    const id = await hostBot("Jammed");
    const before = notices.length;

    await send(id, "loop jammed");
    const { count, refused } = await results(id);

    assert.equal(count, 30, "five answers of five that failed, and the sixth refused");
    assert.equal(refused, 5);
    assert.equal(notices.length - before, 1, "one notice");
    assert.match(notices.at(-1)!, /Jammed kept calling bash/);
    assert.equal(app.isBusy(id), false, "its run stopped");
});
