// The prompt budget: what Pi Pocket adds to the first request of a plain session stays small (pp c3ad1d7a).
import { cleanUp, newSession, openApp, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";

/** About 3,000 tokens (10,046 when set; 11,361 with the ask tool). Raise it only on purpose, in the change that needs more. */
const LIMIT = 12_000;
/** Pi's own tools, and the owner's AGENTS.md and skills: not Pi Pocket's to count. */
const NOT_OURS = new Set(["read", "bash", "edit", "write", "project_context", "skills"]);

type Tool = { name: string; description: string; parameters: unknown };
type System = { sections?: Record<string, string>; toolsAdded?: Tool[] };

test("a new session's sections and tool schemas fit the prompt budget", async () => {
    let first: { messages: System[] } | undefined;
    const app = await openApp(
        scriptedModel((request) => {
            first ??= request as never;

            return fauxAssistantMessage([fauxText("ok")]);
        }),
    );

    await say(app, await newSession(app), "hello");
    await app.close();
    cleanUp();
    const items = first!.messages.flatMap((message) => [
        ...Object.entries(message.sections ?? {}).map(
            ([name, text]) => [name, text.length] as const,
        ),
        ...(message.toolsAdded ?? []).map(
            ({ name, description, parameters }) =>
                [name, JSON.stringify({ name, description, parameters }).length] as const,
        ),
    ]);
    const ours = items.filter(([name]) => !NOT_OURS.has(name)).sort((a, b) => b[1] - a[1]);
    const total = ours.reduce((sum, [, size]) => sum + size, 0);
    const biggest = ours.slice(0, 5).map(([name, size]) => `${name} ${size}`);

    assert.ok(
        total <= LIMIT,
        `Pi Pocket's prompt is ${total} characters, over the budget of ${LIMIT}. Biggest: ${biggest.join(", ")}. Make it smaller, or defer a tool (tool-search.ts); raise the limit only on purpose.`,
    );
});
