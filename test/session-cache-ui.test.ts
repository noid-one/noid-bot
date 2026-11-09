// Sessions a browser keeps, in a tab's memory and on the device (`web/store.js`, `web/session-cache.js`; pi-pocket
// 6ea6d3e5, 3cabe340, 2cf83526, e4d66262): one gone back to shows at once and the server sends only what is new, it
// ends as a fresh load has it, and nothing of it outlasts another run of the server or a sign-out.
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
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import type { Client } from "../src/server/room.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** What each connection said it had of its session, as the server read it (`Client.have`). */
const attached: { id: number | null; have: string | null }[] = [];

before(async () => {
    if (findBrowser() === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    const attach = app.attach.bind(app);

    app.attach = (client: Client) => {
        attached.push({
            id: client.conversationId === undefined ? null : Number(client.conversationId),
            have:
                client.have === undefined
                    ? null
                    : `${client.have.from}.${client.have.count}.${client.have.key}.${client.have.build}`,
        });

        return attach(client);
    };

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "session-cache-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** Go to a session from inside the app, as a session row does. */
const goTo = (id: ConversationId | null) =>
    page.evaluate(`(await import("/store.js")).navigate(${id === null ? "null" : Number(id)})`);

/** Wait until the transcript shows `text`. */
const shown = (text: string) =>
    until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify((document.querySelector('[data-part="transcript"]')?.textContent ?? "").includes(${JSON.stringify(text)}))`,
            ),
        text,
        15_000,
    );

/** Wait until the tab has the session shown whole, on an open connection: as it keeps it. */
const settled = () =>
    until(
        async () =>
            await inPage<boolean>(`
                const { store } = await import("/store.js");
                const { view } = store.state;

                return JSON.stringify(store.state.connection === "open" && view.conversation?.id === store.state.conversationId &&
                    view.build === store.state.server?.build && ![...view.entries.values()].some((each) => each.partial));
            `),
        "the session, whole",
        15_000,
    );

/** The sessions the device keeps, by id. */
const onDevice = () =>
    inPage<number[]>(`
        const { list } = await import("/session-cache.js");

        return JSON.stringify((await list()).map((each) => each.id));
    `);

type Shown = { order: number[]; entries: Record<string, unknown>[] };

/** The session the page shows, as its store has it: the order, and each entry it has, in that order. */
const pageView = () =>
    inPage<Shown>(`
        const { store } = await import("/store.js");
        const { view } = store.state;

        return JSON.stringify({ order: view.order, entries: view.order.filter((id) => view.entries.has(id)).map((id) => view.entries.get(id)) });
    `);

/** The session as a tab that kept nothing gets it, every entry whole (protocol 2). */
async function freshView(id: ConversationId): Promise<Shown> {
    const tab = fakeTab(id, owner(app), 2);

    await app.attach(tab.client);
    await until(() => tab.events.some((each) => each.event === "view"), "a fresh view");
    app.detach(tab.client);
    const view = tab.events.find((each) => each.event === "view")!.data as {
        order: number[];
        entries: { id: number }[];
    };

    return { order: view.order, entries: view.entries };
}

/** The page shows what a fresh load shows: the same order, and each entry it has the same as the server's. */
async function sameAsFresh(id: ConversationId, what: string): Promise<void> {
    const [mine, fresh] = [await pageView(), await freshView(id)];
    const byId = new Map(fresh.entries.map((each) => [(each as { id: number }).id, each]));

    assert.deepEqual(mine.order, fresh.order, `${what}: the order`);
    assert.ok(mine.entries.length > 0, `${what}: some entries`);

    for (const entry of mine.entries) {
        assert.deepEqual(entry, byId.get((entry as { id: number }).id), `${what}: an entry`);
    }
}

test(
    "a session gone back to shows at once, the server sends only what came while away, and it ends as a fresh load",
    real,
    async () => {
        const [first, other] = [await newSession(app), await newSession(app)];

        await say(app, first, "kept here");
        await page.navigate(`${base}/s/${first}`);
        await shown("kept here");
        await settled();
        await goTo(other);
        await settled();
        await say(app, first, "new while away");

        const back = await inPage<{
            drawn: boolean;
            asked: string;
            views: { orderFrom: number | null; entries: string[] }[];
        }>(`
        const { navigate, store } = await import("/store.js");
        const Source = window.EventSource;
        const views = [];
        let asked = "";

        window.EventSource = class extends Source {
            constructor(url) {
                super(url);
                asked = String(url);
                this.addEventListener("view", (event) => {
                    const data = JSON.parse(event.data);

                    views.push({ orderFrom: data.orderFrom ?? null, entries: data.entries.map((each) => each.text ?? each.kind) });
                });
            }
        };

        try {
            navigate(${Number(first)});
            // What the switch put in the store before any event came: the kept session.
            const drawn = views.length === 0 && store.state.view.conversation?.id === ${Number(first)} &&
                [...store.state.view.entries.values()].some((each) => each.text === "kept here");
            const until = Date.now() + 5000;

            while (!views.some((each) => each.entries.includes("new while away")) && Date.now() < until) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }

            return JSON.stringify({ drawn, asked, views });
        } finally {
            window.EventSource = Source;
        }
    `);

        assert.ok(back.drawn, "the kept session shows before the server answers");
        assert.match(
            back.asked,
            /&have=\d+\.\d+\.[0-9a-z]+\.[0-9a-f]{16}/,
            "the tab says what it kept",
        );
        assert.ok(back.views[0]!.orderFrom! > 0, "the view goes on from what the tab kept");
        assert.deepEqual(
            back.views.flatMap((each) => each.entries),
            ["new while away", "assistant"],
            "only what came while away",
        );
        await shown("new while away");
        await settled();
        await sameAsFresh(first, "back");
    },
);

test(
    "a reset while away: the whole session comes again, and the page is as a fresh load",
    real,
    async () => {
        const [first, other] = [await newSession(app), await newSession(app)];

        await say(app, first, "before the reset");
        await page.navigate(`${base}/s/${first}`);
        await shown("before the reset");
        await settled();
        await goTo(other);
        await settled();
        await app.commands.reset(first, owner(app), undefined);
        await say(app, first, "after the reset");
        attached.length = 0;
        await goTo(first);
        await shown("after the reset");
        await settled();
        assert.ok(attached[0]?.have !== null, "the tab named what it kept");
        await sameAsFresh(first, "after a reset");
    },
);

test(
    "a session kept on the device shows after a reload; another person's, another run's, or none when the server says so",
    real,
    async () => {
        const session = await newSession(app);

        const reload = async () => {
            attached.length = 0;
            await page.reload();
            await until(() => attached.length > 0, "a connection after the reload");

            return attached[0]!;
        };

        try {
            await say(app, session, "kept on the device");
            await page.navigate(`${base}/s/${session}`);
            await shown("kept on the device");
            await settled();
            // Saved a few seconds after it settles.
            await until(
                async () => (await onDevice()).includes(Number(session)),
                "saved on the device",
                15_000,
            );
            await say(app, session, "new since the reload");

            // A reload: the tab's memory is gone, so what it says it has came from the device.
            const again = await reload();

            assert.equal(again.id, Number(session), "the connection names the session");
            assert.match(again.have ?? "", new RegExp(`\\.${app.build}$`), "what the device kept");
            await shown("new since the reload");
            await settled();
            await sameAsFresh(session, "after a reload");

            // Another person's (here: the record says so): not shown, and not named to the server.
            await inPage(`
            const disk = await import("/session-cache.js");
            const found = await disk.read(${Number(session)});

            await disk.save(${Number(session)}, found.record, { ...found.info, owner: "someone else" }, 1e9);

            return "true";
        `);
            assert.equal((await reload()).have, null, "another person's is not used");
            await settled();
            await until(
                async () => (await onDevice()).includes(Number(session)),
                "saved again",
                15_000,
            );

            // Another run of the server (a restart): what the device kept is neither shown nor named, and it goes.
            const build = app.build;

            (app as { build: string }).build =
                build === "0".repeat(16) ? "1".repeat(16) : "0".repeat(16);

            try {
                assert.equal((await reload()).have, null, "another run's is not used");
                await settled();
                await sameAsFresh(session, "after a restart");
            } finally {
                (app as { build: string }).build = build;
            }

            // The server keeps sessions out of devices: what was kept goes, and nothing is saved.
            await reload();
            await settled();
            process.env.PI_POCKET_SESSION_CACHE = "off";
            await reload();
            await shown("new since the reload");
            await until(async () => (await onDevice()).length === 0, "nothing on the device");
            await new Promise((resolve) => setTimeout(resolve, 4000));
            assert.deepEqual(await onDevice(), [], "nothing saved");
            assert.equal((await reload()).have, null, "nothing named");
        } finally {
            delete process.env.PI_POCKET_SESSION_CACHE;
        }
    },
);

test(
    "a restart under an open tab: entries it had from the run before go, as other entries may have their ids",
    real,
    async () => {
        const session = await newSession(app);

        // More rows than a first view brings, so the tab holds entries a full view does not send again.
        for (let n = 1; n <= 45; n++) {
            await say(app, session, `row ${n}`);
        }

        await page.navigate(`${base}/s/${session}`);
        await shown("row 45");
        await settled();
        // Earlier messages loaded, and the oldest made into what another run would have under its id.
        await inPage(`
        const { loadEarlier, store } = await import("/store.js");

        await loadEarlier();
        const { view } = store.state;
        const oldest = view.order.find((id) => view.entries.get(id)?.kind === "user");
        const entries = new Map(view.entries);

        entries.set(oldest, { ...entries.get(oldest), text: "another run's words" });
        store.set({ view: { ...view, entries } });

        return "true";
    `);
        assert.ok(
            await inPage<boolean>(`
            const { store } = await import("/store.js");

            return JSON.stringify([...store.state.view.entries.values()].some((each) => each.text === "another run's words"));
        `),
        );
        const build = app.build;

        (app as { build: string }).build =
            build === "0".repeat(16) ? "1".repeat(16) : "0".repeat(16);

        try {
            attached.length = 0;
            server.closeAllConnections();
            await until(() => attached.length > 0, "the tab connects again");
            await until(
                async () =>
                    await inPage<boolean>(`
                    const { store } = await import("/store.js");

                    return JSON.stringify(store.state.view.run === ${JSON.stringify(app.build)} && store.state.connection === "open");
                `),
                "the view of the new run",
            );
            await new Promise((resolve) => setTimeout(resolve, 300));
            assert.equal(
                await inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify([...store.state.view.entries.values()].some((each) => each.text === "another run's words"));
            `),
                false,
                "nothing of the run before stays",
            );
            await sameAsFresh(session, "after a restart under the tab");
        } finally {
            (app as { build: string }).build = build;
        }
    },
);

