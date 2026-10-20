import {
    type App,
    cleanUp,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

let app: App;

before(async () => {
    const model = scriptedModel((request) => {
        const { text, role } = lastText(request as never);

        if (role === "user" && text.includes("START_A_TEAM")) {
            return fauxAssistantMessage(
                [fauxToolCall("team", { action: "start", message: "Count the files." })],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText("Done.")]);
    });

    app = await openApp(model);
    await app.setExtensionEnabled(owner(app), "agent-teams.ts", true);
});
after(async () => {
    await app?.close();
    cleanUp();
});

// With no count limit, the words are what keeps two agents from thanking each other without end (the spend limit is the brake).
test("the team tool and the linked message tell Pi to answer once and stop when the work is done", async () => {
    const id = await newSession(app);

    await say(app, id, "START_A_TEAM");
    const started = app.sessions().find((session) => session.linkedFrom?.id === Number(id));

    assert.ok(started, "a linked session");
    const source = (await modelTexts(app, id)).join("\n");

    assert.match(source, /ask it to send back what it finds, once/);
    assert.match(source, /Do not reply to a message that asks for nothing/);

    await until(
        async () =>
            (await modelTexts(app, started.id as never)).some((text) =>
                text.includes("<linked-session-message>"),
            ),
        "the first message",
    );
    const target = (await modelTexts(app, started.id as never)).join("\n");

    assert.match(
        target,
        /do not reply to thanks, acknowledgements, or messages that ask for nothing/,
    );
    assert.match(target, /stop when the work is done/);
});
