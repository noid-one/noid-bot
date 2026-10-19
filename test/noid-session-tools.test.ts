// noid: Noid, the owner's own assistant, has the session tools beside its own (bash included), its prompt says that
// work in Noid's words, it stays in the list, and nobody but the owner may see it (its tools act as the owner). Every
// other bot has the session tools too; a conversation pi-pocket's assistant left behind is kept out of the way, and
// what was stored under the session tools' old names (a bot's selection, the owner's choice in Extensions) carries
// over.
import {
    type App,
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { ConfigStore } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import {
    OLD_SESSION_TOOLS_EXTENSION,
    SESSION_TOOLS_EXTENSION,
} from "../src/server/session-tools.ts";

/** "show" answers with what Noid was given: its prompt's sections and its tools' names (from the system messages). */
const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);
    const system = (
        request as {
            messages: {
                role: string;
                content?: string;
                sections?: Record<string, string | null>;
                toolsAdded?: { name: string }[];
            }[];
        }
    ).messages.filter((message) => message.role === "system");
    const systemPrompt = system
        .flatMap((message) => [message.content ?? "", ...Object.values(message.sections ?? {})])
        .join("\n");
    const tools = system.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name));

    return fauxAssistantMessage([
        // A bot but Noid hears who it is from: "[from: Owner] show".
        fauxText(
            /^(?:\[from: [^\]]+\] )?show$/.test(text)
                ? JSON.stringify({ systemPrompt, tools })
                : `echo: ${text}`,
        ),
    ]);
};

let app: App;
let noid: ConversationId;

/** The last thing a conversation's model said. */
async function answer(id: ConversationId): Promise<string> {
    const entries = await app.transcripts.allEntries(id, true);
    const last = entries.findLast((entry) => entry.kind === "assistant");

    return last?.kind === "assistant"
        ? last.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : "";
}

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "noid-session-tools-data"), undefined, {
        mainBot: true,
    });
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    noid = app.sessionTools.noid()!;
    // Noid was made as the app opened, before any model was picked.
    await app.commands.configure(noid, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("Noid is the owner's own assistant, and stays in the list", () => {
    assert.notEqual(noid, undefined);
    assert.equal(app.sessionTools.ownerOf(noid), owner(app).id);
    assert.ok(app.sessions().some((session) => Number(session.id) === Number(noid)));
});

test("a conversation stored with pi-pocket's assistant mark loads, out of the list, its person's alone", async () => {
    const { id } = await app.commands.createSession(owner(app), {});

    // `pip`: what pi-pocket stored on its assistant's conversation.
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(id)]!.pip = owner(app).id;
    }, context);
    await until(() => app.sessionMeta(id)?.pip !== undefined, "the mark");

    assert.ok(!app.sessions().some((session) => Number(session.id) === Number(id)));
    assert.equal(app.canSee(app.config.addUser("Old guest", "guest").user, id), false);
    assert.equal(app.sessionTools.actsFor(id), undefined, "no session tools act for it");
});

test("Noid has the session tools beside its own, and its prompt says that work as Noid's", async () => {
    const extensions = (await app.agentState(noid))?.extensions;
    const names = Array.isArray(extensions) ? extensions : (extensions?.add ?? []);

    assert.ok(names.includes(SESSION_TOOLS_EXTENSION), "the session tools, selected");

    await say(app, noid, "show");
    const shown = JSON.parse(await answer(noid)) as {
        systemPrompt: string;
        tools: string[];
    };

    for (const tool of ["sessions", "session_read", "session_send", "approvals", "bot_message"]) {
        assert.ok(shown.tools.includes(tool), `${tool}, offered`);
    }

    assert.ok(shown.tools.includes("bash"), "Noid keeps its own tools");
    assert.match(shown.systemPrompt, /Besides your bots, you look after/);
    assert.doesNotMatch(shown.systemPrompt, /PiP|Pi in Pocket/);
});

test("Noid acts as the owner, so only the owner sees it", () => {
    const { user: guest } = app.config.addUser("Guest", "guest");

    assert.equal(app.canSee(owner(app), noid), true);
    assert.equal(app.canSee(guest, noid), false);
});