/**
 * Keep on the device what it kept of session `from` as if it were session `to`'s: a copy the page may show for `to`
 * only if it checks it, with words of `from`'s alone.
 */
const keptAs = (from: ConversationId, to: number) =>
    inPage(`
        const disk = await import("/session-cache.js");
        const found = await disk.read(${Number(from)});
        const view = { ...found.record.view, conversation: { ...found.record.view.conversation, id: ${to} } };

        await disk.save(${to}, { ...found.record, view }, found.info, 1e9);

        return "true";
    `);

/** Leave session `id` for the list, and wait until the device keeps it. */
async function keptOnDevice(id: ConversationId): Promise<void> {
    await goTo(null);
    await until(async () => (await onDevice()).includes(Number(id)), "saved on the device", 15_000);
}

type Switch = { waited: number; asked: string; painted: boolean };

/**
 * Go to session `id` from inside the app, with `setUp` run first and `tearDown` after: how long it took to connect, what
 * the connection asked for, and whether the page ever showed `foreign` in it, up to `watchMs` after.
 */
const switchTo = (id: number, foreign: string, setUp: string, tearDown: string, watchMs: number) =>
    inPage<Switch>(`
        const { navigate, store } = await import("/store.js");
        const Source = window.EventSource;
        let at = 0;
        let asked = "";
        let painted = false;

        window.EventSource = class extends Source {
            constructor(url) {
                super(url);
                at ||= performance.now();
                asked ||= String(url);
            }
        };
        const stop = store.subscribe((state) => {
            painted ||= state.view.conversation?.id === ${id} &&
                [...state.view.entries.values()].some((each) => each.text === ${JSON.stringify(foreign)});
        });
        ${setUp}
        const started = performance.now();

        try {
            navigate(${id});

            while (at === 0 && performance.now() - started < 5000) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }

            await new Promise((resolve) => setTimeout(resolve, ${watchMs}));

            return JSON.stringify({ waited: Math.round(at - started), asked, painted });
        } finally {
            window.EventSource = Source;
            stop();
            ${tearDown}
        }
    `);

