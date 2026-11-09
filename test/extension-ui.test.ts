// Extensions' browser modules in a real Chromium: what they add shows in the app (the rail, a page in the conversation's
// place), hears its module's events, fails alone, and goes when turned off.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import type { ExtensionWeb } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import type { Pocket } from "../types/pocket.d.ts";
import { pocketVersion } from "../src/server/versions.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const dropIns = join(root, "data", "extensions");
const seen = globalThis as unknown as { meterWeb?: ExtensionWeb };

/** `Pocket`'s members in the public types: `npm run check` holds this to them, and the first test holds `pocket` to it. */
const POCKET_MEMBERS: Record<keyof Pocket, true> = {
    version: true,
    pocketVersion: true,
    module: true,
    title: true,
    h: true,
    html: true,
    Fragment: true,
    useState: true,
    useEffect: true,
    useLayoutEffect: true,
    useRef: true,
    useMemo: true,
    useCallback: true,
    useReducer: true,
    Icon: true,
    Spinner: true,
    Loader: true,
    Markdown: true,
    Switch: true,
    me: true,
    conversationId: true,
    openConversation: true,
    api: true,
    on: true,
    notify: true,
    rail: true,
    menu: true,
    launcher: true,
    page: true,
    sheet: true,
    fence: true,
    mathInline: true,
    toolCall: true,
    openPage: true,
    closePage: true,
    openSheet: true,
    closeSheet: true,
    style: true,
    onDispose: true,
};

/** The owner's meter: a route, events, and a browser module with a rail button and a page. */
const METER = `/** Meter: a reading on a page of its own. */
export default function (_host, web) {
	let reading = 41;
	web.route("GET", "reading", () => ({ reading: ++reading }));
	web.client("meter.js");
	globalThis.meterWeb = web;
}
`;

const METER_JS = `export const pocketApi = 1;

export default function (pocket) {
	const { html, useEffect, useState } = pocket;

	function Meter() {
		const [reading, setReading] = useState(null);

		useEffect(() => {
			pocket.api("reading").then((answer) => setReading(answer.reading));

			return pocket.on("reading", (value) => setReading(value));
		}, []);

		return html\`<p class="meter">Reading: \${reading ?? "…"}</p>\`;
	}

	pocket.page({ id: "meter", title: "Meter", component: Meter });
	const rail = pocket.rail({ id: "meter", title: "Meter", icon: "pulse", page: "meter" });
	// The tests reach this version's pocket, and its rail button, through these.
	globalThis.meterPocket = pocket;
	globalThis.meterRail = rail;
}
`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string, on: BrowserPage = page): Promise<T> {
    return JSON.parse(await on.evaluate(script)) as T;
}

/**
 * Wait for the page's own finite animations (sheets rising, the page fading in), so clicks land where they aim. Not
 * the notices': their countdown runs for seconds.
 */
async function settled(on: BrowserPage = page): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.getAnimations().every((each) => each.effect?.getComputedTiming().endTime === Infinity || each.playState !== "running" || each.effect?.target?.closest?.(".notices")))`,
                on,
            ),
        "animations to finish",
    );
    // A click soon after a layer opened is let go (back.js): wait it out.
    await new Promise((resolve) => setTimeout(resolve, 450));
}

const has = (selector: string, on: BrowserPage = page) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
        on,
    );

const text = (selector: string) =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? "")`,
    );

