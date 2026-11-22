// A tab whose event stream goes quiet past its pings connects again, though the stream never reports an error (#334).
import { type App, cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false } as const;
const host = "127.0.0.1";
let app: App, server: Server, browsers: Browsers, url: string;

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(createHandler({ app, listen: { host, port: 0 }, restart() {} }));
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const token = encodeURIComponent(app.config.ownerToken);

    url = `http://${host}:${(server.address() as { port: number }).port}/login?token=${token}`;
    browsers = new Browsers({ dataDir: `${root}/stream`, load: async () => undefined, save() {} });
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a stream that misses its pings is replaced, and so is one that dies before its first",
    real,
    async () => {
        const page = await browsers.open(1);

        await page.navigate(url);
        const streams = await page.evaluate(`
        const { connect } = await import("/store.js");
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const made = [], Real = EventSource;
        // Every stream after the first hears nothing at all, as one a phone dropped before its first ping.
        globalThis.EventSource = class extends Real {
            constructor(...a) { super(...a); made.push(this); this.mute = made.length > 1; }
            addEventListener(...a) { if (!this.mute) super.addEventListener(...a); }
        };
        await wait(1000);
        connect();
        await wait(1000);
        // A ping says the server pings every 200 ms; then the stream stays quiet, as a half-open one does.
        made[0].dispatchEvent(new MessageEvent("ping", { data: '{"every":200}' }));
        await wait(2000);
        return JSON.stringify(made.length);
    `);

        assert.ok(Number(streams) >= 3, `${streams} streams: a quiet one was kept`);
    },
);

// A Cloudflare quick tunnel passes the first batch, then holds small events back: no ping after the first comes.
const lan = Object.values(networkInterfaces())
    .flat()
    .find((address) => address?.family === "IPv4" && !address.internal)?.address;

test(
    "a stream that hears no ping after its first batch, away from this computer, turns to polling",
    { skip: real.skip || (lan === undefined ? "no address but loopback" : false) },
    async () => {
        const far = createServer(
            createHandler({ app, listen: { host: lan!, port: 0 }, restart() {} }),
        );

        await new Promise<void>((resolve) => far.listen(0, lan, resolve));
        const token = encodeURIComponent(app.config.ownerToken);
        const page = await browsers.open(2);

        try {
            await page.navigate(
                `http://${lan}:${(far.address() as { port: number }).port}/login?token=${token}`,
            );
            const transport = await page.evaluate(`
            const { connect } = await import("/store.js");
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const made = [], Real = EventSource;
            // The server's own pings are held back, as the tunnel does; one stands in for the first batch's.
            globalThis.EventSource = class extends Real {
                constructor(...a) { super(...a); made.push(this); }
                addEventListener(name, fn, ...rest) {
                    super.addEventListener(name, name === "ping" ? (e) => e.isTrusted || fn(e) : fn, ...rest);
                }
            };
            localStorage.removeItem("pocket.transport");
            connect();
            await wait(1500);
            made[0].dispatchEvent(new MessageEvent("ping", { data: '{"every":200}' }));
            await wait(1500);
            return localStorage.getItem("pocket.transport") ?? "";
        `);

            assert.match(
                transport,
                /^poll:/,
                `transport "${transport}": the held-back stream was tried again`,
            );
        } finally {
            far.close();
        }
    },
);

test("a first stream that hears nothing at all is made again", real, async () => {
    const page = await browsers.open(3);

    await page.navigate(url);
    const streams = await page.evaluate(`
        const { connect } = await import("/store.js");
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const made = [], Real = EventSource;
        // No stream hears anything, not even the first ping: the tab knows the server's ping period, but must not wait for it.
        globalThis.EventSource = class extends Real {
            constructor(...a) { super(...a); made.push(this); }
            addEventListener() {}
        };
        connect();
        const until = Date.now() + 20_000;
        while (made.length < 2 && Date.now() < until) await wait(100);
        return JSON.stringify(made.length);
    `);

    assert.ok(Number(streams) >= 2, `${streams} streams: the silent first one was kept`);
});

