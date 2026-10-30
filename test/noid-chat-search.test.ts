// A bot searches what was said in its own chats: its conversation and its group threads, not anyone else's.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { GroupsDoc } from "../src/server/noid/groups.ts";

const app = await openApp(scriptedModel(), join(root, "chat-search-data"));

after(async () => {
    await app.close();
    cleanUp();
});

async function bot(name: string): Promise<{ id: ConversationId; botId: string }> {
    const { id } = await app.bots.create(owner(app), { name, kind: "host", folder: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return { id, botId: app.bots.list().find((each) => each.conversationId === id)!.bot.id };
}

test("a bot finds its own chat and its groups' words, not other groups' or sessions' (rakazo bf1e68dae)", async () => {
    const ada = await bot("Ada");
    const bea = await bot("Bea");
    const cy = await bot("Cy");
    const session = await newSession(app);

    await say(app, ada.id, "Keep the zebra-quartz plan for Friday.");
    await say(app, session, "zebra-quartz in a plain session");
    await app.harness.commit(async (tx) => {
        const doc = await tx.doc(GroupsDoc);
        const message = (id: string, from: string, name: string, text: string, at: number) => ({
            id,
            from,
            name,
            text,
            at,
        });

        doc.groups.ours = {
            id: "ours",
            name: "Ours",
            members: [ada.botId, bea.botId],
            messages: [message("m1", bea.botId, "Bea", "The zebra-quartz plan moved.", 2)],
            createdAt: 1,
        };
        doc.groups.theirs = {
            id: "theirs",
            name: "Theirs",
            members: [bea.botId, cy.botId],
            messages: [message("m2", cy.botId, "Cy", "A secret zebra-quartz note.", 3)],
            createdAt: 1,
        };
    }, context);

    const found = await app.chatSearch.search(ada.id, "Zebra-Quartz plan");

    assert.deepEqual(
        found.map((match) => [match.where, match.who]).sort(),
        [
            ["group Ours", "Bea"],
            ["your chat", "the owner"],
            // The scripted model echoes what it is told.
            ["your chat", "you"],
        ].sort(),
    );
    assert.ok(found.every((match) => !match.text.includes("secret")));
    assert.equal((await app.chatSearch.search(ada.id, "zebra-quartz nothing-like-it")).length, 0);
    await assert.rejects(app.chatSearch.search(session, "zebra-quartz"), /bot's own conversation/);

    // The tool is a bot's alone.
    const tools = async (id: ConversationId) =>
        (await (await app.conversation(id)).agent(context)).tools.map((tool) => tool.name);

    assert.ok((await tools(ada.id)).includes("chat_search"));
    assert.ok(!(await tools(session)).includes("chat_search"));
});