test(
    "a device slow to answer does not hold a switch back, and what it brings late is not shown",
    real,
    async () => {
        const [elsewhere, slow] = [await newSession(app), await newSession(app)];

        await say(app, elsewhere, "words from elsewhere");
        await say(app, slow, "the slow one's own");
        await page.navigate(`${base}/s/${elsewhere}`);
        await shown("words from elsewhere");
        await settled();
        await keptOnDevice(elsewhere);
        await keptAs(elsewhere, Number(slow));

        // Every transaction of the device answers a second after it is done: past the switch's wait (400 ms).
        const slowed = await switchTo(
            Number(slow),
            "words from elsewhere",
            `
            const transaction = IDBDatabase.prototype.transaction;

            IDBDatabase.prototype.transaction = function (...args) {
                const made = transaction.apply(this, args);
                let then;

                made.addEventListener("complete", () => setTimeout(() => then?.(), 1000));
                Object.defineProperty(made, "oncomplete", { set: (f) => { then = f; }, get: () => then });

                return made;
            };
            `,
            `IDBDatabase.prototype.transaction = transaction;`,
            1400,
        );

        assert.ok(slowed.waited < 700, `connected after ${slowed.waited} ms`);
        assert.doesNotMatch(slowed.asked, /&have=/, "nothing named, as nothing was kept in time");
        assert.equal(slowed.painted, false, "the device's late copy is not shown");
        await shown("the slow one's own");
        await settled();
        await sameAsFresh(slow, "after a slow device");
    },
);

