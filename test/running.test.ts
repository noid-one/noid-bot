// Running now: what is at work in each session, from the task graph, as each person may see it.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { TaskGraphNode } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { runningBoard, runningNow } from "../src/server/running.ts";

/** Asked to wait, the model runs a slow command; then it answers. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("done waiting")]);
    }

    if (text.endsWith("wait a bit")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1.5" })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("running now lists a session's run and its tool call, scheduled messages, and only what each person may see", async () => {
    const busy = await newSession(app);
    const quiet = await newSession(app);

    const scheduled = await app.commands.schedule(quiet, owner(app), {
        when: "in 2h look again",
        zone: "UTC",
    });
    const { submissionId } = await app.commands.submit(busy, owner(app), {
        text: "wait a bit",
        requestId: "r1",
    });

    await until(
        async () =>
            (await runningNow(app, owner(app))).some((each) =>
                each.tasks.some((task) => task.label === "running bash"),
            ),
        "the tool call to show",
    );

    const running = await runningNow(app, owner(app));
    const later = running.find((each) => each.id === Number(quiet))!;

    assert.equal(later.tasks[0]?.scheduleId, scheduled.id);
    // It only sleeps until its time: the board counts nothing at work, or running, for it.
    assert.equal(later.tasks[0]?.status, "sleeping");

    const scoped = app.config.addUser("Sam", "guest", [String(quiet)]).user;

    assert.deepEqual(
        (await runningNow(app, scoped)).map((each) => each.id),
        [Number(quiet)],
    );

    await (await app.harness.submission(submissionId, context))!.wait(context);
    assert.equal(
        (await runningNow(app, owner(app))).some((each) => each.id === Number(busy)),
        false,
        "a finished run is gone",
    );
    await app.commands.cancelSchedule(quiet, owner(app), scheduled.id);
});

test("the running board lists every schedule a person may see, with its next times, when each task was first seen, and the message a run works on", async () => {
    const busy = await newSession(app);
    const quiet = await newSession(app);
    const hidden = await newSession(app);

    const repeat = await app.commands.schedule(quiet, owner(app), {
        when: "every 2h check the queue",
        zone: "UTC",
    });
    const once = await app.commands.schedule(hidden, owner(app), {
        when: "in 3h look again",
        zone: "UTC",
    });

    await app.commands.submit(busy, owner(app), { text: "wait a bit", requestId: "r2" });
    await until(
        async () =>
            (await runningBoard(app, owner(app))).sessions.some((each) =>
                each.tasks.some((task) => task.label === "running bash"),
            ),
        "the tool call to show on the board",
    );

    const board = await runningBoard(app, owner(app));
    const every = board.schedules.find((each) => each.id === repeat.id)!;
    const single = board.schedules.find((each) => each.id === once.id)!;

    assert.equal(every.session, Number(quiet));
    assert.equal(every.repeat, "every 2 hours");
    assert.ok(every.upcoming.length > 1, "a repeat's next times");
    assert.equal(every.upcoming[0], every.next);
    assert.equal(every.upcoming[1]! - every.upcoming[0]!, 2 * 60 * 60_000);
    assert.deepEqual(single.upcoming, [single.next]);
    assert.equal(single.repeat, undefined);
    assert.ok(
        board.schedules.every((each, i, all) => i === 0 || all[i - 1]!.next <= each.next),
        "soonest first",
    );

    const working = board.sessions.find((each) => each.id === Number(busy))!;

    assert.equal(typeof working.spent, "number");
    assert.ok(working.tasks.every((task) => typeof task.since === "number"));
    assert.equal(working.prompt?.text, "wait a bit", "the message its run works on");

    const scoped = app.config.addUser("Kim", "guest", [String(quiet)]).user;
    const theirs = await runningBoard(app, scoped);

    assert.deepEqual(
        theirs.schedules.map((each) => each.id),
        [repeat.id],
        "only the schedules of sessions they may see",
    );
    assert.equal(
        theirs.sessions.some((each) => each.id === Number(busy)),
        false,
    );

    await app.commands.cancelSchedule(quiet, owner(app), repeat.id);
    await app.commands.cancelSchedule(hidden, owner(app), once.id);
});

test("noid: a bot's schedules are on the board under its name, as a bot's", async () => {
    const folder = mkdtempSync(join(tmpdir(), "running-bot-"));
    const { id } = await app.bots.create(owner(app), {
        name: "Planner",
        role: "Plans the week",
        kind: "host",
        folder,
    });
    const reminder = await app.commands.schedule(id, owner(app), {
        when: "every day 09:00 plan the day",
        zone: "UTC",
    });

    const board = await runningBoard(app, owner(app));
    const shown = board.schedules.find(
        (each) => each.id === reminder.id && each.session === Number(id),
    );

    assert.ok(shown, "the bot's schedule");
    assert.equal(shown.sessionTitle, "Planner");
    assert.equal(shown.bot, true);
    assert.equal(shown.repeat, "every day at 09:00");

    await app.commands.cancelSchedule(id, owner(app), reminder.id);
});

test("the board reads the task graph once, and takes each session's folder and model from where the list does", async () => {
    const busy = await newSession(app);
    const { submissionId } = await app.commands.submit(busy, owner(app), {
        text: "wait a bit",
        requestId: "r3",
    });

    await until(
        async () =>
            (await runningBoard(app, owner(app))).sessions.some((each) => each.id === Number(busy)),
        "the run on the board",
    );

    const watch = app.harness.watchTaskGraph;
    const list = app.sessions;
    let graphs = 0;
    let lists = 0;

    app.harness.watchTaskGraph = ((...args: Parameters<typeof watch>) => {
        graphs++;

        return watch.apply(app.harness, args);
    }) as typeof watch;
    app.sessions = ((...args: Parameters<typeof list>) => {
        lists++;

        return list.apply(app, args);
    }) as typeof list;

    try {
        const board = await runningBoard(app, owner(app));
        const shown = board.sessions.find((each) => each.id === Number(busy))!;
        const listed = list.call(app, owner(app)).find((each) => each.id === Number(busy))!;

        assert.equal(graphs, 1, "one read of the task graph");
        assert.equal(lists, 0, "no session list");
        assert.ok(shown.model, "its model");
        assert.deepEqual([shown.cwd, shown.model], [listed.cwd, listed.model]);
    } finally {
        app.harness.watchTaskGraph = watch;
        app.sessions = list;
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
});

test("noid: a group thread's round says what it does", async () => {
    const id = await newSession(app);
    const round = {
        id: 1_000_001,
        kind: "x.noid.group-round",
        conversationId: id,
        state: { status: "waiting" },
    } as unknown as TaskGraphNode;
    const [session] = await runningNow(app, owner(app), [round]);

    assert.equal(session?.tasks[0]?.label, "asking a group thread's bots in turn");
});

test("noid: a guest sees none of the owner's bots' schedules", async () => {
    const folder = mkdtempSync(join(tmpdir(), "running-bot-"));
    const { id } = await app.bots.create(owner(app), {
        name: "Secret",
        role: "The owner's own",
        kind: "host",
        folder,
    });
    const reminder = await app.commands.schedule(id, owner(app), {
        when: "every day 09:00 read the owner's mail",
        zone: "UTC",
    });
    const guest = app.config.addUser("Gus", "guest").user;

    assert.equal(
        (await runningBoard(app, guest)).schedules.some((each) => each.session === Number(id)),
        false,
    );
    await app.commands.cancelSchedule(id, owner(app), reminder.id);
});
