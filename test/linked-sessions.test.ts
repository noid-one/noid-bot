// Linked sessions (`linked-sessions.ts`): a repeat acts once, a link shares nothing, and the checks of whom Pi works for
// apply before anything is made or sent.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { LinkedSessionCallsDoc, TurnsDoc } from "../src/server/docs.ts";

let app: App;

before(async () => {
    const model = scriptedModel();

    // A model that thinks, so a linked session's thinking level has room to go too high.
    Object.assign(
        model.models.find((each) => each.id === "faux-1")!,
        { reasoning: true },
    );
    app = await openApp(model);
});
after(async () => {
    await app?.close();
    cleanUp();
});

/** A session with someone Pi works for: linked sessions act as them. */
async function source() {
    const id = await newSession(app);

    await say(app, id, "hello");

    return id;
}

const start = (id: ConversationId, key: string = crypto.randomUUID(), model?: string) =>
    app.linkedSessions.start(id, { title: "Linked", message: "a task", model }, key);
const send = (id: ConversationId, to: string, key: string = crypto.randomUUID()) =>
    app.linkedSessions.send(id, { to, message: "a message" }, key);
const sent = async (id: ConversationId) =>
    (await modelTexts(app, id)).filter(
        (text) => text.includes("<linked-session-message>") && !text.includes("echo:"),
    ).length;

test("a repeated start or send makes one session or one message", async () => {
    const id = await source();
    const { session: target, address } = await app.linkedSessions.start(
        id,
        { message: "a task", thinking: "high" },
        "start-key",
    );
    const count = app.sessions().length;

    // Harder than the session that started it, which is at "off" (Pi Pocket 5a45afd).
    assert.equal((await app.agentState(target))?.thinkingLevel, "high");

    assert.equal((await start(id, "start-key")).session, target);
    assert.equal(app.sessions().length, count);
    await send(id, address, "send-key");
    await send(id, address, "send-key");
    await until(async () => (await sent(target)) > 1, "the messages");
    assert.equal(await sent(target), 2);
});

test("someone who cannot see the origin learns nothing of it and cannot reach it", async () => {
    const id = await source();

    await app.commands.updateSession(id, owner(app), { title: "Secret origin" });
    const { session: target } = await start(id);
    const { user } = app.config.addUser("Target only", "guest", [String(target)]);
    // Someone who sees the linked session but not the origin: the origin's name stays out of the list Pi gets.
    const [origin] = await app.linkedSessions.list(target);

    assert.ok(origin !== undefined && origin.title === undefined && origin.cwd === undefined);
    const tab = fakeTab(undefined, user);

    await app.attach(tab.client);
    // A later change goes out in a broadcast, which must be this person's own list too.
    await app.commands.updateSession(target, owner(app), { title: "Renamed" });
    const lists = () => tab.events.filter((each) => each.event === "sessions");

    await until(() => lists().length > 1, "a list");
    app.detach(tab.client);

    for (const list of [app.sessions(user), ...lists().map((each) => each.data)]) {
        assert.ok(!JSON.stringify(list).includes("Secret origin"));
        assert.ok(!JSON.stringify(list).includes(`"id":${Number(id)}`));
    }

    const { submissionId } = await app.commands.submit(target, user, {
        text: "hello",
        requestId: "guest",
    });

    // With Pi working for them in the linked session, its peers are out of reach.
    await (await app.harness.submission(submissionId, context))!.wait(context);
    assert.deepEqual(await app.linkedSessions.list(target), []);
    await assert.rejects(send(target, origin.address), /not linked/);
});

test("linked sessions exchange more than 10 turns, and no message count stops them", async () => {
    const id = await source();
    const { session: target, address } = await start(id);

    await until(async () => (await sent(target)) === 1, "the first message");
    const [origin] = await app.linkedSessions.list(target);

    // 12 turns each way: 25 messages with the first, past the 20 that stopped a team before 0.19.0.
    for (let turn = 0; turn < 12; turn++) {
        await send(target, origin!.address);
        await send(id, address);
    }

    await until(
        async () => (await sent(target)) === 13 && (await sent(id)) === 12,
        "every message of the exchange",
    );
    await send(id, address);
    await start(id);
    await until(async () => (await sent(target)) === 14, "the message past the old limit");
});

