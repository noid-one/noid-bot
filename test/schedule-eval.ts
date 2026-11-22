// noid: a real-model eval of whether a scheduled run schedules itself again (rakazo ba539aab7). A bot gets its prompt
// and tools as recorded from a real request (a pi.system entry's record from `pocket.sqlite`), with the schedule tool
// loaded, and one scheduled message worded as a standing request ("every 30 minutes"). Its tool calls get canned
// answers; a run that calls `schedule` with `add` copied itself. A follow-up message that says to check back once
// more is the other side: its run should add one. The candidate adds rakazo's line to the guide (noid has it since
// 2026-11-22: record the baseline from a prompt before that). On 2026-11-22, gpt-6.1-terra, 5 reps: baseline 13/20
// and 14/20 copies, candidate 0/20 twice; follow-ups 10/10 on both. Usage:
//   node test/schedule-eval.ts <reps> <system.json> [provider/model]
// It spends model credits: openai/gpt-6.1-terra by default, thinking low, as the owner's bots run.
import { readFileSync } from "node:fs";
import { getSystemMessageText, type Message, type Tool } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const GUIDE_START = 'Messages that start with "[scheduled]" were set up earlier';
const LINE = "Each one is a single scheduled run: do its work now, and do not schedule it again.";
const EXISTING = "s1 · every 30m · next in 30m";

const MESSAGES = [
    "[scheduled] Monitor https://status.example.com every 30 minutes and tell me if it goes down.",
    "[scheduled] Keep checking the inbox every hour for an email from Hollis and tell me when it arrives.",
    "[scheduled] Every morning, summarize the top 3 Hacker News stories for me.",
    "[scheduled] Watch the price of AAPL every 15 minutes and alert me if it drops below $180.",
];

/** Messages whose run should check back once more: the deploy is still running. */
const FOLLOW_UPS = [
    "[scheduled] Check whether the deploy finished. If it is still running, check back in 10 minutes.",
    "[scheduled] See if the long test run is done; if not, look again in 15 minutes and report when it is.",
];

const SCHEDULE: Tool = {
    name: "schedule",
    description:
        "Send yourself a message in this conversation later, or on repeat: to check back on something slow, or for a regular job. Actions: add (when, message), list, cancel (id).",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["add", "list", "cancel"] },
            when: {
                type: "string",
                description:
                    "add: when it goes out, such as in 30m, tomorrow 9:00, or every weekday 8:00",
            },
            message: {
                type: "string",
                description: "add: what you get then; write it so it stands on its own",
            },
            id: { type: "string", description: "cancel: the schedule's id, from add or list" },
        },
        required: ["action"],
    } as never,
};

const ANSWERS: Record<string, (args: Record<string, unknown>) => string> = {
    schedule: (args) =>
        args.action === "add" ? "Added s2." : args.action === "list" ? EXISTING : "Cancelled.",
    bash: () =>
        "HTTP/2 200\nall systems operational\ndeploy: running (step 4 of 9)\ntests: running (212 of 940)",
    read: () => "(empty)",
    memory: () => "No lessons.",
    tool_search: () => "No more tools match.",
};

const [repsArg, file, picked] = process.argv.slice(2);
const reps = Number(repsArg);
const system = JSON.parse(readFileSync(file!, "utf8")).model[0];
const baseline = getSystemMessageText({
    role: "system",
    content: "",
    sections: system.sections,
    timestamp: 0,
});

if (!baseline.includes(GUIDE_START)) {
    throw new Error("the recorded prompt has no schedule guide");
}

const guideEnd =
    baseline.indexOf("stands on its own.", baseline.indexOf(GUIDE_START)) +
    "stands on its own.".length;
const candidate = `${baseline.slice(0, guideEnd)} ${LINE}${baseline.slice(guideEnd)}`;
const tools = [...(system.toolsAdded as Tool[]), SCHEDULE];
const [provider, modelId] = (picked ?? "openai/gpt-6.1-terra").split("/");
const runtime = await ModelRuntime.create();
const model = runtime
    .getAvailableSnapshot()
    .find((found) => found.provider === provider && found.id === modelId);

if (model === undefined) {
    throw new Error(`${provider}/${modelId} is not signed in`);
}

/** Whether the run added a schedule, and what it did. */
async function once(prompt: string, text: string): Promise<{ copied: boolean; calls: string[] }> {
    const messages: Message[] = [{ role: "user", content: text, timestamp: Date.now() }];
    const calls: string[] = [];

    for (let step = 0; step < 6; step++) {
        const reply = await runtime.completeSimple(
            model!,
            { systemPrompt: prompt, messages, tools },
            { reasoning: "low" },
        );

        if (reply.stopReason === "error") {
            throw new Error(reply.errorMessage);
        }

        messages.push(reply);
        const asked = reply.content.filter((block) => block.type === "toolCall");

        if (asked.length === 0) {
            break;
        }

        for (const call of asked) {
            calls.push(
                `${call.name}${call.name === "schedule" ? `:${String(call.arguments.action)}` : ""}`,
            );
            messages.push({
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [
                    { type: "text", text: (ANSWERS[call.name] ?? (() => "Done."))(call.arguments) },
                ],
                isError: false,
                timestamp: Date.now(),
            });
        }
    }

    return { copied: calls.includes("schedule:add"), calls };
}

for (const [name, prompt] of [
    ["baseline", baseline],
    ["candidate", candidate],
] as const) {
    const all = (texts: string[]) =>
        Promise.all(
            texts.flatMap((text) =>
                Array.from({ length: reps }, () =>
                    once(prompt, text).then((run) => ({ text, ...run })),
                ),
            ),
        );
    const [runs, follows] = await Promise.all([all(MESSAGES), all(FOLLOW_UPS)]);
    const copies = runs.filter((run) => run.copied);
    const missed = follows.filter((run) => !run.copied);

    console.log(
        `${name}: ${copies.length}/${runs.length} runs scheduled themselves again; ${follows.length - missed.length}/${follows.length} follow-ups checked back`,
    );

    for (const run of [...copies, ...missed]) {
        console.log(`  ${run.text.slice(12, 70)} → ${run.calls.join(", ")}`);
    }
}
