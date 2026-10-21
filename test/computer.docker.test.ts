// The shared computer for real: Docker, the computer image, pi-env over `docker exec`. Opt-in, as it needs Docker and
// builds or starts a container: NOID_DOCKER=docker npm test (or node --test test/computer.docker.test.ts). Without
// NOID_DOCKER every test here is skipped. They use a computer of their own, noid-computer-test (NOID_COMPUTER), which
// they stop and restart; the owner's noid-computer is never touched. `docker rm -f noid-computer-test` after, if wanted.
import {
    type App,
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Computer, dockerCommand } from "../src/server/noid/computer.ts";
import { route } from "./computer-route.ts";

const enabled = process.env.NOID_DOCKER !== undefined;
// A computer of the tests' own: the owner's (noid-computer), maybe in use, is never stopped or restarted by them.
const NAME = (process.env.NOID_COMPUTER ??= "noid-computer-test");
const skip = enabled ? false : "set NOID_DOCKER to run the shared computer's Docker tests";
const docker = dockerCommand(process.env.NOID_DOCKER ?? "docker");
/** A run of this file has its own folders on the computer, so runs never see each other's files. */
const run = randomUUID().slice(0, 8);
const folder = (name: string) => `/home/noid/bots/test-${run}-${name}`;
const onComputer = (script: string) => docker(["exec", NAME, "sh", "-c", script]);
let app: App | undefined;