test("a session the list does not have is not shown from the device", real, async () => {
    const source = await newSession(app);
    const unlisted = 99_999;

    await say(app, source, "not for an unlisted session");
    await page.navigate(`${base}/s/${source}`);
    await shown("not for an unlisted session");
    await settled();
    await keptOnDevice(source);
    await keptAs(source, unlisted);
    assert.ok(
        await inPage<boolean>(
            `return JSON.stringify((await import("/store.js")).store.state.sessionsLoaded)`,
        ),
        "the list is in",
    );

    const went = await switchTo(unlisted, "not for an unlisted session", "", "", 300);

    assert.doesNotMatch(went.asked, /&have=/, "nothing named");
    assert.equal(went.painted, false, "the device's copy is not shown");
    await goTo(null);
});

test(
    "a subagent of a listed session, never in the list itself, is shown from the device",
    real,
    async () => {
        const source = await newSession(app);
        const subagent = 99_998;

        await say(app, source, "kept for a subagent");
        await page.navigate(`${base}/s/${source}`);
        await shown("kept for a subagent");
        await settled();
        await keptOnDevice(source);
        await keptAs(source, subagent);
        await goTo(source);
        await shown("kept for a subagent");
        // Its session's subagents bar names it, as the server's view of the session does.
        await page.evaluate(`
        const { store } = await import("/store.js");
        const { view } = store.state;

        store.set({ view: { ...view, subagents: [{ name: "helper", conversationId: ${subagent}, busy: false }] } });
    `);

        const went = await switchTo(subagent, "kept for a subagent", "", "", 300);

        assert.match(went.asked, /&have=/, "what the device kept is named");
        assert.ok(went.painted, "the device's copy is shown");
        await goTo(null);
    },
);

