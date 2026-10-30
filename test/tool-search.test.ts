// Tool search: tools that few conversations use (and their prompt sections) wait until Pi searches for them (pp 0.27).
import {
    type App,
    cleanUp,
    context,
    until,
    lastText,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";

let app: App;
/** The sections of the newest request, by name: every system message adds the ones that changed since the last. */
let sections: Record<string, string> = {};
let resultParts: string[] = [];

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const last = (request.messages as { role: string; content?: { type: string }[] }[]).findLast(
        (message) => message.role !== "system",
    );

    if (last?.role === "toolResult") {
        resultParts = (last.content ?? []).map((part) => part.type);
    }

    sections = Object.assign(
        {},
        ...(request.messages as { role: string; sections?: Record<string, string> }[])
            .filter((message) => message.role === "system")
            .map((message) => message.sections ?? {}),
    ) as Record<string, string>;

    if (role !== "toolResult" && text.includes("need the browser")) {
        return fauxAssistantMessage([fauxToolCall("tool_search", { query: "browser" })], {
            stopReason: "toolUse",
        });
    }

    if (role === "user" && text.includes("screenshot from a script")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("codemode", {
                    code: 'return await tools.browser({ action: "screenshot" })',
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (role === "user" && text.includes("start a browsing subagent")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: "looker",
                    message: "Look.",
                    tools: ["read", "browser"],
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (role !== "toolResult" && text.includes("need pull request checks")) {
        return fauxAssistantMessage(
            [fauxToolCall("tool_search", { query: "pull request checks" })],
            {
                stopReason: "toolUse",
            },
        );
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app.close();
    cleanUp();
});

async function agent(id: ConversationId) {
    const each = await (await app.conversation(id)).agent(context);

    return {
        offered: each.tools.map((tool) => tool.name),
        waiting: each.deferred.map((tool) => tool.name),
    };
}

test("a new conversation is offered tool_search, not the tools that wait, and their sections stay out", async () => {
    const id = await newSession(app);
    const { offered, waiting } = await agent(id);

    assert.ok(offered.includes("tool_search"));
    assert.ok(offered.includes("artifact"), "tools in common use are offered");

    for (const name of ["browser", "schedule", "watch_pr"]) {
        assert.ok(!offered.includes(name), `${name} waits`);
        assert.ok(waiting.includes(name), `${name} can be loaded`);
    }

    await say(app, id, "hello");

    // "no section" matches none of the patterns below, so a missing section fails each of them.
    assert.match(sections.deferred_tools ?? "no section", /- browser: /);
    assert.match(sections.deferred_tools ?? "no section", /- schedule: /);
    assert.equal(sections.browser, undefined, "browser is not shown while its tool waits");
});

/** A session on `faux-native`: the model of a provider that takes tool changes in the messages. */
async function nativeSession() {
    const id = await newSession(app);

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-native" },
        thinkingLevel: "off",
    });

    return id;
}

test("on a model with tool changes in the messages, a query of tool names loads exactly those, with their section", async () => {
    const id = await nativeSession();

    await say(app, id, "need the browser");
    await say(app, id, "and now?");

    const { offered, waiting } = await agent(id);

    assert.ok(offered.includes("browser"), "browser is offered after the search");
    assert.ok(!waiting.includes("browser"));
    assert.ok(!offered.includes("schedule"), "a tool the search did not match still waits");
    assert.match(sections.browser ?? "no section", /Chromium/);
    assert.match(sections.deferred_tools ?? "no section", /- schedule:/);
    assert.doesNotMatch(sections.deferred_tools ?? "no section", /- browser:/);
});

test("on any other model, a search leaves the tool list alone and the tool is called from codemode", async () => {
    const id = await newSession(app);

    await say(app, id, "need the browser");
    await say(app, id, "and now?");

    const { offered, waiting } = await agent(id);
    const result = (await app.transcripts.allEntries(id, false)).find(
        (entry) =>
            entry.kind === "toolResult" && (entry as { name?: string }).name === "tool_search",
    ) as { text?: string } | undefined;

    assert.ok(
        !offered.includes("browser"),
        "the list, where the prompt cache starts, did not change",
    );
    assert.ok(waiting.includes("browser"));
    assert.match(result?.text ?? "no result", /tools\.browser\(/);
    assert.match(result?.text ?? "no result", /Parameters \(JSON Schema\)/);
    assert.match(
        result?.text ?? "no result",
        /Chromium/,
        "with what the browser's section would say",
    );
    assert.equal(sections.browser, undefined);

    const callable = (await (await app.conversation(id)).agent(context)).callable.map(
        (tool) => tool.name,
    );

    assert.ok(callable.includes("browser"), "a script can call it");
});

test("on that route, a screenshot taken by a script reaches the model", async () => {
    const id = await newSession(app);

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-vision" },
    });
    await say(app, id, "need the browser");
    await say(app, id, "screenshot from a script");

    assert.deepEqual(resultParts, ["text", "text", "image"]);
});

test("a word that is no tool's name searches, and gives at most two matches", async () => {
    const id = await newSession(app);

    await say(app, id, "need pull request checks");

    const result = (await app.transcripts.allEntries(id, false)).find(
        (entry) =>
            entry.kind === "toolResult" && (entry as { name?: string }).name === "tool_search",
    ) as { text?: string } | undefined;
    const headings = (result?.text ?? "").match(/^## /gm)?.length ?? 0;

    assert.ok(headings >= 1 && headings <= 2, `matches: ${headings}`);
});

test("a subagent can be given a tool that waits in its session", async () => {
    const id = await newSession(app);

    await say(app, id, "start a browsing subagent");

    let child: ConversationId | undefined;

    await until(async () => {
        child = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.looker
            ?.conversationId;

        return child !== undefined;
    }, "the subagent starts");

    assert.deepEqual((await agent(child!)).offered.sort(), ["browser", "read"]);
});
