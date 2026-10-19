// noid's terminal on the shared computer: only the owner opens one, its output is read from an offset (what is no
// longer kept is skipped), a read waits for output, and a terminal that ends says how and lets the computer sleep.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteTerminal, TerminalOptions } from "@earendil-works/pi-env";
import type { User } from "../src/server/config.ts";
import type { Computer } from "../src/server/noid/computer.ts";
import { Terminals } from "../src/server/noid/terminal.ts";

const owner = { id: "o", name: "Owner", role: "owner" } as User;
const guest = { id: "g", name: "Guest", role: "guest" } as User;

/** A computer that only counts folders made, and terminals that echo their input. `gate` holds opens back. */
function fixture(gate?: Promise<void>) {
    const made: string[] = [];
    const opened: TerminalOptions[] = [];
    const closed: number[] = [];
    const exits: ((code: number) => void)[] = [];
    const computer = {
        prepare: async (cwd: string) => void made.push(cwd),
    } as unknown as Computer;
    const terminals = new Terminals(computer, async (options) => {
        await gate;
        const index = opened.push(options) - 1;

        options.onData(new TextEncoder().encode("$ "));
        let exit!: (code: number) => void;
        let fail!: (error: Error) => void;
        const exited = new Promise<number>((resolve, reject) => {
            exit = resolve;
            fail = reject;
        });

        exits.push(exit);

        return {
            pid: 1,
            exited,
            write: (data: string | Uint8Array) =>
                options.onData(typeof data === "string" ? new TextEncoder().encode(data) : data),
            resize: (cols: number, rows: number) =>
                opened[index]!.onData(new TextEncoder().encode(`[${cols}x${rows}]`)),
            close: () => {
                closed.push(index);
                fail(Object.assign(new Error("aborted"), { code: "aborted" }));
            },
        } as unknown as RemoteTerminal;
    });

    return { terminals, made, opened, exits, closed };
}

const text = (data: string) => Buffer.from(data, "base64").toString();

test("only the owner opens a terminal, in a computer folder or the computer's home", async () => {
    const { terminals, made, opened } = fixture();

    await assert.rejects(terminals.open(guest, {}), { status: 403 });

    const bot = await terminals.open(owner, {
        cwd: "/home/noid/bots/scribe/",
        cols: 120,
        rows: 40,
    });
    const elsewhere = await terminals.open(owner, { cwd: "/etc" });

    assert.equal(bot.cwd, "/home/noid/bots/scribe");
    assert.equal(elsewhere.cwd, "/home/noid", "not a folder on this machine");
    assert.deepEqual(made, ["/home/noid/bots/scribe", "/home/noid"]);
    assert.deepEqual([opened[0]?.cols, opened[0]?.rows, opened[1]?.cols], [120, 40, 80]);
    assert.equal(opened[0]?.env?.TERM, "xterm-256color");
    assert.deepEqual(opened[0]?.argv, ["/bin/bash", "-l"]);
    assert.deepEqual(
        terminals.list(owner).map((each) => each.cwd),
        ["/home/noid/bots/scribe", "/home/noid"],
        "a tab coming back finds them",
    );
    // A folder removed since is made again for the next one.
    await terminals.open(owner, { cwd: "/home/noid/bots/scribe" });
    assert.equal(made.filter((each) => each === "/home/noid/bots/scribe").length, 2);
    assert.throws(() => terminals.list(guest), { status: 403 });
    assert.throws(() => terminals.write(guest, bot.id, "ls\n"), { status: 403 });
    terminals.closeAll();
});

test("output reads on from an offset, and a read waits for more", async () => {
    const { terminals } = fixture();
    const { id } = await terminals.open(owner, {});
    const first = await terminals.read(owner, id, 0);

    assert.equal(text(first.data), "$ ", "what it wrote before anyone read");

    const waiting = terminals.read(owner, id, first.next);

    terminals.write(owner, id, "ls\n");
    const second = await waiting;

    assert.equal(text(second.data), "ls\n");
    assert.equal(second.from, first.next);
    assert.equal(second.next, first.next + 3);
    // Read again from the start: a tab that lost its place gets all that is kept.
    assert.equal(text((await terminals.read(owner, id, 0)).data), "$ ls\n");
    terminals.closeAll();
});

test("only the last part of the output is kept", async () => {
    const { terminals } = fixture();
    const { id } = await terminals.open(owner, {});
    const chunk = "x".repeat(64 * 1024);

    for (let each = 0; each < 6; each++) {
        terminals.write(owner, id, chunk);
    }

    const read = await terminals.read(owner, id, 0);

    assert.ok(read.from > 0, "the oldest was dropped");
    assert.equal(read.next, 2 + 6 * chunk.length);
    assert.ok(Buffer.from(read.data, "base64").length <= 256 * 1024 + chunk.length);
    terminals.closeAll();
});

test("a terminal that ends says how, and is gone once read", async () => {
    const { terminals, exits } = fixture();
    const one = await terminals.open(owner, {});
    const two = await terminals.open(owner, {});

    // A read waiting at the end hears of it.
    const reading = terminals.read(owner, one.id, 2);

    exits[0]!(0);
    const ended = await reading;

    assert.equal(ended.ended, "exited with code 0");
    await assert.rejects(terminals.read(owner, one.id, 0), { status: 404 });

    terminals.close(owner, two.id);
    assert.throws(() => terminals.write(owner, two.id, "x"), { status: 404 });
    terminals.closeAll();
});

test("a few terminals at most, also when they open at once", async () => {
    let letGo!: () => void;
    const { terminals } = fixture(new Promise((resolve) => (letGo = resolve)));
    const opens = Array.from({ length: 6 }, () => terminals.open(owner, {}));

    letGo();
    const results = await Promise.allSettled(opens);

    assert.equal(results.filter((each) => each.status === "fulfilled").length, 4);
    assert.equal(terminals.list(owner).length, 4);
    terminals.closeAll();
});

test("one still opening as the server stops is closed, not kept", async () => {
    let letGo!: () => void;
    const { terminals, closed } = fixture(new Promise((resolve) => (letGo = resolve)));
    const opening = terminals.open(owner, {});

    await new Promise((resolve) => setImmediate(resolve));
    terminals.closeAll();
    letGo();
    await assert.rejects(opening, { status: 503 });
    assert.deepEqual(closed, [0]);
    assert.deepEqual(terminals.list(owner), []);
});

test("sizes are kept in range, so both ends draw the same", async () => {
    const { terminals } = fixture();
    const { id } = await terminals.open(owner, {});

    terminals.resize(owner, id, 120.4, 1);
    terminals.resize(owner, id, 9999, "x");
    assert.equal(text((await terminals.read(owner, id, 2)).data), "[120x2][500x24]");
    terminals.closeAll();
});
