import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    root,
    scriptedModel,
    showSessions,
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
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const BOX = ".composer textarea";
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let one: ConversationId;
let two: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** The session `id` open with its message box, a few frames on: by then the box has the focus if it takes it. */
async function opened(id: ConversationId): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(
                    location.pathname === "/s/${Number(id)}" &&
                        store.state.view.conversation?.id === ${Number(id)} &&
                        document.querySelector(${JSON.stringify(BOX)}) !== null,
                );
            `),
        `session ${id} open`,
    );
    await page.evaluate(`
        for (let frame = 0; frame < 6; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    `);
}

/** The session list, loaded afresh at `viewport`. */
async function home(viewport: Viewport): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/`);
    await showSessions(page);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.session-row[data-id="${Number(one)}"]') !== null)`,
            ),
        "the session list",
        20_000,
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    one = await newSession(app);
    two = await newSession(app);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "composer-focus-ui-")),
        load: async () => undefined,
        save: () => {},
        // A mouse, whatever this machine has; the phone size's touch emulation still makes it a touch screen.
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "recall uses this session for arrows and search, and Down restores the draft",
    real,
    async () => {
        await home(VIEWPORTS.desktop);

        for (const [id, text] of [
            [one, "recall A marker"],
            [two, "recall B marker"],
        ] as const) {
            await page.navigate(`${base}/s/${Number(id)}`);
            await opened(id);
            await page.type({ selector: BOX }, text);
            await page.press("Enter");
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(document.querySelector('${BOX}').value === '')`,
                    ),
                "message sent",
            );
        }

        await page.navigate(`${base}/s/${Number(one)}`);
        await opened(one);
        await page.type({ selector: BOX }, "draft");
        await page.press("Home");
        await page.press("ArrowUp");
        const value = () =>
            inPage<string>(`return JSON.stringify(document.querySelector('${BOX}').value)`);

        assert.equal(await value(), "recall A marker");
        await page.press("ArrowDown");
        assert.equal(await value(), "draft");
        await page.type({ selector: BOX }, "recall");
        await page.press("Control+R");
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.history-options') !== null)`,
                ),
            "recall search open",
        );
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll('.history-options [role="option"]')].map(each => each.textContent.trim()))`,
            ),
            ["recall A marker"],
        );
        await page.press("Escape");
    },
);

test("words typed while a message sends stay in the box (rakazo 11aaeeb52)", real, async () => {
    await home(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${Number(two)}`);
    await opened(two);
    // A slow send: the person types on before it ends.
    await page.evaluate(`
        const { actions } = await import("/store.js");
        const submit = actions.submit;

        window.__released = false;
        actions.submit = async (...args) => {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            actions.submit = submit;
            window.__released = true;

            return submit(...args);
        };
    `);
    await page.type({ selector: BOX }, "slow send marker");
    await page.press("Enter");
    await page.type({ selector: BOX }, " and more", { append: true });
    await until(() => inPage<boolean>(`return JSON.stringify(window.__released)`), "send ended");
    await page.evaluate(`
        for (let frame = 0; frame < 30; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    `);
    assert.equal(
        await inPage<string>(`return JSON.stringify(document.querySelector('${BOX}').value)`),
        "and more",
    );
});

/** Hold the answer to the next message send until `window.__release()`; `lose`: it reaches the server, its answer does not. */
async function holdSend(lose = false): Promise<void> {
    await page.evaluate(`
        const { actions } = await import("/store.js");
        const submit = actions.submit;

        window.__sent = [];
        window.__done = false;
        let release;
        const held = new Promise((resolve) => (release = resolve));

        window.__release = release;
        actions.submit = async (...args) => {
            window.__sent.push(args[4]);
            actions.submit = submit;
            // A slow network: the request goes now, its answer comes when released.
            const going = submit(...args);

            try {
                await held;
                const answer = await going;

                if (${lose}) {
                    throw new Error("The answer was lost.");
                }

                return answer;
            } finally {
                window.__done = true;
            }
        };
    `);
}

const boxValue = () =>
    inPage<string>(`return JSON.stringify(document.querySelector('${BOX}')?.value ?? null)`);

async function frames(n = 30): Promise<void> {
    await page.evaluate(`
        for (let frame = 0; frame < ${n}; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    `);
}

/** How many of the person's messages in `id` hold `marker`. */
async function messagesWith(id: ConversationId, marker: string): Promise<number> {
    const entries = await app.transcripts.allEntries(id, true);

    return entries.filter(
        (entry) => entry.kind === "user" && JSON.stringify(entry).includes(marker),
    ).length;
}