const notices = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".notice")].map((each) => each.textContent.trim()))`,
    );

/** Run `script` in the page with the meter's `pocket` (the version loaded now) and `html`; what it returns. */
const withMeter = <T>(script: string) =>
    inPage<T>(`const pocket = globalThis.meterPocket; const { html } = pocket; ${script}`);

/** How this tab's copy of a module's browser module stands, as the Extensions sheet reads it. */
const stateOf = (module: string) =>
    inPage<unknown>(
        `return JSON.stringify((await import("/extension-ui.js")).browserModuleState(${JSON.stringify(module)}) ?? null)`,
    );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Time, in the page, from now until the meter stops, kept as `globalThis.meterTook`. */
const timeTheStop = () =>
    inPage<null>(`
        const { store } = await import("/store.js");
        const { browserModuleState } = await import("/extension-ui.js");
        const started = performance.now();
        const stop = store.subscribe(() => {
            if (browserModuleState("meter")?.status === "failed") {
                globalThis.meterTook = performance.now() - started;
                stop();
            }
        });

        globalThis.meterTook = null;

        return "null";
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(dropIns, { recursive: true });
    writeFileSync(join(dropIns, "meter.ts"), METER);
    writeFileSync(join(dropIns, "meter.js"), METER_JS);
    // A second module, for everyone who sees every session, from a folder.
    writeFileSync(
        join(dropIns, "shared.ts"),
        `/** Shared: a rail button for everyone. */\nexport default (_host, web) => { web.client("shared", { access: "view" }); };\n`,
    );
    mkdirSync(join(dropIns, "shared"));
    writeFileSync(
        join(dropIns, "shared", "index.js"),
        `export default (pocket) => {
	pocket.rail({ id: "hi", title: "Shared", run: () => pocket.notify("info", "hi from shared") });
};
`,
    );
    // Fails while it sets up: the app goes on without it.
    writeFileSync(
        join(dropIns, "broken.ts"),
        `/** Broken: a browser module that throws. */\nexport default (_host, web) => { web.client("broken.js"); };\n`,
    );
    writeFileSync(
        join(dropIns, "broken.js"),
        `export default (pocket) => {
	pocket.rail({ id: "x", title: "Broken", run() {} });
	throw new Error("broken on purpose");
};
`,
    );
    app = await openApp(scriptedModel());

    // Broken is turned on in its own test: its notice would cover the top bar's buttons in the others.
    for (const file of ["meter.ts", "shared.ts"]) {
        await app.setExtensionEnabled(owner(app), file, true);
    }

    session = await newSession(app);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "extension-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(DESKTOP);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const rail = (title: string) => `.sidebar .rail-ext[title="${title}"]`;

test(
    "a browser module's rail button opens its page, which calls its route and hears its events",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        assert.deepEqual(
            await withMeter<string[]>(`return JSON.stringify(Object.keys(pocket).sort())`),
            Object.keys(POCKET_MEMBERS).sort(),
            "pocket has the members of Pocket in types/pocket.d.ts",
        );
        await settled();
        await page.click({ selector: rail("Meter") });
        await until(
            async () => (await text(".ext-page .meter")) === "Reading: 42",
            "the reading from its route",
        );

        assert.equal(
            await withMeter<string>(`return JSON.stringify(pocket.pocketVersion)`),
            pocketVersion(),
        );
        seen.meterWeb!.send("reading", 7);
        await until(
            async () => (await text(".ext-page .meter")) === "Reading: 7",
            "the reading the server sent",
        );
        await withMeter(`pocket.openConversation("${session}"); return "null"`);
        await until(
            async () => (await has(".composer")) && !(await has(".ext-page")),
            "normal conversation navigation",
        );
    },
);

test("a browser module that fails says so, and the rest of the app goes on", real, async () => {
    await app.setExtensionEnabled(owner(app), "broken.ts", true);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            (await notices()).some((each) =>
                each.includes("broken failed to load in this browser: broken on purpose"),
            ),
        "the failure's notice",
    );
    // What it added before it threw is gone; the others' stay.
    assert.equal(await has(rail("Broken")), false);
    assert.equal(await has(rail("Meter")), true);
    assert.equal(await has(".composer"), true);
    await app.setExtensionEnabled(owner(app), "broken.ts", false);
});

