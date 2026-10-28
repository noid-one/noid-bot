// noid's routines: schedules that repeat on cron's five fields too, run now when asked without moving their next time,
// remember what came of their latest runs, and push "Routine failed" when one stops with an error.
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
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ScheduleDoc } from "../src/server/docs.ts";
import type { PushMessage } from "../src/server/push.ts";
import type { RunOutcome } from "../src/server/schedules.ts";
import { describeRepeat, parseWhen } from "../src/server/when.ts";

const iso = (moment: number) => new Date(moment).toISOString();
/** Sunday, October 4, 2026, 10:00 in Chicago (15:00 UTC). */
const sunday = Date.UTC(2026, 9, 4, 15, 0);
const chicago = "America/Chicago";

test("cron's five fields: lists, ranges, steps, names, and either day when both are given", () => {
    const next = (text: string, now = sunday) => {
        const parsed = parseWhen(text, now, chicago);

        return [iso(parsed.next), describeRepeat(parsed.every!), parsed.rest];
    };

    assert.deepEqual(next("cron 0 8 * * 1-5 the news"), [
        "2026-10-05T13:00:00.000Z",
        "cron 0 8 * * 1-5",
        "the news",
    ]);
    assert.equal(next("cron 30 8 1 * * x")[0], "2026-11-01T14:30:00.000Z", "the first, after DST");
    assert.equal(next("cron */15 * * * * x")[0], "2026-10-04T15:15:00.000Z");
    assert.equal(next("cron 5/20 7 * * * x")[0], "2026-10-05T12:05:00.000Z", "from 5, every 20");
    assert.equal(next("cron 0 9 * jan,feb mon x")[0], "2027-01-04T15:00:00.000Z");
    assert.equal(next("cron 0 8 * * 7 x")[0], "2026-10-11T13:00:00.000Z", "7 is Sunday too");
    assert.equal(next("cron 0 9 13 * fri x")[0], "2026-10-09T14:00:00.000Z", "Friday, or the 13th");
    assert.equal(next("cron 0 9 29 2 * x")[0], "2028-02-29T15:00:00.000Z", "the next leap day");

    // The wall clock holds across the change: 8:00 is 13:00 UTC before and 14:00 after.
    const saturday = parseWhen("cron 0 8 * * * x", Date.UTC(2026, 9, 31, 12), chicago).next;
    const after = parseWhen("cron 0 8 * * * x", saturday, chicago).next;

    assert.deepEqual(
        [iso(saturday), iso(after)],
        ["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z"],
    );

    // A day field that starts with `*` leaves the days to the other: Mondays that fall on an odd day.
    assert.equal(next("cron 0 9 */2 * 1 x", Date.UTC(2026, 9, 6))[0], "2026-10-19T14:00:00.000Z");
    // Minutes close together in one hour are fine when the next hour is not one of its hours.
    assert.equal(next("cron 0,55 8 * * * x")[0], "2026-10-05T13:00:00.000Z");

    for (const [text, problem] of [
        ["cron */5 * * * * x", /at most every 10 minutes/],
        ["cron 0 8 30 2 */1 x", /No day matches/],
        ["cron 0,55 * * * * x", /at most every 10 minutes/],
        // 23:58, then 00:00 the next day.
        ["cron 0,58 0,23 * * * x", /at most every 10 minutes/],
        ["cron 0 8 * *", /five fields/],
        ["cron 0 25 * * * x", /not a valid cron hour/],
        ["cron 0 8 * * funday x", /not a valid cron day of the week/],
        ["cron 0 9 30 2 * x", /No day matches/],
        ["cron 9-1 * * * * x", /not a valid cron minute/],
        ["cron */0 * * * * x", /not a valid cron minute/],
    ] as const) {
        assert.throws(() => parseWhen(text, sunday, chicago), problem, text);
    }
});

