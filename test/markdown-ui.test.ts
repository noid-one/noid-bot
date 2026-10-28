import {
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
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
import { createHandler } from "../src/server/http.ts";
import { renderMarkdown } from "../src/server/http/artifacts.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
// Deep enough to run marked out of stack (rakazo #2489), even on Linux Chromium's 8 MB main thread (Node's ~1 MB, as on
// Windows and phones, gives out near 3000): quotes in quotes, then a plain line after.
const DEEP = `${">".repeat(60_000)} deep\n\nafter`;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let id: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(
        scriptedModel((request) =>
            lastText(request as never).text.includes("ramble")
                ? fauxAssistantMessage([fauxText("and then, and")], { stopReason: "length" })
                : fauxAssistantMessage([fauxText(DEEP)]),
        ),
    );
    id = await newSession(app);
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
        dataDir: mkdtempSync(join(root, "markdown-ui-")),
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

test("a Markdown artifact that nests too deeply shows as written", async () => {
    const html = await renderMarkdown(DEEP);

    assert.ok(
        html.startsWith('<pre style="white-space:pre-wrap">&#62;&#62;&#62;'),
        html.slice(0, 80),
    );
    assert.ok(html.endsWith("deep\n\nafter</pre>"), html.slice(-80));
    assert.equal(html.includes("<blockquote"), false);
    assert.equal(await renderMarkdown("# Title"), "<h1>Title</h1>\n");
});

test(
    "a reply that nests too deeply shows as written, and the transcript still draws",
    real,
    async () => {
        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/s/${Number(id)}`);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
                ),
            "the message box",
            20_000,
        );
        await page.type({ selector: ".composer textarea" }, "nest");
        await page.press("Enter");
        await until(
            async () =>
                await inPage<boolean>(`
                const plain = document.querySelector(".reply .md-plain");

                return JSON.stringify(plain !== null && plain.textContent.endsWith("deep\\n\\nafter"));
            `),
            "the reply, as written",
            60_000,
        ).catch(async (error: unknown) => {
            const seen = await page.evaluate(`
            return JSON.stringify({
                path: location.pathname,
                replies: document.querySelectorAll(".reply").length,
                quotes: document.querySelectorAll(".reply blockquote").length,
                md: document.querySelector(".reply .md")?.outerHTML.slice(0, 300),
                classes: [...document.querySelectorAll(".reply *")].map((n) => n.className).filter(Boolean).slice(0, 30),
            });
        `);

            throw new Error(`${String(error)}: ${seen}`);
        });

        const shown = await inPage<{ asked: boolean; quotes: number; wraps: string }>(`
        const plain = document.querySelector(".reply .md-plain");

        return JSON.stringify({
            asked: [...document.querySelectorAll(".transcript *")].some((node) => node.textContent === "nest"),
            quotes: document.querySelectorAll(".reply blockquote").length,
            wraps: getComputedStyle(plain).whiteSpace,
        });
    `);

        assert.deepEqual(shown, { asked: true, quotes: 0, wraps: "pre-wrap" });
    },
);

test("a reply the output limit cut says so under its words (rakazo #2342)", real, async () => {
    await page.type({ selector: ".composer textarea" }, "ramble");
    await page.press("Enter");
    await until(
        async () =>
            await inPage<boolean>(`
                return JSON.stringify(
                    [...document.querySelectorAll(".reply .muted.small")].some(
                        (note) => note.textContent === "Cut off at the model's output limit.",
                    ),
                );
            `),
        "the cut note",
        20_000,
    );
});
