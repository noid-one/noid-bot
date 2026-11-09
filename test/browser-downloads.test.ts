// noid: a bot's page saves what it downloads in the bot's own Downloads folder, and its call says where (after rakazo
// 5c99a28d4). The shared browser is played by a Chromium on this machine, so no Docker is needed.
import { root } from "./env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Browsers } from "../src/server/browser.ts";
import { Chromium } from "../src/server/browser/cdp.ts";
import createBrowser from "../src/server/extensions/browser.ts";
import type { PocketHost } from "../src/server/host.ts";
import { findBrowser, profileFolder } from "../src/server/browser/discovery.ts";
import {
    DOWNLOADS_UNUSABLE,
    downloadLines,
    downloadName,
    saveDownloads,
} from "../src/server/browser/downloads.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let server: Server;
let browsers: Browsers;
let base = "";
let shared = "";
let bot = "";
let page = 0;

before(async () => {
    if (chromium === undefined) {
        return;
    }

    server = createServer((request, response) => {
        if (request.url === "/file") {
            response.writeHead(200, {
                "content-type": "application/pdf",
                "content-disposition": 'attachment; filename="state$ment;.pdf"',
            });
            response.end("%PDF-1.4 statement");

            return;
        }

        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<a id="get" href="/file">Get the statement</a>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(root, "browser-downloads-"));

    shared = join(dir, "shared", "downloads");
    bot = join(dir, "bots", "b1");
    mkdirSync(shared, { recursive: true });
    mkdirSync(bot, { recursive: true });
    browsers = new Browsers({
        dataDir: dir,
        load: async () => undefined,
        save: () => {},
        remote: {
            claims: () => true,
            launch: () => Chromium.launch(chromium, profileFolder(chromium, dir), []),
            downloadPath: shared,
        },
    });
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
});

/** Save the page's downloads since `after` into `folder`, as a call of the browser tool does. */
const save = async (opened: Awaited<ReturnType<Browsers["open"]>>, folder: string, after = 0) =>
    saveDownloads(opened, {
        env: new NodeExecutionEnv({ cwd: bot }),
        folder,
        source: shared,
        after,
        startedAt: Date.now(),
        context: BACKGROUND_CONTEXT,
    });

test(
    "a click that downloads saves the file in the bot's Downloads folder and says where",
    real,
    async () => {
        const opened = await browsers.open(++page);
        const folder = join(bot, "Downloads");

        await opened.navigate(base);
        await opened.click({ selector: "#get" });
        const first = await save(opened, folder);

        assert.deepEqual(first.saved, [
            { name: "state_ment_.pdf", path: join(folder, "state_ment_.pdf"), size: 18 },
        ]);
        assert.equal(readFileSync(join(folder, "state_ment_.pdf"), "utf8"), "%PDF-1.4 statement");
        assert.deepEqual(readdirSync(shared), [], "moved out of the shared folder");
        assert.match(downloadLines(first.saved).join("\n"), /state_ment_\.pdf \(18 bytes\)/);

        // The same file again: the first is not written over, and what the last call told of is not told again.
        await opened.click({ selector: "#get" });
        const second = await save(opened, folder, first.seq);

        assert.deepEqual(
            second.saved.map((file) => file.name),
            ["state_ment_ (1).pdf"],
        );
        assert.deepEqual((await save(opened, folder, second.seq)).saved, []);
    },
);

test(
    "the browser tool's click lists what it downloaded, with its path in the bot's folder",
    real,
    async () => {
        const id = ++page;
        // A bot of its own, whose Downloads folder is not there yet.
        const cwd = join(bot, "..", "b3");

        mkdirSync(cwd);
        const host = { browsers, onHost: () => false, botOf: () => "b1" } as unknown as PocketHost;
        const tool = createBrowser(host).tools![0]!;
        const api = {
            conversationId: id,
            env: new NodeExecutionEnv({ cwd }),
            snapshot: async () => ({ cwd }),
        };
        const call = (args: Record<string, unknown>) =>
            tool.execute(args as never, api as never, BACKGROUND_CONTEXT) as Promise<{
                output: { type: string; text?: string }[];
                details: { downloads?: { path?: string }[] };
            }>;

        await call({ action: "navigate", url: base });
        const clicked = await call({ action: "click", selector: "#get" });
        const text = clicked.output[0]!.text!;
        const path = join(cwd, "Downloads", "state_ment_.pdf");

        assert.match(text, /Downloaded, into your Downloads folder:/);
        assert.ok(text.includes(`- ${path} (18 bytes)`), text);
        assert.deepEqual(
            clicked.details.downloads?.map((file) => file.path),
            [path],
        );
        assert.equal(readFileSync(path, "utf8"), "%PDF-1.4 statement");
    },
);

test("an address that is a file is downloaded, not an error", real, async () => {
    const opened = await browsers.open(++page);
    const folder = join(bot, "Navigated");
    const result = await opened.navigate(`${base}/file`);

    assert.deepEqual(result, { download: true });
    assert.equal((await save(opened, folder)).saved[0]?.path, join(folder, "state_ment_.pdf"));
});

test("a Downloads folder reached through a link refuses the download", real, async () => {
    const elsewhere = join(bot, "..", "b2");
    const folder = join(bot, "Linked");

    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, folder);
    const opened = await browsers.open(++page);

    await opened.navigate(base);
    await opened.click({ selector: "#get" });

    assert.deepEqual((await save(opened, folder)).saved, [
        { name: "state_ment_.pdf", error: DOWNLOADS_UNUSABLE },
    ]);
    assert.deepEqual(readdirSync(elsewhere), [], "nothing in the other bot's folder");

    for (const name of readdirSync(shared)) {
        rmSync(join(shared, name));
    }
});

test("a site's name for a file becomes one plain segment", () => {
    assert.equal(downloadName("../../.bashrc"), "_.._.bashrc");
    assert.equal(downloadName("a$(rm -rf ~)`x`.txt"), "a_(rm -rf ~)_x_.txt");
    assert.equal(downloadName("  report\n2026.pdf  "), "report 2026.pdf");
    assert.equal(downloadName("..."), "download");
    assert.equal(downloadName(""), "download");
    assert.equal(downloadName(`${"x".repeat(200)}.pdf`), `${"x".repeat(76)}.pdf`);
});
