// noid: a bot's page saves what it downloads in the bot's own Downloads folder, and its call says where (after rakazo
// 5c99a28d4). The shared browser is played by a Chromium on this machine, so no Docker is needed.
import { root } from "./env.ts";
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
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
    MAX_DOWNLOAD_BYTES,
    downloadName,
    nameDownload,
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
/** The first part of the `/slow` file: enough that the browser starts the download rather than waiting to see it. */
const FIRST = "first ".repeat(1000);

/** Ends the `/slow` file. */
let finishSlow = () => {};

before(async () => {
    if (chromium === undefined) {
        return;
    }

    server = createServer((request, response) => {
        // Two files of the same name: another bot's, or the owner's, statement.
        if (request.url === "/file" || request.url === "/other") {
            response.writeHead(200, {
                "content-type": "application/pdf",
                "content-disposition": 'attachment; filename="state$ment;.pdf"',
            });
            response.end(request.url === "/file" ? "%PDF-1.4 statement" : "%PDF-1.4 the other one");

            return;
        }

        // A file that says it is larger than a call may save, and sends a little of it.
        if (request.url === "/huge") {
            response.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-disposition": 'attachment; filename="huge.bin"',
                "content-length": String(MAX_DOWNLOAD_BYTES + 1),
            });
            response.write(Buffer.alloc(1024));

            return;
        }

        // A file that comes in two parts: the second once the test lets it go.
        if (request.url === "/slow") {
            response.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-disposition": 'attachment; filename="slow.txt"',
                "content-length": String(FIRST.length + 5),
            });
            response.write(FIRST);
            finishSlow = () => response.end("-last");

            return;
        }

        response.writeHead(200, { "content-type": "text/html" });
        response.end(
            `<a id="get" href="/file">Get the statement</a> <a id="other" href="/other">Get the other one</a> <a id="huge" href="/huge">Get it all</a> <a id="slow" href="/slow">Get it slowly</a>`,
        );
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
            downloadFiles: () => new NodeExecutionEnv({ cwd: shared }),
        },
    });
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
});

/** Wait until `check` holds: what the browser does with a file happens a moment after its events. */
async function until(check: () => boolean, what: string): Promise<void> {
    for (const started = Date.now(); !check(); await new Promise((done) => setTimeout(done, 20))) {
        if (Date.now() - started > 10_000) {
            throw new Error(`Timed out waiting for ${what}`);
        }
    }
}

/** Save the page's downloads since `after` into `folder`, as a call of the browser tool does. */
const save = async (
    opened: Awaited<ReturnType<Browsers["open"]>>,
    folder: string,
    after = 0,
    startedAt = Date.now(),
) =>
    saveDownloads(opened, {
        env: new NodeExecutionEnv({ cwd: bot }),
        folder,
        source: shared,
        after,
        startedAt,
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
    assert.deepEqual(
        readdirSync(shared),
        [],
        "not left in the shared folder, where every bot reads",
    );
});

test(
    "two bots' files of the same name each reach their own bot, and the owner's stays",
    real,
    async () => {
        // The owner's own statement, already in the shared folder: the browser saves each download under its guid.
        writeFileSync(join(shared, "state_ment_.pdf"), "the owner's");
        const one = await browsers.open(++page);
        const two = await browsers.open(++page);

        await one.navigate(base);
        await two.navigate(base);
        await one.click({ selector: "#get" });
        await two.click({ selector: "#other" });
        const first = await save(one, join(bot, "One"));
        const second = await save(two, join(bot, "Two"));

        assert.equal(readFileSync(first.saved[0]!.path!, "utf8"), "%PDF-1.4 statement");
        assert.equal(readFileSync(second.saved[0]!.path!, "utf8"), "%PDF-1.4 the other one");
        assert.equal(readFileSync(join(shared, "state_ment_.pdf"), "utf8"), "the owner's");
        assert.deepEqual(readdirSync(shared), ["state_ment_.pdf"]);
    },
);