test(
    "words put in while a message sends follow the sent ones, which leave without their end spaces (pi-pocket 6043bfd0)",
    real,
    async () => {
        await home(VIEWPORTS.desktop);
        await page.navigate(`${base}/s/${Number(two)}`);
        await opened(two);
        await holdSend();
        await page.type({ selector: BOX }, "end space marker ");
        await page.press("Enter");
        await page.evaluate(`
        const { insertIntoComposer } = await import("/store.js");

        insertIntoComposer("> quoted");
    `);
        await until(
            async () => (await boxValue()) === "end space marker\n\n> quoted",
            "the insert",
        );
        await page.evaluate(`window.__release()`);
        await until(() => inPage<boolean>(`return JSON.stringify(window.__done)`), "send ended");
        await frames();
        assert.equal(await boxValue(), "> quoted");
    },
);

test(
    "a message whose answer was lost goes once when sent again (pi-pocket de882e72)",
    real,
    async () => {
        await home(VIEWPORTS.desktop);
        await page.navigate(`${base}/s/${Number(one)}`);
        await opened(one);
        await holdSend(true);
        await page.type({ selector: BOX }, "lost answer marker");
        await page.press("Enter");
        await page.evaluate(`window.__release()`);
        await until(() => inPage<boolean>(`return JSON.stringify(window.__done)`), "send ended");
        await frames();
        assert.equal(
            await boxValue(),
            "lost answer marker",
            "the words stay: it may not have gone",
        );

        // Sent again, with the same request id: the server gives back the first send.
        const first = await inPage<string[]>(`return JSON.stringify(window.__sent)`);

        await holdSend();
        await page.press("Enter");
        await page.evaluate(`window.__release()`);
        await until(() => inPage<boolean>(`return JSON.stringify(window.__done)`), "sent again");
        await until(async () => (await boxValue()) === "", "the box empties");
        assert.deepEqual(await inPage<string[]>(`return JSON.stringify(window.__sent)`), first);
        await app.harness.waitForIdle(context);
        await until(
            async () => (await messagesWith(one, "lost answer marker")) >= 1,
            "the message",
        );
        assert.equal(await messagesWith(one, "lost answer marker"), 1, "one message, not two");
    },
);

test(
    "a session left and come back to while its message sends waits for it, and keeps its files (pi-pocket f5d693ee, rakazo c13a8ea50)",
    real,
    async () => {
        await home(VIEWPORTS.desktop);
        await page.navigate(`${base}/s/${Number(one)}`);
        await opened(one);
        await holdSend();
        await page.type({ selector: BOX }, "switch marker");
        await page.press("Enter");

        // Away to two, a draft there; a file added in one before coming back stays.
        await page.evaluate(`
        const { navigate } = await import("/store.js");

        navigate(${Number(two)});
    `);
        await opened(two);
        await page.type({ selector: BOX }, "two's draft");
        await page.evaluate(`
        const { navigate } = await import("/store.js");

        navigate(${Number(one)});
    `);
        await opened(one);
        assert.equal(await boxValue(), "switch marker", "still on its way");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.composer button[aria-label="Send"]')?.disabled ?? true)`,
            ),
            true,
            "Send waits for it",
        );
        await page.evaluate(`
        const { insertIntoComposer } = await import("/store.js");

        insertIntoComposer("", [new File(["kept"], "kept.txt", { type: "text/plain" })]);
    `);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.composer .chip-name')?.textContent === "kept.txt")`,
                ),
            "the file",
        );
        await page.evaluate(`
        const { navigate } = await import("/store.js");

        navigate(${Number(two)});
    `);
        await opened(two);
        await page.evaluate(`window.__release()`);
        await until(() => inPage<boolean>(`return JSON.stringify(window.__done)`), "send ended");
        await frames();
        assert.equal(await boxValue(), "two's draft", "the other session's draft is its own");
        await page.evaluate(`
        const { navigate } = await import("/store.js");

        navigate(${Number(one)});
    `);
        await opened(one);
        assert.equal(await boxValue(), "", "the words that went left");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('.composer .chip-name')?.textContent ?? null)`,
            ),
            "kept.txt",
            "the file added meanwhile stays",
        );
        await until(async () => (await messagesWith(one, "switch marker")) >= 1, "the message");
        assert.equal(await messagesWith(one, "switch marker"), 1);
    },
);

test("signing out forgets the unsent words (pi-pocket 62d89658)", real, async () => {
    await home(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${Number(two)}`);
    await opened(two);
    await page.type({ selector: BOX }, " secret draft", { append: true });
    assert.notEqual(
        await inPage<string | null>(
            `return JSON.stringify(localStorage.getItem("pocket.draft.${Number(two)}"))`,
        ),
        null,
    );
    await page.evaluate(`
        const { signOut } = await import("/store.js");

        await signOut();
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Object.keys(localStorage).every((key) => !/^pocket\\.(?:draft|pastes|sendRequest)\\./.test(key)))`,
            ).catch(() => false),
        "drafts forgotten",
    );
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});