test(
    "a poll that hangs, away from this computer, is given up and asked again",
    { skip: real.skip || (lan === undefined ? "no address but loopback" : false) },
    async () => {
        const far = createServer(
            createHandler({ app, listen: { host: lan!, port: 0 }, restart() {} }),
        );

        await new Promise<void>((resolve) => far.listen(0, lan, resolve));
        const token = encodeURIComponent(app.config.ownerToken);
        const page = await browsers.open(4);

        try {
            await page.navigate(
                `http://${lan}:${(far.address() as { port: number }).port}/login?token=${token}`,
            );
            const polls = await page.evaluate(`
            const { connect } = await import("/store.js");
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const real = fetch;
            let polls = 0;
            // The first answer says the server holds a poll 300 ms; the second poll hangs, as on a half-open connection.
            globalThis.fetch = async (input, init) => {
                if (!String(input).includes("/api/poll?") || String(input).includes("close=1")) {
                    return real(input, init);
                }

                polls++;

                if (polls === 2) {
                    return new Promise((_, reject) =>
                        init.signal.addEventListener("abort", () => reject(new DOMException("stop", "AbortError"))),
                    );
                }

                const response = await real(input, init);
                const data = await response.json();

                return new Response(JSON.stringify({ ...data, hold: 300 }), { status: response.status });
            };
            localStorage.setItem("pocket.transport", "poll:" + Date.now());
            connect();
            const until = Date.now() + 20_000;
            while (polls < 3 && Date.now() < until) await wait(100);
            localStorage.removeItem("pocket.transport");
            return JSON.stringify(polls);
        `);

            assert.ok(Number(polls) >= 3, `${polls} polls: the hung one was waited on`);
        } finally {
            far.close();
        }
    },
);

test(
    "a stream that hears nothing try after try is still made again within a minute",
    real,
    async () => {
        const page = await browsers.open(5);

        await page.navigate(url);
        const waits = await page.evaluate(`
        const { connect } = await import("/store.js");
        const realTimeout = setTimeout;
        const wait = (ms) => new Promise((resolve) => realTimeout(resolve, ms));
        const made = [], firstData = [];
        const Real = EventSource;
        // Not even the stream's headers come, so no try counts as open.
        globalThis.EventSource = class extends Real {
            constructor(...a) { super(...a); made.push(this); }
            addEventListener() {}
            set onopen(_) {}
        };
        // Time runs 200 times faster, so eight silent tries in a row take seconds, not minutes.
        globalThis.setTimeout = (fn, ms = 0, ...rest) => {
            if (String(fn).includes("heardAny")) firstData.push(ms);
            return realTimeout(fn, ms / 200, ...rest);
        };
        connect();
        const until = Date.now() + 20_000;
        while (made.length < 9 && Date.now() < until) await wait(50);
        globalThis.setTimeout = realTimeout;
        return JSON.stringify(firstData);
    `);
        const asked = JSON.parse(waits) as number[];

        assert.ok(asked.length >= 8, `${asked.length} tries`);
        assert.ok(
            Math.max(...asked) <= 60_000,
            `waits ${asked.join(", ")}: one waited past a minute`,
        );
    },
);

test(
    "a poll that hangs before its headers, try after try, waits twice as long each time",
    { skip: real.skip || (lan === undefined ? "no address but loopback" : false) },
    async () => {
        const far = createServer(
            createHandler({ app, listen: { host: lan!, port: 0 }, restart() {} }),
        );

        await new Promise<void>((resolve) => far.listen(0, lan, resolve));
        const token = encodeURIComponent(app.config.ownerToken);
        const page = await browsers.open(6);

        try {
            await page.navigate(
                `http://${lan}:${(far.address() as { port: number }).port}/login?token=${token}`,
            );
            const starts = await page.evaluate(`
            const { connect } = await import("/store.js");
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const real = fetch;
            const starts = [];
            // The first answer says the server holds a poll 300 ms; every later poll hangs before its headers.
            globalThis.fetch = async (input, init) => {
                if (!String(input).includes("/api/poll?") || String(input).includes("close=1")) {
                    return real(input, init);
                }

                starts.push(Date.now());

                if (starts.length > 1) {
                    return new Promise((_, reject) =>
                        init.signal.addEventListener("abort", () => reject(new DOMException("stop", "AbortError"))),
                    );
                }

                const response = await real(input, init);
                const data = await response.json();

                return new Response(JSON.stringify({ ...data, hold: 300 }), { status: response.status });
            };
            localStorage.setItem("pocket.transport", "poll:" + Date.now());
            connect();
            const until = Date.now() + 30_000;
            while (starts.length < 4 && Date.now() < until) await wait(100);
            localStorage.removeItem("pocket.transport");
            return JSON.stringify(starts);
        `);
            const at = JSON.parse(starts) as number[];

            assert.ok(at.length >= 4, `${at.length} polls`);
            // Each gap is the hung poll's wait (2.45 s for a 300 ms hold), then the pause after a failure (1 s, then 2 s).
            const first = at[2]! - at[1]! - 1000;
            const second = at[3]! - at[2]! - 2000;

            assert.ok(
                second > first * 1.6,
                `the second hung poll waited ${second} ms, the first ${first} ms`,
            );
        } finally {
            far.close();
        }
    },
);
