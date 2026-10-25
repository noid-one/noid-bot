import {
    type App,
    cleanUp,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { SHOT_MAX } from "../src/server/browser/page.ts";
import { normalizeUrl } from "../src/server/browser/urls.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { onlyReads } from "../src/server/noid/read-only.ts";
import { uploadable } from "../src/server/extensions/browser.ts";

/** A JPEG's size in pixels, from its first frame header. */
function jpegSize(data: string): { width: number; height: number } {
    const bytes = Buffer.from(data, "base64");

    for (let at = 2; at + 9 < bytes.length; at += 2 + bytes.readUInt16BE(at + 2)) {
        const marker = bytes[at + 1]!;

        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
        }
    }

    throw new Error("no JPEG frame header");
}

test("addresses as people type them become URLs the browser may open", () => {
    assert.equal(normalizeUrl("localhost:5173"), "http://localhost:5173/");
    assert.equal(normalizeUrl("example.com/docs"), "https://example.com/docs");
    assert.equal(normalizeUrl("about:blank"), "about:blank");

    for (const refused of [
        "javascript:alert(1)",
        "chrome://settings",
        "view-source:https://example.com",
        "file:///etc/hosts",
        "/etc/hosts",
        "data:text/html,hi",
    ]) {
        assert.equal(normalizeUrl(refused), undefined, refused);
    }

    // Pi and the owner may open files on this machine.
    assert.equal(normalizeUrl("file:///etc/hosts", { trusted: true }), "file:///etc/hosts");
    assert.equal(
        normalizeUrl("./site/index.html", { trusted: true, cwd: "/work" }),
        "file:///work/site/index.html",
    );
    assert.equal(normalizeUrl("data:text/html,hi", { trusted: true }), "data:text/html,hi");
    assert.equal(normalizeUrl("javascript:alert(1)", { trusted: true }), undefined);
});

test("looking at pages only reads, and acting on them does not", () => {
    for (const action of ["navigate", "snapshot"]) {
        assert.equal(onlyReads("browser", { action }), true, action);
    }

    for (const action of ["click", "type", "press", "select", "evaluate"]) {
        assert.equal(onlyReads("browser", { action }), false, action);
    }

    // A data: page is one Pi writes, scripts and all.
    assert.equal(
        onlyReads("browser", {
            action: "navigate",
            url: "data:text/html,<script>fetch('/x')</script>",
        }),
        false,
    );
});

// ─── With a real browser ────────────────────────────────────────────────

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

const PAGE = `<!doctype html><html><head><title>Smoke test</title><meta name="viewport" content="width=device-width"></head><body>
<header><nav><a href="/two">Second page</a> <a href="/two" target="_blank">Popup</a></nav></header>
<main><h1>Hello</h1><p>Some intro text for the page.</p>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Sent ' + document.getElementById('email').value + ' ' + document.getElementById('pick').value">
<label for="email">Email</label><input id="email" type="email" placeholder="you@example.com" value="old@example.com">
<select id="pick"><option value="a">Apple</option><option value="b">Banana</option></select>
<button type="submit">Send</button></form>
<div id="out"></div>
<div id="fancy" style="cursor:pointer" onclick="this.textContent='clicked div'">Fancy div</div>
<button id="confirm" onclick="this.textContent = confirm('Sure?') ? 'yes' : 'no'">Ask</button>
<div style="height:3000px"></div><p id="bottom">The end</p>
</main><script>console.log("hello", {a: 1}); console.error("boom"); setTimeout(() => { throw new Error("late failure") }, 10);</script></body></html>`;

let site: Server;
let base = "";

before(async () => {
    site = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html" });

        response.end(request.url === "/two" ? "<title>Two</title><h1>Second</h1>" : PAGE);
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});

after(() => {
    site.close();
    cleanUp();
});

