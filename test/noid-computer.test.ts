// noid's shared computer, without Docker: sessions whose folder an environment claims (here a virtual /remote tree,
// which does not exist on this machine, backed by a temp folder) must reach their files only through that
// environment. Each feature is checked on such a session: Pi's tools, the viewer, images, the @ list, @ mentions,
// attachments, AGENTS.md, and the git features that refuse it. The Computer's container lifecycle is checked with a
// fake docker.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Connection, LocalExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import { Computer, type Docker, normalFolder, onComputer } from "../src/server/noid/computer.ts";

const VIRTUAL = "/remote";
const real = join(root, "remote-backing");
const daemon = new Connection({ command: [localDaemon()] });

/** `/remote/…` as the temp folder behind it, and back. */
const toReal = (path: string) =>
    path === VIRTUAL || path.startsWith(`${VIRTUAL}/`) ? real + path.slice(VIRTUAL.length) : path;

const toVirtual = (value: unknown): unknown => {
    if (typeof value === "string") {
        return value === real || value.startsWith(`${real}/`)
            ? VIRTUAL + value.slice(real.length)
            : value;
    }

    if (Array.isArray(value)) {
        return value.map(toVirtual);
    }

    // Plain objects only (results, file infos): readers and buffers pass as they are.
    if (
        value !== null &&
        typeof value === "object" &&
        Object.getPrototypeOf(value) === Object.prototype
    ) {
        return Object.fromEntries(
            Object.entries(value).map(([key, each]) => [key, toVirtual(each)]),
        );
    }

    return value;
};

/** An environment whose paths are under /remote: what this machine's disk does not have, as on the shared computer. */
function mappedEnv(cwd: string): ExecutionEnv {
    // As the shared computer does on a folder's first use: its environment makes it.
    mkdirSync(toReal(cwd), { recursive: true });

    const env = new LocalExecutionEnv({ cwd: toReal(cwd), connection: daemon });

    return new Proxy(env, {
        get(target, key) {
            if (key === "cwd") {
                return cwd;
            }

            const value = Reflect.get(target, key, target) as unknown;

            if (typeof value !== "function") {
                return value;
            }

            return async (...args: unknown[]) => {
                const mapped = args.map((arg) => {
                    if (typeof arg === "string") {
                        return toReal(arg);
                    }

                    if (arg !== null && typeof arg === "object" && "cwd" in arg) {
                        return { ...arg, cwd: toReal(String((arg as { cwd: string }).cwd)) };
                    }

                    return arg;
                });

                return toVirtual(
                    await (value as (...a: unknown[]) => unknown).apply(target, mapped),
                );
            };
        },
    }) as ExecutionEnv;
}

