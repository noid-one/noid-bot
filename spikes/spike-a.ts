/**
 * Phase 0, spike A: Pi's tools through pi-env, one environment shared by several bots, surviving a crash.
 *
 *   node spikes/spike-a.ts start  <data> <transport>   submit a long command, then hang (the runner SIGKILLs it)
 *   node spikes/spike-a.ts resume <data> <transport>   reopen the storage, resume, and report what happened
 *   node spikes/spike-a.ts shared <data> <transport>   two bots run commands and edit one shared file at once
 *
 * <transport> is `local` (pi-env's daemon on this machine) or `docker:<container>` (the daemon inside a container,
 * through `docker exec -i`; NOID_DOCKER names the docker binary). Every tool runs through a RemoteExecutionEnv with the
 * same id, "noid:computer", so the bots share one computer and differ only in their folders: bots/a and bots/b.
 * Output is one JSON object per line.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Connection, localDaemon, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [mode = "", data = "", transport = "local"] = process.argv.slice(2);
const say = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

mkdirSync(data, { recursive: true });

/** The computer's home: a folder on this machine for `local`, the container's home for docker. */
const home = transport === "local" ? join(data, "computer") : "/home/noid";

if (transport === "local") {
    mkdirSync(home, { recursive: true });
}

const docker = process.env.NOID_DOCKER ?? "docker";
const command =
    transport === "local"
        ? [localDaemon()]
        : [docker, "exec", "-i", transport.slice("docker:".length), "/opt/pi-env/pi-env"];
const connection = new Connection({ command });
const envAt = (cwd: string) => new RemoteExecutionEnv({ connection, id: "noid:computer", cwd });

/** "run COMMAND" calls bash; "edit FILE OLD NEW" calls edit; a tool result is answered with its text. */
const faux = fauxProvider({ tokensPerSecond: 5000 });

const lastText = (request: { messages: { role: string; content: unknown }[] }) => {
    const last = request.messages.at(-1)!;
    const text =
        typeof last.content === "string"
            ? last.content
            : (last.content as { type: string; text?: string }[])
                  .map((part) => (part.type === "text" ? part.text : ""))
                  .join("");

    return { role: last.role, text: text.trim() };
};

faux.setResponses(
    Array.from({ length: 100 }, () => (request: never) => {
        const { role, text } = lastText(request);

        if (role === "toolResult") {
            return fauxAssistantMessage([fauxText(`tool said: ${text.slice(0, 200)}`)]);
        }

        const [verb, ...rest] = text.split(" ");

        if (verb === "run") {
            return fauxAssistantMessage([fauxToolCall("bash", { command: rest.join(" ") })], {
                stopReason: "toolUse",
            });
        }

        if (verb === "edit") {
            const [path = "", oldText = "", newText = ""] = rest;

            return fauxAssistantMessage(
                [fauxToolCall("edit", { path, edits: [{ oldText, newText }] })],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    }) as never,
);

const models = createModels();

models.setProvider(faux.provider);

const registry = createRegistry();

registry.install(CodingTools);

const harness = await Harness.open(
    await openNodeSqliteStorage(join(data, "spike.sqlite")),
    { models, registry, env: ({ cwd }) => envAt(cwd ?? home) },
    context,
);
const agent = (name: string) => ({
    model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
    extensions: [CodingTools],
    cwd: `${home}/bots/${name}`,
});
const LONG = {
    type: "input" as const,
    content: "run echo started > marker; sleep 25; echo finished >> marker",
    requestId: "spike-a-long",
};

/** What the model saw from its tool calls: the text of each tool result, newest last. */
async function toolResults(conversation: { context: (c: typeof context) => Promise<unknown> }) {
    const { messages } = (await conversation.context(context)) as {
        messages: { role: string; isError?: boolean; content: { type: string; text?: string }[] }[];
    };

    return messages
        .filter((message) => message.role === "toolResult")
        .map((message) => ({
            isError: message.isError === true,
            text: message.content
                .map((part) => part.text ?? "")
                .join("")
                .slice(0, 240),
        }));
}

/** Runs a shell command on the computer, returning its output (or its error). */
async function sh(cwd: string, script: string) {
    let output = "";
    const result = await envAt(cwd).exec(
        script,
        { onOutput: (text) => void (output += text) },
        context,
    );

    return result.ok ? output.trim() : `error: ${String(result.error)}`;
}

try {
    if (mode === "start") {
        say({
            setup: await sh(
                home,
                "mkdir -p bots/a bots/b shared && rm -f bots/a/marker && echo ok",
            ),
        });

        const a = await harness.root(context, { agent: agent("a") });
        const submission = await a.submit(LONG, context);

        say({ submitted: submission.id, at: Date.now() });
        await new Promise(() => {});
    }

    if (mode === "resume") {
        const started = Date.now();
        // Nothing runs a process here: the daemon died with the last one, and with it everything it started.
        const before = await sh(home, "ps -eo args | grep -c '^sleep 25$' || true");

        harness.resume();

        const a = await harness.root(context);
        const submission = await a.submit(LONG, context);
        const settled = await submission.wait(context);

        say({
            sleepsRunningBeforeResume: before,
            sameSubmission: submission.id,
            settled: settled.status,
            tookMs: Date.now() - started,
            toolResults: await toolResults(a),
            marker: await sh(`${home}/bots/a`, "cat marker 2>&1"),
        });
    }

    if (mode === "shared") {
        await sh(
            home,
            "mkdir -p bots/a bots/b shared && printf 'LINE_A\\nLINE_B\\n' > shared/x.md && rm -f shared/log",
        );

        const a = await harness.root(context, { agent: agent("a") });
        const b = await harness.createConversation(
            { ownership: { kind: "ownerless" }, agent: agent("b") },
            context,
        );
        const started = Date.now();
        const runs = await Promise.all([
            a.submit({ type: "input", content: "run sleep 3; pwd >> ../../shared/log" }, context),
            b.submit({ type: "input", content: "run sleep 3; pwd >> ../../shared/log" }, context),
        ]);

        await Promise.all(runs.map((run) => run.wait(context)));

        const parallelMs = Date.now() - started;
        const edits = await Promise.all([
            a.submit({ type: "input", content: "edit ../../shared/x.md LINE_A A_DONE" }, context),
            b.submit({ type: "input", content: "edit ../../shared/x.md LINE_B B_DONE" }, context),
        ]);

        await Promise.all(edits.map((run) => run.wait(context)));
        say({
            parallelMs,
            log: await sh(home, "cat shared/log"),
            shared: await sh(home, "cat shared/x.md"),
            aSaw: (await toolResults(a)).at(-1),
            bSaw: (await toolResults(b)).at(-1),
        });
    }
} finally {
    if (mode !== "start") {
        await harness.close(context);
        await connection.close();
    }
}
