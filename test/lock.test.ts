import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { takeLock } from "../src/server/lock.ts";

const lockModule = new URL("../src/server/lock.ts", import.meta.url).href;
const linux = process.platform === "linux";
const holderScript = `
    process.send({ status: "ready", pid: process.pid });
    setInterval(() => {}, 1000);
`;
const contenderScript = `
    import { takeLock } from ${JSON.stringify(lockModule)};
    process.on("message", (message) => {
        if (message !== "go") return;
        try {
            takeLock(process.argv[1]);
            process.send({ status: "held", pid: process.pid });
        } catch (error) {
            process.send({ status: "blocked", error: error.message });
        }
    });
    process.send({ status: "ready", pid: process.pid });
`;

interface Message {
    status: string;
    pid?: number;
    error?: string;
}

function nextMessage(child: ChildProcess): Promise<Message> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Child did not respond")), 10_000);
        const onMessage = (message: Message) => finish(undefined, message);
        const onError = (error: Error) => finish(error);
        const onExit = (code: number | null, signal: string | null) =>
            finish(new Error(`Child exited before responding: ${code}, ${signal}`));

        const finish = (error?: Error, message?: Message) => {
            clearTimeout(timer);
            child.off("message", onMessage);
            child.off("error", onError);
            child.off("exit", onExit);

            if (error) {
                reject(error);
            } else {
                resolve(message!);
            }
        };

        child.once("message", onMessage);
        child.once("error", onError);
        child.once("exit", onExit);
    });
}

async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }

    const exited = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);

    child.kill("SIGTERM");

    try {
        await exited;
    } finally {
        clearTimeout(timer);
    }
}

function fixture(t: TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "pocket-lock-test-"));
    const lock = join(dir, "harness.lock");
    const children: ChildProcess[] = [];

    t.after(async () => {
        await Promise.all(children.map(stop));
        rmSync(dir, { recursive: true, force: true });
    });

    async function child(
        script = holderScript,
        executable = process.execPath,
        args: string[] = [],
    ) {
        const process = spawn(executable, ["--input-type=module", "-e", script, "--", ...args], {
            stdio: ["ignore", "ignore", "pipe", "ipc"],
        });

        children.push(process);

        let stderr = "";

        process.stderr!.on("data", (data) => (stderr += data));

        try {
            assert.equal((await nextMessage(process)).status, "ready");
        } catch (error) {
            throw new Error(`Child startup failed: ${stderr}`, { cause: error });
        }

        return process;
    }

    return { dir, lock, children, child };
}

function fileId(path: string): string {
    const stat = statSync(path, { bigint: true });

    return `${stat.dev}:${stat.ino}:${stat.ctimeNs}`;
}

function startTime(pid: number): string {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const value = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/)[19];

    assert.ok(value !== undefined && /^\d+$/.test(value));

    return value;
}

function identity(lock: string, pid: number) {
    return {
        version: 1,
        pid,
        fileId: fileId(lock),
        ...(linux
            ? {
                  startTime: startTime(pid),
                  bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
              }
            : {}),
    };
}

function writeIdentity(lock: string, value: unknown): void {
    writeFileSync(`${lock}.identity`, JSON.stringify(value));
}

function assertOccupied(lock: string): void {
    const before = readFileSync(lock);
    const metadata = existsSync(`${lock}.identity`) ? readFileSync(`${lock}.identity`) : undefined;

    assert.throws(() => takeLock(lock), /already running/i);
    assert.deepEqual(readFileSync(lock), before);

    if (metadata !== undefined) {
        assert.deepEqual(readFileSync(`${lock}.identity`), metadata);
    } else {
        assert.equal(existsSync(`${lock}.identity`), false);
    }
}

test("takeLock keeps a pid-only lock and publishes generation-bound identity", (t) => {
    const { lock } = fixture(t);
    const release = takeLock(lock);

    assert.equal(typeof release, "function");
    assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid));
    assert.deepEqual(
        JSON.parse(readFileSync(`${lock}.identity`, "utf8")),
        identity(lock, process.pid),
    );

    release();
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(`${lock}.identity`), false);
    assert.doesNotThrow(release);
});

