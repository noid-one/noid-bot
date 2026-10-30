/**
 * Ask: Pi asks you up to 4 questions on a card in the session, each with 2 to 4 answers to tap or one of your own, and
 * waits for your answer. It goes on with what you chose.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { pickedLabels } from "../asks.ts";
import type { AskField, PocketHost } from "../host.ts";
import { waitMs } from "../noid/approvals.ts";

const DESCRIPTION =
    "Ask the person 1 to 4 questions on a card, each with 2 to 4 answers to tap (or their own). " +
    "Waits for the answer; returns one line per question: `header: answer`.";

const GUIDE = `Use the ask tool only when a decision changes the work and only the person can make it (scope, behavior, a trade-off). One call for all questions; put the option you recommend first, ending its label with "(Recommended)". Not for permission to run tools, and never twice for the same thing.`;

const DECLINED =
    "The person declined to answer. Do not ask again at once; go on with your best judgment, or ask in plain text.";
const UNANSWERED =
    "Nobody answered in time. Go on with your best judgment, and say in your reply what you chose and why.";

/** Who settles a bot's question nobody answered (`noid/approvals.ts` times its own out the same way). */
const NOBODY = "nobody, in time";

/** What the call gives back, kept in its memo: a restart after the answer does not ask again. */
type Reply = { text: string; answers?: { header: string; question: string; answer: string }[] };

/** One line: what a model writes can hold line breaks, which a card's words do not. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

const Choice = Type.Object({
    label: Type.String({ minLength: 1, maxLength: 60, description: "The answer, 1 to 5 words" }),
    description: Type.Optional(
        Type.String({ maxLength: 160, description: "What it means or costs, in one line" }),
    ),
});

const Question = Type.Object({
    question: Type.String({
        minLength: 1,
        maxLength: 300,
        description: "The whole question, ending with a question mark",
    }),
    header: Type.String({ minLength: 1, maxLength: 12, description: "A short tag, such as Scope" }),
    options: Type.Array(Choice, { minItems: 2, maxItems: 4 }),
    multiSelect: Type.Optional(Type.Boolean({ description: "More than one can be chosen" })),
});

export default function createAsk(host: PocketHost) {
    const ask = defineTool({
        name: "ask",
        description: DESCRIPTION,
        parameters: Type.Object({
            questions: Type.Array(Question, { minItems: 1, maxItems: 4 }),
        }),
        // The card's id comes from the call: after a restart, the same card asks again, unless the answer is in the memo.
        replay: "safe",
        execute: async (args, api, context) => {
            // A subagent works for another agent: nobody reads its chat. Its session has no `ask` (`subagents.ts`), but
            // one started before that has.
            const agent = await api.agent(context);

            if (agent.instructions?.startsWith('You are the subagent "')) {
                throw new Error(
                    "A subagent cannot ask the person: put the question in your report.",
                );
            }

            const questions = args.questions.map((each) => ({
                question: flat(each.question),
                header: flat(each.header),
                options: each.options.map((option) => ({
                    label: flat(option.label),
                    ...(option.description === undefined || flat(option.description) === ""
                        ? {}
                        : { description: flat(option.description) }),
                })),
                multiple: each.multiSelect === true,
            }));
            let reply = await api.memo<Reply>("pocket.ask", context);

            if (reply === undefined) {
                const fields: AskField[] = questions.map((each, at) => ({
                    name: `q${at + 1}`,
                    label: each.question,
                    header: each.header,
                    choices: each.options,
                    ...(each.multiple ? { multiple: true } : {}),
                    other: true,
                    placeholder: "Or type your own answer",
                }));
                const id = `${api.taskId}:${api.callId}`;
                // A bot often runs with nobody watching (mail, a schedule, a group round): its question waits as long
                // as its approvals do, then the bot goes on without the answer. Pi's own sessions wait for the person.
                const bot = host.botOf(api.conversationId);
                const timer =
                    bot === undefined
                        ? undefined
                        : setTimeout(
                              () => host.approvals.answer(id, { allow: false, by: NOBODY }),
                              waitMs(),
                          );

                timer?.unref();

                let answer;

                try {
                    answer = await host.approvals.request(
                        {
                            id,
                            conversationId: api.conversationId,
                            taskId: api.taskId,
                            callId: api.callId,
                            tool: "ask",
                            subject: `${bot?.name ?? "Pi"} asks`,
                            // The questions: what a tile, a row in Needs you, and a notification show.
                            reason: questions.map((each) => each.question).join(" · "),
                            createdAt: Date.now(),
                            form: {
                                // Each question has its header as a chip: the title names who asks.
                                title: `${bot?.name ?? "Pi"} asks`,
                                fields,
                                submit: "Send",
                            },
                        },
                        context,
                    );
                } finally {
                    clearTimeout(timer);
                }

                const values = answer.values;
                const answers =
                    answer.allow && values !== undefined
                        ? questions.map((each, at) => {
                              const field = fields[at]!;
                              const value = values[field.name] ?? "";

                              return {
                                  header: each.header,
                                  question: each.question,
                                  answer:
                                      pickedLabels(field, value)?.join("; ") ??
                                      `Other: "${flat(value)}"`,
                              };
                          })
                        : undefined;

                reply = await api.memo<Reply>(
                    "pocket.ask",
                    answers === undefined
                        ? { text: answer.by === NOBODY ? UNANSWERED : DECLINED }
                        : {
                              text: answers
                                  .map((each) => `${each.header}: ${each.answer}`)
                                  .join("\n"),
                              answers,
                          },
                    context,
                );
            }

            return {
                output: [{ type: "text" as const, text: reply.text }],
                ...(reply.answers === undefined ? {} : { details: { answers: reply.answers } }),
            };
        },
    });

    return defineExtension({
        name: "pocket-ask",
        tools: [Object.assign(ask, { annotations: { readOnlyHint: true } })],
        sections: [section("ask", () => GUIDE)],
    });
}