test(
    "the engine reads, clicks, types in, and streams a real page, and opens it again where it was",
    real,
    async () => {
        const saved = new Map<number, { url?: string }>();
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "engine-")),
            load: async (id) => saved.get(id),
            save: (id, value) => saved.set(id, value),
        });

        try {
            const page = await browsers.open(1);

            assert.deepEqual(await page.navigate(`${base}/`), { status: 200 });
            await until(() => page.title === "Smoke test", "the title");

            // A huge page comes back small enough for a model to take: too large an image breaks the conversation.
            await page.evaluate("document.body.style.cssText = 'width: 2600px; height: 6000px'; 1");
            const whole = await page.screenshot({ fullPage: true });
            const image = jpegSize(whole.data);

            assert.ok(
                whole.width >= 2600 && whole.height >= 6000,
                `${whole.width}×${whole.height}`,
            );
            assert.ok(Math.max(image.width, image.height) <= SHOT_MAX, JSON.stringify(image));
            await page.evaluate("document.body.style.cssText = ''; scrollTo(0, 0); 1");

            // A web page cannot use a new tab to open a file here, which it could not open itself.
            await page.evaluate("window.open('file:///etc/hosts'); 1");
            // Chromium refuses it by itself; the page's own rule refuses it too, should a tab open anyway.
            await until(
                () =>
                    page
                        .logs()
                        .some((entry) =>
                            /^(Not allowed to load local resource: |A new tab for )file:\/\/\/etc\/hosts/.test(
                                entry.text,
                            ),
                        ),
                "the refused tab",
            );
            await new Promise((done) => setTimeout(done, 500));
            assert.equal(page.url, `${base}/`);
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);

test(
    "upload attaches files to a hidden file input, listed in the snapshot, with no file chooser",
    real,
    async () => {
        const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "upload-")) });
        const folder = mkdtempSync(join(root, "upload-files-"));
        const file = join(folder, "resume.pdf");

        writeFileSync(file, "%PDF-1.4 a resume");

        try {
            const page = await browsers.open(1);

            await page.navigate(`${base}/`);
            await page.evaluate(
                `document.body.innerHTML = '<label class="button">Attach your resume<input type="file" accept=".pdf" style="display:none"></label>'; 1`,
            );
            const { lines } = await page.snapshot();
            const ref = /\[(e\d+)\] file upload[^\n]*accepts \.pdf/.exec(lines)?.[1];

            assert.ok(ref !== undefined, lines);
            assert.match(lines, /File uploads/);
            assert.equal(await page.upload({ ref }, [file]), "resume.pdf");
            assert.match(
                await page.evaluate("document.querySelector('input').files[0].name"),
                /resume\.pdf/,
            );
            // The label stands for its input too.
            assert.equal(await page.upload({ label: "Attach your resume" }, [file]), "resume.pdf");
            assert.match((await page.snapshot()).lines, /= "resume\.pdf"/);
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);

test("a password field's value is never part of what describes or finds it", real, async () => {
    const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "password-")) });

    try {
        const page = await browsers.open(1);

        await page.navigate(`${base}/`);
        await page.evaluate(
            `document.body.innerHTML = '<input id="secret" type="password"><input id="plain" value="visible words"><button id="under" style="position:absolute;left:0;top:200px;width:200px;height:40px">Under</button><input id="over" type="password" style="position:absolute;left:0;top:200px;width:200px;height:40px">'; 1`,
        );
        // An unlabelled field that holds a password: nothing about it says the password.
        await page.type({ selector: "#secret" }, "correct-horse");
        assert.equal(
            await page.evaluate("document.querySelector('#secret').value"),
            "correct-horse",
        );
        assert.equal((await page.locate({ selector: "#secret" })).label, "input#secret");
        await assert.rejects(page.locate({ label: "correct-horse" }), /Nothing on the page says/);
        // A password field lying over what Pi clicks is named without its value too.
        await page.evaluate("document.querySelector('#over').value = 'correct-horse'; 1");
        const found = await page.locate({ selector: "#under" });

        assert.equal(found.covered, "input#over");
        // Other fields are still found by what they hold.
        assert.equal(
            (await page.locate({ label: "visible words" })).label,
            'input#plain "visible words"',
        );
    } finally {
        await browsers.closeAll({ final: true });
    }
});