for (const executableKind of ["copied", "symlinked"] as const) {
    test(`a live holder with a ${executableKind} Node binary and non-node name stays locked`, async (t) => {
        const { dir, lock, child } = fixture(t);
        const executable = join(dir, "pocket-host");

        if (executableKind === "copied") {
            copyFileSync(process.execPath, executable);
        } else {
            symlinkSync(process.execPath, executable);
        }

        const holder = await child(contenderScript, executable, [lock]);
        const held = nextMessage(holder);

        holder.send("go");
        assert.equal((await held).status, "held");
        assertOccupied(lock);
    });
}

test("an old-format Node lock preserves a live pid without metadata", async (t) => {
    const { lock, child } = fixture(t);
    const holder = await child();

    writeFileSync(lock, `${holder.pid}\n`);
    assertOccupied(lock);
});

test("EPERM from a pid probe preserves the lock without reliable stale evidence", async (t) => {
    const { lock, child } = fixture(t);
    const holder = await child();
    const originalKill = process.kill;

    writeFileSync(lock, `${holder.pid}\n`);

    const kill = t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === holder.pid && signal === 0) {
            throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
        }

        return originalKill(pid, signal);
    });

    try {
        assertOccupied(lock);
        assert.equal(kill.mock.callCount(), 1);
    } finally {
        kill.mock.restore();
    }

    assert.equal(process.kill, originalKill);
});

test(
    "Linux process identity handles spaces and parentheses in stat comm",
    { skip: !linux },
    async (t) => {
        const { lock, child } = fixture(t);
        const title = "pi (host) (x)";
        const holder = await child(
            `process.title = ${JSON.stringify(title)};\n${contenderScript}`,
            process.execPath,
            [lock],
        );
        const held = nextMessage(holder);

        holder.send("go");
        assert.equal((await held).status, "held");

        const stat = readFileSync(`/proc/${holder.pid}/stat`, "utf8");
        const saved = identity(lock, holder.pid!);

        assert.equal(stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")), title);
        assert.deepEqual(JSON.parse(readFileSync(`${lock}.identity`, "utf8")), saved);
        assertOccupied(lock);

        saved.startTime = String(BigInt(saved.startTime!) + 1n);
        writeIdentity(lock, saved);

        const release = takeLock(lock);

        assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid));
        release();
    },
);

test("an old-format renamed Node lock with a server entry argument stays occupied", async (t) => {
    const { dir, lock, child } = fixture(t);
    const executable = join(dir, "renamed-pocket-host");

    symlinkSync(process.execPath, executable);

    const holder = await child(holderScript, executable, ["src/server/main.ts"]);

    writeFileSync(lock, `${holder.pid}\n`);
    assertOccupied(lock);
});

test("a legacy lock preserves an unrelated live executable", { skip: !linux }, async (t) => {
    const { lock, children } = fixture(t);
    const holder = spawn("/bin/sleep", ["60"], { stdio: "ignore" });

    children.push(holder);
    await once(holder, "spawn");
    writeFileSync(lock, `${holder.pid}\n`);
    assertOccupied(lock);
});

for (const kind of ["missing", "damaged", "wrongpid", "orphan", "old-version", "invalid-fields"]) {
    test(`${kind} identity cannot evict a live pid`, async (t) => {
        const { lock, child } = fixture(t);
        const holder = await child();

        writeFileSync(lock, `${holder.pid}\n`);

        const saved = { ...identity(lock, holder.pid!), startTime: "0" };

        switch (kind) {
            case "missing":
                break;
            case "damaged":
                writeFileSync(`${lock}.identity`, "{not valid JSON");
                break;
            case "wrongpid":
                writeIdentity(lock, { ...saved, pid: holder.pid! + 1 });
                break;
            case "orphan":
                // Preserve the old inode so its metadata cannot match the replacement generation.
                writeIdentity(lock, saved);
                renameSync(lock, `${lock}.previous`);
                writeFileSync(lock, `${holder.pid}\n`);
                assert.notEqual(fileId(lock), saved.fileId);
                break;
            case "old-version":
                writeIdentity(lock, { ...saved, version: 0 });
                break;
            case "invalid-fields":
                writeIdentity(lock, { ...saved, startTime: 0, bootId: "invalid" });
                break;
        }

        assertOccupied(lock);
    });
}