/** A message that says "fail" stops with an error, one that says "ramble" at the output limit; anything else is echoed. */
const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    return text.includes("fail")
        ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "Bad request" })
        : text.includes("ramble")
          ? fauxAssistantMessage([fauxText("and then, and then, and")], { stopReason: "length" })
          : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const model = scriptedModel(route);
const dataDir = join(root, "routines-data");
let app: App;
/** How far ahead of the real time the server's clock is. */
let ahead = 0;

before(async () => {
    app = await openApp(model, dataDir);
});

after(async () => {
    await app?.close();
    cleanUp();
});

const items = async (id: ConversationId) =>
    Object.values((await app.harness.snapshot(ScheduleDoc, id, context))?.items ?? {});

async function settled(id: ConversationId, scheduleId: string) {
    let runs: RunOutcome[] = [];

    await until(async () => {
        runs = (await app.commands.scheduleRuns(id, owner(app)))[scheduleId] ?? [];

        return runs.length > 0 && runs.every((run) => run.status !== "running");
    }, "the runs to settle");

    return runs;
}

test("run now sends at once, keeps the next time, and remembers what came of it", async () => {
    const id = await newSession(app);
    const routine = await app.commands.schedule(id, owner(app), {
        when: "cron 0 8 * * 1-5 summarize the inbox",
        zone: chicago,
    });

    await app.commands.runSchedule(id, owner(app), routine.id);
    const [run] = await settled(id, routine.id);

    assert.equal(run?.status, "done");
    assert.equal(run?.now, true);

    const [after] = await items(id);

    assert.equal(after?.next, routine.next, "the next time stays");
    assert.equal(after?.runs, 0, "a run now is not one of its times");
    await assert.rejects(app.commands.runSchedule(id, owner(app), "nope"), { status: 404 });

    const viewer = app.config.addUser("Vic", "viewer").user;

    await assert.rejects(app.commands.runSchedule(id, viewer, routine.id), { status: 403 });
});

test("run now goes out as whoever set it up, and only when it may go out at its time too", async () => {
    const id = await newSession(app);
    const gus = app.config.addUser("Gus", "guest").user;
    const his = await app.commands.schedule(id, gus, { when: "every day 7:00 from Gus" });

    await app.commands.runSchedule(id, owner(app), his.id);
    const [sent] = (await items(id))[0]!.history!;

    assert.ok(sent!.requestId.startsWith(`u:${gus.id}:`), "Gus's, as his text says");
    assert.equal((await settled(id, his.id))[0]?.status, "done");

    app.config.updateUser(gus.id, { role: "viewer" });
    await assert.rejects(app.commands.runSchedule(id, owner(app), his.id), {
        status: 409,
        message: /can no longer steer/,
    });
});

/** Pushes while `body` runs, with their urgency. */
async function pushes(
    body: (sent: { message: PushMessage; urgency: string | undefined }[]) => Promise<void>,
) {
    const store = app.pushStore!;
    const sent: { message: PushMessage; urgency: string | undefined }[] = [];
    const { notify, subscriptions } = store;

    store.notify = async (_userId, message, options) => {
        sent.push({ message, urgency: options?.urgency });

        return 1;
    };

    store.subscriptions = () => [{ endpoint: "https://push.example.net/1" }] as never;

    try {
        await body(sent);
    } finally {
        store.notify = notify;
        store.subscriptions = subscriptions;
    }
}

const routineFailed = (sent: { message: PushMessage }[]) =>
    sent.find((each) => each.message.title.startsWith("Routine failed"));

test("a routine with no model to ask fails, and says so", async () => {
    // Made while nobody had picked a model: it has none.
    const picked = app.config.lastModel;

    app.config.lastModel = undefined;
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    app.config.lastModel = picked;

    await pushes(async (sent) => {
        const routine = await app.commands.schedule(id, owner(app), { when: "every day 6:00 x" });

        await app.commands.runSchedule(id, owner(app), routine.id);
        assert.equal((await settled(id, routine.id))[0]?.status, "failed");
        await until(() => routineFailed(sent) !== undefined, "the push");
        assert.match(routineFailed(sent)!.message.body, /“x”: its model is not available here/);
    });
});

