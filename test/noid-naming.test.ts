// noid: a bot made without a name is named by a model for what it does ("Release Manager"), never one another bot has;
// a bot can ask for a new name; what naming costs counts in the bot's own spend.
import { type App, cleanUp, lastText, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { UsageDoc } from "@earendil-works/pi-durable";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { cleanName, NAME_PROMPT } from "../src/server/noid/naming.ts";

/** The names asked for, in order; each reply is the next one not said taken. */
const prompts: string[] = [];

const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    if (!text.startsWith(NAME_PROMPT)) {
        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    }

    prompts.push(text);

    return fauxAssistantMessage([
        fauxText(
            /taken:.*Ship Captain/.test(text)
                ? "Tag Wrangler"
                : /taken:.*Release Manager/.test(text)
                  ? '"Ship Captain".'
                  : "Release Manager",
        ),
    ]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "noid-naming-data"));
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a reply is a name only when it reads as one, and is not taken", () => {
    const taken = new Set(["researcher"]);

    assert.equal(cleanName('"Release Manager".', taken), "Release Manager");
    assert.equal(cleanName("Name: Inbox Triage", taken), "Inbox Triage", "without its label");
    assert.equal(cleanName("Researcher", taken), undefined, "taken");
    assert.equal(cleanName("Agent 7", taken), undefined, "no numbers");
    assert.equal(
        cleanName("This bot would be best named something like a manager", taken),
        undefined,
        "a sentence is no name",
    );
});

test("a bot made without a name is named for what it does, and its spend counts the naming", async () => {
    const made = await app.bots.create(owner(app), {
        role: "Cuts releases and writes their notes",
        instructions: "Tag, build, and publish each release.",
    });

    assert.equal(made.bot.name, "Release Manager");
    assert.match(prompts.at(-1)!, /Role: Cuts releases/);
    assert.match(prompts.at(-1)!, /Instructions: Tag, build/);

    const usage = await app.harness.snapshot(UsageDoc, made.id, BACKGROUND_CONTEXT);

    assert.ok(usage?.models["faux/faux-1"] !== undefined, "naming is in the bot's spend");

    // A second like it gets a name of its own: the model is told which are taken.
    const second = await app.bots.create(owner(app), { role: "Also cuts releases" });

    assert.equal(second.bot.name, "Ship Captain");
});

test("a bot can ask for a new name; with nothing said about it, it must be given one", async () => {
    const made = await app.bots.create(owner(app), { name: "Zork", role: "Cuts releases" });
    const { name } = await app.bots.suggestName(owner(app), made.id);

    assert.equal(name, "Tag Wrangler", "not one taken");
    await assert.rejects(app.bots.create(owner(app), {}), /Give it a name/);
});