test(
    "codes go into one-box-per-digit fields a key at a time, and other fields as before",
    real,
    async () => {
        const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "code-")) });
        // Boxes that move focus on input, boxes that take only key presses, a field that takes only key presses, and boxes
        // that send focus elsewhere after the second digit. The page counts key presses.
        const fixture = `
        <label>Name <input id="name" value="Ada"></label>
        <div id="otp"></div><div id="keyed"></div><div id="jump"></div>
        <div id="wrapped"><input type="hidden" name="code"></div>
        <input id="strict" aria-label="Strict"><input id="tags" aria-label="Tags" oninput="window.tagInputs = (window.tagInputs || 0) + 1; this.value = ''">
        <script>
            window.keys = 0;
            addEventListener("keydown", () => window.keys++, true);
            for (const id of ["otp", "keyed", "jump", "wrapped"]) {
                const boxes = Array.from({ length: 6 }, (_, i) => {
                    const box = document.createElement("input");
                    box.maxLength = 1;
                    box.setAttribute("aria-label", id + " " + (i + 1));
                    // "wrapped": each box in a wrapper of its own, beside a hidden input that holds the code.
                    const wrapper = id === "wrapped" ? document.createElement("div") : null;
                    wrapper?.append(box);
                    document.getElementById(id).append(wrapper ?? box);
                    return box;
                });
                boxes.forEach((box, i) => {
                    box.addEventListener("focus", () => box.select());
                    if (id === "keyed") {
                        box.addEventListener("beforeinput", (event) => event.preventDefault());
                        box.addEventListener("keydown", (event) => {
                            if (!/^[0-9]$/.test(event.key)) return;
                            event.preventDefault();
                            box.value = event.key;
                            boxes[Math.min(i + 1, 5)].focus();
                        });
                        return;
                    }
                    box.addEventListener("input", () => {
                        if (box.value && i < 5) setTimeout(() => boxes[i + 1].focus(), 0);
                        if (id === "jump" && i === 1) setTimeout(() => document.getElementById("name").focus(), 0);
                    });
                });
            }
            const strict = document.getElementById("strict");
            strict.addEventListener("beforeinput", (event) => { if (event.inputType === "insertText" && event.data.length > 1) event.preventDefault(); });
        </script>`;
        const values = (id: string) =>
            page.evaluate(
                `[...document.querySelectorAll("#${id} input")].map((box) => box.value).join("")`,
            );
        let page!: Awaited<ReturnType<Browsers["open"]>>;

        try {
            page = await browsers.open(1);
            await page.navigate(`${base}/`);
            await page.evaluate(
                `document.open(); document.write(${JSON.stringify(fixture)}); document.close(); 1`,
            );

            // An ordinary field: replaced in one insert, with no key presses.
            await page.type({ selector: "#name" }, "Grace");
            assert.equal(await page.evaluate("document.getElementById('name').value"), "Grace");
            assert.equal(await page.evaluate("window.keys"), "0");

            await page.type({ label: "otp 1" }, "123456");
            assert.equal(await values("otp"), "123456");
            await page.type({ label: "keyed 1" }, "654321");
            assert.equal(await values("keyed"), "654321");
            await page.type({ label: "wrapped 1" }, "112233");
            assert.equal(await values("wrapped"), "112233");
            // A field that refuses inserted text takes the same text as keys.
            await page.type({ selector: "#strict" }, "4242");
            assert.equal(await page.evaluate("document.getElementById('strict').value"), "4242");

            // A field that took the text and emptied itself, as a tag field does, gets it once.
            await page.type({ selector: "#tags" }, "alpha");
            assert.equal(await page.evaluate("window.tagInputs"), "1");
            // Focus leaves the code's boxes: typing stops there and says how far it got, typing nothing elsewhere.
            await assert.rejects(
                page.type({ label: "jump 1" }, "987654"),
                /Typed 2 of 6 characters/,
            );
            assert.equal(await values("jump"), "98");
            assert.equal(await page.evaluate("document.getElementById('name').value"), "Grace");
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);

