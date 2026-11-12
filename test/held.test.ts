// Stop holds the queue (Pi Pocket 53f1a942): queued messages wait in HeldDoc until someone sends them, each still its
// author's; its sender edits it back into the box, its sender or the driver withdraws it.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    openApp,
    owner as ownerOf,
    scriptedModel,
    newSession as startSession,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { HeldDoc } from "../src/server/docs.ts";

const faux = scriptedModel((context) => {
    const { text } = lastText(context as never);

    // About 5 s of streaming at the scripted model's 2000 tokens a second: time to queue behind it.
    if (text.includes("stream a long answer")) {
        return fauxAssistantMessage([fauxText("word ".repeat(8000))]);
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
});

let app: App;
const owner = () => ownerOf(app);
const newSession = () => startSession(app);

/** What Pi was sent and answered, in the transcript's order. */
async function texts(id: ConversationId): Promise<string> {
    const entries = await app.transcripts.allEntries(id, true);

    return entries
        .flatMap((entry) =>
            entry.kind === "user"
                ? [entry.text]
                : entry.kind === "assistant"
                  ? entry.blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))
                  : [],
        )
        .join("\n");
}

before(async () => {
    app = await openApp(faux);
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("Stop holds queued follow-ups and steers, and sends nothing until someone sends them", async () => {
    const id = await newSession();

    await app.commands.submit(id, owner(), { text: "stream a long answer", requestId: "sc-1" });
    await until(() => app.isBusy(id), "the run to start");
    const followUp = await app.commands.submit(id, owner(), {
        text: "held follow-up",
        requestId: "sc-2",
    });
    const steer = await app.commands.submit(id, owner(), {
        text: "held steer",
        mode: "steer",
        requestId: "sc-3",
    });

    await app.commands.abort(id, owner());
    await until(() => !app.isBusy(id), "the run to stop");
    assert.equal((await app.harness.snapshot(InboxDoc, id, context))!.items.length, 0);

    for (const { submissionId } of [followUp, steer]) {
        const record = await (await app.harness.submission(submissionId, context))!.status(context);

        assert.equal(record.status, "unanswered");
        assert.equal("reason" in record ? record.reason : undefined, "aborted");
    }

    const held = (await app.harness.snapshot(HeldDoc, id, context))!.items;

    assert.deepEqual(
        held.map((item) => [item.mode, item.by]),
        [
            ["followUp", owner().id],
            ["steer", owner().id],
        ],
    );
    assert.doesNotMatch(await texts(id), /held follow-up|held steer/);

    assert.equal(await app.commands.sendHeld(id, owner()), 2);
    await until(async () => /echo: .*held steer/.test(await texts(id)), "the held ones answered");
    await until(() => !app.isBusy(id), "their answers");
    const all = await texts(id);

    assert.ok(all.indexOf("held follow-up") < all.indexOf("held steer"), "in their order");
    assert.equal(all.match(/echo: .*held follow-up/g)?.length, 1, "sent once");
    assert.deepEqual((await app.harness.snapshot(HeldDoc, id, context))!.items, []);
    assert.equal(await app.commands.sendHeld(id, owner()), 0, "nothing left to send");
});

test("a held message is withdrawn by its sender or the driver, and edited by its sender only", async () => {
    const id = await newSession();
    const guest = app.config.addUser("Held guest", "guest").user;

    try {
        await app.commands.submit(id, owner(), { text: "stream a long answer", requestId: "hd-1" });
        await until(() => app.isBusy(id), "the run to start");
        await app.commands.submit(id, owner(), { text: "owner's held", requestId: "hd-2" });
        await app.commands.submit(id, guest, { text: "guest's held", requestId: "hd-3" });
        await app.commands.abort(id, guest);
        await until(() => !app.isBusy(id), "the run to stop");
        const [mine, theirs] = (await app.harness.snapshot(HeldDoc, id, context))!.items;

        assert.equal(theirs!.by, guest.id);
        await assert.rejects(app.commands.editHeld(id, owner(), theirs!.key), /Only its sender/);
        await assert.rejects(app.commands.editHeld(id, guest, mine!.key), /Only its sender/);

        const back = await app.commands.editHeld(id, guest, theirs!.key);

        assert.equal(back.text, "guest's held");
        await assert.rejects(app.commands.editHeld(id, guest, theirs!.key), /no longer held/);
        // The owner drives: they withdraw anyone's.
        await app.commands.dropHeld(id, owner(), mine!.key);
        assert.deepEqual((await app.harness.snapshot(HeldDoc, id, context))!.items, []);
        assert.doesNotMatch(await texts(id), /owner's held|guest's held/);
    } finally {
        app.config.removeUser(guest.id);
    }
});

test("the held messages show in the room, with who wrote them", async () => {
    const id = await newSession();
    const tab = fakeTab(id, owner(), 6);
    const held = () => (tab.field("held") ?? []) as { text: string; by?: string }[];

    await app.attach(tab.client);

    try {
        await app.commands.submit(id, owner(), { text: "stream a long answer", requestId: "hr-1" });
        await until(() => app.isBusy(id), "the run to start");
        await app.commands.submit(id, owner(), { text: "shown while held", requestId: "hr-2" });
        await app.commands.abort(id, owner());
        await until(() => held().length === 1, "the held message in a view");
        assert.match(held()[0]!.text, /shown while held/);
        assert.equal(held()[0]!.by, owner().id);
        await app.commands.sendHeld(id, owner());
        await until(() => held().length === 0, "an empty held list");
    } finally {
        app.detach(tab.client);
    }
});
