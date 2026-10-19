// noid's desktop: one display, one mouse. A bot holds the lease while it acts, another is told to wait, the owner
// always gets it, it ends with a release or two minutes after its holder last acted; and each action is the xdotool
// command it says, with its arguments checked.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { User } from "../src/server/config.ts";
import {
    commandFor,
    Desktop,
    DesktopLease,
    LEASE_MS,
    MAX_HOLD_MS,
} from "../src/server/noid/desktop.ts";

test("one holder at a time; the owner wins; it ends with a release or when it runs out", () => {
    let now = 0;
    const lease = new DesktopLease(() => now);
    const scout = { id: "1", name: "Scout" };
    const scribe = { id: "2", name: "Scribe" };
    const holder = () => lease.holder?.name;

    assert.deepEqual(lease.take(scout), { ok: true });
    assert.deepEqual(lease.take(scout), { ok: true }, "its own, again");
    assert.equal((lease.take(scribe) as { holder: { name: string } }).holder.name, "Scout");

    lease.release(scribe);
    assert.equal(holder(), "Scout", "only its holder lets it go");
    lease.release(scout);
    assert.deepEqual(lease.take(scribe), { ok: true });

    now += LEASE_MS + 1;
    assert.equal(holder(), undefined, "two minutes without acting");
    assert.deepEqual(lease.take(scout), { ok: true });

    assert.deepEqual(lease.take({ id: "owner:o", name: "Owner" }, true), { ok: true });
    assert.equal(holder(), "Owner", "the owner takes it from a bot");
    assert.equal((lease.take(scout) as { ok: boolean }).ok, false);
});

test("a bot keeping it ten minutes in a row gives way to one that waits; the owner's never does", () => {
    let now = 0;
    const lease = new DesktopLease(() => now);
    const scout = { id: "1", name: "Scout" };
    const scribe = { id: "2", name: "Scribe" };

    lease.take(scout);

    // Scout acts every minute: its lease never runs out, but after ten minutes another may have it.
    for (let minute = 1; minute < 10; minute++) {
        now = minute * 60_000;
        lease.take(scout);
        assert.equal((lease.take(scribe) as { ok: boolean }).ok, false);
    }

    now = MAX_HOLD_MS;
    assert.deepEqual(lease.take(scribe), { ok: true });

    // The owner's lease is never taken by a bot, however long the owner keeps acting.
    for (let minute = 0; minute <= 20; minute++) {
        now += 60_000;
        lease.take({ id: "owner:o", name: "Owner" }, true);
    }

    assert.equal((lease.take(scout) as { ok: boolean }).ok, false);
});

test("each action is its xdotool command, and arguments that do not fit are refused", () => {
    assert.equal(commandFor({ action: "screenshot" }), undefined);
    // A click first raises and focuses the window under it: the desktop has no window manager to.
    assert.deepEqual(commandFor({ action: "click", x: 10.4, y: 20 })!.slice(3), [
        "point",
        "10",
        "20",
        "click",
        "1",
    ]);
    assert.match(
        commandFor({ action: "click", x: 1, y: 1 })![2]!,
        /windowraise "\$id" windowfocus "\$id"/,
    );
    assert.deepEqual(commandFor({ action: "scroll", x: 1, y: 1, dy: -3 })!.slice(-2), ["3", "4"]);
    assert.deepEqual(commandFor({ action: "key", keys: "ctrl+s Enter" }), [
        "xdotool",
        "key",
        "--",
        "ctrl+s",
        "Return",
    ]);
    // Typed text is one argument after `--`: it cannot become an option or a second command.
    assert.deepEqual(commandFor({ action: "type", text: "--help; rm -rf ~" }), [
        "xdotool",
        "type",
        "--delay",
        "12",
        "--",
        "--help; rm -rf ~",
    ]);
    assert.deepEqual(commandFor({ action: "open", command: "xterm -e top" })!.slice(-1), [
        "xterm -e top",
    ]);

    for (const [input, problem] of [
        [{ action: "click", x: 1280, y: 1 }, /x must be a number from 0 to 1279/],
        [{ action: "type", text: "x".repeat(1001) }, /up to 1000 characters/],
        // xdotool runs its own commands named after keys: none may be.
        [{ action: "key", keys: "Return exec sh -c id" }, /not a key/],
        [{ action: "key", keys: "windowkill" }, /not a key/],
        [{ action: "key", keys: "ctrl+$(id)" }, /not a key/],
        [{ action: "click", x: "1", y: 1 }, /x must be a number/],
        [{ action: "scroll", x: 1, y: 1, dy: 0 }, /dy must be/],
        [{ action: "type", text: "" }, /type needs text/],
        [{ action: "fly" }, /action is one of/],
    ] as const) {
        assert.throws(() => commandFor(input as Record<string, unknown>), problem);
    }
});

test("only the owner watches or takes over the desktop", async () => {
    const desktop = new Desktop({ computer: { onStop: () => {} } } as never);
    const guest = { id: "g", name: "Guest", role: "guest" } as User;

    await assert.rejects(desktop.view(guest), { status: 403 });
    await assert.rejects(desktop.act(guest, { action: "click", x: 1, y: 1 }), { status: 403 });
});

test("the computer stopping frees the desktop; a lesson picked up after a restart holds it again", async () => {
    let stopped = () => {};

    const lesson = {
        name: "Stamp",
        goal: "x",
        folder: "/home/noid/.agents/skills/stamp",
        by: "o",
        startedAt: 0,
        start: "/home/noid/.cache/noid-lessons/a.png",
        steps: [],
    };
    const app = {
        computer: {
            onStop: (listener: () => void) => {
                stopped = listener;
            },
        },
        harness: {
            commit: async () => undefined,
            snapshot: async () => ({ lesson }),
        },
        config: { userById: () => ({ id: "o", name: "Owner", role: "owner" }) },
    };
    const desktop = new Desktop(app as never);
    const holder = () => desktop.lease.holder?.name;

    desktop.lease.take({ id: "1", name: "Scout" });
    stopped();
    assert.equal(holder(), undefined, "its programs are gone, and so is its hold");

    await desktop.restore();
    assert.equal(desktop.teaching.lesson?.name, "Stamp");
    assert.equal(holder(), "Owner", "the owner holds it for the lesson again");
    assert.equal((desktop.lease.take({ id: "1", name: "Scout" }) as { ok: boolean }).ok, false);
});

test("programs carry their holder: the others' close when it changes hands, and the holder's when it gives it back", async () => {
    const calls: string[][] = [];
    const env = {
        exec: async (argv: string[]) => {
            calls.push(argv);

            return { ok: true, value: { exitCode: 0 } };
        },
    };
    const desktop = new Desktop({ computer: { onStop: () => {}, env: () => env } } as never);
    const owner = { id: "o", name: "Owner", role: "owner" } as User;
    const closes = () => calls.filter((argv) => argv[3] === "close").map((argv) => argv.slice(4));

    desktop.lease.take({ id: "1", name: "Scout" });
    await desktop.act(owner, { action: "open", command: "xterm" });
    assert.deepEqual(closes(), [["except", "owner:o"]], "Scout's programs close");
    assert.deepEqual(calls.find((argv) => argv.includes("open"))!.slice(-2), ["xterm", "owner:o"]);

    await desktop.act(owner, { action: "click", x: 1, y: 1 });
    assert.equal(closes().length, 1, "still the owner's: nothing closes");

    await desktop.act(owner, { action: "release" });
    assert.deepEqual(closes().at(-1), ["only", "owner:o"]);
    assert.equal(desktop.lease.holder, undefined);
});