test(
    "an endless loop of microtasks that calls pocket is stopped in about a second",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await timeTheStop();
        // Each turn of the loop after an await. The page answers again only once the loop ends.
        await withMeter<null>(`
            globalThis.spinEnded = null;
            (async () => {
                let count = 0;

                try {
                    for (;;) {
                        await Promise.resolve();
                        globalThis.meterRail.update({ badge: (++count % 50) + 1 });
                    }
                } catch (error) {
                    globalThis.spinEnded = error.message;
                }
            })();

            return "null";
        `);
        await until(
            () => inPage<boolean>(`return JSON.stringify(globalThis.spinEnded !== null)`),
            "the loop ended",
        );
        assert.deepEqual(await stateOf("meter"), {
            status: "failed",
            error: "it redraws without end",
        });

        const took = await inPage<number | null>(`return JSON.stringify(globalThis.meterTook)`);

        assert.ok(typeof took === "number" && took < 2000, `stopped after ${took} ms`);
    },
);

test("safe mode: ?noext=1 loads no browser modules in the tab, across a reload", real, async () => {
    try {
        await page.navigate(`${base}/s/${session}?noext=1`);
        await until(() => has(".composer"), "the conversation");
        await until(
            async () =>
                (await notices()).some((each) =>
                    each.includes("Extensions' browser parts are off in this tab"),
                ),
            "the notice",
        );
        assert.equal(await has(".rail-ext"), false);

        // A reload in the same tab keeps it.
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(".composer"), "the conversation again");
        await sleep(500);
        assert.equal(await has(".rail-ext"), false);
    } finally {
        await inPage<null>(`sessionStorage.removeItem("pocket.noext"); return "null"`);
    }
});

test("Lancet Guard stays on until its inline confirmation is accepted", real, async () => {
    await app.setExtensionEnabled(owner(app), "guard.ts", true);
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(".composer"), "the conversation");
    await inPage(`(await import("/store.js")).openSheet({ type: "extensions" }); return "null";`);
    await until(() => has('.switch[aria-label="Lancet Guard: on"]'), "the guard switch");
    await settled();
    await inPage(
        `document.querySelector('.switch[aria-label="Lancet Guard: on"]').focus(); return "null";`,
    );
    await page.press("Space");
    await until(() => has(".guard-confirm"), "the inline confirmation");
    assert.equal(await has('.switch[aria-label="Lancet Guard: on"]'), true);
    await page.press("Enter");
    await until(async () => !(await has(".guard-confirm")), "Keep it on cancels");
    assert.equal(await has('.switch[aria-label="Lancet Guard: on"]'), true);
    await page.press("Space");
    await until(() => has(".guard-confirm"), "the confirmation to accept");
    await page.press("Tab");
    await page.press("Enter");
    await until(
        () => has('.switch[aria-label="Lancet Guard: off"]:focus'),
        "guard off and focus restored",
    );
});

