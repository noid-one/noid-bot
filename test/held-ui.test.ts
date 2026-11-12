// What a Stop held shows over the message box (Pi Pocket 53f1a942): Show lists it, Edit takes one back into the box,
// Send sends what is held.
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
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { HeldDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script));
const bar = () =>
    inPage<string | null>(
        `return JSON.stringify(document.querySelector('[data-part="held"]')?.textContent ?? null)`,
    );
/** Click the button in the held bar whose words are `label`. */
const click = (label: string) =>
    inPage<boolean>(`
        const button = [...document.querySelectorAll('[data-part="held"] button')].find(
            (each) => each.textContent.trim() === ${JSON.stringify(label)},
        );
        button?.click();
        return JSON.stringify(button !== undefined);
    `);
const held = async (id: ConversationId) =>
    (await app.harness.snapshot(HeldDoc, id, context))?.items ?? [];

/** Queue `text` behind a long answer, then Stop: it is held. */
async function hold(id: ConversationId, text: string) {
    await app.commands.submit(id, owner(app), {
        text: "stream a long answer",
        requestId: crypto.randomUUID(),
    });
    await until(() => app.isBusy(id), "the run to start");
    await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });
    await app.commands.abort(id, owner(app));
    await until(async () => !app.isBusy(id) && (await held(id)).length === 1, "it held");
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(
        scriptedModel((context) => {
            const { text } = lastText(context as never);

            return text.includes("stream a long answer")
                ? fauxAssistantMessage([fauxText("word ".repeat(8000))])
                : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
        }),
    );
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "held-ui-")),
        load: async () => undefined,
        save: () => {},
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
    "the held bar lists a held message, Edit takes it into the box, Send sends one",
    real,
    async () => {
        const id = await newSession(app);

        await hold(id, "take me back");
        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/s/${id}`);
        await until(async () => (await bar()) !== null, "the held bar", 20_000);
        assert.match((await bar()) ?? "", /1 message held\./);

        // Show lists it, with who wrote it; Edit takes it back into the box and out of the held list.
        assert.ok(await click("Show"));
        await until(async () => /take me back/.test((await bar()) ?? ""), "the held list");
        assert.match((await bar()) ?? "", /Queue · you/);
        assert.ok(await click("Edit"));
        await until(
            async () =>
                (await inPage<string>(
                    `return JSON.stringify(document.querySelector('[data-part="composer"] textarea')?.value ?? "")`,
                )) === "take me back",
            "the words in the box",
        );
        await until(async () => (await bar()) === null, "the bar to go");
        assert.deepEqual(await held(id), []);

        // Held again: Send sends it, and the bar goes.
        await hold(id, "send me now");
        await until(async () => (await bar()) !== null, "the held bar again", 20_000);
        assert.ok(await click("Send"));
        await until(async () => (await bar()) === null, "the bar to go after Send");
        await until(
            async () =>
                (await app.transcripts.allEntries(id, true)).some(
                    (entry) => entry.kind === "user" && entry.text.includes("send me now"),
                ),
            "the held message sent",
        );
    },
);