test("upload takes regular files only, and on the computer only from the session's folder and shared", async () => {
    const home = mkdtempSync(join(root, "upload-home-"));
    const mine = join(home, "bots", "scout");
    const shared = join(home, "shared");
    const other = join(home, "bots", "other");

    for (const folder of [mine, shared, other]) {
        mkdirSync(folder, { recursive: true });
    }

    writeFileSync(join(mine, "a.txt"), "a");
    writeFileSync(join(shared, "b.txt"), "b");
    writeFileSync(join(other, "secret.txt"), "s");
    symlinkSync(join(other, "secret.txt"), join(mine, "link.txt"));

    // An environment as pi-durable's: results, not throws.
    const { realpathSync, statSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    const result = <T>(make: () => T) => {
        try {
            return { ok: true as const, value: make() };
        } catch (error) {
            return { ok: false as const, error: error as Error };
        }
    };

    const env = {
        absolutePath: async (path: string) => result(() => resolve(mine, path)),
        canonicalPath: async (path: string) => result(() => realpathSync(path)),
        fileInfo: async (path: string) =>
            result(() => {
                const info = statSync(path);

                return { kind: info.isDirectory() ? "directory" : "file", size: info.size };
            }),
    } as never;
    const within = [mine, shared];

    assert.deepEqual(
        await uploadable(env, ["a.txt", join(shared, "b.txt")], within, BACKGROUND_CONTEXT),
        [realpathSync(join(mine, "a.txt")), realpathSync(join(shared, "b.txt"))],
    );
    await assert.rejects(
        uploadable(env, [join(other, "secret.txt")], within, BACKGROUND_CONTEXT),
        /outside your folder/,
    );
    await assert.rejects(
        uploadable(env, ["link.txt"], within, BACKGROUND_CONTEXT),
        /outside your folder/,
        "a link is followed",
    );
    await assert.rejects(uploadable(env, ["."], within, BACKGROUND_CONTEXT), /is not a file/);
    await assert.rejects(
        uploadable(env, ["nope.txt"], within, BACKGROUND_CONTEXT),
        /is not a file/,
    );
    // On this machine (a host session): any regular file, as Pi reads any.
    assert.equal(
        (await uploadable(env, [join(other, "secret.txt")], undefined, BACKGROUND_CONTEXT)).length,
        1,
    );
});

test("pages do not see an automated browser, on a phone or after one", real, async () => {
    const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "agent-")) });

    try {
        const page = await browsers.open(1);

        await page.navigate(`${base}/`);
        assert.match(await page.evaluate("String(navigator.webdriver)"), /false/);
        const desktop = await page.evaluate("navigator.userAgent");

        assert.doesNotMatch(desktop, /HeadlessChrome/);
        await page.setViewport({ ...VIEWPORTS.mobile });
        assert.match(await page.evaluate("navigator.userAgent"), /Android/);
        await page.setViewport({ ...VIEWPORTS.desktop });
        assert.equal(await page.evaluate("navigator.userAgent"), desktop);
    } finally {
        await browsers.closeAll({ final: true });
    }
});

test("a command sent while a navigation swaps the page waits for it", real, async () => {
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "swap-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        const page = await browsers.open(1, { restore: false });

        // Across sites (to the test site and back to about:blank), Chromium moves the page to a new process and for a
        // moment refuses commands. A reload or stop sent right then used to fail: "Not attached to an active page".
        for (let round = 0; round < 3; round++) {
            await page.navigate("about:blank");
            await page.navigate(`${base}/`);
            await page.go(-1, { wait: false });
            await page.reload({ wait: false });
            await page.navigate(`${base}/two`, { wait: false });
            await page.stop();
        }
    } finally {
        await browsers.closeAll({ final: true });
    }
});

