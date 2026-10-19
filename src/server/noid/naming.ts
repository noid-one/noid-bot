/**
 * noid: a bot's name, written by a model from what the bot does: a name like a teammate's job title ("Researcher",
 * "Release Manager", "Inbox Triage"), not a made-up word. The model is the one a new session starts with, as a person
 * chose it; never another picked on the side. What it costs counts in the bot's spend, as a session's title does.
 */
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { PocketApp } from "../app.ts";
import { HttpError } from "../errors.ts";
import { cleanTitle } from "../titles.ts";

const MAX_NAME = 40;
const MAX_WORDS = 4;
/** How much of the bot's instructions the model reads. */
const READ_CHARS = 2000;

/** What the model is asked, before what the bot does. */
export const NAME_PROMPT =
    "You name AI agents that work on a person's team. Reply with only the agent's name: 1 to 3 words that say what it does, as a teammate's job title reads (for example Researcher, Release Manager, Inbox Triage, Copy Editor). Plain words in title case, no quotes, no numbers, no punctuation at the end, in the language of the description.";

/**
 * A model's reply as a bot's name: a title (`cleanTitle`), short enough to be a name, and not one taken (`taken`, in
 * lower case). Undefined when it is not one.
 */
export function cleanName(reply: string, taken: ReadonlySet<string>): string | undefined {
    const name = cleanTitle(reply.replace(/^\s*(?:(?:bot|agent)\s+)?name\s*:\s*/i, ""))?.replace(
        /…$/,
        "",
    );

    if (
        name === undefined ||
        name.length > MAX_NAME ||
        name.split(/\s+/).length > MAX_WORDS ||
        /\d/.test(name)
    ) {
        return undefined;
    }

    return taken.has(name.toLowerCase()) ? undefined : name;
}

export type Naming = { name: string; model: Model<never>; usage: Usage };

/**
 * Ask the model a new session starts with for a name for a bot that does `role` (and follows `instructions`), none of
 * `taken`. Fails with what to do instead when there is no such model, or its reply is no name.
 */
export async function nameBot(
    app: PocketApp,
    what: { role: string; instructions: string },
    taken: readonly string[],
): Promise<Naming> {
    const ref = app.commands.defaultModel().model;
    const model = ref === undefined ? undefined : app.models.getModel(ref.provider, ref.modelId);

    if (model === undefined) {
        throw new HttpError(400, "There is no model to name it with: give it a name.");
    }

    const description = [
        what.role === "" ? "" : `Role: ${what.role}`,
        what.instructions === "" ? "" : `Instructions: ${what.instructions.slice(0, READ_CHARS)}`,
    ]
        .filter(Boolean)
        .join("\n");
    const reply = await app.models.completeSimple(
        model,
        {
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `${NAME_PROMPT}${taken.length === 0 ? "" : ` Not one of these, which are taken: ${taken.join(", ")}.`}\n\n<agent>\n${description}\n</agent>`,
                        },
                    ],
                    timestamp: Date.now(),
                },
            ],
        },
        // Its own identity with the provider: some providers refuse a request without one, and no session has one yet.
        { maxTokens: 1024, cacheRetention: "none", sessionId: crypto.randomUUID() },
    );
    const name =
        reply.stopReason === "stop"
            ? cleanName(
                  reply.content
                      .flatMap((part) => (part.type === "text" ? [part.text] : []))
                      .join(""),
                  new Set(taken.map((each) => each.toLowerCase())),
              )
            : undefined;

    if (name === undefined) {
        throw new HttpError(502, "The model gave no name for it: give it one.");
    }

    return { name, model: model as Model<never>, usage: reply.usage };
}