test(
    "storage that is full: the older sessions kept go, and the save goes through",
    real,
    async () => {
        const kept = await inPage<{ saved: boolean; ids: number[] }>(`
        const disk = await import("/session-cache.js");
        const ids = [90_001, 90_002, 90_003];
        const info = { owner: "test", build: "test", size: 10 };

        // Only these three kept, oldest first.
        await disk.clear();

        for (const id of ids) {
            await disk.save(id, { view: id }, info, 1e9);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        // The next save finds the storage full, once, as browsers tell it: its requests go through, and then its
        // transaction aborts with the error.
        const getAll = IDBObjectStore.prototype.getAll;
        let full = true;

        IDBObjectStore.prototype.getAll = function (...args) {
            const request = getAll.apply(this, args);
            const transaction = this.transaction;

            if (full && transaction.mode === "readwrite" && transaction.objectStoreNames.contains("views")) {
                full = false;
                request.addEventListener("success", () => {
                    const error = new DOMException("The storage is full", "QuotaExceededError");

                    Object.defineProperty(transaction, "error", { value: error });
                    transaction.abort();
                });
            }

            return request;
        };

        let saved = true;

        try {
            await disk.save(90_004, { view: 90_004 }, info, 1e9);
        } catch {
            saved = false;
        } finally {
            IDBObjectStore.prototype.getAll = getAll;
        }

        const left = (await disk.list()).map((each) => each.id).filter((id) => id >= 90_000);

        await disk.drop((each) => each.id >= 90_000);

        return JSON.stringify({ saved, ids: left.sort() });
    `);

        assert.ok(kept.saved, "the save went through");
        assert.deepEqual(kept.ids, [90_003, 90_004], "the older half of the others went");
    },
);

test(
    "a device that never answers holds a switch back only a moment, and is not waited for again",
    real,
    async () => {
        const [first, second, third] = [
            await newSession(app),
            await newSession(app),
            await newSession(app),
        ];

        await say(app, first, "before it stops answering");
        await page.navigate(`${base}/s/${first}`);
        await shown("before it stops answering");
        await settled();

        // Dropping the database makes the page let go of its connection, so its next use opens it again: an open that
        // never answers, as some browsers' do.
        await inPage(`
            await new Promise((resolve) => {
                const request = indexedDB.deleteDatabase("pocket-sessions");

                request.onsuccess = request.onerror = request.onblocked = resolve;
            });

            return "true";
        `);
        const hang = `
            const open = IDBFactory.prototype.open;

            window.opens ??= 0;
            IDBFactory.prototype.open = function () {
                window.opens++;

                return {};
            };
        `;
        const restore = `IDBFactory.prototype.open = open;`;

        try {
            const once = await switchTo(Number(second), "", hang, restore, 0);

            assert.ok(once.waited < 700, `the first switch connected after ${once.waited} ms`);
            // Past the open's own wait (a second): it has failed, for good.
            await new Promise((resolve) => setTimeout(resolve, 1200));

            const again = await switchTo(Number(third), "", hang, restore, 0);

            assert.ok(again.waited < 100, `the next switch connected after ${again.waited} ms`);
            assert.equal(
                await inPage<number>(`return JSON.stringify(window.opens)`),
                1,
                "one open",
            );
        } finally {
            // A fresh page, with the device as it was.
            await page.navigate(`${base}/`);
        }
    },
);

test(
    "a device slow to open its storage, not stuck: once it answers, the cache is used",
    real,
    async () => {
        const late = await inPage<{ first: string; second: string; saved: string; opens: number }>(`
        // A copy of the module of its own, so the app's is left as it is.
        const disk = await import("/session-cache.js?late-open");
        const open = IDBFactory.prototype.open;
        let opens = 0;

        // Every open answers 1.3 s on: past the module's wait (a second), as a slow phone's may.
        IDBFactory.prototype.open = function (...args) {
            opens++;
            const request = open.apply(this, args);
            const slow = { get result() { return request.result; }, get error() { return request.error; } };

            request.onupgradeneeded = (event) => slow.onupgradeneeded?.(event);
            request.onerror = (event) => slow.onerror?.(event);
            request.onsuccess = (event) => setTimeout(() => slow.onsuccess?.(event), 1300);

            return slow;
        };

        const outcome = (promise) => promise.then(() => "ok", (error) => error.message);

        try {
            const first = await outcome(disk.read(90_100));

            await new Promise((resolve) => setTimeout(resolve, 600));

            return JSON.stringify({
                first,
                second: await outcome(disk.read(90_100)),
                saved: await outcome(disk.save(90_100, { view: 1 }, { owner: "test", build: "test", size: 1 }, 1e9)),
                opens,
            });
        } finally {
            IDBFactory.prototype.open = open;
            await disk.drop((each) => each.id === 90_100).catch(() => {});
        }
    `);

        assert.equal(late.first, "The session cache did not open", "not waited for past a second");
        assert.equal(late.second, "ok", "read once it answered");
        assert.equal(late.saved, "ok", "saved once it answered");
        assert.equal(late.opens, 1, "the open that answered late is the one used");
    },
);

