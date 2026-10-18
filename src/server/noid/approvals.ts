/**
 * noid's approvals: which of a bot's tool calls wait for the owner, with pi-pocket's mechanism (`Approvals`: a card in
 * the app and a push notification with Allow and Deny, the answer kept in the call's memo so a restart never asks
 * twice) and rakazo's classification (`packages/core/src/action-approval.ts`, Apache-2.0):
 *
 * - A computer bot runs its shell, files, browser, and its own memory and schedules without asking: the container is
 *   the boundary. Forgetting a memory asks (rakazo's `forget_memory`).
 * - A host bot asks before anything that changes this machine: bash that is not read-only (plan mode's reader list),
 *   write, and edit.
 * - Sessions that are not bots are Pi's own: they never ask (Pi's way).
 *
 * "Always allow" on a card keeps a rule for that bot and tool. A question nobody answers in time is denied; time never
 * allows anything.
 */
import type { Context } from "@earendil-works/chord";
import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";
import { defineDoc, defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import { blockedInPlanMode } from "../extensions/plan.ts";
import { BUILT_IN_TOOLS } from "../reload.ts";
import type { ApprovalAnswer } from "../host.ts";
import type { BotProfile } from "./bots.ts";

/** The start of the id of every question noid asks, which only it may turn into an "always allow" rule. */
export const NOID_APPROVAL = "noid:";

/** Rules the owner made with "Always allow": a bot's calls of a tool that run without asking from then on. */
export const ApprovalRulesDoc = defineDoc<{
    rules: { bot: string; tool: string; at: number; by: string }[];
}>({
    kind: "x.noid.approval-rules",
    version: 1,
    scope: "session",
    initial: () => ({ rules: [] }),
});

export type Verdict = { ask: false } | { ask: true; reason: string; subject: string };

/** Where a bot's conversation runs now: its folder decides, not the kind it was made as (a folder can move). */
export type Place = "host" | "computer";

/**
 * Tools a host bot uses without asking although plan mode would block them: they change the bot's own state, not this
 * machine (rakazo exempts remember, schedules, and subagents too). A subagent's own calls are checked as the bot's.
 */
const BOT_STATE_TOOLS = new Set(["memory", "schedule", "subagent", "goal"]);

const flat = (text: string, max = 300) => {
    const line = text.replace(/\s+/g, " ").trim();

    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * Whether a bot's call asks the owner first, by rakazo's classes. On this machine a bot asks before anything that is
 * not read-only, by plan mode's list of what only looks (so a tool nobody listed asks); on the shared computer the
 * container is the boundary. Pure, so the rules are easy to read and test.
 */
export function classify(
    bot: BotProfile | undefined,
    place: Place,
    tool: string,
    args: Record<string, unknown>,
    readOnly = false,
): Verdict {
    if (bot === undefined) {
        return { ask: false };
    }

    if (tool === "memory" && args.action === "remove") {
        return {
            ask: true,
            reason: "forgets a memory",
            subject: `forget ${String(args.id ?? "")}`,
        };
    }

    if (place === "computer" || BOT_STATE_TOOLS.has(tool)) {
        return { ask: false };
    }

    if (blockedInPlanMode(tool, args, readOnly) === undefined) {
        return { ask: false };
    }

    const subject =
        tool === "bash"
            ? flat(String(args.command ?? ""))
            : tool === "write" || tool === "edit"
              ? flat(String(args.path ?? ""))
              : flat(JSON.stringify(args));
    const reason =
        tool === "bash"
            ? "runs a command on your machine"
            : tool === "write"
              ? "writes a file on your machine"
              : tool === "edit"
                ? "edits a file on your machine"
                : `uses ${tool} on your machine`;

    return { ask: true, reason, subject };
}

/** How long a question waits before it is denied (NOID_APPROVAL_MINUTES, default an hour). */
function waitMs(): number {
    const minutes = Number(process.env.NOID_APPROVAL_MINUTES ?? 60);

    return (minutes > 0 ? minutes : 60) * 60_000;
}

/** The hook: always on, as approvals are a guard, not an option (pi-pocket's core-or-extension rule C1). */
export function createApprovals(app: PocketApp) {
    return defineExtension({
        name: "noid-approvals",
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api, context: Context) => {
                    const bot = app.bots.of(api.conversationId);

                    if (bot === undefined) {
                        return undefined;
                    }

                    // A tool's own read-only mark counts, as in plan mode; a built-in's can only come from a wrap.
                    const runtime = api as typeof api & Partial<Pick<ToolExecutionApi, "agent">>;
                    const declared = (await runtime.agent?.(context))?.tools.find(
                        (tool) => tool.name === call.name,
                    ) as { annotations?: ToolAnnotations } | undefined;
                    const verdict = classify(
                        bot,
                        app.onHost(api.conversationId) ? "host" : "computer",
                        call.name,
                        call.arguments as Record<string, unknown>,
                        !BUILT_IN_TOOLS.has(call.name) &&
                            declared?.annotations?.readOnlyHint === true,
                    );

                    if (!verdict.ask) {
                        return undefined;
                    }

                    const rules = (await api.snapshot(ApprovalRulesDoc, context))?.rules ?? [];

                    if (rules.some((rule) => rule.bot === bot!.id && rule.tool === call.name)) {
                        return undefined;
                    }

                    let answer = await api.memo<ApprovalAnswer>("noid.approval", context);

                    if (answer === undefined) {
                        // Its own id (Lancet Guard's is the bare call): "always allow" only answers noid's own questions.
                        const id = `${NOID_APPROVAL}${api.taskId}:${call.id}`;
                        const timer = setTimeout(
                            () => app.approvals.answer(id, { allow: false, by: "nobody, in time" }),
                            waitMs(),
                        );

                        timer.unref();

                        try {
                            const asked = await app.approvals.request(
                                {
                                    id,
                                    conversationId: api.conversationId,
                                    taskId: api.taskId,
                                    callId: call.id,
                                    tool: call.name,
                                    subject: verdict.subject,
                                    reason: `${bot!.name} ${verdict.reason}`,
                                    createdAt: Date.now(),
                                },
                                context,
                            );

                            answer = await api.memo<ApprovalAnswer>(
                                "noid.approval",
                                asked,
                                context,
                            );
                        } finally {
                            clearTimeout(timer);
                        }
                    }

                    return answer.allow
                        ? undefined
                        : {
                              block: `${answer.by} denied this ${call.name} call (${verdict.reason}). Do not try to get around it; say what you wanted to do instead.`,
                          };
                },
            }),
        ],
    });
}