/** "run COMMAND" calls bash; "check WORD" says whether WORD is in Pi's system prompt; tool results are echoed. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
    }

    const [verb = "", ...rest] = text.split(" ");

    if (verb === "run") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: rest.join(" ") })], {
            stopReason: "toolUse",
        });
    }

    if (verb === "check") {
        // What Pi was given before this message: its system prompt (as system entries) and the earlier messages.
        const { messages, systemPrompt } = request as {
            messages: unknown[];
            systemPrompt?: string;
        };
        const given = JSON.stringify({ systemPrompt, messages: messages.slice(0, -1) });

        return fauxAssistantMessage([fauxText(`has ${rest[0]}: ${given.includes(rest[0]!)}`)]);
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
let stopProviding: () => void;

before(async () => {
    mkdirSync(real, { recursive: true });
    app = await openApp(scriptedModel(route), join(root, "computer-data"));
    stopProviding = app.provideEnvironment({
        claims: (cwd) => cwd === VIRTUAL || cwd.startsWith(`${VIRTUAL}/`),
        env: mappedEnv,
    });
});

after(async () => {
    stopProviding?.();
    await app?.close();
    daemon.close();
    cleanUp();
});

async function answer(id: ConversationId): Promise<string> {
    const entries = await app.transcripts.allEntries(id, true);
    const last = entries.findLast((entry) => entry.kind === "assistant");

    return last?.kind === "assistant"
        ? last.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : "";
}

test("a session in a claimed folder works there: Pi's tools run there, nothing on this machine", async () => {
    assert.ok(!existsSync(VIRTUAL), "the test needs /remote to be absent on this machine");

    const id = await newSession(app, `${VIRTUAL}/bots/alpha`);

    assert.equal(app.cwdOf(id), `${VIRTUAL}/bots/alpha`);
    assert.equal(app.onHost(id), false);

    await say(app, id, "run pwd > where.txt && echo done");
    assert.match(await answer(id), /done/);
    assert.equal(
        readFileSync(join(real, "bots", "alpha", "where.txt"), "utf8").trim(),
        join(real, "bots", "alpha"),
    );
});

test("the viewer, the @ list, and images read the claimed folder", async () => {
    const id = await newSession(app, `${VIRTUAL}/bots/beta`);
    const folder = join(real, "bots", "beta");

    mkdirSync(folder, { recursive: true });

    writeFileSync(join(folder, "notes.md"), "# Plan\nship it\n");
    mkdirSync(join(folder, "img"), { recursive: true });
    // A 1x1 PNG.
    writeFileSync(
        join(folder, "img", "dot.png"),
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            "base64",
        ),
    );

    const view = await app.workspace.viewFile(id, owner(app), "notes.md");

    assert.equal(view.kind, "text");
    assert.equal(view.path, `${VIRTUAL}/bots/beta/notes.md`);
    assert.match(view.kind === "text" ? view.text : "", /ship it/);

    const folderView = await app.workspace.viewFile(id, owner(app), ".");

    assert.equal(folderView.kind, "folder");
    await assert.rejects(app.workspace.viewFile(id, owner(app), "missing.md"), /is not there/);

    const list = await app.workspace.fileList(id, owner(app));

    assert.deepEqual([...list.files].sort(), ["img/dot.png", "notes.md"]);

    const image = await app.workspace.remoteImage(id, owner(app), "img/dot.png");

    assert.equal(image.file, `${VIRTUAL}/bots/beta/img/dot.png`);
    assert.equal(
        Buffer.from(await image.read())
            .subarray(1, 4)
            .toString(),
        "PNG",
    );
    assert.match(
        image.etag,
        /^"[0-9a-z]+-[0-9a-z]+"$/,
        "an etag from size and time, without reading the file",
    );
    await assert.rejects(app.workspace.remoteImage(id, owner(app), "notes.md"), /Image not found/);
});

test("@ mentions and attachments reach Pi from the claimed folder", async () => {
    const id = await newSession(app, `${VIRTUAL}/bots/gamma`);
    const folder = join(real, "bots", "gamma");

    mkdirSync(folder, { recursive: true });

    writeFileSync(join(folder, "todo.txt"), "buy-llama-food\n");

    const upload = join(root, "computer-upload.txt");

    writeFileSync(upload, "attached-yak\n");
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text: "look at @todo.txt",
        requestId: crypto.randomUUID(),
        inlineFiles: true,
        attachments: [{ path: upload, name: "notes.txt", mime: "text/plain", size: 13 }],
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);

    // What the model got: the message with the mentioned file's text, and where the attachment is.
    const { messages } = await (await app.conversation(id)).context(context);
    const sent = JSON.stringify(messages.filter((message) => message.role === "user"));

    assert.match(sent, /buy-llama-food/, "the mentioned file came from the claimed folder");
    assert.match(
        sent,
        new RegExp(`${VIRTUAL}/bots/gamma/uploads/`),
        "Pi is told where the copy is on the computer",
    );
    assert.equal(
        readFileSync(join(folder, "uploads", "computer-upload.txt"), "utf8"),
        "attached-yak\n",
    );
});

test("AGENTS.md files come from the claimed folder and its parents", async () => {
    writeFileSync(join(real, "AGENTS.md"), "Top-level-walrus rule.\n");
    mkdirSync(join(real, "bots", "delta"), { recursive: true });
    writeFileSync(join(real, "bots", "delta", "AGENTS.md"), "Delta-otter rule.\n");

    const id = await newSession(app, `${VIRTUAL}/bots/delta`);

    await say(app, id, "check Top-level-walrus");
    assert.equal(await answer(id), "has Top-level-walrus: true");
    await say(app, id, "check Delta-otter");
    assert.equal(await answer(id), "has Delta-otter: true");
});

test("git features and worktrees refuse a session in a claimed folder, plainly", async () => {
    const id = await newSession(app, `${VIRTUAL}/bots/epsilon`);

    assert.equal(app.workspace.head(id), undefined);
    assert.equal(app.workspace.inRepository(`${VIRTUAL}/bots/epsilon`), false);
    await assert.rejects(app.workspace.branches(id, owner(app)), /sessions on this machine/);
    await assert.rejects(app.workspace.changeDiff(id, owner(app), "x"), /sessions on this machine/);
    assert.deepEqual(await app.workspace.changes(id, owner(app)), {
        files: [],
        more: 0,
        piOnly: [],
    });
    await assert.rejects(
        app.commands.createSession(owner(app), { cwd: `${VIRTUAL}/bots/zeta`, worktree: true }),
        /Worktrees are for folders on this machine/,
    );
});

test("a session moves onto and off a claimed folder", async () => {
    const id = await newSession(app);

    assert.equal(app.onHost(id), true);
    await app.commands.configure(id, owner(app), { cwd: `${VIRTUAL}/bots/moved` });
    assert.equal(app.onHost(id), false);
    assert.equal(app.cwdOf(id), `${VIRTUAL}/bots/moved`);
});

test("a folder is judged once `..` and a final slash are resolved, never by its spelling", async () => {
    assert.equal(onComputer("/home/noid/bots/a/"), true);
    assert.equal(onComputer("/home/noid/../noid/bots/a"), true);
    assert.equal(onComputer("/home/noid/../../etc"), false);
    assert.equal(onComputer("/home/noidx/bots"), false);
    assert.equal(onComputer("home/noid/bots"), false, "only absolute paths");
    assert.equal(normalFolder("/home/noid/bots/a/"), "/home/noid/bots/a");

    // A path that only looks claimed is this machine's, and must be there: nothing is made for it.
    await assert.rejects(
        app.commands.createSession(owner(app), { cwd: `${VIRTUAL}/../${root}/made-by-mistake` }),
        /isn't there/,
    );
    assert.ok(!existsSync(join(root, "made-by-mistake")));

    const id = await newSession(app, `${VIRTUAL}/bots/slash/`);

    assert.equal(app.cwdOf(id), `${VIRTUAL}/bots/slash`);
});

test("someone other than the owner reaches only the session's folder, links included", async () => {
    const id = await newSession(app, `${VIRTUAL}/bots/theta`);
    const folder = join(real, "bots", "theta");

    mkdirSync(folder, { recursive: true });

    writeFileSync(join(real, "secret.txt"), "the-owner-only\n");
    writeFileSync(join(folder, "shared.txt"), "for-everyone\n");
    symlinkSync(join(real, "secret.txt"), join(folder, "link.txt"));

    const guest = app.config.addUser("Theta guest", "guest", [String(id)]).user;
    const shared = await app.workspace.viewFile(id, guest, "shared.txt");

    assert.equal(shared.kind === "text" && shared.text, "for-everyone\n");
    await assert.rejects(app.workspace.viewFile(id, guest, "link.txt"), /not there/);
    await assert.rejects(app.workspace.viewFile(id, guest, `${VIRTUAL}/secret.txt`), /not there/);

    const owners = await app.workspace.viewFile(id, owner(app), "link.txt");

    assert.equal(owners.kind === "text" && owners.text, "the-owner-only\n");
});

// ─── The Computer's lifecycle, with a fake docker ───────────────────────────────────────────

/** A docker that remembers what it was asked, with a container in `state` and an image present or not. */
function fakeDocker(initial: { state: "missing" | "stopped" | "running"; image: boolean }) {
    const calls: string[] = [];
    let { state, image } = initial;

    const docker: Docker = async (args) => {
        calls.push(args.slice(0, 2).join(" "));
        await new Promise((resolve) => setTimeout(resolve, 5));

        if (args[0] === "inspect") {
            if (state === "missing") {
                throw new Error("No such container");
            }

            return state === "running" ? "true" : "false";
        }

        if (args[0] === "image") {
            if (!image) {
                throw new Error("No such image");
            }

            return "sha256:1";
        }

        if (args[0] === "build") {
            image = true;
        }

        if (args[0] === "run" || args[0] === "start") {
            state = "running";
        }

        if (args[0] === "stop") {
            state = "stopped";
        }

        return "";
    };

    return { docker, calls };
}

