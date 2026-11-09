// The boot screen says when the app could not start: a file a blocker stopped, or a web file that fails as it runs (a
// syntax error saved while editing the app from inside itself), instead of staying on "starting".
import { type App, cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App | undefined;
let server: Server | undefined;
let browsers: Browsers | undefined;
let base = "";
/** How the next load of one module goes wrong: blocked, or saved with a syntax error. */
let broken: { path: string; how: "blocked" | "syntax" } | null = null;

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    const handle = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        if (broken !== null && request.url?.startsWith(broken.path)) {
            if (broken.how === "blocked") {
                response.writeHead(403).end();
            } else {
                response
                    .writeHead(200, {
                        "content-type": "text/javascript",
                        "cache-control": "no-store",
                    })
                    .end("export const half = ;\n");
            }

            return;
        }

        void handle(request, response);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "boot-failure-ui-")),
        load: async () => undefined,
        save: () => {},
    });
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function bootDetail(page: BrowserPage): Promise<string> {
    let detail = "";

    await until(async () => {
        detail = JSON.parse(
            await page.evaluate(
                `JSON.stringify(document.querySelector(".boot.failed .boot-detail")?.textContent ?? "")`,
            ),
        ) as string;

        return detail !== "";
    }, "the boot screen to say the app could not start");

    return detail;
}

test(
    "a file of the app that a blocker stops shows on the boot screen (pi-pocket 35c340c5)",
    real,
    async () => {
        broken = { path: "/splitter.js", how: "blocked" };
        const page = await browsers!.open(1);

        await page.navigate(`${base}/`);
        assert.match(await bootDetail(page), /did not load/);
        assert.equal(
            JSON.parse(
                await page.evaluate(
                    `JSON.stringify(document.querySelector(".boot-caption").textContent)`,
                ),
            ),
            "could not start",
        );
    },
);

test("a web file saved with a syntax error says so, not 'starting' for good", real, async () => {
    broken = { path: "/splitter.js", how: "syntax" };
    const page = await browsers!.open(2);

    await page.navigate(`${base}/`);
    assert.match(await bootDetail(page), /did not load|failed/);
});

test(
    "an app that starts shows no failure, even after an error it survives (pi-pocket ad35b595)",
    real,
    async () => {
        broken = null;
        const page = await browsers!.open(3);

        await page.navigate(`${base}/`);
        await until(
            async () =>
                JSON.parse(
                    await page.evaluate(
                        `JSON.stringify(document.querySelector("#app > .boot") === null)`,
                    ),
                ) as boolean,
            "the app to replace the boot screen",
        );
        await page.evaluate(`setTimeout(() => { throw new Error("later"); }); 1`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(
            JSON.parse(
                await page.evaluate(
                    `JSON.stringify(document.querySelector(".boot.failed") !== null)`,
                ),
            ),
            false,
        );
    },
);
