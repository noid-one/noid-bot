// noid: bringing a site's sign-in from the owner's Chrome to the computer's browser moves that site's cookies only.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { copySignIn } from "../src/server/noid/host-chrome.ts";

/** A browser at the end of a DevTools pipe: answers each command with `answer`, and keeps what it was sent. */
function fakeBrowser(answer: (method: string, params: any) => unknown) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const sent: { method: string; params: any; sessionId?: string }[] = [];
    let pending = "";

    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
        pending += chunk;

        for (let end = pending.indexOf("\0"); end !== -1; end = pending.indexOf("\0")) {
            const message = JSON.parse(pending.slice(0, end));

            pending = pending.slice(end + 1);
            sent.push(message);
            stdout.write(
                `${JSON.stringify({ id: message.id, result: answer(message.method, message.params) })}\0`,
            );
        }
    });

    return { process: { stdin, stdout } as any, sent };
}

const cookie = (domain: string, name: string, session = false) => ({
    domain,
    name,
    value: "v",
    path: "/",
    size: 2,
    session,
    expires: session ? -1 : 2_000_000_000,
    secure: true,
    httpOnly: true,
});

test("only the site's cookies come over, its own and those of the domains above it", async () => {
    const chrome = fakeBrowser(() => ({
        cookies: [
            cookie(".x.com", "auth_token"),
            cookie("x.com", "ct0"),
            cookie("api.x.com", "api"),
            cookie(".notx.com", "other"),
            cookie(".google.com", "SID"),
            cookie(".x.com", "session", true),
        ],
    }));
    const computer = fakeBrowser(() => ({ targetInfos: [] }));

    assert.deepEqual(await copySignIn(chrome.process, "www.x.com", computer.process), {
        copied: 4,
        reloaded: 0,
    });

    const set = computer.sent.find((message) => message.method === "Storage.setCookies");

    assert.deepEqual(
        set?.params.cookies.map((c: any) => c.name),
        ["auth_token", "ct0", "api", "session"],
    );
    // A session cookie stays one (no expiry); size is Chrome's own, not a cookie's.
    assert.equal(set?.params.cookies[3].expires, undefined);
    assert.equal(set?.params.cookies[0].expires, 2_000_000_000);
    assert.equal(set?.params.cookies[0].size, undefined);
});

test("signed in nowhere: nothing is set", async () => {
    const chrome = fakeBrowser(() => ({ cookies: [cookie(".google.com", "SID")] }));
    const computer = fakeBrowser(() => ({}));

    assert.deepEqual(await copySignIn(chrome.process, "x.com", computer.process), {
        copied: 0,
        reloaded: 0,
    });
    assert.equal(computer.sent.length, 0);
});

test("the site's tabs open in the computer's browser load again, signed in, the first in front", async () => {
    const chrome = fakeBrowser(() => ({ cookies: [cookie(".x.com", "auth_token")] }));
    const computer = fakeBrowser((method, params) =>
        method === "Target.getTargets"
            ? {
                  targetInfos: [
                      { targetId: "a", type: "page", url: "https://x.com/i/jf/onboarding/web" },
                      { targetId: "b", type: "page", url: "https://duckduckgo.com/?q=x.com" },
                      { targetId: "c", type: "page", url: "https://mobile.x.com/home" },
                      { targetId: "d", type: "service_worker", url: "https://x.com/sw.js" },
                  ],
              }
            : method === "Target.attachToTarget"
              ? { sessionId: `s-${params.targetId}` }
              : {},
    );

    assert.deepEqual(await copySignIn(chrome.process, "x.com", computer.process), {
        copied: 1,
        reloaded: 2,
    });
    assert.deepEqual(
        computer.sent
            .filter((message: any) => message.method === "Page.reload")
            .map((message: any) => message.sessionId),
        ["s-a", "s-c"],
    );
    assert.equal(
        computer.sent.find((message) => message.method === "Target.activateTarget")?.params
            .targetId,
        "a",
    );
});