for (const mismatch of ["startTime", "bootId"] as const) {
    test(
        `a verified Linux ${mismatch} mismatch permits takeover of a reused pid`,
        { skip: !linux },
        async (t) => {
            const { lock, child } = fixture(t);
            const holder = await child();

            writeFileSync(lock, `${holder.pid}\n`);

            const saved = identity(lock, holder.pid!);

            if (mismatch === "startTime") {
                saved.startTime = String(BigInt(saved.startTime!) + 1n);
            } else {
                saved.bootId =
                    saved.bootId === "00000000-0000-0000-0000-000000000000"
                        ? "11111111-1111-1111-1111-111111111111"
                        : "00000000-0000-0000-0000-000000000000";
            }

            writeIdentity(lock, saved);

            const release = takeLock(lock);

            assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid));
            assert.deepEqual(
                JSON.parse(readFileSync(`${lock}.identity`, "utf8")),
                identity(lock, process.pid),
            );
            assert.doesNotThrow(() => process.kill(holder.pid!, 0));
            release();
        },
    );
}

test("a dead pid permits takeover and replacement of its identity", async (t) => {
    const { lock, child } = fixture(t);
    const holder = await child();

    writeFileSync(lock, `${holder.pid}\n`);
    writeIdentity(lock, identity(lock, holder.pid!));
    await stop(holder);
    assert.throws(() => process.kill(holder.pid!, 0), { code: "ESRCH" });

    const release = takeLock(lock);

    assert.deepEqual(
        JSON.parse(readFileSync(`${lock}.identity`, "utf8")),
        identity(lock, process.pid),
    );
    release();
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(`${lock}.identity`), false);
});

test("a second acquisition in the same process fails without changing either file", (t) => {
    const { lock } = fixture(t);
    const release = takeLock(lock);

    assertOccupied(lock);
    release();
});

test("an old release cannot remove replacement lock and identity files with the same pid", (t) => {
    const { lock } = fixture(t);
    const release = takeLock(lock);

    renameSync(lock, `${lock}.previous`);
    writeFileSync(lock, `${process.pid}\n`);
    writeIdentity(lock, identity(lock, process.pid));

    const replacement = readFileSync(lock);
    const metadata = readFileSync(`${lock}.identity`);

    release();
    assert.deepEqual(readFileSync(lock), replacement);
    assert.deepEqual(readFileSync(`${lock}.identity`), metadata);
});

test("a repeated release cannot remove a later acquisition in the same process", (t) => {
    const { lock } = fixture(t);
    const firstRelease = takeLock(lock);

    firstRelease();

    const secondRelease = takeLock(lock);
    const secondIdentity = readFileSync(`${lock}.identity`);

    firstRelease();
    assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid));
    assert.deepEqual(readFileSync(`${lock}.identity`), secondIdentity);
    secondRelease();
});

test("identity publication failure rolls back the newly created lock", (t) => {
    const { lock } = fixture(t);

    mkdirSync(`${lock}.identity`);
    assert.throws(() => takeLock(lock));
    assert.equal(existsSync(lock), false, "publication failure must not strand a live-pid lock");
});

for (const contents of ["", "not-a-pid\n", "0\n", "-1\n"]) {
    test(`an incomplete or damaged lock is not reclaimed: ${JSON.stringify(contents)}`, (t) => {
        const { lock } = fixture(t);

        writeFileSync(lock, contents);
        assert.throws(() => takeLock(lock), /incomplete|damaged/i);
        assert.equal(readFileSync(lock, "utf8"), contents);
        assert.equal(existsSync(`${lock}.identity`), false);
    });
}

test(
    "fresh concurrent exclusive-create contenders elect exactly one owner",
    { timeout: 30_000 },
    async (t) => {
        const { lock, child } = fixture(t);
        const contenders = await Promise.all(
            Array.from({ length: 8 }, () => child(contenderScript, process.execPath, [lock])),
        );
        const results = contenders.map((contender) => {
            const result = nextMessage(contender);

            contender.send("go");

            return result;
        });
        const messages = await Promise.all(results);
        const owners = messages.filter((message) => message.status === "held");

        assert.equal(owners.length, 1, JSON.stringify(messages));
        assert.equal(messages.filter((message) => message.status === "blocked").length, 7);
        assert.ok(owners[0]);
        assert.equal(readFileSync(lock, "utf8").trim(), String(owners[0].pid));
        assert.deepEqual(
            JSON.parse(readFileSync(`${lock}.identity`, "utf8")),
            identity(lock, owners[0].pid!),
        );
        assertOccupied(lock);
    },
);