test(
    "Markdown extension points render, update, and remove their registrations",
    real,
    async (t) => {
        t.after(() => app.setExtensionEnabled(owner(app), "diagrams.ts", true));
        // Exercise the test renderer, not the built-in renderer that normally takes precedence.
        await app.setExtensionEnabled(owner(app), "diagrams.ts", false);
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's browser module");

        const before = await inPage<{ revision: number; math: boolean }>(`
        const markdown = await import("/markdown-ext.js");
        return JSON.stringify({ revision: markdown.markdownRevision(), math: markdown.mathOn() });
    `);
        const invalid = await withMeter<string>(`
        try {
            pocket.fence({ id: "bad-fence", langs: [], component: () => null });
            return JSON.stringify("accepted");
        } catch (error) {
            return JSON.stringify(error.message);
        }
    `);

        assert.match(invalid, /langs is a non-empty list/);
        await withMeter(`
        globalThis.fenceHandle = pocket.fence({
            id: "test-fence",
            langs: ["PI-TEST"],
            component: ({ source, lang, streaming }) =>
                pocket.h("output", {
                    class: "fence-probe",
                    "data-source": source.trim(),
                    "data-lang": lang,
                    "data-streaming": String(streaming),
                }),
        });
        globalThis.mathHandle = pocket.mathInline({
            id: "test-math",
            mount(element, source, display) {
                element.classList.add("math-probe");
                element.dataset.source = source;
                element.dataset.display = String(display);
                element.textContent = "mounted";
            },
        });
        return "null";
    `);

        const afterAdd = await inPage<number>(`
        return JSON.stringify((await import("/markdown-ext.js")).markdownRevision());
    `);

        assert.ok(
            afterAdd > before.revision,
            "adding Markdown renderers changes the Markdown revision",
        );

        const rendered = await withMeter<{
            source: string | undefined;
            lang: string | undefined;
            streaming: string | undefined;
            mathParsed: boolean;
            mathMounted: boolean;
            mathCustom: boolean;
        }>(`
        const { render } = await import("preact");
        const host = globalThis.markdownTestHost ??= document.createElement("div");
        const fence = String.fromCharCode(96).repeat(3);
        const newline = String.fromCharCode(10);
        const text = [fence + "Pi-Test", "fence-body", fence, "", "$x+y$"].join(newline);
        document.body.append(host);
        render(pocket.h(pocket.Markdown, { text }), host);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const block = host.querySelector("output.fence-probe");
        const math = host.querySelector('code[data-part="inline-math"]');

        return JSON.stringify({
            source: block?.dataset.source,
            lang: block?.dataset.lang,
            streaming: block?.dataset.streaming,
            mathParsed: math !== null,
            mathMounted: math?.hasAttribute("data-mounted") ?? false,
            mathCustom: math?.classList.contains("math-probe") ?? false,
        });
    `);

        assert.deepEqual(rendered, {
            source: "fence-body",
            lang: "Pi-Test",
            streaming: "false",
            mathParsed: true,
            mathMounted: true,
            mathCustom: true,
        });

        const updated = await withMeter<string>(`
        globalThis.mathHandle.update({
            mount(element, source) {
                element.classList.add("math-updated");
                element.dataset.source = source;
            },
        });
        const { render } = await import("preact");
        const fence = String.fromCharCode(96).repeat(3);
        const newline = String.fromCharCode(10);
        const text = [fence + "Pi-Test", "fence-body", fence, "", "$x+y$"].join(newline);
        render(pocket.h(pocket.Markdown, { text }), globalThis.markdownTestHost);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const updated = globalThis.markdownTestHost.querySelector(".math-updated");

        return JSON.stringify(updated?.dataset.source ?? null);
    `);

        assert.equal(updated, "x+y", "an updated math renderer remounts existing Markdown");

        await withMeter(`
        globalThis.fenceHandle.remove();
        globalThis.mathHandle.remove();
        return "null";
    `);
        const afterRemove = await inPage<number>(`
        return JSON.stringify((await import("/markdown-ext.js")).markdownRevision());
    `);

        assert.ok(
            afterRemove > afterAdd,
            "removing Markdown renderers changes the Markdown revision",
        );

        const fallback = await withMeter<{
            customFence: boolean;
            defaultFence: string | undefined;
            math: boolean;
            mathMounted: boolean;
        }>(`
        const { render } = await import("preact");
        const host = globalThis.markdownTestHost;
        const fence = String.fromCharCode(96).repeat(3);
        const newline = String.fromCharCode(10);
        const text = [fence + "Pi-Test", "fence-body", fence, "", "$x+y$"].join(newline);
        render(pocket.h(pocket.Markdown, { text }), host);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const math = host.querySelector('code[data-part="inline-math"]');

        return JSON.stringify({
            customFence: host.querySelector("output.fence-probe") !== null,
            defaultFence: host.querySelector('pre[data-lang="Pi-Test"] code')?.textContent,
            math: (await import("/markdown-ext.js")).mathOn(),
            mathMounted: math?.hasAttribute("data-mounted") ?? false,
        });
    `);

        assert.deepEqual(fallback, {
            customFence: false,
            defaultFence: "fence-body",
            math: before.math,
            mathMounted: before.math,
        });
        await withMeter(`
        globalThis.markdownTestHost.remove();
        delete globalThis.markdownTestHost;
        return "null";
    `);
    },
);

