// The shared computer for real: Docker, the computer image, pi-env over `docker exec`. Opt-in, as it needs Docker and
// builds or starts a container: NOID_DOCKER=docker npm test (or node --test test/computer.docker.test.ts). Without
// NOID_DOCKER every test here is skipped.
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
const skip = enabled ? false : "set NOID_DOCKER to run the shared computer's Docker tests";
const docker = dockerCommand(process.env.NOID_DOCKER ?? "docker");
/** A run of this file has its own folders on the computer, so runs never see each other's files. */
const run = randomUUID().slice(0, 8);
const folder = (name: string) => `/home/noid/bots/test-${run}-${name}`;
const onComputer = (script: string) => docker(["exec", "noid-computer", "sh", "-c", script]);
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
        await docker(["restart", "--time", "2", "noid-computer"]);
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
