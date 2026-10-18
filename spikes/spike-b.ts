/**
 * Phase 0, spike B: one headful Chromium in the shared computer, a window per bot, driven from the server.
 *
 *   node spikes/spike-b.ts windows <container> <n>     open n overlapping windows; count each one's screencast frames
 *   node spikes/spike-b.ts login   <container>         set a cookie in one window, read it in another
 *   node spikes/spike-b.ts check   <container>         start Chromium again and read the cookie (after a restart)
 *
 * NOID_HARD=1 makes `login` leave the browser running, for a runner that then kills the container.
 *
 * Chromium runs inside the container through `docker exec -i` (NOID_DOCKER names the docker binary), launched with
 * `--remote-debugging-pipe` and its fds 3 and 4 joined to the exec's stdin and stdout, so the DevTools protocol travels
 * over the exec itself: no published port. pi-pocket's own pipe client (src/server/browser/cdp.ts) speaks it.
 */
import { spawn } from "node:child_process";
import { Connection, type Json } from "../src/server/browser/cdp.ts";

const [mode = "", container = "noid-computer-spike", count = "2"] = process.argv.slice(2);
const docker = process.env.NOID_DOCKER ?? "docker";
const say = (event: Record<string, unknown>) => console.log(JSON.stringify(event));
const SITE = "http://127.0.0.1:8000/";
const PROFILE = "/home/noid/.browser-profile";
const FLAGS = [
    "--remote-debugging-pipe",
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--password-store=basic",
    "--window-size=1280,800",
];

/** Starts Chromium in the container and returns the protocol connection, plus a way to stop it. */
async function launch() {
    // A Chromium stopped hard leaves its profile locked; clear the locks first (rakazo does the same).
    const script =
        `rm -f ${PROFILE}/Singleton*; exec chromium ${FLAGS.join(" ")} about:blank ` +
        `3<&0 4>&1 1>/dev/null 2>>/tmp/chromium.log`;
    const child = spawn(docker, ["exec", "-i", container, "sh", "-c", script], {
        stdio: ["pipe", "pipe", "inherit"],
    });
    const connection = new Connection(child.stdin, child.stdout);
    const version = await connection.send("Browser.getVersion", {}, undefined, 30_000);

    return {
        connection,
        version: version.product as string,
        stop: () => {
            connection.close("done");
            child.kill();
        },
    };
}

/** Opens a window on `url` and attaches to its page, returning the page's session. */
async function openWindow(connection: Connection, url: string, index: number) {
    const { targetId } = await connection.send("Target.createTarget", {
        url,
        newWindow: true,
        // Overlapping on purpose: each window is mostly covered by the next.
        left: 40 * index,
        top: 40 * index,
        width: 1280,
        height: 800,
    });
    const { sessionId } = await connection.send("Target.attachToTarget", {
        targetId,
        flatten: true,
    });

    await connection.send("Page.enable", {}, sessionId);

    return sessionId as string;
}

const evaluate = async (connection: Connection, sessionId: string, expression: string) =>
    (await connection.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId))
        .result?.value as Json;

async function memory(): Promise<string> {
    const output = await new Promise<string>((resolve) => {
        const child = spawn(docker, [
            "stats",
            "--no-stream",
            "--format",
            "{{.MemUsage}}",
            container,
        ]);
        let text = "";

        child.stdout.on("data", (chunk) => (text += String(chunk)));
        child.on("exit", () => resolve(text.trim()));
    });

    return output;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const browser = await launch();

say({ browser: browser.version });

try {
    if (mode === "windows") {
        const n = Number(count);
        const sessions: string[] = [];
        const frames = new Map<string, number>();

        for (let index = 0; index < n; index++) {
            sessions.push(await openWindow(browser.connection, SITE, index));
        }

        await sleep(1500);
        const idleMemory = await memory();

        for (const sessionId of sessions) {
            frames.set(sessionId, 0);
            browser.connection.listen(sessionId, (method, params) => {
                if (method === "Page.screencastFrame") {
                    frames.set(sessionId, (frames.get(sessionId) ?? 0) + 1);
                    void browser.connection.send(
                        "Page.screencastFrameAck",
                        { sessionId: params.sessionId },
                        sessionId,
                    );
                }
            });
            await browser.connection.send(
                "Page.startScreencast",
                { format: "jpeg", quality: 60, maxWidth: 800, maxHeight: 500 },
                sessionId,
            );
        }

        const before = await Promise.all(
            sessions.map((sessionId) =>
                evaluate(
                    browser.connection,
                    sessionId,
                    "Number(document.getElementById('frame').textContent)",
                ),
            ),
        );

        await sleep(4000);

        const after = await Promise.all(
            sessions.map((sessionId) =>
                evaluate(
                    browser.connection,
                    sessionId,
                    "Number(document.getElementById('frame').textContent)",
                ),
            ),
        );

        say({
            windows: n,
            screencastFramesIn4s: sessions.map((sessionId) => frames.get(sessionId)),
            animationFramesIn4s: after.map((value, index) => value - before[index]),
            memoryOpenIdle: idleMemory,
            memoryWhileCasting: await memory(),
        });
    }

    if (mode === "login") {
        const [first = "", second = ""] = [
            await openWindow(browser.connection, SITE, 0),
            await openWindow(browser.connection, SITE, 1),
        ];
        const value = `noid-${Date.now()}`;

        await evaluate(
            browser.connection,
            first,
            `document.cookie = "session=${value}; max-age=86400; path=/"`,
        );
        await evaluate(browser.connection, second, "location.reload()");
        await sleep(1000);
        say({
            set: value,
            otherWindowSees: await evaluate(browser.connection, second, "document.cookie"),
        });

        // Close the browser the way the server will on an orderly stop, so cookies reach the disk. NOID_HARD=1 skips
        // it, so the runner can kill the container right away, as a crash would.
        if (process.env.NOID_HARD !== "1") {
            await browser.connection.send("Browser.close").catch(() => {});
        } else {
            say({ hanging: true });
            await new Promise(() => {});
        }
    }

    if (mode === "check") {
        const page = await openWindow(browser.connection, SITE, 0);

        say({ afterRestartSees: await evaluate(browser.connection, page, "document.cookie") });
    }
} finally {
    browser.stop();
}