test("the computer is created once when missing, started when stopped, left alone when running", async () => {
    const missing = fakeDocker({ state: "missing", image: true });
    const computer = new Computer({}, missing.docker);

    await Promise.all([computer.start(), computer.start(), computer.start()]);
    assert.equal(
        missing.calls.filter((call) => call.startsWith("run")).length,
        1,
        "one container for three asks",
    );
    assert.equal(await computer.state(), "running");

    const stopped = fakeDocker({ state: "stopped", image: true });

    await new Computer({}, stopped.docker).start();
    assert.ok(stopped.calls.includes("start noid-computer"));
    assert.ok(!stopped.calls.some((call) => call.startsWith("run")));

    const running = fakeDocker({ state: "running", image: true });

    await new Computer({}, running.docker).start();
    assert.deepEqual(running.calls, ["inspect --type"]);
});

test("the computer stops only after its idle time, never while held", async () => {
    let now = 0;
    const { docker, calls } = fakeDocker({ state: "running", image: true });
    const computer = new Computer({ idleMs: 1000, now: () => now }, docker);

    assert.equal(computer.idle(), false);
    now = 999;
    assert.equal(computer.idle(), false);
    now = 1000;
    assert.equal(computer.idle(), true);

    const release = computer.hold();

    now = 5000;
    assert.equal(computer.idle(), false, "held");
    release();
    assert.equal(computer.idle(), false, "a release is activity");
    now = 6000;
    assert.equal(computer.idle(), true);
    // An idle stop that finds work begun while docker answered leaves the container running.
    const busy = computer.stop({ ifIdle: true });
    const hold = computer.hold();

    await busy;
    assert.ok(!calls.includes("stop --time"), "not stopped under work that began meanwhile");
    hold();
    now = 20_000;
    await computer.stop({ ifIdle: true });
    assert.ok(calls.includes("stop --time"));
    assert.equal(await computer.state(), "stopped");
    await computer.close(context);
});

test("closing the computer cleans up its environments (they are proxies over pi-env's)", async () => {
    const { docker } = fakeDocker({ state: "running", image: true });
    const computer = new Computer({}, docker);

    computer.env("/home/noid/bots/one");
    computer.env("/home/noid/bots/two/");
    await computer.close(context);
});

test("a computer that cannot start gives an error result, not a throw", async () => {
    const broken: Docker = async (args) => {
        throw new Error(args[0] === "build" ? "no docker here" : "No such object");
    };

    const computer = new Computer({}, broken);
    const result = await computer.env("/home/noid/bots/down").exec("true", undefined, context);

    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error.message : "", /Could not make \/home\/noid\/bots\/down/);
    await computer.close(context);
});