test(
    "two tabs of a browser share what the device keeps; a sign-out in one stops the other's saves",
    real,
    async () => {
        const [shared, other] = [await newSession(app), await newSession(app)];

        await say(app, shared, "seen in the first tab");
        await say(app, other, "elsewhere");
        await page.navigate(`${base}/s/${shared}`);
        await shown("seen in the first tab");
        await settled();
        await goTo(other);
        await settled();
        // To the list: nothing shown is saved, and what was left is saved now.
        await goTo(null);
        await until(
            async () => {
                const kept = await onDevice();

                return kept.includes(Number(shared)) && kept.includes(Number(other));
            },
            "saved on the device",
            15_000,
        );
        await say(app, shared, "new for the second tab");

        // A second tab of the same browser: a frame of the app, with the same storage, opened on the session.
        attached.length = 0;
        await inPage(`
            const frame = document.createElement("iframe");

            frame.id = "second";
            frame.src = "/s/${Number(shared)}";
            frame.style.cssText = "width: 800px; height: 600px";
            document.body.append(frame);

            return "true";
        `);
        const inSecond = (text: string) =>
            inPage<boolean>(`
                const doc = document.getElementById("second").contentDocument;

                return JSON.stringify((doc?.querySelector('[data-part="transcript"]')?.textContent ?? "").includes(${JSON.stringify(text)}));
            `);

        await until(() => attached.some((each) => each.id === Number(shared)), "its connection");
        assert.match(
            attached.find((each) => each.id === Number(shared))!.have ?? "",
            new RegExp(`\\.${app.build}$`),
            "the second tab names what the first kept",
        );
        await until(() => inSecond("seen in the first tab"), "the kept session, in the second tab");
        await until(() => inSecond("new for the second tab"), "what came since, in the second tab");

        // The first tab signs out (here: only its word to the others, the storage event, and the device emptied): the
        // second, leaving the session, saves nothing more.
        await inPage(`
            localStorage.setItem("pocket.signedOut", String(Date.now()));
            await (await import("/session-cache.js")).clear();

            return "true";
        `);
        await inPage(`
            const win = document.getElementById("second").contentWindow;

            win.history.pushState(null, "", "/s/${Number(other)}");
            win.dispatchEvent(new win.PopStateEvent("popstate", { state: null }));

            return "true";
        `);
        await until(() => inSecond("elsewhere"), "the other session, in the second tab");
        await new Promise((resolve) => setTimeout(resolve, 4500));
        assert.deepEqual(await onDevice(), [], "nothing saved after the sign-out");
        await inPage(`document.getElementById("second").remove(); return "true";`);
    },
);

test("a session left just before signing out is not saved on the device after", real, async () => {
    const [first, second] = [await newSession(app), await newSession(app)];

    await say(app, first, "private words");
    await page.navigate(`${base}/s/${first}`);
    await shown("private words");
    await settled();
    // Leave it, and sign out before its save, while the server takes its time to answer the sign-out.
    const during = await inPage<number[]>(`
        const store = await import("/store.js");
        const fetched = fetch;

        globalThis.fetch = async (url, options) => {
            if (String(url).endsWith("/logout")) {
                await new Promise((resolve) => setTimeout(resolve, 2500));
            }

            return fetched(url, options);
        };
        store.navigate(${Number(second)});
        void store.signOut();
        // Past the save planned as it left, while the sign-out is still on its way.
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return JSON.stringify((await (await import("/session-cache.js")).list()).map((each) => each.id));
    `);

    await until(
        async () => await inPage<boolean>(`return JSON.stringify(location.pathname === "/")`),
        "signed out",
    );
    assert.deepEqual(during, [], "nothing saved while the sign-out is on its way");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.deepEqual(await onDevice(), [], "nothing of the person's sessions on the device");
});
