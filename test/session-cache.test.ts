// What a tab kept of a session it opened before (protocol 6, `have`): the server sends only what came after, and the
// whole view when what it kept no longer fits (`Room.push`, `PocketApp.build`; pi-pocket 6ea6d3e5, 2cf83526).
import {
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { ConversationId } from "@earendil-works/pi-durable";
import { keptPart } from "../src/server/http/events.ts";
import { fingerprint } from "../web/text-hash.js";

const faux = scriptedModel();
let app: App;

before(async () => {
    app = await openApp(faux);
    // Compaction keeps only the newest few messages as they are, so a short conversation has something to summarize.
    app.settings.getCompactionSettings = () => ({
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 50,
    });
});

after(async () => {
    await app?.close();
    cleanUp();
});

type Entry = { id: number; kind: string; text?: string; partial?: boolean };
type View = {
    full: boolean;
    conversation: { id: number };
    entries: Entry[];
    order?: number[];
    orderFrom?: number;
};
type Tab = ReturnType<typeof fakeTab>;
type Kept = { order: number[]; entries: Map<number, Entry> };

const views = (tab: Tab) =>
    tab.events.filter((each) => each.event === "view").map((each) => each.data as View);

/** Attach a tab, and wait for its first view and the whole entries that come right after a light one. */
async function opened(tab: Tab, on = app): Promise<void> {
    await on.attach(tab.client);
    await until(() => views(tab).length >= 1, "the first view");
    await until(
        () => ![...viewOf(tab).entries.values()].some((entry) => entry.partial === true),
        "the whole entries",
    );
}

/** What a tab has after its views, merged as `mergeView` in `web/store.js` merges them. */
function viewOf(tab: Tab, start: Kept = { order: [], entries: new Map() }): Kept {
    let order = start.order;
    let entries = new Map(start.entries);

    for (const view of views(tab)) {
        if (view.order !== undefined) {
            order =
                view.orderFrom === undefined
                    ? view.order
                    : order.slice(0, view.orderFrom).concat(view.order);
        }

        for (const entry of view.entries) {
            const had = entries.get(entry.id);

            if (!(entry.partial === true && had !== undefined && had.partial !== true)) {
                entries.set(entry.id, entry);
            }
        }

        const keep = new Set(order);

        entries = new Map([...entries].filter(([id]) => keep.has(id)));
    }

    return { order, entries };
}

/** What a tab names when it kept `kept` (`haveOf` in `web/store.js`), from `from` on. */
const haveOf = (kept: Kept, from = 0, build = app.build) => ({
    from,
    count: kept.order.length,
    key: fingerprint(kept.order.join(",")),
    build,
});

/** Open a session as a tab of protocol 6 that kept nothing, and what it then has. */
async function freshly(id: ConversationId): Promise<Kept> {
    const tab = fakeTab(id, owner(app), 6);

    await opened(tab);
    app.detach(tab.client);

    return viewOf(tab);
}

/**
 * A tab still open ends with what a fresh tab has. The fresh tab loads first: an update the room batches may still be on
 * its way to the open one, so it is waited for, and a tab that never gets there fails with the difference.
 */
async function endsAsFresh(tab: Tab, id: ConversationId, start: Kept, what: string): Promise<void> {
    const fresh = await freshly(id);

    await until(() => isDeepStrictEqual(viewOf(tab, start), fresh), what, 5_000).catch(() => {});
    assert.deepEqual(viewOf(tab, start), fresh, what);
}

/** The ids of every entry sent to a tab. */
const sent = (tab: Tab) =>
    views(tab).flatMap((view) => view.entries.filter((e) => e.partial !== true).map((e) => e.id));

test("a tab that kept a session gets only what came after, and ends with what a fresh tab has", async () => {
    const id = await newSession(app);

    for (let n = 1; n <= 3; n++) {
        await say(app, id, `message ${n}`);
    }

    const kept = await freshly(id);

    // Nothing new since: the view names where the order goes on, and brings nothing.
    const again = fakeTab(id, owner(app), 6);

    again.client.have = haveOf(kept);
    await opened(again);
    await new Promise((resolve) => setTimeout(resolve, 150));
    app.detach(again.client);
    const [none, ...rest] = views(again);

    assert.deepEqual(
        { full: none!.full, entries: none!.entries.length, order: none!.order },
        { full: true, entries: 0, order: [] },
    );
    assert.equal(none!.orderFrom, kept.order.length);
    assert.ok(rest.every((each) => each.entries.length === 0 && each.order === undefined));

    // A message while away: only its entries come, with their part of the order, and the tab ends as a fresh one.
    await say(app, id, "message 4");
    const later = fakeTab(id, owner(app), 6);

    later.client.have = haveOf(kept);
    await opened(later);
    const first = views(later)[0]!;

    assert.equal(first.orderFrom, kept.order.length);
    assert.deepEqual(
        sent(later).map((each) => kept.entries.has(each)),
        sent(later).map(() => false),
        "nothing it kept comes again",
    );
    assert.deepEqual(
        first.entries.map((entry) => entry.text ?? entry.kind),
        ["message 4", "assistant"],
    );
    await endsAsFresh(later, id, kept, "the same as a fresh tab's");

    // An update of a tab that has the order brings only the end of it, too.
    await say(app, id, "message 5");
    await until(
        () => views(later).some((each) => each.entries.some((e) => e.text === "message 5")),
        "the update with the message",
    );
    const update = views(later).find((each) => each.entries.some((e) => e.text === "message 5"))!;

    assert.equal(update.full, false);
    assert.equal(update.orderFrom, kept.order.length + 2);
    assert.ok(update.order!.length <= 2, `${update.order!.length} ids`);
    await endsAsFresh(later, id, kept, "still the same as a fresh tab's");
    app.detach(later.client);
});

test("an update still on its way when a fresh tab loads: the open tab ends with what the fresh one has", async () => {
    const id = await newSession(app);

    await say(app, id, "message 1");
    const kept = await freshly(id);
    const later = fakeTab(id, owner(app), 6);

    later.client.have = haveOf(kept);
    await opened(later);
    // A long reply: its last update is batched after the tab first hears of the message.
    await say(app, id, "message 2 " + "word ".repeat(1500));
    await until(
        () =>
            views(later).some((each) =>
                each.entries.some((e) => e.text?.startsWith("message 2") === true),
            ),
        "the update with the message",
    );
    await endsAsFresh(later, id, kept, "the same as a fresh tab's");
    app.detach(later.client);
});

test("what no longer fits gets the whole view: another order, too much, another run, older code", async () => {
    const id = await newSession(app);

    await say(app, id, "one");
    await say(app, id, "two");
    const kept = await freshly(id);

    for (const [what, have, protocol] of [
        ["another order", { ...haveOf(kept), key: "abc" }, 6],
        ["more than there is", { ...haveOf(kept), count: kept.order.length + 99 }, 6],
        ["from past the end", { ...haveOf(kept), from: kept.order.length + 1 }, 6],
        ["another run's", haveOf(kept, 0, app.build === "0" ? "1" : "0"), 6],
        ["older code", haveOf(kept), 5],
    ] as const) {
        const tab = fakeTab(id, owner(app), protocol);

        tab.client.have = have;
        await opened(tab);
        app.detach(tab.client);
        const whole = views(tab)[0]!;

        assert.equal(whole.orderFrom, undefined, what);
        assert.deepEqual(whole.order, kept.order, what);
        assert.deepEqual(viewOf(tab), kept, what);
    }
});

test("entries a tab kept only from a point on: the newest rows' ones it lacks come, none it has", async () => {
    const id = await newSession(app);

    for (let n = 1; n <= 3; n++) {
        await say(app, id, `part ${n}`);
    }

    const kept = await freshly(id);
    const part = fakeTab(id, owner(app), 6);
    const partial: Kept = {
        order: kept.order,
        entries: new Map([...kept.entries].filter(([each]) => kept.order.indexOf(each) >= 4)),
    };

    part.client.have = haveOf(kept, 4);
    await opened(part);
    app.detach(part.client);
    const got = new Set(sent(part));

    assert.equal(views(part)[0]!.orderFrom, kept.order.length);
    assert.ok(
        kept.order.slice(0, 4).every((each) => got.has(each)),
        "the ones it lacks",
    );
    assert.ok(
        kept.order.slice(4).every((each) => !got.has(each)),
        "none it has",
    );
    assert.deepEqual(viewOf(part, partial), kept);
});

test("a new context or a compaction while away: the order no longer starts with what the tab kept", async () => {
    const id = await newSession(app);

    await say(app, id, "before");
    const kept = await freshly(id);

    await app.commands.reset(id, owner(app), "carry on");
    await say(app, id, "after the reset");
    const reset = fakeTab(id, owner(app), 6);

    reset.client.have = haveOf(kept);
    await opened(reset);
    app.detach(reset.client);
    assert.equal(views(reset)[0]!.orderFrom, undefined, "a whole view");
    assert.deepEqual(viewOf(reset), await freshly(id), "as a fresh tab's");

    const before = await freshly(id);

    await app.commands.compact(id, owner(app), undefined);
    await until(
        async () => [...(await freshly(id)).entries.values()].some((e) => e.kind === "compaction"),
        "the compaction",
    );
    const compacted = fakeTab(id, owner(app), 6);

    compacted.client.have = haveOf(before);
    await opened(compacted);
    app.detach(compacted.client);
    assert.equal(views(compacted)[0]!.orderFrom, undefined, "a whole view");
    assert.deepEqual(viewOf(compacted), await freshly(id), "as a fresh tab's");
});

test("a fork while away leaves the session as it was, and the fork opens whole", async () => {
    const id = await newSession(app);

    await say(app, id, "to fork");
    const kept = await freshly(id);
    const last = [...kept.entries.values()].findLast((entry) => entry.kind === "assistant")!;
    const { id: fork } = await app.commands.fork(id, owner(app), { entryId: last.id });

    await say(app, fork, "only in the fork");
    const back = fakeTab(id, owner(app), 6);

    back.client.have = haveOf(kept);
    await opened(back);
    app.detach(back.client);
    assert.equal(views(back)[0]!.orderFrom, kept.order.length);
    assert.equal(sent(back).length, 0, "nothing came");
    assert.deepEqual(viewOf(back, kept), await freshly(id));

    // What the tab kept of the source, named on the fork, is the fork's own start: the same entries, by id.
    const forked = await freshly(fork);
    const onFork = fakeTab(fork, owner(app), 6);

    onFork.client.have = haveOf(kept);
    await opened(onFork);
    app.detach(onFork.client);
    const merged = viewOf(onFork, kept);

    assert.deepEqual(merged.order, forked.order);
    assert.deepEqual(
        [...merged.entries.values()].filter((each) => forked.entries.has(each.id)),
        [...forked.entries.values()].filter((each) => merged.entries.has(each.id)),
        "every entry it has is the fork's",
    );
});

test("a restart is another run: what a tab kept before it is not used, even with the same ids", async () => {
    const dataDir = join(root, "restart");
    let first = await openApp(faux, dataDir);
    const id = await newSession(first);

    await say(first, id, "kept before the restart");
    const tab = fakeTab(id, owner(first), 6);

    await opened(tab, first);
    first.detach(tab.client);
    const kept = viewOf(tab);
    const build = first.build;

    await first.close();
    first = await openApp(faux, dataDir);

    try {
        assert.notEqual(first.build, build, "each start is its own run");
        assert.match(first.build, /^[0-9a-f]{16}$/);
        const hello = await first.hello(owner(first));

        assert.equal(hello.server.build, first.build);
        assert.equal(hello.server.deviceCache, true, "on by default");
        process.env.PI_POCKET_SESSION_CACHE = "off";

        try {
            assert.equal((await first.hello(owner(first))).server.deviceCache, false);
        } finally {
            delete process.env.PI_POCKET_SESSION_CACHE;
        }

        const after = fakeTab(id, owner(first), 6);

        after.client.have = { ...haveOf(kept), build };
        await opened(after, first);
        first.detach(after.client);
        assert.equal(views(after)[0]!.orderFrom, undefined, "a whole view");
    } finally {
        await first.close();
    }
});

test("have is read only in its own form", () => {
    assert.deepEqual(keptPart("0.12.abc.0123456789abcdef"), {
        from: 0,
        count: 12,
        key: "abc",
        build: "0123456789abcdef",
    });

    for (const bad of [
        null,
        "",
        "1.2.abc",
        "1.2.ABC.00",
        "1.2.abc.xyz",
        "-1.2.abc.00",
        "1.2.abc.00.1",
    ]) {
        assert.equal(keptPart(bad), undefined, String(bad));
    }
});

test("access taken back while the room opens: nothing of the session goes to the tab", async () => {
    const id = await newSession(app);

    await say(app, id, "not for the guest any more");
    const guest = {
        id: "guest-cache",
        name: "Guest",
        role: "guest",
        sessions: [String(id)],
    } as never as Parameters<typeof fakeTab>[1];
    const room = app.room.bind(app);
    const tab = fakeTab(id, guest, 6);

    app.room = async (which) => {
        const opened = await room(which);

        (guest as { sessions: string[] }).sessions = [];

        return opened;
    };

    try {
        await app.attach(tab.client);
    } finally {
        app.room = room;
    }

    assert.equal(views(tab).length, 0, "no view");
    assert.equal(tab.last("missing")?.conversationId, id);
    assert.equal(tab.client.conversationId, undefined);
});