test("a routine whose answer the output limit cut is done, and says it was cut (rakazo #2342)", async () => {
    const id = await newSession(app);
    const routine = await app.commands.schedule(id, owner(app), {
        when: "every day 8:00 ramble on",
    });
    const plain = await app.commands.schedule(id, owner(app), { when: "every day 8:30 short" });

    await app.commands.runSchedule(id, owner(app), routine.id);
    assert.deepEqual(
        (({ status, cut }) => ({ status, cut }))((await settled(id, routine.id))[0]!),
        { status: "done", cut: true },
    );
    await app.commands.runSchedule(id, owner(app), plain.id);
    assert.equal((await settled(id, plain.id))[0]?.cut, undefined);
});

test("a routine that fails says so in its runs and pushes Routine failed", async () => {
    const id = await newSession(app);

    await pushes(async (sent) => {
        const routine = await app.commands.schedule(id, owner(app), {
            when: "every day 7:00 fail on purpose",
            zone: chicago,
        });
        const plain = await app.commands.schedule(id, owner(app), {
            when: "every day 9:00 all good",
            zone: chicago,
        });

        await app.commands.runSchedule(id, owner(app), routine.id);
        const [run] = await settled(id, routine.id);

        assert.equal(run?.status, "failed");
        assert.match(run?.error ?? "", /Bad request/);
        await until(
            () => sent.some((each) => each.message.title.startsWith("Routine failed")),
            "the push",
        );

        const push = sent.find((each) => each.message.title.startsWith("Routine failed"))!;

        assert.match(push.message.body, /“fail on purpose”: Bad request/);
        assert.equal(push.urgency, "high");

        // Another routine of the session that went well is not the one that failed.
        await app.commands.runSchedule(id, owner(app), plain.id);
        assert.equal((await settled(id, plain.id))[0]?.status, "done");

        // A person's own message that fails is no routine's.
        sent.length = 0;
        await app.commands.submit(id, owner(app), {
            text: "please fail now",
            requestId: crypto.randomUUID(),
        });
        await until(
            () => sent.some((each) => each.message.title.startsWith("Pi stopped with an error")),
            "the plain error push",
        );
        assert.ok(!sent.some((each) => each.message.title.startsWith("Routine failed")));
    });
});

test("a routine's own times are remembered too, a few at most", async () => {
    const id = await newSession(app);
    const routine = await app.commands.schedule(id, owner(app), {
        when: "cron 0,30 * * * * tick",
        zone: "UTC",
    });

    // Past its time, after a restart: it goes out, and that run is remembered.
    await app.close();
    ahead += 31 * 60_000;
    const offset = ahead;

    app = await openApp(model, dataDir, () => Date.now() + offset);
    await until(async () => (await items(id))[0]?.runs === 1, "the routine to go out");

    const [run] = await settled(id, routine.id);

    assert.equal(run?.status, "done");
    assert.equal(run?.now, undefined);

    for (let each = 0; each < 12; each++) {
        await app.commands.runSchedule(id, owner(app), routine.id);
    }

    assert.equal((await items(id))[0]?.history?.length, 10);
});

test("a one-time scheduled message that fails pushes too, though it is gone once sent", async () => {
    const id = await newSession(app);

    await app.commands.schedule(id, owner(app), { when: "in 10m fail later", zone: "UTC" });
    await app.close();
    ahead += 11 * 60_000;
    const offset = ahead;

    app = await openApp(model, dataDir, () => Date.now() + offset);
    await pushes(async (sent) => {
        await until(() => routineFailed(sent) !== undefined, "the push");
        assert.match(routineFailed(sent)!.message.body, /A scheduled message: Bad request/);
    });
});
