// A person's Stop of a subagent (Pi Pocket e3aa23d1): said to its parent as a stop, not a failure; the message the
// Stop held is followed to its answer once someone sends it, or reported dropped when someone drops it. The parent's own
// `subagent stop` is said as such too.
import {
    type App,
    cleanUp,
    context,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    say as sayAs,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { HeldDoc, SubagentsDoc } from "../src/server/docs.ts";

/** A command that prints nothing and never ends by itself. */
const HANG = "exec tail -f /dev/null";

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: said } = lastText(request as never);
    const text = said.replace(/^\[from: [^\]]+\] /, "");
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (subagent !== undefined) {
        // Its first task hangs on a command; anything after it answers.
        if (role === "user" && text.startsWith("Check ")) {
            return fauxAssistantMessage([fauxToolCall("bash", { command: HANG })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText(`result of ${subagent}: ${text.slice(0, 40)}`)]);
    }

    const action = /^(spawn|nudge|halt) (\S+)$/.exec(text);

    if (action !== null) {
        const [, verb, name] = action;
        const args =
            verb === "spawn"
                ? { action: "spawn", name, message: `Check ${name}.` }
                : verb === "nudge"
                  ? { action: "send", name, message: "One more thing." }
                  : { action: "stop", name };

        return fauxAssistantMessage([fauxToolCall("subagent", args as never)], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText("noted")]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "subagent-stop-follow"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function session(): Promise<ConversationId> {
    const id = await newSession(app);

    await loadTools(app, id, "subagent");

    return id;
}

const say = (id: ConversationId, text: string) => sayAs(app, id, text);

/** The messages the parent got, each as its text. */
async function inbox(id: ConversationId): Promise<string[]> {
    return (await (await app.harness.conversation(id, context))!.context(context)).messages
        .filter((message) => message.role === "user")
        .map((message) =>
            typeof message.content === "string"
                ? message.content
                : (message.content as { text?: string }[]).map((part) => part.text ?? "").join(""),
        );
}

const agent = async (id: ConversationId, name: string) =>
    (await app.harness.snapshot(SubagentsDoc, id, context))!.agents[name]!;

/** Whether the subagent waits on a running call. */
async function stuck(id: ConversationId, name: string): Promise<boolean> {
    const live = await app.harness.snapshot(
        LiveDoc,
        (await agent(id, name)).conversationId,
        context,
    );

    return live?.tools?.some((tool) => tool.status === "running") === true;
}

const told = async (id: ConversationId, what: string | RegExp) =>
    (await inbox(id)).some((text) =>
        typeof what === "string" ? text.includes(what) : what.test(text),
    );

/** A stuck subagent with a message queued behind its stuck call, stopped by a person: its conversation. */
async function stoppedWithHeld(id: ConversationId, name: string): Promise<ConversationId> {
    await say(id, `spawn ${name}`);
    await until(() => stuck(id, name), "the subagent on a stuck call");
    await say(id, `nudge ${name}`);

    const child = (await agent(id, name)).conversationId;

    await app.commands.abort(child, owner(app));
    await until(
        () => told(id, `${name} stopped: a person stopped it before it answered`),
        "the report of the Stop",
    );
    await until(
        () => told(id, `${name} stopped: a person stopped it. Your message waits, held`),
        "word that the message waits, held, while nobody sends it",
    );
    await until(() => !app.isBusy(child), "the subagent stopped");

    return child;
}

test("a person's Stop is said as such, and the message it held reaches the parent with its answer", async () => {
    const id = await session();
    const child = await stoppedWithHeld(id, "held");

    assert.equal(await app.commands.sendHeld(child, owner(app)), 1);
    await until(
        () => told(id, /\[subagent held answered[^]*One more thing/),
        "the answer to the held message",
    );
    assert.ok(!(await inbox(id)).join("\n").includes("held failed"), "a Stop is no failure");
});

test("a held message a person drops is reported dropped", async () => {
    const id = await session();
    const child = await stoppedWithHeld(id, "dropped");
    const key = (await app.harness.snapshot(HeldDoc, child, context))!.items[0]!.key;

    await app.commands.dropHeld(child, owner(app), key);
    await until(
        () =>
            told(
                id,
                "dropped stopped: a person stopped it, and took your message out of its queue",
            ),
        "the report of the dropped message",
    );
    assert.ok(!(await inbox(id)).join("\n").includes("dropped failed"), "a Stop is no failure");
});

test("the parent's own stop is said as its own", async () => {
    const id = await session();

    await say(id, "spawn halted");
    await until(() => stuck(id, "halted"), "the subagent on a stuck call");
    await say(id, "halt halted");
    await until(
        () => told(id, "halted stopped: you stopped it before it answered"),
        "the report of the parent's stop",
    );
    assert.equal((await agent(id, "halted")).stoppedBy, "parent");
    assert.ok(!(await inbox(id)).join("\n").includes("halted failed"), "a stop is no failure");
});
