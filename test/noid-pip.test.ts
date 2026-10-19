// noid: Noid does PiP's work. Where there is a main bot, the owner's "PiP" is Noid's conversation: it has PiP's tools
// beside its own (bash included), its prompt says that work in Noid's words, it stays in the list, no separate PiP is
// made, and nobody but the owner may see it (its tools act as the owner).
import {
    type App,
    cleanUp,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PIP_EXTENSION } from "../src/server/pip.ts";

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
        fauxText(text === "show" ? JSON.stringify({ systemPrompt, tools }) : `echo: ${text}`),
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
    app = await openApp(scriptedModel(route), join(root, "noid-pip-data"), undefined, {
        mainBot: true,
    });
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    noid = app.pip.noid()!;
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

test("the owner's PiP is Noid: no other is made, and Noid stays in the list", async () => {
    assert.notEqual(noid, undefined);
    assert.equal(app.pip.idOf(owner(app).id), noid);
    assert.equal(app.pip.ownerOf(noid), owner(app).id);
    assert.equal(await app.pip.ensure(owner(app)), noid, "PiP's conversation is Noid's");
    assert.equal(
        Object.values(app.sessionCatalogue()).filter((meta) => meta.pip !== undefined).length,
        0,
        "no separate PiP",
    );
    assert.ok(app.sessions().some((session) => Number(session.id) === Number(noid)));
});

test("Noid has PiP's tools beside its own, and its prompt says that work as Noid's", async () => {
    const extensions = (await app.agentState(noid))?.extensions;
    const names = Array.isArray(extensions) ? extensions : (extensions?.add ?? []);

    assert.ok(names.includes(PIP_EXTENSION), "PiP's extension, selected");

    await say(app, noid, "show");
    const shown = JSON.parse(await answer(noid)) as {
        systemPrompt: string;
        tools: string[];
    };

    for (const tool of ["sessions", "session_read", "session_send", "approvals", "bot_message"]) {
        assert.ok(shown.tools.includes(tool), `${tool}, offered`);
    }

    assert.ok(shown.tools.includes("bash"), "Noid keeps its own tools: PiP's limits are not its");
    assert.match(shown.systemPrompt, /Besides your bots, you look after/);
    assert.doesNotMatch(shown.systemPrompt, /You are PiP/);
});

test("Noid acts as the owner, so only the owner sees it", () => {
    const { user: guest } = app.config.addUser("Guest", "guest");

    assert.equal(app.canSee(owner(app), noid), true);
    assert.equal(app.canSee(guest, noid), false);
});