test("a download that is no bot's gets the name its site gave it", real, async () => {
    const before = new Set(readdirSync(shared));
    const opened = await browsers.open(++page);

    await opened.navigate(base);
    // Tabs of their own, as the owner's on the computer's desktop: no page of Pi's began the downloads. Two of the
    // same name at once are named one after the other, so neither writes over the other.
    const other = JSON.stringify(`${base}/other`);

    await opened.evaluate(`window.open(${other}); 1`);
    await opened.evaluate(`window.open(${other}); 1`);
    await until(
        () =>
            readdirSync(shared).filter((name) => !before.has(name) && name.endsWith(".pdf"))
                .length === 2,
        "the owner's downloads",
    );

    const added = readdirSync(shared)
        .filter((name) => !before.has(name))
        .sort();

    // Both kept, each under a name of its own beside what was there.
    assert.equal(added.length, 2, `two files: ${added.join(", ")}`);
    assert.ok(
        added.every((name) => /^state_ment_( \(\d+\))?\.pdf$/.test(name)),
        `the site's name: ${added.join(", ")}`,
    );

    for (const name of added) {
        assert.equal(readFileSync(join(shared, name), "utf8"), "%PDF-1.4 the other one");
    }

    assert.deepEqual((await save(opened, join(bot, "Owner's"))).saved, [], "not the bot's");
});

test("a download no call moved is deleted when its page closes", real, async () => {
    const before = readdirSync(shared);
    const id = ++page;
    const opened = await browsers.open(id);

    await opened.navigate(base);
    await opened.click({ selector: "#get" });
    await until(
        () => opened.downloads().some((download) => download.state === "completed"),
        "the download",
    );
    assert.equal(readdirSync(shared).length, before.length + 1, "in the shared folder");
    await browsers.close(id);
    await until(() => readdirSync(shared).length === before.length, "the download deleted");
});

test(
    "a download larger than a call may save is stopped, and nothing of it stays",
    real,
    async () => {
        const before = readdirSync(shared);
        const opened = await browsers.open(++page);
        const folder = join(bot, "Huge");

        await opened.navigate(base);
        await opened.click({ selector: "#huge" });

        assert.deepEqual((await save(opened, folder)).saved, [
            { name: "huge.bin", error: "Not saved: larger than 100 MB." },
        ]);
        assert.deepEqual(readdirSync(folder), []);
        await until(() => readdirSync(shared).length === before.length, "the download deleted");
    },
);

test("a download still going when its call ends is moved once it is done", real, async () => {
    const opened = await browsers.open(++page);
    const folder = join(bot, "Slow");

    await opened.navigate(base);
    await opened.click({ selector: "#slow" });
    await until(() => opened.downloads().length > 0, "the download to begin");

    // A call whose time to wait is up: the file is told of under the name it will get.
    const { saved } = await save(opened, folder, 0, 0);
    const path = join(folder, "slow.txt");

    assert.deepEqual(saved, [
        { name: "slow.txt", path, size: saved[0]?.size, state: "downloading" },
    ]);
    assert.match(downloadLines(saved).join("\n"), /still downloading/);
    finishSlow();
    await until(() => readdirSync(folder).includes("slow.txt"), "the file moved");
    assert.equal(readFileSync(path, "utf8"), `${FIRST}-last`);
});

test("two of the owner's downloads of one name named at once both stay", async () => {
    const folder = mkdtempSync(join(root, "browser-naming-"));
    const env = new NodeExecutionEnv({ cwd: folder });

    writeFileSync(join(folder, "guid-a"), "A");
    writeFileSync(join(folder, "guid-b"), "B");
    await Promise.all([
        nameDownload(env, join(folder, "guid-a"), "report.pdf"),
        nameDownload(env, join(folder, "guid-b"), "report.pdf"),
    ]);

    assert.deepEqual(
        readdirSync(folder)
            .sort()
            .map((name) => `${name}=${readFileSync(join(folder, name), "utf8")}`),
        ["report (1).pdf=B", "report.pdf=A"],
    );
});

test("a site's name for a file becomes one plain segment", () => {
    assert.equal(downloadName("../../.bashrc"), "_.._.bashrc");
    assert.equal(downloadName("a$(rm -rf ~)`x`.txt"), "a_(rm -rf ~)_x_.txt");
    assert.equal(downloadName("  report\n2026.pdf  "), "report 2026.pdf");
    assert.equal(downloadName("..."), "download");
    assert.equal(downloadName(""), "download");
    assert.equal(downloadName(`${"x".repeat(200)}.pdf`), `${"x".repeat(76)}.pdf`);
});