/** The reports of linked sessions' runs in `id`: what the fence of each carries. */
const reports = async (id: ConversationId, ended: RegExp) =>
    (await modelTexts(app, id))
        // A message to the lead (a string), not the lead's answer about it (an array of parts).
        .filter((text) => text.startsWith('"') && ended.test(text))
        .map(
            (text) =>
                /<linked-session-message>\\n([^]*?)\\n<\/linked-session-message>/.exec(text)?.[1],
        );

test("a linked session's final answer comes back to the session that started it, once for each run", async () => {
    const id = await source();
    const { session: target, address } = await start(id);
    const finished = /Linked session \S+ finished its run/;

    await until(async () => (await reports(id, finished)).length === 1, "the first report");
    // The whole answer, defanged like any linked message: the echo model answers with the message it got.
    assert.match(
        (await reports(id, finished))[0]!,
        /^echo: .*a task\\n‹\/linked-session-message>$/,
    );

    // The lead answers the report (it is an ordinary message there), and the answer is no report of its own.
    await until(() => !app.isBusy(id), "the lead to answer");
    assert.equal((await reports(id, finished)).length, 1);

    // A second run: a second report, with that run's answer, and the first one is not sent again.
    await app.linkedSessions.send(id, { to: address, message: "more work" }, "more");
    await until(async () => (await reports(id, finished)).length === 2, "the second report");
    assert.match((await reports(id, finished))[1]!, /more work/);
    assert.equal(app.sessionMeta(target)?.linkedFrom?.id, Number(id));
});

test("only the session that started one hears its answer by itself: a message the other way asks for a reply", async () => {
    const id = await source();
    const { session: target, address } = await start(id);

    await until(async () => (await sent(target)) === 1, "the first message");
    const [origin] = await app.linkedSessions.list(target);
    const asks = /Your final answer does not reach that session by itself/;
    const comes = /your final answer reaches it by itself/;

    // From the lead: no reply needed, and the tool is told so.
    assert.deepEqual(await app.linkedSessions.send(id, { to: address, message: "more" }, "down"), {
        answers: true,
    });
    await until(async () => (await sent(target)) === 2, "the lead's message");
    const down = (await modelTexts(app, target)).filter((text) => text.startsWith('"'));

    assert.match(down.at(-1)!, comes);
    assert.doesNotMatch(down.at(-1)!, asks);

    // From the worker to its lead: the lead's run end reports to nobody, so the message asks it to reply.
    assert.deepEqual(
        await app.linkedSessions.send(target, { to: origin!.address, message: "a question" }, "up"),
        { answers: false },
    );
    await until(async () => (await sent(id)) === 1, "the worker's question");
    const up = (await modelTexts(app, id)).filter(
        (text) => /a question/.test(text) && text.startsWith('"'),
    );

    assert.match(up.at(-1)!, asks);
    assert.doesNotMatch(up.at(-1)!, comes);
});

test("a linked session that fails or is stopped says so to the session that started it", async () => {
    const failing = scriptedModel((request) => {
        const { text } = lastText(request as never);

        if (text.includes("FAIL_NOW")) {
            return {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "the model fell over",
            } as never;
        }

        if (text.includes("STREAM_A_WHILE")) {
            return fauxAssistantMessage([fauxText("word ".repeat(80_000))]);
        }

        return fauxAssistantMessage([fauxText("Done.")]);
    });
    const isolated = await openApp(failing, join(root, "report-data"));
    const texts = async (id: ConversationId, ended: RegExp) =>
        (await modelTexts(isolated, id)).filter((text) => text.startsWith('"') && ended.test(text));

    try {
        const origin = await newSession(isolated);

        await say(isolated, origin, "hello");
        const { session } = await isolated.linkedSessions.start(
            origin,
            { message: "FAIL_NOW" },
            "fail",
        );
        const failed = /Linked session \S+ failed/;

        await until(async () => (await texts(origin, failed)).length === 1, "the failure report");
        assert.match((await texts(origin, failed))[0]!, /fell over/);
        assert.equal(isolated.isBusy(session), false);

        const second = await isolated.linkedSessions.start(
            origin,
            { message: "STREAM_A_WHILE" },
            "stream",
        );

        await until(() => isolated.isBusy(second.session), "the run to start");
        await isolated.commands.abort(second.session, owner(isolated));
        const stopped = /Linked session \S+ was stopped/;

        await until(async () => (await texts(origin, stopped)).length === 1, "the stop report");
    } finally {
        await isolated.close();
    }
});

