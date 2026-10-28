// Images sent to a model that cannot see them (rakazo #1996): Send asks first, "Send as files" sends them as files the
// model can open, "Change model" opens the picker, and a model that sees images is not asked about.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
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

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const faux = scriptedModel();
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

// faux-2 takes text only, as many models do; faux-vision takes images.
for (const model of faux.models) {
    if (model.id === "faux-2") {
        model.input = ["text"];
    }
}

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Session `id` open, with a one-pixel PNG dropped into its message box and uploaded. */
async function withImage(id: ConversationId, text: string): Promise<void> {
    await page.navigate(`${base}/s/${Number(id)}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
            ),
        "the message box",
        20_000,
    );
    await page.type({ selector: ".composer textarea" }, text);
    await page.evaluate(`
        const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
        const data = new DataTransfer();

        data.items.add(new File([png], "dot.png", { type: "image/png" }));
        document.querySelector(".composer").dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
        return "null";
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".composer .chip") !== null && document.querySelector(".composer .chip .spinner") === null)`,
            ),
        "the image uploaded",
        20_000,
    );
}

/** What the session's messages from the owner say, and how many images went along inline. */
async function userEntries(id: ConversationId) {
    return (await app.transcripts.allEntries(id, true))
        .filter((entry) => entry.kind === "user")
        .map((entry) => {
            const user = entry as unknown as { text: string; images?: number };

            return { text: user.text, images: user.images ?? 0 };
        });
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(faux);
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
        dataDir: mkdtempSync(join(root, "image-warning-ui-")),
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

test(
    "an image for a model that cannot see it asks first, and goes as a file when told to",
    real,
    async () => {
        const id = await newSession(app);

        await app.commands.configure(id, app.config.users[0]!, {
            model: { provider: "faux", modelId: "faux-2" },
            thinkingLevel: "off",
        });
        await withImage(id, "what is in this picture?");
        await page.click({ selector: '[aria-label="Send"]' });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".image-warning") !== null)`,
                ),
            "the warning",
        );
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".image-warning").textContent)`,
            ),
            /faux-2 cannot see images: they go as files it can open, not look at\.\s*Send as filesChange model/,
        );
        assert.deepEqual(await userEntries(id), [], "nothing sent yet");

        // Change model opens the picker; closing it leaves the message as it was.
        await page.click({ selector: ".image-warning .button" });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".model-menu") !== null)`,
                ),
            "the model picker",
        );
        await page.press("Escape");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".model-menu") === null)`,
                ),
            "the picker to close",
        );

        // The picker leaves with an animation, and the box moves back as it goes: Send as files is pressed once it is
        // uncovered and stays where it is.
        let last = "";

        await until(async () => {
            const now = await inPage<string>(`
            const button = document.querySelector(".image-warning .link");
            const box = button.getBoundingClientRect();
            const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button;

            return JSON.stringify(top ? \`\${box.x},\${box.y}\` : "");
        `);
            const still = now !== "" && now === last;

            last = now;
            await new Promise((resolve) => setTimeout(resolve, 150));

            return still;
        }, "the warning uncovered and still");
        await page.click({ selector: ".image-warning .link" });
        await until(async () => (await userEntries(id)).length === 1, "the message, sent");

        const [sent] = await userEntries(id);

        assert.equal(sent!.images, 0, "no image inline");
        assert.match(
            sent!.text,
            /what is in this picture\?\n\nAttached files \(saved on the server\):\n- .*dot\.png/,
        );
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".image-warning") === null && document.querySelector(".composer .chip") === null)`,
                ),
            "the box emptied and the warning gone",
        );
    },
);

test("a model that sees images is not asked about", real, async () => {
    const id = await newSession(app);

    await app.commands.configure(id, app.config.users[0]!, {
        model: { provider: "faux", modelId: "faux-vision" },
        thinkingLevel: "off",
    });
    await withImage(id, "and this one?");
    await page.click({ selector: '[aria-label="Send"]' });
    await until(async () => (await userEntries(id)).length === 1, "the message, sent at once");
    assert.equal((await userEntries(id))[0]!.images, 1, "the image went inline");
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector(".image-warning") !== null)`,
        ),
        false,
    );
});
