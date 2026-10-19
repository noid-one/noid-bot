// Two weeks of routines across bots, in a few seconds: the server restarts once a simulated day with its clock that
// much further ahead, and every routine goes out once a day it is due, never twice, never missed, with a failing one
// pushing "Routine failed" each time. Phase 5's exit asks for two weeks of real use; this is the same run sped up.
import {
    type App,
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ScheduleDoc } from "../src/server/docs.ts";
import type { PushMessage } from "../src/server/push.ts";

const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    return text.includes("flaky")
        ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "Bad request" })
        : fauxAssistantMessage([fauxText(`done: ${text.slice(0, 60)}`)]);
};

const model = scriptedModel(route);
const dataDir = join(root, "soak-data");
let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

const DAY = 24 * 60 * 60_000;
/** Monday, October 5, 2026, 06:00 UTC: the first simulated morning, before any routine is due. */
const start = Date.UTC(2026, 9, 5, 6);

async function openAt(at: number): Promise<App> {
    const offset = at - Date.now();

    return openApp(model, dataDir, () => Date.now() + offset, { mainBot: true });
}

async function sentTexts(app: App, id: ConversationId): Promise<string[]> {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        1000,
        undefined,
        context,
    );

    return page.items
        .filter((entry) => entry.kind === "pi.user")
        .map((entry) => JSON.stringify(entry.model));
}

test("two simulated weeks of daily routines across bots: each goes out once a day it is due", async () => {
    app = await openAt(start);
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };

    const bot = async (name: string) => {
        const { id } = await app!.bots.create(owner(app!), { name, kind: "host", folder: work });

        await app!.commands.configure(id, owner(app!), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
        });

        return id;
    };

    const noid = app.bots.list().find((each) => each.bot.main)!.conversationId;

    await app.commands.configure(noid, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    const scribe = await bot("Scribe");
    const scout = await bot("Scout");
    const plan = [
        { id: noid, when: "every day 8:00 brief me on the bots", per: "daily" },
        { id: scribe, when: "cron 30 7 * * 1-5 write the standup notes", per: "weekdays" },
        { id: scout, when: "every day 9:00 check the flaky feed", per: "daily" },
    ] as const;

    for (const each of plan) {
        await app.commands.schedule(each.id, owner(app), { when: each.when, zone: "UTC" });
    }

    let failures = 0;

    for (let day = 1; day <= 14; day++) {
        await app.close();
        // Noon of each day: every routine of the morning is due.
        app = await openAt(start + (day - 1) * DAY + 6 * 60 * 60_000);

        const store = app.pushStore!;

        store.subscriptions = () => [{ endpoint: "https://push.example.net/1" }] as never;

        store.notify = async (_userId: string, message: PushMessage) => {
            failures += message.title.startsWith("Routine failed") ? 1 : 0;

            return 1;
        };

        const expected = (per: string) =>
            Array.from({ length: day }, (_, index) =>
                new Date(start + index * DAY).getUTCDay(),
            ).filter((each) => per === "daily" || (each >= 1 && each <= 5)).length;

        for (const each of plan) {
            await until(
                async () =>
                    Object.values(
                        (await app!.harness.snapshot(ScheduleDoc, each.id, context))!.items,
                    )[0]!.runs === expected(each.per),
                `day ${day}: ${each.when}`,
            );
        }

        await app.harness.waitForIdle(context);
        await until(() => failures === day, `day ${day}: the flaky routine's push`);
    }

    // Two weeks: 14 daily briefs, 10 weekday standups, 14 failed checks each pushed once, and nothing sent twice.
    const count = async (id: ConversationId, word: string) =>
        (await sentTexts(app!, id)).filter((text) => text.includes(word)).length;

    assert.equal(await count(noid, "brief me on the bots"), 14);
    assert.equal(await count(scribe, "write the standup notes"), 10);
    assert.equal(await count(scout, "check the flaky feed"), 14);
    assert.equal(failures, 14);

    const outcomes = await app.commands.scheduleRuns(scout, owner(app));

    assert.deepEqual(
        Object.values(outcomes)[0]!.map((run) => run.status),
        Array.from({ length: 10 }, () => "failed"),
        "the last ten runs, all failed, all remembered",
    );
});