test(
    "a fence renderer that throws shows its source, and the rest of the reply renders",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's browser module");

        const shown = await withMeter<{
            error: boolean;
            source: string | undefined;
            after: boolean;
        }>(`
        const handle = pocket.fence({
            id: "throwing-fence",
            langs: ["throw-test"],
            component: () => {
                throw new Error("bad source");
            },
        });
        const { render } = await import("preact");
        const host = document.createElement("div");
        const fence = String.fromCharCode(96).repeat(3);
        const text = [fence + "throw-test", "the source", fence, "", "after the fence"].join(
            String.fromCharCode(10),
        );
        document.body.append(host);
        render(pocket.h(pocket.Markdown, { text }), host);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const result = {
            error: /bad source/.test(host.querySelector(".error-box")?.textContent ?? ""),
            source: host.querySelector("pre code")?.textContent,
            after: (host.textContent ?? "").includes("after the fence"),
        };
        render(null, host);
        host.remove();
        handle.remove();

        return JSON.stringify(result);
    `);

        assert.deepEqual(shown, { error: true, source: "the source", after: true });
    },
);

test("turning the module off takes away its button and closes its page", real, async () => {
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(rail("Meter")), "the meter's rail button");

    const mathBefore = await inPage<boolean>(`
        return JSON.stringify((await import("/markdown-ext.js")).mathOn());
    `);

    await withMeter(`
        pocket.fence({
            id: "unload-fence",
            langs: ["unload-test"],
            component: () => pocket.h("output", { class: "unload-fence" }),
        });
        pocket.mathInline({
            id: "unload-math",
            mount(element) {
                element.classList.add("unload-math");
            },
        });
        return "null";
    `);
    const rendered = await withMeter<{ registered: boolean; custom: boolean }>(`
        const { render } = await import("preact");
        const host = globalThis.markdownUnloadHost ??= document.createElement("div");
        const fence = String.fromCharCode(96).repeat(3);
        const text = [fence + "unload-test", "value", fence].join(String.fromCharCode(10));
        document.body.append(host);
        render(pocket.h(pocket.Markdown, { text }), host);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return JSON.stringify({
            registered: (await import("/markdown-ext.js")).fenceFor("unload-test") !== undefined,
            custom: host.querySelector("output.unload-fence") !== null,
        });
    `);

    assert.deepEqual(rendered, { registered: true, custom: true });
    await settled();
    await page.click({ selector: rail("Meter") });
    await until(() => has(".ext-page .meter"), "the page");
    await app.setExtensionEnabled(owner(app), "meter.ts", false);
    await until(
        async () => !(await has(".ext-page")) && !(await has(rail("Meter"))),
        "the page and button gone",
    );
    const removed = await inPage<{
        registered: boolean;
        custom: boolean;
        fallback: string | undefined;
        math: boolean;
    }>(`
        const { h, render } = await import("preact");
        const { Markdown } = await import("/ui.js");
        const host = globalThis.markdownUnloadHost;
        const fence = String.fromCharCode(96).repeat(3);
        const text = [fence + "unload-test", "value", fence].join(String.fromCharCode(10));
        render(h(Markdown, { text }), host);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const markdown = await import("/markdown-ext.js");

        return JSON.stringify({
            registered: markdown.fenceFor("unload-test") !== undefined,
            custom: host.querySelector("output.unload-fence") !== null,
            fallback: host.querySelector('pre[data-lang="unload-test"] code')?.textContent,
            math: markdown.mathOn(),
        });
    `);

    assert.deepEqual(removed, {
        registered: false,
        custom: false,
        fallback: "value",
        math: mathBefore,
    });
    assert.equal(await has(rail("Shared")), true);
    await inPage(`
        globalThis.markdownUnloadHost.remove();
        delete globalThis.markdownUnloadHost;
        return "null";
    `);
});