test("a message to a linked session lands at its next pause unless told to wait for its run", async () => {
    const streaming = scriptedModel((request) => {
        const { text } = lastText(request as never);

        if (text.includes("STREAM_A_WHILE")) {
            return fauxAssistantMessage([fauxText("word ".repeat(80_000))]);
        }

        return fauxAssistantMessage([fauxText("Done.")]);
    });
    const isolated = await openApp(streaming, join(root, "steer-data"));

    try {
        const origin = await newSession(isolated);

        await say(isolated, origin, "hello");
        const { session, address: to } = await isolated.linkedSessions.start(
            origin,
            { message: "STREAM_A_WHILE" },
            "busy",
        );

        await until(() => isolated.isBusy(session), "the run to start");
        await isolated.linkedSessions.send(origin, { to, message: "now" }, "steer");
        await isolated.linkedSessions.send(
            origin,
            { to, message: "later", steer: false },
            "follow",
        );
        const modes = (await isolated.harness.snapshot(InboxDoc, session, context))?.items.map(
            (item) => item.mode,
        );

        assert.deepEqual(modes, ["steer", "followUp"]);
    } finally {
        await isolated.close();
    }
});

test("a start or send is refused past a spend limit or without the turn", async () => {
    const id = await source();
    const { session: target, address } = await start(id);
    const count = app.sessions().length;

    await until(async () => (await sent(target)) === 1, "the first message");
    await assert.rejects(start(target), /cannot start/);

    const refused = async (why: RegExp) => {
        await assert.rejects(start(id), why);
        await assert.rejects(send(id, address), why);
        assert.equal(app.sessions().length, count);
        assert.equal(await sent(target), 1);
    };

    // What the linked session spent counts against the budget of the session that started it.
    await recordCost(app, target, 0.02);
    await until(() => app.spend.sessionSpent(target) === 0.02, "the spend");
    await app.spend.setSessionBudget(owner(app), id, 0.01);
    await refused(/spend limit/);
    await app.spend.setSessionBudget(owner(app), id, null);

    const driver = app.config.addUser("Driver", "guest").user;

    await app.harness.commit(async (tx) => {
        Object.assign(await tx.doc(TurnsDoc, id), { on: true, driver: driver.id, asks: [] });
    }, context);
    await refused(/driving/);
});

test("an unavailable model creates no session", async (t) => {
    const id = await source();
    const count = app.sessions().length;
    const key = "unavailable";

    // A model that is neither the session's own nor on the owner's list for subagents is refused.
    await assert.rejects(start(id, key, "faux/faux-2"), /not allowed/);
    await app.allowSubagentModel(owner(app), "faux/faux-2", true);
    t.mock.method(app.providers, "problem", async () => "its sign-in expired");
    await assert.rejects(start(id, key, "faux/faux-2"), /sign-in expired/);
    assert.equal(app.sessions().length, count);

    const token = createHash("sha256").update(`${id}:${key}`).digest("hex");

    assert.equal(
        (await app.harness.snapshot(LinkedSessionCallsDoc, id, context))?.items[token],
        undefined,
    );
});

test("one session starts 12 linked sessions, and no count refuses one", async () => {
    const id = await source();

    // Past the 10 that one session could start before 0.19.0.
    for (let each = 0; each < 12; each++) {
        await start(id);
    }

    const started = app.sessions().filter((session) => session.linkedFrom?.id === Number(id));

    assert.equal(started.length, 12);
    assert.equal(new Set(started.map((session) => session.id)).size, 12);
});

test("a session that started others shows what counts against its limit: theirs too", async () => {
    const id = await source();
    const { session: child } = await start(id);

    await app.spend.setSessionBudget(owner(app), id, 1);
    await recordCost(app, id, 0.25);
    await recordCost(app, child, 0.5);

    const row = app.spend.summary(owner(app)).sessions.find((each) => each.id === Number(id));

    assert.equal(row?.spent, 0.75);
});