test(
    "Pi uses the browser tool, and people watch and use the same page in the panel",
    real,
    async () => {
        const results: string[] = [];

        const route: FauxResponseStep = (context) => {
            const { role, text } = lastText(context as never);
            const call = (args: Parameters<typeof fauxToolCall>[1]) =>
                fauxAssistantMessage([fauxToolCall("browser", args)], { stopReason: "toolUse" });

            if (role === "toolResult") {
                results.push(text);

                return fauxAssistantMessage([fauxText("done")]);
            }

            if (text.includes("open the test page")) {
                return call({
                    action: "navigate",
                    url: base.replace("http://", ""),
                    snapshot: true,
                });
            }

            if (text.includes("take a screenshot")) {
                return call({ action: "screenshot" });
            }

            return fauxAssistantMessage([fauxText("ok")]);
        };

        const app: App = await openApp(scriptedModel(route), join(root, "app"));
        const { createHandler } = await import("../src/server/http.ts");
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
        const viewer = app.config.addUser("Vee", "viewer");
        const guest = app.config.addUser("Gus", "guest");
        const request = (token: string, path: string, body?: unknown) =>
            fetch(
                `${api}/${path}`,
                body === undefined
                    ? { headers: { authorization: `Bearer ${token}` } }
                    : {
                          method: "POST",
                          headers: {
                              authorization: `Bearer ${token}`,
                              "x-pocket": "1",
                              "content-type": "application/json",
                          },
                          body: JSON.stringify(body),
                      },
            );

        try {
            const id = await newSession(app);

            // A model that takes images keeps the screenshot in the transcript.
            await app.commands.configure(id, owner(app), {
                model: { provider: "faux", modelId: "faux-vision" },
            });
            const tab = fakeTab(id, owner(app));

            await app.attach(tab.client);
            assert.equal(tab.last("browser")?.open, false);

            await say(app, id, "open the test page");
            await until(() => results.length === 1, "the navigate result");
            assert.match(results[0]!, /\[e\d+\] button "Send"/);
            await until(() => tab.last("browser")?.url === `${base}/`, "the page reaching the tab");

            await say(app, id, "take a screenshot");
            await until(() => results.length === 2, "the screenshot result");
            const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
            const entries = await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT);
            const shot = entries.items.find(
                (entry) =>
                    entry.kind === "pi.tool-result" &&
                    JSON.stringify(entry.model).includes("Screenshot of the viewport"),
            )!;

            assert.equal(
                (await app.transcripts.entryImage(id, shot.id as unknown as number, 0))?.mimeType,
                "image/jpeg",
                "Pi sees the screenshot",
            );

            // Everyone who sees the session watches; only people who can steer use the page, and files are the owner's.
            await request(app.config.ownerToken, `c/${id}/browser/navigate`, { url: `${base}/` });
            const state = (await (await request(viewer.token, `c/${id}/browser`)).json()) as {
                open: boolean;
            };

            assert.equal(state.open, true);
            const frame = await request(viewer.token, `c/${id}/browser/frame?after=0`);

            assert.equal(frame.status, 200);
            assert.equal(frame.headers.get("content-type"), "image/jpeg");
            assert.equal(
                (await request(viewer.token, `c/${id}/browser/navigate`, { url: "example.com" }))
                    .status,
                403,
            );
            assert.equal(
                (await request(viewer.token, `c/${id}/browser/input`, { events: [] })).status,
                403,
            );
            const file = await request(guest.token, `c/${id}/browser/navigate`, {
                url: "file:///etc/hosts",
            });

            assert.equal(file.status, 400);
            assert.equal(
                (
                    await request(guest.token, `c/${id}/browser/navigate`, {
                        url: `${base.replace("http://", "")}/two`,
                    })
                ).status,
                200,
            );
            await until(
                () => app.browsers.page(Number(id))?.url === `${base}/two`,
                "the guest's address",
            );
            assert.deepEqual(await (await request(guest.token, `c/${id}/browser/servers`)).json(), {
                servers: [],
            });
            assert.equal((await request(guest.token, `c/${id}/browser/teleport`, {})).status, 404);
            app.detach(tab.client);
        } finally {
            server.closeAllConnections();
            server.close();
            await app.close();
        }
    },
);

test(
    "in a browser people use, a bot's page is a tab of the window's own size that keeps painting",
    real,
    async () => {
        const dataDir = mkdtempSync(join(root, "tabs-"));
        const browsers = new Browsers({
            dataDir,
            remote: {
                claims: () => true,
                // Headless, its window is 800×600: a desktop page there is that wide at most, not the 1280×800 preset.
                launch: () => Chromium.launch(chromium!, join(dataDir, "people"), []),
                tabs: true,
            },
        });

        try {
            const page = await browsers.open(1);

            await page.navigate(`${base}/`);
            const [visibility, width] = (
                await page.evaluate("document.visibilityState + ' ' + innerWidth")
            ).split(" ");

            assert.equal(visibility, "visible");
            assert.ok(Number(width) <= 800, `the window's ${width}, not the preset's 1280`);
            assert.ok((await page.frame(0)) !== undefined, "frames for the panel");
            // A phone's size is still the phone's.
            await page.setViewport({ ...VIEWPORTS.mobile });
            assert.equal(await page.evaluate("String(innerWidth)"), String(VIEWPORTS.mobile.width));
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);