test("every bot has the session tools, acting as the owner; bots are not sessions there", async () => {
    const { id: bot } = await app.bots.create(owner(app), { name: "Scout", role: "Finds things" });
    const extensions = (await app.agentState(bot))?.extensions;
    const names = Array.isArray(extensions) ? extensions : (extensions?.add ?? []);

    assert.ok(names.includes(SESSION_TOOLS_EXTENSION), "the session tools, selected");
    await app.commands.configure(bot, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await say(app, bot, "show");
    const shown = JSON.parse(await answer(bot)) as { systemPrompt: string; tools: string[] };

    for (const tool of ["sessions", "session_start", "session_send", "bot_message"]) {
        assert.ok(shown.tools.includes(tool), `${tool}, offered`);
    }

    assert.ok(!shown.tools.includes("bot_create"), "making bots stays Noid's");
    assert.match(shown.systemPrompt, /You can also work through sessions/);
    assert.doesNotMatch(shown.systemPrompt, /PiP|Besides your bots/);

    assert.equal(app.sessionTools.actsFor(bot), owner(app).id);
    assert.equal(app.sessionTools.ownerOf(bot), undefined, "a bot is not the owner's own");
    assert.equal(app.canSee(app.config.addUser("Visitor", "guest").user, bot), false);

    const { sessions } = app.sessionTools.sessions(bot);

    assert.ok(!sessions.some((session) => Number(session.id) === Number(noid)), "Noid is a bot");
    await assert.rejects(app.sessionTools.read(bot, Number(noid)), /is a bot/);
});

test("the list says what a bot last said, under its name", async () => {
    await say(app, noid, "hello there");
    await until(
        () =>
            app
                .sessions()
                .find((session) => Number(session.id) === Number(noid))
                ?.said?.endsWith("hello there") === true,
        "the list to say Noid's last words",
    );
});

test("a bot whose selection names the session tools as pi-pocket did gets them under their new name", async () => {
    const named = (extensions: unknown) =>
        Array.isArray(extensions)
            ? (extensions as string[])
            : [
                  ...((extensions as { add?: string[] } | undefined)?.add ?? []),
                  ...((extensions as { remove?: string[] } | undefined)?.remove ?? []),
              ];
    const old = (names: string[]) =>
        names.map((name) =>
            name === SESSION_TOOLS_EXTENSION ? OLD_SESSION_TOOLS_EXTENSION : name,
        );
    const { id: listed } = await app.bots.create(owner(app), { name: "Lister", role: "Lists" });
    const { id: added } = await app.bots.create(owner(app), { name: "Adder", role: "Adds" });

    // As stored before the rename: one selection a list, one a set of additions.
    await app.harness.commit(async (tx) => {
        const first = await tx.doc(AgentDoc, listed);
        const second = await tx.doc(AgentDoc, added);

        first.extensions = old(named(first.extensions));
        second.extensions = { add: old(named(second.extensions)) };
    }, context);

    for (const bot of [listed, added]) {
        assert.ok(
            named((await app.agentState(bot))?.extensions).includes(OLD_SESSION_TOOLS_EXTENSION),
        );
    }

    await app.bots.ensureTools();

    for (const bot of [listed, added]) {
        const names = named((await app.agentState(bot))?.extensions);

        assert.ok(names.includes(SESSION_TOOLS_EXTENSION), "the new name");
        assert.ok(!names.includes(OLD_SESSION_TOOLS_EXTENSION), "the old one gone");
        await app.commands.configure(bot, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
        });
        await say(app, bot, "show");
        const shown = JSON.parse(await answer(bot)) as { tools: string[] };

        assert.ok(shown.tools.includes("sessions"), "the session tools, offered");
    }

    assert.ok(Array.isArray((await app.agentState(listed))?.extensions), "a list stays a list");
});

test("the owner's choice in Extensions under the session tools' old file name carries over", () => {
    const folder = join(root, "renamed-config");

    mkdirSync(folder, { recursive: true });
    writeFileSync(
        join(folder, "config.json"),
        JSON.stringify({ version: 1, ownerToken: "t", users: [], disabledExtensions: ["pip.ts"] }),
    );
    const config = new ConfigStore(folder);

    assert.equal(config.extensionChoice("session-tools.ts"), false);
    assert.equal(config.extensionChoice("pip.ts"), undefined);
});