before(async () => {
    if (enabled) {
        app = await openApp(scriptedModel(route), join(root, "docker-data"));
    }
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function answer(id: ConversationId): Promise<string> {
    const entries = await app!.transcripts.allEntries(id, true);
    const last = entries.findLast((entry) => entry.kind === "assistant");

    return last?.kind === "assistant"
        ? last.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : "";
}

test(
    "Pi's tools, ! commands, and the viewer run in the session's folder on the computer",
    { skip },
    async () => {
        const id = await newSession(app!, folder("tools"));

        await say(app!, id, "run pwd && whoami && echo from-pi > made-by-pi.txt");
        assert.match(await answer(id), new RegExp(`ok: ${folder("tools")}\\s+noid`));
        assert.equal(await onComputer(`cat ${folder("tools")}/made-by-pi.txt`), "from-pi");

        await app!.shell.start(id, owner(app!), { command: "cat made-by-pi.txt && pwd" });

        const shellOutput = async () => {
            const shell = (await app!.transcripts.history(id, Number.MAX_SAFE_INTEGER)).find(
                (entry) => entry.kind === "shell",
            );

            return shell?.kind === "shell" ? shell.output : undefined;
        };

        await until(
            async () => (await shellOutput()) !== undefined,
            "the ! command's entry",
            30_000,
        );
        assert.equal(await shellOutput(), `from-pi\n${folder("tools")}\n`);
        assert.match(
            (await modelTexts(app!, id)).join("\n"),
            /from-pi/,
            "Pi sees the ! command's output",
        );

        const view = await app!.workspace.viewFile(id, owner(app!), "made-by-pi.txt");

        assert.equal(view.kind === "text" && view.text, "from-pi\n");
        assert.deepEqual((await app!.workspace.fileList(id, owner(app!))).files, [
            "made-by-pi.txt",
        ]);
    },
);

test(
    "a server killed mid-command resumes: the call is interrupted and nothing is left running",
    { skip },
    async () => {
        const data = join(root, "docker-crash");
        const place = folder("crash");
        const child = spawn(
            process.execPath,
            [join(import.meta.dirname, "computer-crash-child.ts"), data, place],
            {
                stdio: ["ignore", "pipe", "inherit"],
                env: { ...process.env, NODE_NO_WARNINGS: "1" },
            },
        );
        let said = "";

        child.stdout.on("data", (chunk) => (said += String(chunk)));
        await until(() => said.includes("requestId"), "the child to start the command", 60_000);
        await until(
            async () => (await onComputer(`cat ${place}/marker 2>/dev/null || true`)) === "started",
            "the command to be running",
            30_000,
        );
        assert.equal(await onComputer("ps -eo args | grep -c '^sleep 30$' || true"), "1");

        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
        await until(
            async () => (await onComputer("ps -eo args | grep -c '^sleep 30$' || true")) === "0",
            "the command to stop with the server",
            15_000,
        );

        // The next server: the same request is the same submission, and the cut-off call comes back interrupted.
        const { id, requestId } = JSON.parse(said.trim()) as {
            id: ConversationId;
            requestId: string;
        };
        const next = await openApp(scriptedModel(route), data);

        try {
            next.harness.resume();
            const { submissionId } = await next.commands.submit(id, owner(next), {
                text: "run echo started > marker && sleep 30 && echo finished >> marker",
                requestId,
            });

            await (await next.harness.submission(submissionId, context))!.wait(context);
            assert.match(
                (await modelTexts(next, id)).join("\n"),
                /interrupted and may have partially run/,
            );
            assert.equal(await onComputer(`cat ${place}/marker`), "started");
        } finally {
            await next.close();
        }
    },
);

test(
    "after a container restart, the next call reconnects and the files are still there",
    { skip },
    async () => {
        const id = await newSession(app!, folder("restart"));

        await say(app!, id, "run echo kept > kept.txt");
        await docker(["restart", "--time", "2", NAME]);
        await say(app!, id, "run cat kept.txt");
        assert.equal((await answer(id)).trim(), "ok: kept");
    },
);

test(
    "the computer stops after its idle time and starts again on the next call",
    { skip },
    async () => {
        const computer = new Computer({ idleMs: 1500 });
        const stopWatching = computer.watchIdle(250);

        try {
            const env = computer.env("/home/noid");

            assert.ok((await env.exec("true", undefined, context)).ok);
            await until(
                async () => (await computer.state()) === "stopped",
                "the idle stop",
                30_000,
            );

            let output = "";
            const again = await env.exec(
                "echo back",
                { onOutput: (text) => void (output += text) },
                context,
            );

            assert.ok(again.ok);
            assert.equal(output.trim(), "back");
            assert.equal(await computer.state(), "running");
        } finally {
            stopWatching();
            await computer.close(context);
        }
    },
);

test(
    "two bots share the computer: one leaves a file in shared/, the other reads it",
    { skip },
    async () => {
        const made = async (name: string) => {
            const { id } = await app!.bots.create(owner(app!), { name: `${name} ${run}` });

            await app!.commands.configure(id, owner(app!), {
                model: { provider: "faux", modelId: "faux-1" },
                thinkingLevel: "off",
            });

            return id;
        };

        const writer = await made("Writer");
        const reader = await made("Reader");

        await say(
            app!,
            writer,
            `run pwd && echo from-the-writer > /home/noid/shared/handoff-${run}.txt`,
        );
        assert.match(await answer(writer), new RegExp(`/home/noid/bots/writer-${run}`));
        await say(app!, reader, `run pwd && cat ../../shared/handoff-${run}.txt`);
        assert.match(
            await answer(reader),
            new RegExp(`/home/noid/bots/reader-${run}\\s+from-the-writer`),
        );
    },
);

test(
    "bots share the computer's one browser on its desktop: a tab each, one login for all, live frames",
    { skip },
    async () => {
        const made = async (name: string) =>
            (await app!.bots.create(owner(app!), { name: `${name} ${run}` })).id;
        const first = await made("Browser One");
        const second = await made("Browser Two");

        // A site on the computer, as a dev server a bot starts would be.
        await docker([
            "exec",
            "-d",
            NAME,
            "sh",
            "-c",
            "cd /tmp && python3 -m http.server 8765 --bind 127.0.0.1",
        ]);
        await until(
            async () =>
                (await onComputer(
                    "python3 -c \"import urllib.request as u; print(u.urlopen('http://127.0.0.1:8765/').status)\"",
                )) === "200",
            "the site to answer",
            20_000,
        );

        const one = await app!.browsers.open(Number(first));
        const two = await app!.browsers.open(Number(second));

        assert.ok(one.shared && two.shared, "tabs of the shared browser");
        assert.notEqual(one.targetId, two.targetId);
        assert.equal(one.contextId, two.contextId, "one context: one set of logins");

        await one.navigate("http://127.0.0.1:8765/");
        await one.evaluate(`document.cookie = "noid_login=${run}; max-age=86400; path=/"`);
        await two.navigate("http://127.0.0.1:8765/");
        assert.match(await two.evaluate("document.cookie"), new RegExp(`noid_login=${run}`));

        // Neither tab took the other for its popup.
        assert.ok(!one.closed && !two.closed);

        // People watch through the panel: frames keep coming for both, though one tab is behind the other.
        const firstFrame = await one.frame(0);
        const secondFrame = await two.frame(0);

        assert.ok(firstFrame !== undefined && secondFrame !== undefined, "frames for both tabs");

        await app!.browsers.close(Number(first));
        assert.ok(!two.closed, "closing one bot's tab leaves the other's");
        await app!.browsers.close(Number(second));
    },
);

test(
    "the computer's browser starts on a stopped computer, and outlives the bots letting go of it",
    { skip },
    async () => {
        const id = (await app!.bots.create(owner(app!), { name: `Cold ${run}` })).id;

        // A stopped computer: its display starts in the background as the browser asks for it.
        await app!.browsers.closeAll();
        await docker(["stop", "--time", "2", NAME]);

        const page = await app!.browsers.open(Number(id));

        assert.ok(page.shared);
        await page.navigate("about:blank");
        await page.evaluate("1 + 1");

        // Let go of and reached again at once: the desktop's browser kept running, its login with it.
        await docker([
            "exec",
            "-d",
            NAME,
            "sh",
            "-c",
            "cd /tmp && python3 -m http.server 8766 --bind 127.0.0.1",
        ]);
        await until(
            async () =>
                (await onComputer(
                    "python3 -c \"import urllib.request as u; print(u.urlopen('http://127.0.0.1:8766/').status)\"",
                )) === "200",
            "the site to answer",
            20_000,
        );
        await page.navigate("http://127.0.0.1:8766/");
        await page.evaluate(`document.cookie = "quick=${run}; max-age=86400; path=/"`);
        await app!.browsers.closeAll();

        const again = await app!.browsers.open(Number(id));

        await again.navigate("http://127.0.0.1:8766/");
        assert.match(await again.evaluate("document.cookie"), new RegExp(`quick=${run}`));
        assert.equal(
            await onComputer("pgrep -c -x chromium >/dev/null && echo running"),
            "running",
        );
        await app!.browsers.close(Number(id));
    },
);

test("the owner's terminal is a shell in a folder on the computer", { skip }, async () => {
    const terminals = app!.terminals;
    const { id, cwd } = await terminals.open(owner(app!), {
        cwd: folder("terminal"),
        cols: 100,
        rows: 30,
    });

    assert.equal(cwd, folder("terminal"));
    terminals.write(owner(app!), id, "echo hello-$((6*7)) && pwd && tput cols\n");

    let seen = "";
    let from = 0;

    await until(async () => {
        const read = await terminals.read(owner(app!), id, from);

        seen += Buffer.from(read.data, "base64").toString();
        from = read.next;

        return (
            seen.includes("hello-42") && seen.includes(folder("terminal")) && /\b100\b/.test(seen)
        );
    }, "the shell's answer");

    terminals.write(owner(app!), id, "exit 3\n");
    await until(async () => {
        const read = await terminals.read(owner(app!), id, from);

        from = read.next;

        return read.ended === "exited with code 3";
    }, "the shell to exit");
});

test("skills every bot shares, and git, work on the real computer", { skip }, async () => {
    const skill = `/home/noid/.agents/skills/test-${run}`;

    await onComputer(
        `mkdir -p ${skill} && printf -- '---\\nname: test-${run}\\ndescription: Marmot-${run} helper\\n---\\nBody\\n' > ${skill}/SKILL.md`,
    );

    try {
        const id = await newSession(app!, folder("skills"));

        await say(app!, id, `prompt has Marmot-${run}`);
        assert.equal(await answer(id), `has Marmot-${run}: true`);
        await say(app!, id, `prompt has ${skill}/SKILL.md`);
        assert.equal(await answer(id), `has ${skill}/SKILL.md: true`);
    } finally {
        await onComputer(`rm -rf ${skill}`);
    }

    const repo = folder("git");

    await onComputer(
        `mkdir -p ${repo} && cd ${repo} && git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m first && echo hi > note.txt`,
    );
    const id = await newSession(app!, repo);

    await until(() => app!.workspace.head(id) !== undefined, "the branch from git there");
    assert.deepEqual(app!.workspace.head(id), { branch: "main" });
    assert.deepEqual(
        (await app!.workspace.changes(id, owner(app!))).files.map((file) => [file.path, file.kind]),
        [["note.txt", "new"]],
    );
    assert.match(await app!.workspace.changeDiff(id, owner(app!), "note.txt"), /^\+hi$/m);
});

test(
    "a bot drives a program on the desktop, one bot at a time, and the owner watches",
    { skip },
    async () => {
        const make = async (name: string) => {
            const { id } = await app!.bots.create(owner(app!), {
                name: `${name}-${run}`,
                kind: "computer",
            });

            await app!.commands.configure(id, owner(app!), {
                model: { provider: "faux", modelId: "faux-1" },
                thinkingLevel: "off",
            });

            return id;
        };

        const painter = await make("Painter");
        const sculptor = await make("Sculptor");
        const mark = `desk-ok-${run}`;

        // A run cut short earlier may have left one open.
        await onComputer(`pkill -x xterm; rm -f /tmp/${mark}; true`);
        await say(app!, painter, 'desk {"action":"open","command":"xterm -geometry 80x24+0+0"}');
        assert.match(await answer(painter), /Did open\. Take a screenshot/);
        await say(app!, painter, 'desk {"action":"screenshot"}');
        assert.match(await answer(painter), /The desktop, 1280×800/);
        await say(app!, painter, 'desk {"action":"click","x":100,"y":100}');
        await say(app!, painter, `desk {"action":"type","text":"echo ok > /tmp/${mark}"}`);
        await say(app!, painter, 'desk {"action":"key","keys":"Return"}');
        await until(
            async () => (await onComputer(`cat /tmp/${mark} 2>/dev/null || true`)).trim() === "ok",
            "the typed command to run in xterm",
        );

        // xterm stayed open across Painter's turns (each run ended). While Painter holds it, Sculptor may look, not act.
        app!.desktop.lease.take({ id: String(painter), name: `Painter-${run}` });
        await say(app!, sculptor, 'desk {"action":"screenshot"}');
        assert.match(await answer(sculptor), new RegExp(`\\(Painter-${run} is using it\\)`));
        await say(app!, sculptor, 'desk {"action":"click","x":5,"y":5}');
        assert.match(await answer(sculptor), new RegExp(`Painter-${run} is using the desktop now`));

        const view = await app!.desktop.view(owner(app!));

        assert.ok(view.image.startsWith("iVBORw0KGgo"), "a PNG");
        // Released, what Painter opened closes.
        await say(app!, painter, 'desk {"action":"release"}');
        await until(
            async () => (await onComputer("pgrep -x xterm || true")).trim() === "",
            "Painter's xterm to close",
        );
        await onComputer(`rm -f /tmp/${mark}`);
    },
);

test(
    "the owner shows a task on the desktop, and every bot gets it as a skill",
    { skip },
    async () => {
        let desktop = app!.desktop;
        const name = `Stamp ${run}`;
        const slug = `stamp-${run}`;
        const skillDir = `/home/noid/.agents/skills/${slug}`;

        await onComputer(`pkill -x xterm; rm -rf ${skillDir}; true`);
        await desktop.teach(owner(app!), { name, goal: `Write a stamp file for run ${run}` });
        await desktop.act(owner(app!), { action: "open", command: "xterm -geometry 80x24+0+0" });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await desktop.act(owner(app!), { action: "click", x: 100, y: 100 });
        await desktop.act(owner(app!), { action: "type", text: `touch /tmp/${slug}` });

        // The server restarts in the middle of the lesson: it goes on where it was.
        await app!.close();
        app = await openApp(scriptedModel(route), join(root, "docker-data"));
        assert.equal((await app.desktop.view(owner(app))).teaching?.steps, 3);
        desktop = app.desktop;
        await desktop.act(owner(app), { action: "key", keys: "Return" });
        assert.equal((await desktop.view(owner(app!))).teaching?.steps, 4);

        // While the owner shows it, no bot acts on the desktop.
        assert.equal(desktop.lease.holder?.name, owner(app!).name);

        const saved = await desktop.learned(owner(app!), true);

        assert.deepEqual(saved, { folder: skillDir });
        assert.match(await onComputer(`cat ${skillDir}/SKILL.md`), /3\. Type "touch \/tmp\/stamp-/);
        assert.match(
            await onComputer(`ls ${skillDir}`),
            /end\.png[\s\S]*start\.png|start\.png[\s\S]*end\.png/,
        );

        // A second lesson of the same name would overwrite it: refused.
        await assert.rejects(desktop.teach(owner(app!), { name, goal: "again" }), /already/);

        // A bot on the computer finds it with its skills.
        const id = await newSession(app!, folder("skill-user"));

        await say(app!, id, `prompt has ${skillDir}/SKILL.md`);
        assert.equal(await answer(id), `has ${skillDir}/SKILL.md: true`);
        await desktop.act(owner(app!), { action: "release" });
        await onComputer(`rm -rf ${skillDir} /tmp/${slug}; pkill -x xterm; true`);
    },
);

test(
    "a link that opens a new tab, with or without noopener, opens in the bot's own tab",
    { skip },
    async () => {
        const { id } = await app!.bots.create(owner(app!), { name: `Popper ${run}` });
        const site = `/tmp/popups-${run}`;
        // A port of this run's own: a server another run left behind would answer for it.
        const port = 20_000 + Math.floor(Math.random() * 20_000);

        await onComputer(
            `mkdir -p ${site} && printf '%s' '<a id="plain" target="_blank" href="/plain.html">plain</a> <a id="noopener" target="_blank" rel="noopener noreferrer" href="/noopener.html">noopener</a>' > ${site}/index.html && echo plain > ${site}/plain.html && echo noopener > ${site}/noopener.html`,
        );
        await docker([
            "exec",
            "-d",
            NAME,
            "sh",
            "-c",
            `echo $$ > ${site}/pid && exec python3 -m http.server ${port} --bind 127.0.0.1 --directory ${site}`,
        ]);
        await until(
            async () =>
                (await onComputer(
                    `python3 -c "import urllib.request as u; print(u.urlopen('http://127.0.0.1:${port}/').status)" 2>/dev/null || true`,
                )) === "200",
            "the site to answer",
            20_000,
        );

        const page = await app!.browsers.open(Number(id));

        for (const link of ["plain", "noopener"]) {
            await page.navigate(`http://127.0.0.1:${port}/`);
            await page.click({ selector: `#${link}` });
            await until(
                () => page.url === `http://127.0.0.1:${port}/${link}.html`,
                `the ${link} link to open in the bot's tab`,
                15_000,
            );
        }

        await app!.browsers.close(Number(id));
        await onComputer(`kill $(cat ${site}/pid) 2>/dev/null; rm -rf ${site}; true`);
    },
);
