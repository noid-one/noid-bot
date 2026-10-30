// Pi's `ask` tool (`extensions/ask.ts`): questions with answers to pick, on a card that `Approvals` shows and the answer
// route checks (`asks.ts`); in a bot's session, a question nobody answers in time lets the bot go on.
import {
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { checkValues } from "../src/server/asks.ts";
import type { User } from "../src/server/config.ts";

const options = [
    { label: "Postgres", description: "One server" },
    { label: "SQLite", description: "A file" },
];
const questions = [
    { header: "Database", question: "Which database?", options, multiSelect: false },
    { header: "Parts", question: "Which parts?", options, multiSelect: true },
];
const app = await openApp(
    scriptedModel((request) => {
        const { role, text } = lastText(request as never);

        return role === "toolResult" || !text.endsWith("ask me")
            ? fauxAssistantMessage([fauxText(`ok: ${text}`)])
            : fauxAssistantMessage([fauxToolCall("ask", { questions })], { stopReason: "toolUse" });
    }),
);
const stored = async (id: number) =>
    JSON.stringify(await app.transcripts.allEntries(id as never, true));

after(async () => {
    await app.close();
    cleanUp();
});

test("a question takes one of its labels, several with multiple, or any text with other", () => {
    const field = { name: "q1", label: "Which database?", choices: options };
    const check = (more: object, q1: string) => checkValues([{ ...field, ...more }], { q1 });

    assert.deepEqual(check({}, "SQLite"), { q1: "SQLite" });
    assert.throws(() => check({}, "MySQL"), /^Error: Choose an answer to Which database\?$/);
    assert.throws(() => check({ multiple: true }, "SQLite\nSQLite"), /Choose/);
    assert.throws(() => checkValues([field], { q1: "SQLite", q9: "x" }), /not a question/);
    assert.ok(check({ multiple: true }, "SQLite\nPostgres") && check({ other: true }, "MySQL"));
});

test("Pi's questions show on a card, and the answer comes back as one line for each", async () => {
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "please ask me", requestId: "ask-1" });
    await until(() => app.approvals.forConversation(id).length === 1, "the card");
    const [card] = app.approvals.forConversation(id);

    assert.equal(card!.form?.title, "Pi asks");
    assert.equal(card!.reason, "Which database? · Which parts?");
    // An Allow with no answers (a notification's, say) is not an answer.
    await assert.rejects(app.answerApproval(card!.id, true, owner(app)), /Answer the questions/);

    const guest: User = { id: "guest-1", name: "Guest", role: "guest" } as User;

    assert.match(String(app.cannotAllow(guest, card!)), /Only the person Pi works for/);
    await app.answerApproval(card!.id, true, owner(app), false, {
        q1: "SQLite",
        q2: "SQLite\nnew",
    });
    await until(async () => (await stored(id)).includes("ok: Database"), "the answer");
    assert.match(await stored(id), /ok: Database: SQLite\\nParts: Other: \\"SQLite new\\"/);
});

test("a bot asks without an approval of its own, and goes on when nobody answers in time", async () => {
    const bot = await app.bots.create(owner(app), {
        name: "Asker",
        role: "Asks",
        kind: "host",
        folder: work,
    });

    await app.commands.configure(bot.id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    process.env.NOID_APPROVAL_MINUTES = "0.005";

    try {
        await app.commands.submit(bot.id, owner(app), { text: "ask me", requestId: "ask-bot" });
        await until(async () => (await stored(bot.id)).includes("ok: Nobody answered"), "go on");
    } finally {
        delete process.env.NOID_APPROVAL_MINUTES;
    }

    assert.deepEqual(app.approvals.forConversation(bot.id), []);
    assert.doesNotMatch(await stored(bot.id), /denied this ask call/);
});
