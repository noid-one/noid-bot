/**
 * The Pi Pocket server core: one durable Harness over one SQLite file, shared by every session, every subagent, and
 * every connected browser. Browsers attach to a conversation's committed view; nothing a browser sees exists only in
 * memory, except who is connected, who is typing, and which tool calls wait for approval.
 *
 * What people ask of Pi lives in `commands.ts`, the people's side of a session in `collab.ts`, push notifications in
 * `alerts.ts`, provider sign-ins in `providers.ts`, and each conversation's shared live view in `room.ts`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
    getAgentDir,
    ModelRuntime,
    resolveModelScopeWithDiagnostics,
    SettingsManager,
    type Skill,
} from "@earendil-works/pi-coding-agent";
import {
    AgentDoc,
    type AgentState,
    type CommitPublication,
    type Conversation,
    type ConversationId,
    type Cursor,
    createRegistry,
    defineExtension,
    type DocumentCommitChange,
    Harness,
    type HarnessSettings,
    LiveDoc,
    type LiveState,
    ProviderDoc,
    type Registry,
    type Storage,
    UsageDoc,
    type UsageState,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Alerts } from "./alerts.ts";
import { Attribution, type Missing } from "./attribution.ts";
import { Browsers } from "./browser.ts";
import type { BrowserState } from "./browser/page.ts";
import { Collab, REACTIONS } from "./collab.ts";
import { Commands } from "./commands.ts";
import { LinkedSessions } from "./linked-sessions.ts";
import { APP_ROOT, ConfigStore, type User } from "./config.ts";
import {
    ArtifactBodyDoc,
    type ArtifactMeta,
    ArtifactsDoc,
    AuthorsDoc,
    BrowserDoc,
    ChatDoc,
    type ChatMessage,
    DecisionsDoc,
    FolderFavoritesDoc,
    MemoryDoc,
    type SessionMeta,
    SessionsDoc,
    SpendDoc,
    type SubagentRecord,
    SubagentsDoc,
    TurnsDoc,
} from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { ExtensionCommands } from "./extension-commands.ts";
import { ExtensionWebs, mayUse } from "./extension-web.ts";
import { defang, quoted } from "./fence.ts";
import { FolderFavorites } from "./folder-favorites.ts";
import { Gallery } from "./gallery.ts";
import { Goals } from "./goals.ts";
import { type ApprovalRequest, Approvals, type PocketHost, type WebAccess } from "./host.ts";
import { type GuardStatus, LancetGuard } from "./lancet.ts";
import { takeLock } from "./lock.ts";
import { Memory } from "./memory.ts";
import { compactionReader } from "./compaction.ts";
import {
    alwaysAsks,
    ApprovalRulesDoc,
    createApprovals,
    AUTO_REVIEW_APPROVAL,
    EVERY_TIME_APPROVAL,
    NOID_APPROVAL,
    NOT_SHOWN,
} from "./noid/approvals.ts";
import { BOT_MAIL_EXTENSION, BotMail, OVERSEER_EXTENSION } from "./noid/botmail.ts";
import { Bots, type PersonFace } from "./noid/bots.ts";
import { ownerOf } from "./noid/owner.ts";
import { checkValues } from "./asks.ts";
import { Chromium } from "./browser/cdp.ts";
import { Computer, COMPUTER_HOME, onComputer } from "./noid/computer.ts";
import { connectHostChrome, windowsPowerShell } from "./noid/host-chrome.ts";
import { claudeBinary, claudeCliProvider, stopClaudeCli } from "./noid/claude-cli.ts";
import { Desktop, DESKTOP_EXTENSION } from "./noid/desktop.ts";
import { Groups } from "./noid/groups.ts";
import { Terminals } from "./noid/terminal.ts";
import { isThinkingLevel, modelInfo, modelList, resolveModel, THINKING_LEVELS } from "./models.ts";
import { pocketVersion } from "./versions.ts";
import { configureHttp } from "./net.ts";
import { createPublicFetch } from "./public-fetch.ts";
import { PiSessions } from "./pi-sessions.ts";
import { Hooks } from "./hooks.ts";
import { SessionTools, SESSION_TOOLS_EXTENSION } from "./session-tools.ts";
import { NOID_COMPACT_CHOICES, NoidCompaction } from "./noid-compact.ts";
import { RepoWatches } from "./repo-watches.ts";
import { snippet } from "./projection.ts";
import { loadPromptTemplates, type PromptTemplate, type SkillCommand } from "./prompts.ts";
import { BASE_THEME, Themes } from "./themes.ts";
import { THEME_ID } from "./themes/format.ts";
import { measureModelStreams } from "./timing.ts";
import { CacheKeeper } from "./cache-keeper.ts";
import { Providers } from "./providers.ts";
import { PushStore } from "./push.ts";
import { type ExtensionInfo, ExtensionLoader, linkTypes, prepareDropInFolder } from "./reload.ts";
import { ResendTask } from "./resend.ts";
import { type Client, reportingOf, Room, ROOM_DOCS, subagentView } from "./room.ts";
import { Schedules } from "./schedules.ts";
import { FAILED_RUN, whyUnanswered } from "./subagent-runs.ts";
import { cutWhole } from "./cut.ts";
import { Shell } from "./shell.ts";
import {
    loadSessionSkills,
    projectDistrusted,
    type ProjectTrust,
    readProjectTrust,
    saveProjectTrust,
    type SkillSources,
    type TrustChoice,
} from "./skills.ts";
import { Spend } from "./spend.ts";
import { Transcripts } from "./transcripts.ts";
import { Watches } from "./watches.ts";
import { Workspace } from "./workspace.ts";

const context = BACKGROUND_CONTEXT;

/** How other devices reach this server, as reported by the launcher (`bin/pi-pocket.js`). */
export type AccessInfo = {
    mode: string;
    label: string;
    /** The address other devices should use, such as a tunnel's public https URL. */
    url?: string;
};

/** The extension module that runs Lancet Guard on tool calls. */
const GUARD_FILE = "guard.ts";
/** How long the server waits, when it stops, for extension modules' cleanups that wait. */
const CLEANUP_LIMIT_MS = 3000;
/** The extension module with the browser tool. While it is off, the Browser panel is off too. */
const BROWSER_FILE = "browser.ts";
const BROWSER_EXTENSION = "pocket-browser";
/** The extension module with Noid's session tools. */
const SESSION_TOOLS_FILE = "session-tools.ts";
/** The extension module with the subagent tool, rebuilt when the models subagents may use change. */
const SUBAGENTS_FILE = "subagents.ts";
/** The most models the owner may allow subagents besides their session's own. */
const MAX_SUBAGENT_MODELS = 50;

/**
 * The most conversations a tab gets live peeks for at once: the sessions on its screen, and the subagents working
 * there, each row asking for its own as the tiles do.
 */
export const MAX_PEEKS = 20;

/** How much of a failed run's reason the session list carries: it goes to every tab on each change. */
const FAILURE_TEXT = 120;
/** How much of a waiting call the session list carries (a tile's peek has more): enough to tell calls apart. */
const ASK_SUBJECT = 200;
const ASK_REASON = 200;
/** The most failed subagents a session's row names: the list goes to every tab. */
const FAILED_AGENTS = 5;

/**
 * The call a session waits on, as its row in the session list carries it (Priority's Needs you). noid: a bot's call
 * (an id starting `noid:`) asks as the bot the session is or works for; the row names it from the list's `bot` and
 * `worksFor`.
 */
type SessionAsk = {
    id: string;
    conversationId: number;
    tool: string;
    subject: string;
    reason: string;
    requestedBy?: string;
    /** When it asked (the server's clock). */
    at: number;
    /** How many calls wait in the session, its subagents' too. */
    count: number;
    /** A question Pi asks (the ask tool): answered on its card only, never allowed from the row. */
    form?: true;
};

/** A conversation's subagents document, as far as the app reads it. */
type SubagentsValue = {
    agents?: Record<string, SubagentRecord>;
    outbox?: readonly { name: string }[];
    sending?: { reports: readonly { name: string }[] };
};

type SubagentsOf = { agents: Record<string, SubagentRecord>; reporting: Set<string> };

/** One subagent on the subagents board: the subagents bar's view, the session it works in, and the call it waits on. */
export type SubagentEntry = ReturnType<typeof subagentView> & {
    id: number;
    waiting?: true;
    approval?: { tool: string; subject: string };
};

/** Where a subagent is. Waiting for an approval comes before working: it is working, held up. */
export type SubagentState = "waiting" | "working" | "failed" | "stopped" | "done";

export function subagentState(entry: SubagentEntry): SubagentState {
    if (entry.waiting === true) {
        return "waiting";
    }

    if (entry.busy) {
        return "working";
    }

    return entry.stopped === true ? "stopped" : entry.failed === true ? "failed" : "done";
}

/**
 * On the subagents board, a session's finished subagents (done, stopped, or failed and dealt with) past this many, the
 * oldest, are left out: the session list counts them, and the board says how many more there are. Those that work,
 * wait, failed with nobody dealing with it yet, or have a report on its way always show.
 */
const BOARD_FINISHED = 24;

/** How often agent files are looked at again (`Bots.syncAgentFiles`). */
const AGENT_FILES_MS = 10_000;

/** How long a read of Pi's settings serves skills and trust before it is read again. */
const SETTINGS_STALE_MS = 30_000;

/** A session's subagents as the board gets them: all but its oldest finished ones past `BOARD_FINISHED`. */
function forBoard(entries: readonly SubagentEntry[]): SubagentEntry[] {
    const finished = (entry: SubagentEntry) =>
        entry.reporting !== true &&
        (["done", "stopped"].includes(subagentState(entry)) ||
            (subagentState(entry) === "failed" && entry.dealt === true));
    const done = entries.filter(finished);

    if (done.length <= BOARD_FINISHED) {
        return [...entries];
    }

    const when = (entry: SubagentEntry) => entry.answeredAt ?? entry.askedAt ?? 0;
    const kept = new Set(done.sort((a, b) => when(b) - when(a)).slice(0, BOARD_FINISHED));

    return entries.filter((entry) => !finished(entry) || kept.has(entry));
}

/**
 * How many of a session's subagents are in each state, without the empty ones, and how many of those that failed a
 * person dealt with (`dealt`): the rest need someone. Undefined for none at all.
 */
function countSubagents(
    entries: readonly SubagentEntry[],
): (Partial<Record<SubagentState, number>> & { dealt?: number }) | undefined {
    if (entries.length === 0) {
        return undefined;
    }

    const counts: Partial<Record<SubagentState, number>> & { dealt?: number } = {};

    for (const entry of entries) {
        const state = subagentState(entry);

        counts[state] = (counts[state] ?? 0) + 1;

        if (state === "failed" && entry.dealt === true) {
            counts.dealt = (counts.dealt ?? 0) + 1;
        }
    }

    return counts;
}

/**
 * A session's failed subagents that nobody dealt with, newest first: what the list's Dismiss needs (the failure is
 * named by when it failed, as `dismissSubagent` takes it). Stopped ones did not fail, and the rest are dealt with.
 */
function failedSubagents(
    entries: readonly SubagentEntry[],
): { name: string; conversationId: number; at: number }[] {
    return entries
        .filter((entry) => subagentState(entry) === "failed" && entry.dealt !== true)
        .sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0))
        .slice(0, FAILED_AGENTS)
        .map((entry) => ({
            name: entry.name,
            conversationId: Number(entry.conversationId),
            at: entry.answeredAt ?? 0,
        }));
}

export interface OpenOptions {
    dataDir: string;
    defaultCwd: string;
    supervised: boolean;
    log?: (line: string) => void;
    /** Tests register scripted providers here. */
    configureModels?: (models: ModelRuntime) => void;
    /** The clock durable work runs by, such as scheduled messages. Tests move it ahead. */
    now?: () => number;
    /** The browser to run for the Browser panel and tool; null for none. Undefined finds one on this machine. */
    browser?: string | null;
    /** The home folder, whose `.agents/skills/` every session has. Undefined is Pi's: `$HOME`. Tests use their own. */
    home?: string;
    /** noid: make Noid, the main bot, when there is none (default true; tests that do not test bots leave it out). */
    mainBot?: boolean;
}

/** How long noid's shared computer may sit idle before it stops (NOID_COMPUTER_IDLE_MINUTES; 0 never stops it). */
function idleMinutes(): number {
    const minutes = Number(process.env.NOID_COMPUTER_IDLE_MINUTES ?? 15);

    return minutes > 0 ? minutes : Number.POSITIVE_INFINITY;
}

/**
 * An environment other than this machine (noid's shared computer): which folders it runs, and the environment of each.
 * `claims` only looks at the path, so asking costs nothing.
 */
export type EnvironmentProvider = {
    claims(cwd: string): boolean;
    env(cwd: string): ExecutionEnv;
};

export class PocketApp {
    readonly config: ConfigStore;
    /** Push subscriptions and their keys; undefined until the server opened. */
    pushStore: PushStore | undefined;
    readonly approvals = new Approvals((id) => this.attribution.requesterOf(id));
    readonly guard = new LancetGuard();
    readonly dataDir: string;
    readonly defaultCwd: string;
    readonly supervised: boolean;
    readonly startedAt = Date.now();
    /** Set by the launcher over IPC; undefined when the server runs on its own. */
    access: AccessInfo | undefined;
    harness!: Harness;
    models!: ModelRuntime;
    settings!: SettingsManager;
    loader!: ExtensionLoader;
    readonly commands = new Commands(this);
    readonly extensionCommands = new ExtensionCommands(this);
    readonly linkedSessions = new LinkedSessions(this);
    readonly collab = new Collab(this);
    readonly alerts = new Alerts(this);
    readonly providers = new Providers(this);
    readonly schedules = new Schedules(this);
    readonly goals = new Goals(this);
    readonly shell = new Shell(this);
    readonly spend = new Spend(this);
    /** Keeps the prompt cache warm while a run waits on a tool call (`cache-keeper.ts`). */
    readonly cacheKeeper = new CacheKeeper({
        log: (line) => this.#log(line),
        conversationOf: (sessionId) => this.#conversationOfSession(sessionId),
        isRunning: (conversationId) => this.#busy.has(conversationId as ConversationId),
        accountFor: (conversationId) => {
            const id = conversationId as ConversationId;
            const payer = this.spend.payer(id);

            return {
                check: () => {
                    const person = this.config.userById(payer);

                    if (person === undefined || !this.#busy.has(id)) {
                        return false;
                    }

                    try {
                        this.spend.check(person, id);

                        return true;
                    } catch {
                        return false;
                    }
                },
                recordUsage: (message) => this.spend.recordModelUsage(id, payer, message),
            };
        },
    });
    /** Who Pi works for in each conversation, and who wrote and queued each message. */
    readonly attribution = new Attribution(this);
    /** The conversation's folder: files, the viewer, changes, and uploads. */
    readonly workspace = new Workspace(this);
    /** The conversation's stored history, as people read it. */
    readonly transcripts = new Transcripts(this);
    /** Pi's sessions from the terminal, which the owner can continue here. */
    readonly piSessions = new PiSessions(this);
    /** The session tools: what they do for Noid and the other bots, and the follows that report to them. */
    readonly sessionTools = new SessionTools(this);
    /** Noid's context kept small: compacted sooner than a session's, with summaries of its own (`noid-compact.ts`). */
    readonly noidCompaction = new NoidCompaction(this);
    /** Sessions' watches of their pull requests (`watches.ts`). */
    readonly watches = new Watches(this);
    /** Standing orders on GitHub repositories: what happens there goes to Noid or a session (`repo-watches.ts`). */
    readonly repoWatches = new RepoWatches(this);
    /** Webhooks: addresses other services post to, each a message to a session or Noid (`hooks.ts`). */
    readonly hooks = new Hooks(this);
    /** Lessons Pi keeps across sessions, for a project or everywhere. */
    readonly memory = new Memory(this);
    /** noid's bots: sessions with a name, a role, a face, and a place to work. */
    readonly bots = new Bots(this);
    /** noid: bots messaging bots, and Noid's overseer tools. */
    readonly botMail = new BotMail(this);
    /** Each person's favorite working folders, shared by their devices. */
    readonly folderFavorites = new FolderFavorites(this);
    /** Other people's drop-ins, from a reviewed index: found, installed off, read, updated, removed (`gallery.ts`). */
    readonly gallery = new Gallery(this);
    /** Theme folders: the app's look and layout, built in and the owner's (`themes.ts`). */
    readonly themes: Themes;
    /** Each conversation's browser page, which Pi and the people in the conversation share. */
    readonly browsers: Browsers;
    /** noid: PowerShell on Windows, when bots use the owner's own Chrome there (NOID_BROWSER=chrome, from WSL). */
    readonly hostChrome: string | undefined;
    /** What extension modules add to the app: their routes, browser modules, and events (`extension-web.ts`). */
    readonly webs: ExtensionWebs;
    #websTimer: NodeJS.Timeout | undefined;
    /** Whose tabs the next `hello` for browser modules goes to: those who may use any of these. */
    readonly #websFor = new Set<WebAccess>();
    /** Whether everyone's tabs must hear `hello` again, for a change to the modules' commands. */
    #websAll = false;
    readonly #clients = new Set<Client>();
    readonly #rooms = new Map<ConversationId, Promise<Room>>();
    readonly #envs = new Map<string, NodeExecutionEnv>();
    /** Extensions' environments (noid's shared computer): the first that claims a cwd runs its commands. */
    readonly #environments = new Set<EnvironmentProvider>();
    /**
     * noid's shared computer. Part of the app, not a module that can be off or reloading: a folder under its home always
     * runs there (or fails, when Docker is not there), never on this machine.
     */
    readonly computer = new Computer({
        idleMs: idleMinutes() * 60_000,
        log: (message) => this.#log(`computer: ${message}`),
    });
    /** Group threads: the owner and several bots in one room. */
    readonly groups = new Groups(this);
    /** The shared computer's desktop, and the lease of its one mouse. */
    readonly desktop = new Desktop(this);
    /** The owner's shells on the shared computer. */
    readonly terminals = new Terminals(this.computer);
    #stopIdleWatch: () => void = () => {};
    readonly #busy = new Set<ConversationId>();
    /** When each conversation's last run ended, since this server started: peek tiles show sessions done since a look. */
    readonly #endedAt = new Map<ConversationId, number>();
    /** noid: what each bot last said, for its row in the list (Grok's list shows it): read once, and as its runs end. */
    readonly #lastSaid = new Map<string, string | undefined>();
    /**
     * Conversations whose last run ended because the model or provider failed (not stopped by someone), since this
     * server started: the session list marks them until their next run starts.
     */
    readonly #failed = new Map<ConversationId, string>();
    readonly #agents = new Map<ConversationId, AgentState>();

    /** The newest chat message (not activity) of each conversation, for unread dots in the session list. */
    readonly #lastChat = new Map<string, { at: number; userId: string }>();
    /** Subagent conversation → the conversation that spawned it. */
    readonly #parents = new Map<ConversationId, ConversationId>();
    /** Each conversation's subagents, and those with a report on its way to it: for the board and the session list. */
    readonly #subagents = new Map<ConversationId, SubagentsOf>();
    #sessions: Record<string, SessionMeta> = {};
    #sessionsTimer: NodeJS.Timeout | undefined;
    /** noid: how often agent files are looked at again, for the bots made from them. */
    #agentFilesTimer: NodeJS.Timeout | undefined;
    /** The extensions installed now: every conversation runs with them, except the session tools, which bots select. */
    #registry: Registry | undefined;
    #unsubscribeCommits: (() => void) | undefined;
    #unsubscribeApprovals: (() => void) | undefined;
    #unsubscribeBrowsers: (() => void) | undefined;
    #lockFile: string;
    #releaseLock: (() => void) | undefined;
    #openingStorage: Storage | undefined;
    #closing: Promise<void> | undefined;
    readonly #log: (line: string) => void;
    readonly #configureModels: ((models: ModelRuntime) => void) | undefined;
    readonly #home: string;
    readonly #mainBot: boolean;
    /** The clock durable work runs by. */
    readonly now: () => number;

    /** The home folder: its `.agents/` has skills and agent files. */
    get home(): string {
        return this.#home;
    }

    private constructor(options: OpenOptions) {
        this.#configureModels = options.configureModels;
        this.#home = options.home ?? (process.env.HOME || homedir());
        this.#mainBot = options.mainBot ?? true;
        this.now = options.now ?? Date.now;
        this.dataDir = options.dataDir;
        this.defaultCwd = options.defaultCwd;
        this.supervised = options.supervised;
        this.config = new ConfigStore(options.dataDir);
        this.#lockFile = join(options.dataDir, "harness.lock");
        this.#log = options.log ?? ((line) => console.log(line));
        this.hostChrome = process.env.NOID_BROWSER === "chrome" ? windowsPowerShell() : undefined;

        if (process.env.NOID_BROWSER === "chrome" && this.hostChrome === undefined) {
            this.#log(
                "NOID_BROWSER=chrome needs Windows (from WSL): bots use the shared computer's browser.",
            );
        }

        this.browsers = new Browsers({
            dataDir: options.dataDir,
            ...(options.browser === undefined ? {} : { executable: options.browser }),
            log: (line) => this.#log(line),
            // noid: bots, and sessions on the shared computer, use one browser, a tab each, logins shared: the one on
            // the computer's desktop, or with NOID_BROWSER=chrome the owner's own Chrome. People watch and use a bot's
            // tab in the Browser panel, and the whole browser on the desktop.
            remote:
                this.hostChrome === undefined
                    ? {
                          claims: (id) => this.#onComputer(id),
                          launch: async () =>
                              Chromium.over(
                                  await this.computer.connectBrowser(),
                                  "the computer's browser",
                              ),
                          hold: () => this.computer.hold(),
                          downloadPath: `${COMPUTER_HOME}/shared/downloads`,
                          tabs: true,
                      }
                    : {
                          claims: (id) => this.#onComputer(id),
                          launch: async () =>
                              Chromium.over(connectHostChrome(this.hostChrome!), "your Chrome"),
                          tabs: true,
                      },
            load: async (id) =>
                (await this.harness.snapshot(
                    BrowserDoc,
                    id as unknown as ConversationId,
                    context,
                )) ?? undefined,
            save: (id, saved) => {
                void this.harness
                    .commit(async (tx) => {
                        const doc = await tx.doc(BrowserDoc, id as unknown as ConversationId);

                        if (saved.url !== undefined && doc.url !== saved.url) {
                            doc.url = saved.url;
                        }

                        const viewport = saved.viewport;

                        if (
                            viewport !== undefined &&
                            JSON.stringify(doc.viewport) !== JSON.stringify(viewport)
                        ) {
                            doc.viewport = { ...viewport };
                        }
                    }, context)
                    .catch((error: unknown) =>
                        this.#log(`browser page not saved: ${describe(error)}`),
                    );
            },
        });
        this.themes = new Themes({
            builtIn: join(APP_ROOT, "web", "themes"),
            dataDir: options.dataDir,
            notify: (message) => this.ownerNotice("warning", message),
            // Everyone's tabs: a theme anyone may have chosen changed, or one came or went.
            changed: () => {
                const lists = { owner: this.themes.list(true), others: this.themes.list(false) };

                for (const client of this.#clients) {
                    client.send(
                        "themes",
                        client.user.role === "owner" ? lists.owner : lists.others,
                    );
                }

                void this.#themeDefaultStillHere();
            },
            log: (line) => this.#log(line),
        });
        this.webs = new ExtensionWebs({
            changed: (access) => this.#websChanged(access),
            deliver: (part, access, event, data, to) => {
                for (const client of this.#clients) {
                    if (
                        (to === undefined || client.user.id === to) &&
                        mayUse(client.user, access)
                    ) {
                        client.send("ext", { module: part.module, event, data });
                    }
                }
            },
            // Everyone's tabs hear the new list in `hello`: commands are for guests too, not by a browser module's access.
            commandsChanged: () => this.#websChanged("all"),
            log: (line) => this.#log(line),
            // Something about a module only the owner can mend: their tabs, as what it says can name the server's folders.
            warn: (message) => this.ownerNotice("warning", message),
        });
    }

    /**
     * Browser modules came, went, or changed: the tabs of the people they are for hear which to load, once for changes
     * that come together.
     */
    #websChanged(access: readonly WebAccess[] | "all"): void {
        if (this.#closing !== undefined) {
            return;
        }

        if (access === "all") {
            this.#websAll = true;
        } else {
            for (const each of access) {
                this.#websFor.add(each);
            }
        }

        if (this.#websTimer !== undefined) {
            return;
        }

        this.#websTimer = setTimeout(() => {
            const changed = [...this.#websFor];
            const all = this.#websAll;

            this.#websTimer = undefined;
            this.#websFor.clear();
            this.#websAll = false;
            void this.#refreshClients((user) => all || changed.some((each) => mayUse(user, each)));
        }, 50);
    }

    /** Write a line to the server log. */
    log(line: string): void {
        this.#log(line);
    }

    static async open(options: OpenOptions): Promise<PocketApp> {
        const app = new PocketApp(options);

        try {
            await app.#open();
        } catch (error) {
            if (app.#releaseLock !== undefined) {
                await app.close();
            }

            throw error;
        }

        return app;
    }

    async #open(): Promise<void> {
        this.#releaseLock = takeLock(this.#lockFile);
        this.provideEnvironment({ claims: onComputer, env: (cwd) => this.computer.env(cwd) });

        if (Number.isFinite(idleMinutes())) {
            this.#stopIdleWatch = this.computer.watchIdle();
        }

        try {
            this.pushStore = new PushStore(this.dataDir);
        } catch (error) {
            this.#log(`Push notifications are off: ${describe(error)}`);
        }

        this.settings = SettingsManager.create(this.defaultCwd);

        try {
            configureHttp(
                this.settings.getHttpIdleTimeoutMs() || 2_147_483_647,
                this.settings.getGlobalSettings().httpProxy,
            );
        } catch (error) {
            this.#log(`HTTP setup failed, using Node defaults: ${describe(error)}`);
        }

        this.models = await ModelRuntime.create();
        // Innermost: observe the adapter payload as it is sent.
        this.cacheKeeper.installPayloadObserver(this.models);
        this.providers.modelRefresh.watch(this.models);
        this.#configureModels?.(this.models);

        // noid: Claude through the owner's Claude Code, where there is one. Tests bring models of their own.
        if (this.#configureModels === undefined) {
            const claude = await claudeBinary();

            if (claude !== undefined) {
                this.models.registerNativeProvider(claudeCliProvider(claude).provider);
                this.#log(`Claude Code models through ${claude}`);
            }
        }

        measureModelStreams(this.models);
        // Outermost: it sees each real request finish, and replays it through the wrappers below.
        this.cacheKeeper.install(this.models);
        await this.models.getAvailable().catch(() => []);

        const registry = createRegistry();

        registry.install(CodingTools);
        // noid: approvals are a guard, so they are part of the app, not a module someone can turn off.
        registry.install(createApprovals(this));
        // noid: bots' own tools, which bots select (`Bots.create`) and other conversations do not.
        registry.install(this.botMail.extension);
        registry.install(this.botMail.overseer);
        registry.install(this.desktop.extension);
        registry.install(this.groups.extension);
        // Durable work of the app itself, whatever extension modules are on.
        registry.install(
            defineExtension({
                name: "pocket-core",
                tasks: [
                    ResendTask,
                    this.shell.task,
                    this.commands.followTask,
                    this.extensionCommands.task,
                ],
            }),
        );
        const host: PocketHost = {
            guard: this.guard,
            approvals: this.approvals,
            agentDir: getAgentDir(),
            dataDir: this.dataDir,
            pocketVersion: pocketVersion(),
            modelInfo: (spec) => modelInfo(this.models, spec),
            skillPaths: () => {
                try {
                    return this.settings.getSkillPaths();
                } catch {
                    return [];
                }
            },
            skills: (cwd) => this.skills(cwd),
            agentFiles: (conversationId) =>
                this.attribution.requesterOf(conversationId) === ownerOf(this)?.id
                    ? this.bots.agentFiles()
                    : [],
            resolveModel: (spec) => resolveModel(this.models, spec, this.signInNeeded),
            subagentModels: () => this.config.subagentModels,
            modelProblem: (ref, fresh) => this.providers.problem(ref, fresh),
            fetchPublic: createPublicFetch(),
            requesterOf: (conversationId) => this.attribution.requesterOf(conversationId),
            notice: (level, message, conversationId) => this.notice(level, message, conversationId),
            heldBack: (conversationId) => this.spend.heldBack(conversationId),
            onLimitsChanged: (listener) => this.spend.onLimitsChanged(listener),
            onHost: (conversationId) => this.onHost(conversationId),
            botOf: (conversationId) => this.bots.of(conversationId),
            linkedSessions: this.linkedSessions,
            schedules: this.schedules,
            goals: this.goals,
            browsers: this.browsers,
            sessionTools: this.sessionTools,
            watches: this.watches,
            repoWatches: this.repoWatches,
            memory: this.memory,
            gallery: this.gallery,
            text: Object.freeze({ quoted, defang }),
            thinkingLevels: THINKING_LEVELS,
        };

        this.#registry = registry;
        const dropIn = join(this.dataDir, "extensions");

        try {
            prepareDropInFolder(dropIn, join(APP_ROOT, "node_modules"));
        } catch (error) {
            this.#log(`Drop-in extensions cannot import Pi Pocket's packages: ${describe(error)}`);
        }

        try {
            linkTypes(dropIn, join(APP_ROOT, "types", "pocket.d.ts"));
        } catch (error) {
            this.#log(`The drop-in folder has no _pocket.d.ts: ${describe(error)}`);
        }

        this.loader = new ExtensionLoader(
            registry,
            host,
            { builtIn: join(APP_ROOT, "src", "server", "extensions"), dropIn },
            (file) => this.config.extensionChoice(file),
            // What a module's load says can name the server's folders, or quote a provider: the owner's to read.
            { webs: this.webs, notify: (level, message) => this.ownerNotice(level, message) },
        );
        await this.themes.load().catch((error: unknown) => {
            this.#log(`Themes could not be read: ${describe(error)}`);
        });
        // A gallery update the server stopped in the middle of goes back first, so no extension loads half of one, and
        // a theme it had out of its folder is back before the owner's default is checked.
        await this.gallery.recover().catch((error: unknown) => {
            this.#log(`The extension gallery could not check its updates: ${describe(error)}`);
        });
        await this.#themeDefaultStillHere();
        await this.loader.loadAll();

        const storage = await openNodeSqliteStorage(join(this.dataDir, "pocket.sqlite"));

        this.#openingStorage = storage;
        this.harness = await Harness.open(
            storage,
            {
                models: this.models,
                registry,
                settings: this.#harnessSettings(),
                now: this.now,
                env: ({ cwd }) => this.envAt(cwd ?? this.defaultCwd),
                conversationCreated: async (tx, conversation) => {
                    // Every conversation gets the app's documents up front, so views can read them from the start.
                    await tx.doc(AuthorsDoc, conversation.id);
                    await tx.doc(ArtifactsDoc, conversation.id);
                    await tx.doc(SubagentsDoc, conversation.id);
                },
                onReport: (error) => this.notice("warning", describe(error)),
            },
            context,
        );

        this.#openingStorage = undefined;
        const conversations = await this.#recover(storage);

        await this.spend.load(conversations);

        this.#unsubscribeCommits = this.harness.subscribeCommits((publication) =>
            this.#committed(publication),
        );
        this.#unsubscribeApprovals = this.approvals.subscribe((id) => {
            void this.#rooms.get(id)?.then(
                (room) => room.schedule(),
                () => {},
            );
            const root = this.rootOf(id);

            // A subagent's call waits on its session's peek tile too.
            if (root !== id) {
                void this.#rooms.get(root)?.then(
                    (room) => room.schedulePeek(),
                    () => {},
                );
            }

            this.#scheduleSessions();
            this.alerts.announceApprovals();
        });
        // A browser page's address, title, and loading go to the tabs watching its conversation, as they change.
        this.#unsubscribeBrowsers = this.browsers.subscribe((id, state) => {
            const conversationId = id as unknown as ConversationId;

            void this.#rooms.get(conversationId)?.then(
                (room) => {
                    for (const client of room.clients) {
                        client.send("browser", this.#browserEvent(conversationId, state));
                    }
                },
                () => {},
            );
        });

        if (this.guardOn()) {
            void this.guard.warm().catch(() => {});
        }

        // noid: Noid is there from the first open. Its folder on the computer is made when it first works.
        if (this.#mainBot) {
            await this.bots.ensureNoid();
        }

        // Bots made before their tools existed get them (a no-op for the rest).
        await this.bots.ensureTools();

        // noid: a bot for each agent file, kept up with the files while the server runs.
        if (this.#mainBot) {
            await this.#syncAgentFiles();
            this.#agentFilesTimer = setInterval(() => void this.#syncAgentFiles(), AGENT_FILES_MS);
            this.#agentFilesTimer.unref();
        }

        await this.desktop.restore();

        // Work a previous process left unfinished continues now.
        this.harness.resume();
    }

    /**
     * What this process keeps in memory about every conversation, read back from storage at startup: which are busy,
     * their agents, chat, subagents, and who Pi works for in each. Authors a crash kept out of the authors documents are
     * written back, in one commit. Returns every conversation's id.
     */
    async #recover(storage: Storage): Promise<ConversationId[]> {
        this.#sessions = { ...((await this.harness.snapshot(SessionsDoc, context))?.items ?? {}) };
        const conversations: ConversationId[] = [];
        const unrecorded = new Map<ConversationId, Missing[]>();
        let cursor: Cursor | undefined;

        do {
            const page = await this.harness.commit(
                (tx) => tx.scanConversations({}, 256, cursor),
                context,
            );

            for (const { id } of page.items) {
                conversations.push(id);
                const live = await this.harness.snapshot(LiveDoc, id, context);

                if (live?.run !== undefined) {
                    this.#busy.add(id);
                }

                const agent = await this.harness.snapshot(AgentDoc, id, context);

                if (agent !== undefined) {
                    this.#agents.set(id, agent as AgentState);
                }

                this.#noteChat(id, (await this.harness.snapshot(ChatDoc, id, context))?.messages);
                const missing = await this.attribution.recover(
                    storage,
                    id,
                    await this.harness.snapshot(AuthorsDoc, id, context),
                );

                if (missing.length > 0) {
                    unrecorded.set(id, missing);
                }

                this.#noteSubagents(id, await this.harness.snapshot(SubagentsDoc, id, context));
            }

            cursor = page.next;
        } while (cursor !== undefined);

        await this.attribution.repair(unrecorded);

        return conversations;
    }

    /** Every commit, as Pi Durable publishes it: what the app keeps in memory follows it, and so do the open views. */
    #committed(publication: CommitPublication): void {
        let sessionsChanged = false;

        let alreadyPaid = false;

        // A cache warm pays its captured person in the same commit as its usage, in either document order. A commit
        // with both documents has paid every usage change in it. Normal spend counts never change UsageDoc.
        for (const change of publication.changes) {
            if (
                change.type === "document" &&
                change.record.kind === SpendDoc.definition.kind &&
                change.value !== null
            ) {
                this.spend.countedChanged(change.value as { people: Record<string, number> });
                alreadyPaid = true;
            }
        }

        // Usage in a commit is from the work that was going on before it: it is counted before a message the same
        // commit places changes whom Pi works for.
        for (const change of publication.changes) {
            if (
                change.type === "document" &&
                change.record.kind === UsageDoc.definition.kind &&
                change.conversationId !== undefined
            ) {
                this.spend.usageChanged(
                    change.conversationId,
                    change.value as UsageState | null,
                    alreadyPaid,
                );

                // A team's top session with a limit shows the team's spend: it follows a linked session's too.
                const root = this.rootOf(change.conversationId);
                const top = this.spend.teamRoot(root);

                if (top !== root && this.#sessions[String(top)]?.budget !== undefined) {
                    void this.#rooms.get(top)?.then(
                        (room) => room.schedule(),
                        () => {},
                    );
                }
            }
        }

        for (const change of publication.changes) {
            if (change.type === "document") {
                if (this.#documentCommitted(change)) {
                    sessionsChanged = true;
                }
            } else if (change.type === "submission") {
                this.attribution.submissionCommitted(change.value);
                this.schedules.settled(change.value);

                // A run that failed because its provider's sign-in could not be renewed marks that provider; one that
                // was answered shows its provider works, and a mark it had (signed in again in Pi's terminal app, say)
                // is asked again.
                if (change.value.status === "unanswered" && change.value.reason === "model_error") {
                    this.providers.runFailed(change.value.detail);
                } else if (change.value.status === "done") {
                    const provider = this.#agents.get(change.value.conversationId)?.model?.provider;

                    if (provider !== undefined) {
                        this.providers.runAnswered(provider);
                    }
                }

                // Its run failed: the commit that settles it ends the run too, so the list hears of both at once.
                if (
                    change.value.status === "unanswered" &&
                    FAILED_RUN.has(change.value.reason) &&
                    this.#sessions[String(change.value.conversationId)] !== undefined &&
                    !this.#failed.has(change.value.conversationId)
                ) {
                    this.#failed.set(
                        change.value.conversationId,
                        cutWhole(
                            whyUnanswered(change.value.reason, change.value.detail),
                            FAILURE_TEXT,
                        ),
                    );
                    sessionsChanged = true;
                }
            }
        }

        if (sessionsChanged) {
            this.#scheduleSessions();
        }
    }

    /**
     * Pi started work in session `id` at `at`: it moves up the list, as a message sent there does, whatever started it
     * (a scheduled message, a subagent's report, a message sent again after a restart). One moved up since `at` (a
     * message through `Commands.submit` moves it too) is left as it is. A commit listener may not commit, so this commits
     * after it.
     */
    #movedUp(id: ConversationId, at: number): void {
        setImmediate(() => {
            this.harness
                .commit(async (tx) => {
                    const meta = (await tx.doc(SessionsDoc)).items[String(id)];

                    if (meta !== undefined && meta.updatedAt < at) {
                        meta.updatedAt = Date.now();
                    }
                }, context)
                .catch((error: unknown) => this.log(`session not moved up: ${describe(error)}`));
        });
    }

    /** A document changed: the views that show it update. True when the session list changed too. */
    #documentCommitted(change: Extract<DocumentCommitChange, { type: "document" }>): boolean {
        const kind = change.record.kind;
        const id = change.conversationId;
        let sessionsChanged = false;

        if (kind === "pi.live" && id !== undefined) {
            const busy = (change.value as LiveState | null)?.run !== undefined;

            if (busy !== this.#busy.has(id)) {
                if (busy) {
                    this.#busy.add(id);
                    // A new run starts over: whether it fails is its own to say.
                    this.#failed.delete(id);

                    if (this.#sessions[String(id)] !== undefined) {
                        this.#movedUp(id, Date.now());
                    }
                } else {
                    this.#busy.delete(id);
                }

                sessionsChanged = true;
                this.alerts.runChanged(id, busy);

                if (!busy) {
                    this.workspace.runEnded(id);
                    this.desktop.runEnded(id);
                }

                if (!busy) {
                    this.spend.runEnded(id);
                    // No request follows the last tool call of a run that ended or was stopped (Noid's and bots' too).
                    this.cacheKeeper.runEnded(Number(id));
                    this.noidCompaction.runEnded(id);

                    if (this.#sessions[String(id)] !== undefined) {
                        this.#endedAt.set(id, Date.now());
                    }

                    // Read once this change is committed: inside its listener, the answer is not there yet.
                    if (this.#sessions[String(id)]?.bot !== undefined) {
                        setTimeout(() => void this.#readLastSaid(String(id)), 0);
                    }
                }

                // A parent shows its subagents' busy state.
                for (const pending of this.#rooms.values()) {
                    void pending.then((room) => {
                        if (
                            Object.values(room.subagents).some(
                                (record) => record.conversationId === id,
                            )
                        ) {
                            room.schedule();
                        }
                    });
                }
            }
        } else if (kind === "pi.agent" && id !== undefined) {
            if (change.value !== null) {
                this.#agents.set(id, change.value as AgentState);
            }

            sessionsChanged = true;
        } else if (kind === SessionsDoc.definition.kind) {
            this.#sessions = {
                ...((change.value as { items?: Record<string, SessionMeta> } | null)?.items ?? {}),
            };
            sessionsChanged = true;

            // Views show a session's title, limit, and worktree from here.
            for (const pending of this.#rooms.values()) {
                void pending.then(
                    (room) => room.schedule(),
                    () => {},
                );
            }
        } else if (kind === FolderFavoritesDoc.definition.kind) {
            this.folderFavorites.committed(
                change.value as { users: Record<string, string[]> } | null,
            );
        } else if (kind === MemoryDoc.definition.kind) {
            this.memory.committed();
        } else if (ROOM_DOCS.has(kind) && id !== undefined) {
            if (kind === ChatDoc.definition.kind) {
                if (
                    this.#noteChat(
                        id,
                        (change.value as { messages?: ChatMessage[] } | null)?.messages,
                    )
                ) {
                    sessionsChanged = true;
                }
            } else if (kind === SubagentsDoc.definition.kind) {
                this.#noteSubagents(id, change.value as SubagentsValue | null);
                // The list counts each session's subagents, and the board lists them.
                sessionsChanged = true;
            }

            void this.#rooms.get(id)?.then(
                (room) => room.setDoc(kind, change.value as Record<string, unknown> | null),
                () => {},
            );

            if (kind === TurnsDoc.definition.kind) {
                for (const pending of this.#rooms.values()) {
                    void pending.then(
                        (room) => {
                            if (room.id !== id && this.rootOf(room.id) === id) {
                                room.setDoc(kind, change.value as Record<string, unknown> | null);
                            }
                        },
                        () => {},
                    );
                }
            }
        }

        return sessionsChanged;
    }

    /** How model requests stream here: Pi's timeout and retries. Pi Durable's requests and Noid's summaries use it. */
    streamSettings(): { timeoutMs: number; maxRetryDelayMs?: number; maxRetries?: number } {
        const read = <T>(get: () => T): T | undefined => {
            try {
                return get();
            } catch {
                return undefined;
            }
        };

        const provider = read(() => this.settings.getProviderRetrySettings());
        const idle = read(() => this.settings.getHttpIdleTimeoutMs()) ?? 300_000;

        return {
            timeoutMs: provider?.timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle),
            ...(provider?.maxRetryDelayMs === undefined
                ? {}
                : { maxRetryDelayMs: provider.maxRetryDelayMs }),
            ...(provider?.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
        };
    }

    #harnessSettings(): HarnessSettings {
        const settings = this.settings;
        // Each model's own compaction values from Pi's settings, too (Pi Pocket a0a7f6c).
        const compaction = compactionReader(settings, (line) => this.#log(line));

        const safe = <T>(read: () => T): T | undefined => {
            try {
                return read();
            } catch {
                return undefined;
            }
        };

        const registry = () => this.#registry;
        const stream = () => this.streamSettings();

        return {
            // A phase can wait for hours without changing state; repeated process kills must not park it.
            restartLimit: Infinity,
            // Every installed extension, in install order, but the session tools: their tools and prompt are for bots'
            // conversations only, which select them by name (`session-tools.ts`).
            get extensions() {
                return registry()
                    ?.snapshot()
                    .installed()
                    .filter(
                        (extension) =>
                            extension.name !== SESSION_TOOLS_EXTENSION &&
                            extension.name !== BOT_MAIL_EXTENSION &&
                            extension.name !== OVERSEER_EXTENSION &&
                            extension.name !== DESKTOP_EXTENSION,
                    );
            },
            get stream() {
                return stream();
            },
            get compaction() {
                return safe(compaction) ?? {};
            },
            get retry() {
                return safe(() => settings.getRetrySettings()) ?? {};
            },
            get steeringMode() {
                return safe(() => settings.getSteeringMode());
            },
            get followUpMode() {
                return safe(() => settings.getFollowUpMode());
            },
        } as HarnessSettings;
    }

    /** Where a conversation's commands run: an extension's environment that claims its folder, else this machine. */
    envFor(id: ConversationId): ExecutionEnv {
        return this.envAt(this.cwdOf(id));
    }

    /** Whether a conversation's folder is on this machine, so features that read it directly (files, git) may. */
    onHost(id: ConversationId): boolean {
        return !this.claims(this.cwdOf(id));
    }

    /** Whether an extension's environment runs this folder (it is not a folder of this machine). */
    claims(cwd: string): boolean {
        return this.#providerOf(cwd) !== undefined;
    }

    /** Adds an environment: it claims the folders it runs (returning their environment) and leaves the rest. */
    provideEnvironment(provider: EnvironmentProvider): () => void {
        this.#environments.add(provider);

        return () => this.#environments.delete(provider);
    }

    #providerOf(cwd: string): EnvironmentProvider | undefined {
        for (const provider of this.#environments) {
            if (provider.claims(cwd)) {
                return provider;
            }
        }

        return undefined;
    }

    /** Where commands in a folder run: the environment that claims it, else this machine. */
    envAt(cwd: string): ExecutionEnv {
        return this.#providerOf(cwd)?.env(cwd) ?? this.#env(cwd);
    }

    #env(cwd: string): NodeExecutionEnv {
        let env = this.#envs.get(cwd);

        if (env === undefined) {
            env = new NodeExecutionEnv({ cwd });
            this.#envs.set(cwd, env);
        }

        return env;
    }

    // ─── Clients ────────────────────────────────────────────────────────────

    notice(
        level: "info" | "warning" | "error",
        message: string,
        conversationId?: ConversationId,
    ): void {
        this.#log(`[${level}] ${message}`);

        for (const client of this.#clients) {
            // Server-wide notices can name other sessions' folders: people invited to one session do not get them.
            const reaches =
                conversationId === undefined
                    ? client.user.sessions === undefined
                    : client.conversationId === conversationId &&
                      this.canSee(client.user, conversationId);

            if (reaches) {
                client.send("notice", { level, message });
            }
        }
    }

    /** A notice for the owner's tabs alone: about what only they may change. */
    ownerNotice(level: "info" | "warning" | "error", message: string): void {
        this.#log(`[${level}] ${message}`);

        for (const client of this.#clients) {
            if (client.user.role === "owner") {
                client.send("notice", { level, message });
            }
        }
    }

    /** Every open view builds itself again: what it shows from outside its documents changed (a model's sign-in). */
    refreshViews(): void {
        for (const pending of this.#rooms.values()) {
            void pending.then(
                (room) => room.schedule(),
                () => {},
            );
        }
    }

    /** Every connected tab. */
    get clients(): ReadonlySet<Client> {
        return this.#clients;
    }

    /** Tell every browser to reload, after a web file changed. */
    reloadClients(file: string): void {
        for (const client of this.#clients) {
            client.send("reload", { file });
        }
    }

    /**
     * Start sending a tab its events. The tab may close during the waits here (opening a room, or the guard's status
     * right after a restart, when every browser reconnects at once): `detach` has then run, and the tab must not be added.
     */
    async attach(client: Client): Promise<void> {
        const arriving = !this.#online(client.user.id);

        this.#clients.add(client);
        const hello = await this.hello(client.user);

        if (!this.#clients.has(client)) {
            return;
        }

        client.send("hello", this.#helloFor(client, hello));
        this.#sendSessions(client, this.sessions(client.user));

        if (client.user.role === "owner" && this.themes.failure !== undefined) {
            client.send("notice", { level: "warning", message: this.themes.failure });
        }

        if (arriving) {
            this.#peopleChanged(client.user.id);
        }

        if (client.conversationId === undefined) {
            return;
        }

        if (!this.canSee(client.user, client.conversationId)) {
            client.send("missing", {
                conversationId: client.conversationId,
                message: "This session is not shared with you.",
            });
            // Keep the tab for app-wide events only: nothing about that conversation reaches it, and it is not "there".
            client.conversationId = undefined;

            return;
        }

        try {
            const id = client.conversationId;
            const room = await this.room(id);

            if (!this.#clients.has(client)) {
                this.releaseRoom(room);

                return;
            }

            room.keepOpen();
            room.clients.add(client);
            room.push(client, true);
            client.send("chat", { conversationId: room.id, full: true, messages: room.chat });
            client.send("notes", { conversationId: room.id, ...room.notes });
            // Also while the browser is off: turned on later, the panel has its state at once.
            client.send(
                "browser",
                this.#browserEvent(room.id, this.browsers.state(Number(room.id))),
            );

            for (const other of room.clients) {
                if (other !== client) {
                    room.push(other, false);
                }
            }

            room.pushPresence();
            this.#scheduleSessions();
        } catch (error) {
            client.send("missing", {
                conversationId: client.conversationId,
                message: describe(error),
            });
        }
    }

    detach(client: Client): void {
        if (!this.#clients.delete(client)) {
            return;
        }

        for (const id of client.peeks ?? []) {
            this.#unpeek(client, id);
        }

        client.peeks = undefined;

        if (!this.#online(client.user.id)) {
            this.#peopleChanged(client.user.id);
        }

        if (client.conversationId === undefined) {
            return;
        }

        this.#leaveRoom(client, client.conversationId);
    }

    /** Take a tab out of a conversation's room: the others see it go, and the room closes once no tab is left. */
    #leaveRoom(client: Client, id: ConversationId): void {
        void this.#rooms.get(id)?.then(
            (room) => {
                if (!room.clients.delete(client)) {
                    return;
                }

                if (!room.has(client.user.id)) {
                    room.setTyping(client.user.id, null);
                }

                room.pushPresence();
                room.schedule();
                this.#scheduleSessions();
                this.releaseRoom(room);
            },
            () => {},
        );
    }

    /**
     * The sessions a connection shows as peek tiles on its screen now, and the subagents its subagents bar shows. Each
     * gets short `peek` updates while it stays there; the rest stop, and their views close as they do when the last tab
     * leaves. Conversations this person may not see are left out. `connection` is the id its `hello` carried. A list
     * numbered `seq` below one already taken arrived late, and is dropped.
     */
    setPeeks(user: User, connection: string, ids: readonly ConversationId[], seq?: number): void {
        // Sessions, and the subagents of sessions: the subagents bar shows what each does now.
        const wanted = new Set(
            ids
                .filter(
                    (id) =>
                        this.#sessions[String(this.rootOf(id))] !== undefined &&
                        this.canSee(user, id),
                )
                .slice(0, MAX_PEEKS),
        );

        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            if (seq !== undefined) {
                if (seq <= (client.peekSeq ?? -Infinity)) {
                    continue;
                }

                client.peekSeq = seq;
            }

            const had = client.peeks ?? new Set<ConversationId>();

            client.peeks = new Set(wanted);

            for (const id of had) {
                if (!wanted.has(id)) {
                    this.#unpeek(client, id);
                }
            }

            for (const id of wanted) {
                if (!had.has(id)) {
                    void this.#peek(client, id);
                }
            }
        }
    }

    async #peek(client: Client, id: ConversationId): Promise<void> {
        let room: Room;

        try {
            room = await this.room(id);
        } catch {
            // A session that is gone has no tile to show.
            return;
        }

        // The tab left, or scrolled the tile away, while the view opened.
        if (!this.#clients.has(client) || client.peeks?.has(id) !== true) {
            this.releaseRoom(room);

            return;
        }

        // Scrolled away and back while the view opened: the first of the two calls added it already.
        if (room.peekers.has(client)) {
            return;
        }

        room.keepOpen();
        room.peekers.add(client);
        room.pushPeek(client);
    }

    #unpeek(client: Client, id: ConversationId): void {
        void this.#rooms.get(id)?.then(
            (room) => {
                if (room.peekers.delete(client)) {
                    this.releaseRoom(room);
                }
            },
            () => {},
        );
    }

    /** A tab was hidden or shown: hidden tabs show their person as away, and let push notifications through. */
    setVisible(user: User, tab: string, visible: boolean): void {
        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.id !== tab || client.visible === visible) {
                continue;
            }

            client.visible = visible;
            const id = client.conversationId;

            if (id !== undefined) {
                void this.#rooms.get(id)?.then(
                    (room) => room.pushPresence(),
                    () => {},
                );
            }
        }
    }

    #online(userId: string): boolean {
        for (const client of this.#clients) {
            if (client.user.id === userId) {
                return true;
            }
        }

        return false;
    }

    /** Is this person looking at this conversation right now, in a visible tab? */
    watching(userId: string, id: ConversationId): boolean {
        for (const client of this.#clients) {
            if (
                client.user.id === userId &&
                client.conversationId === id &&
                client.visible !== false
            ) {
                return true;
            }
        }

        return false;
    }

    /** Change someone's name: shown at once on their messages, in the people lists, and on their avatar. */
    rename(user: User, name: string): void {
        this.#profileChanged(user, { name });
    }

    /** noid: change someone's face: shown at once wherever their avatar is, as a bot's is when it is edited. */
    setFace(user: User, face: PersonFace): void {
        this.#profileChanged(user, { face: Object.keys(face).length === 0 ? undefined : face });
    }

    #profileChanged(user: User, change: Pick<User, "name"> | Pick<User, "face">): void {
        this.config.updateUser(user.id, change);
        this.#peopleChanged();

        for (const pending of this.#rooms.values()) {
            void pending.then(
                (room) => room.has(user.id) && room.pushPresence(),
                () => {},
            );
        }
    }

    /** Someone came, went, or changed: remember when they were last here and tell everyone. */
    #peopleChanged(userId?: string): void {
        if (userId !== undefined && this.config.userById(userId) !== undefined) {
            // Only a timestamp: a full disk must not stop the server on every connect and close.
            try {
                this.config.updateUser(userId, { lastSeen: Date.now() });
            } catch (error) {
                this.#log(`last seen not saved: ${describe(error)}`);
            }
        }

        for (const client of this.#clients) {
            client.send("users", this.people(client.user));
        }
    }

    /**
     * The people with access to this server as `viewer` may see them: who is online now, and when the others were last
     * here. People invited to one session see only those who share it, and not which sessions others are limited to.
     */
    people(viewer: User) {
        const scope = viewer.sessions;

        return this.config.users
            .filter(
                (each) =>
                    scope === undefined ||
                    each.sessions === undefined ||
                    each.sessions.some((id) => scope.includes(id)),
            )
            .map((each) => ({
                id: each.id,
                name: each.name,
                role: each.role,
                ...(each.face === undefined ? {} : { face: each.face }),
                online: this.#online(each.id),
                ...(each.lastSeen === undefined ? {} : { lastSeen: each.lastSeen }),
                ...(each.sessions === undefined || scope !== undefined
                    ? {}
                    : { sessions: each.sessions.map(Number) }),
            }));
    }

    // ─── Access ─────────────────────────────────────────────────────────────

    /** A session's conversations: itself and the subagents under it that are known here. */
    conversationsOf(root: ConversationId): ConversationId[] {
        return [
            ...new Set([
                root,
                ...[...this.#agents.keys()].filter((id) => this.rootOf(id) === root),
            ]),
        ];
    }

    /** The conversation that spawned a subagent's; undefined for any other conversation. */
    parentOf(id: ConversationId): ConversationId | undefined {
        return this.#parents.get(id);
    }

    /** The session a conversation belongs to: itself, or the session its subagent chain started from. */
    rootOf(id: ConversationId): ConversationId {
        let current = id;

        for (let depth = 0; depth < 32; depth++) {
            const parent = this.#parents.get(current);

            if (parent === undefined) {
                return current;
            }

            current = parent;
        }

        return current;
    }

    /**
     * People invited to one session see only that session and its subagents. A bot is the owner's alone: its session
     * tools act as them, so anyone else who could write to it would act as them too.
     */
    canSee(user: User, id: ConversationId): boolean {
        const root = this.rootOf(id);
        const theirs = this.sessionTools.actsFor(root);

        if (theirs !== undefined && theirs !== user.id) {
            return false;
        }

        // The shared computer is the owner's too (its browser holds every bot's logins): someone else works in a
        // session there only when invited to that one session.
        if (user.role !== "owner" && user.sessions === undefined && !this.onHost(root)) {
            return false;
        }

        return user.sessions === undefined || user.sessions.includes(String(root));
    }

    requireSee(user: User, id: ConversationId): void {
        if (!this.canSee(user, id)) {
            throw new HttpError(404, "This session is not shared with you.");
        }
    }

    /** Viewers read, chat, and react; they never make Pi do anything. */
    requireSteer(user: User): void {
        if (user.role === "viewer") {
            throw new HttpError(
                403,
                "You can view this session but not steer Pi. Ask the owner for steering rights.",
            );
        }
    }

    /** While take turns is on, only the driver sends to Pi or changes its settings. */
    async requireDriver(id: ConversationId, user: User): Promise<void> {
        this.requireSteer(user);
        const turns = await this.harness.snapshot(TurnsDoc, this.rootOf(id), context);

        if (turns?.on !== true || turns.driver === user.id) {
            return;
        }

        const driver = turns.driver === undefined ? undefined : this.config.userById(turns.driver);

        throw new HttpError(
            409,
            driver === undefined
                ? "Take turns is on: take the wheel first."
                : `${driver.name} is driving. Ask to drive first.`,
        );
    }

    #noteChat(id: ConversationId, messages: readonly ChatMessage[] | undefined): boolean {
        const last = messages?.findLast((message) => message.kind !== "event");
        const key = String(id);
        const before = this.#lastChat.get(key);

        if (last === undefined) {
            return this.#lastChat.delete(key);
        }

        if (before?.at === last.at && before.userId === last.userId) {
            return false;
        }

        this.#lastChat.set(key, { at: last.at, userId: last.userId });

        return true;
    }

    #noteSubagents(id: ConversationId, doc: SubagentsValue | null | undefined): void {
        const agents = doc?.agents ?? {};

        for (const record of Object.values(agents)) {
            this.#parents.set(record.conversationId, id);
        }

        if (Object.keys(agents).length === 0) {
            this.#subagents.delete(id);
        } else {
            this.#subagents.set(id, { agents: { ...agents }, reporting: reportingOf(doc) });
        }
    }

    /**
     * Every subagent, by the session it works in (its parent's, or the session its parent's chain started from), as the
     * subagents board shows it: the subagents bar's view, with the session and the call it waits on, if any.
     */
    #subagentsBySession(): Map<string, SubagentEntry[]> {
        const asks = new Map<ConversationId, ApprovalRequest>();

        for (const approval of this.approvals.all()) {
            if (!asks.has(approval.conversationId)) {
                asks.set(approval.conversationId, approval);
            }
        }

        const sessions = new Map<string, SubagentEntry[]>();

        for (const [parent, { agents, reporting }] of this.#subagents) {
            const session = String(this.rootOf(parent));

            if (this.#sessions[session] === undefined) {
                continue;
            }

            const list = sessions.get(session) ?? [];

            for (const [name, record] of Object.entries(agents)) {
                const ask = asks.get(record.conversationId);

                list.push({
                    id: Number(session),
                    ...subagentView(
                        name,
                        record,
                        this.#busy.has(record.conversationId),
                        reporting.has(name),
                    ),
                    ...(ask === undefined
                        ? {}
                        : {
                              waiting: true,
                              approval: { tool: ask.tool, subject: ask.subject.slice(0, 200) },
                          }),
                });
            }

            sessions.set(session, list);
        }

        return sessions;
    }

    /**
     * Every subagent in the sessions this person can see, for the subagents board, but a session's oldest finished ones
     * past `BOARD_FINISHED`. Archived sessions are left out, unless one of their subagents works or waits there.
     */
    subagents(user?: User): SubagentEntry[] {
        const all: SubagentEntry[] = [];

        for (const [id, list] of this.#subagentsBySession()) {
            if (user !== undefined && !this.canSee(user, Number(id) as unknown as ConversationId)) {
                continue;
            }

            if (this.#sessions[id]?.archived === true && !list.some((entry) => entry.busy)) {
                continue;
            }

            all.push(...forBoard(list));
        }

        return all;
    }

    /**
     * A tab opened or closed the subagents board: while open, it gets every subagent with each session list. A request
     * numbered `seq` below one already taken arrived late, and is dropped.
     */
    setBoard(user: User, connection: string, on: boolean, seq?: number): void {
        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            if (seq !== undefined) {
                if (seq <= (client.boardSeq ?? -Infinity)) {
                    continue;
                }

                client.boardSeq = seq;
            }

            client.board = on;
            client.boardSent = undefined;

            if (on) {
                this.#sendBoard(client, this.subagents(client.user));
            }
        }
    }

    /** Send a tab's board its subagents, unless they are what it last got. */
    #sendBoard(client: Client, entries: SubagentEntry[]): void {
        const json = JSON.stringify(entries);

        if (json !== client.boardSent) {
            client.boardSent = json;
            client.send("subagents", entries);
        }
    }

    /** A conversation's shared view, opened when no tab has it open. Hand it to `releaseRoom` when done with it. */
    async room(id: ConversationId): Promise<Room> {
        let pending = this.#rooms.get(id);

        if (pending === undefined) {
            pending = (async () => {
                const conversation = await this.harness.conversation(id, context);

                if (conversation === undefined) {
                    throw new HttpError(404, `Conversation ${String(id)} does not exist`);
                }

                const room = new Room(this, id);

                await room.open(conversation);

                return room;
            })();
            this.#rooms.set(id, pending);
            pending.catch(() => this.#rooms.delete(id));
        }

        return pending;
    }

    /** A conversation's shared view if it is open now; undefined otherwise, without opening it. */
    openRoom(id: ConversationId): Promise<Room> | undefined {
        return this.#rooms.get(id);
    }

    /** Close a room shortly after its last tab (or peek tile) left, unless one comes back first. */
    releaseRoom(room: Room): void {
        if (room.clients.size === 0 && room.peekers.size === 0) {
            room.closeLater(() => this.#rooms.delete(room.id));
        }
    }

    /** All signed-in models, with Pi's enabledModels scope marked for the picker. */
    async modelList() {
        // Pi settings are read from JSON; the SDK expects an array of strings.
        const configured = this.settings.getEnabledModels();
        const patterns = Array.isArray(configured)
            ? configured.filter((pattern): pattern is string => typeof pattern === "string")
            : [];
        // The scope asks Pi which models are available, which reads its sign-ins: one that cannot be read leaves the
        // scope out, as in a picker without one, rather than failing `hello` and with it every tab.
        const { scopedModels } =
            patterns.length > 0
                ? await resolveModelScopeWithDiagnostics(patterns, this.models).catch(() => ({
                      scopedModels: [],
                  }))
                : { scopedModels: [] };

        return modelList(this.models, this.signInNeeded, scopedModels);
    }

    async hello(user: User) {
        return {
            user: {
                id: user.id,
                name: user.name,
                role: user.role,
                ...(user.face === undefined ? {} : { face: user.face }),
                ...(user.sessions === undefined ? {} : { sessions: user.sessions.map(Number) }),
            },
            users: this.people(user),
            models: await this.modelList(),
            guard: await this.guardStatus(),
            server: {
                pocketVersion: pocketVersion(),
                supervised: this.supervised,
                startedAt: this.startedAt,
                home: homedir(),
                defaultCwd: this.defaultCwd,
                extensions: this.loader.extensionNames(),
                // The browser modules this person's tabs load (`extension-ui.js`), each with the tools its module
                // installs: the only ones whose calls it may describe (`pocket.toolCall`).
                ui: this.#browserModules(user),
                // The commands this person may run: viewers none, guests the ones for conversations.
                extensionCommands: this.webs
                    .commands()
                    .filter(
                        (command) =>
                            user.role === "owner" ||
                            (user.role === "guest" && command.scope === "conversation"),
                    ),
                // Tells the web app this server has people chat and typing indicators.
                chat: true,
                // Manual refresh reloads shared model configuration and catalogs; only the owner may start it.
                refreshModels: user.role === "owner",
                // Tells the web app this server sends peek tiles (`POST /api/peeks`, `peek` events).
                peeks: true,
                // This server's clock: peek tiles compare the browser's looks with when runs ended here.
                now: Date.now(),
                // Collaboration features: 2 adds roles, take turns, reactions, pins, notes, mentions, and push.
                collab: 2,
                reactions: REACTIONS,
                approvalRule: this.config.approvalRule,
                // The model and thinking level new sessions start with, or null for the last one picked.
                defaultModel: this.config.defaultModel ?? null,
                // The theme and colors of browsers that have not chosen their own, or null for the app's own.
                themeDefault: this.config.themeDefault ?? null,
                // The models Pi may start subagents on besides their session's own: the owner's to see and change.
                ...(user.role === "owner"
                    ? { subagentModels: [...this.config.subagentModels] }
                    : {}),
                // This person's bots have the session tools (`session-tools.ts`).
                sessionTools: this.sessionTools.available(user),
                // Tokens of context above which Noid compacts itself once idle; 0: only as sessions do.
                noidCompactAt: this.noidCompaction.compactAt,
            },
            // Read after the guard's wait, so a connecting device does not replace a live update with an older list.
            folderFavorites: await this.folderFavorites.list(user),
            // Every theme folder, for Appearance and for the look this tab uses (`theme.js`).
            themes: this.themes.list(user.role === "owner"),
        };
    }

    #browserModules(user: User) {
        const tools = new Map(
            this.loader
                .list()
                .map((each) => [
                    each.file.replace(/\.ts$/, ""),
                    each.extensions.flatMap((extension) => extension.tools),
                ]),
        );

        return this.webs
            .clients(user)
            .map((each) => ({ ...each, tools: tools.get(each.module) ?? [] }));
    }

    /** A tab's hello: what everyone gets, and the id of its own connection, which its peek lists name. */
    #helloFor(client: Client, hello: Awaited<ReturnType<PocketApp["hello"]>>) {
        return { ...hello, connection: client.connection };
    }

    #scheduleSessions(): void {
        if (this.#sessionsTimer !== undefined) {
            return;
        }

        this.#sessionsTimer = setTimeout(() => {
            this.#sessionsTimer = undefined;
            let all: ReturnType<PocketApp["sessions"]> | undefined;
            let board: SubagentEntry[] | undefined;
            // Everyone but the owner gets a list of their own: bots are the owner's alone, and scoped people see theirs.
            const lists = new Map<string, ReturnType<PocketApp["sessions"]>>();
            // Each list's JSON, worked out once however many tabs get it.
            const jsons = new Map<ReturnType<PocketApp["sessions"]>, string>();

            for (const client of this.#clients) {
                const user = client.user;
                const whole = user.role === "owner" && user.sessions === undefined;
                let list = whole ? (all ??= this.sessions()) : lists.get(user.id);

                if (list === undefined) {
                    list = this.sessions(user);
                    lists.set(user.id, list);
                }

                let json = jsons.get(list);

                if (json === undefined) {
                    json = JSON.stringify(list);
                    jsons.set(list, json);
                }

                this.#sendSessions(client, list, json);

                if (client.board === true) {
                    this.#sendBoard(
                        client,
                        whole ? (board ??= this.subagents()) : this.subagents(user),
                    );
                }
            }
        }, 400);
    }

    /** noid: read what a bot last said, then tell the lists. */
    async #readLastSaid(id: string): Promise<void> {
        this.#lastSaid.set(id, this.#lastSaid.get(id));

        try {
            const said = await this.transcripts.lastSaid(Number(id) as unknown as ConversationId);

            if (said !== this.#lastSaid.get(id)) {
                this.#lastSaid.set(id, said);
                this.#scheduleSessions();
            }
        } catch {
            // A conversation that cannot be read yet shows its role instead.
        }
    }

    /** Send a tab its session list, unless it is what the tab last got: the list is large, and changes come often. */
    #sendSessions(
        client: Client,
        sessions: ReturnType<PocketApp["sessions"]>,
        json = JSON.stringify(sessions),
    ): void {
        if (json !== client.sessionsSent) {
            client.sessionsSent = json;
            client.send("sessions", sessions);
        }
    }

    /**
     * The call each session waits on, by session: the oldest one waiting there or in a subagent of it, as a tile's peek
     * shows its calls, cut short (the list goes to every tab), and how many wait.
     */
    #oldestAsks(): Map<string, SessionAsk> {
        const asks = new Map<string, SessionAsk>();

        for (const request of this.approvals.all()) {
            const session = String(this.rootOf(request.conversationId));
            const kept = asks.get(session);

            if (kept !== undefined && kept.at <= request.createdAt) {
                kept.count++;

                continue;
            }

            asks.set(session, {
                id: request.id,
                conversationId: Number(request.conversationId),
                tool: request.tool,
                subject: cutWhole(request.subject, ASK_SUBJECT),
                reason: cutWhole(request.reason, ASK_REASON),
                ...(request.requestedBy === undefined ? {} : { requestedBy: request.requestedBy }),
                at: request.createdAt,
                count: (kept?.count ?? 0) + 1,
                ...(request.form === undefined ? {} : { form: true as const }),
            });
        }

        return asks;
    }

    /** The session list, with who is in each session and its newest chat message. Each person sees what they may open. */
    sessions(user?: User) {
        const waiting = new Set(
            this.approvals.all().map((approval) => String(this.rootOf(approval.conversationId))),
        );
        const people = new Map<string, Map<string, string>>();
        const subagents = this.#subagentsBySession();
        const asks = this.#oldestAsks();

        for (const client of this.#clients) {
            if (client.conversationId === undefined) {
                continue;
            }

            const key = String(client.conversationId);
            const here = people.get(key) ?? new Map<string, string>();

            here.set(client.user.id, client.user.name);
            people.set(key, here);
        }

        return Object.entries(this.#sessions)
            .filter(
                ([id]) =>
                    user === undefined ||
                    this.canSee(user, Number(id) as unknown as ConversationId),
            )
            .map(([id, meta]) => {
                const model = this.#agents.get(Number(id) as unknown as ConversationId)?.model;
                const busy = this.#busy.has(Number(id) as unknown as ConversationId);
                const here = [...(people.get(id) ?? new Map<string, string>())].map(
                    ([userId, name]) => ({ id: userId, name }),
                );
                const chat = this.#lastChat.get(id);

                if (meta.bot !== undefined && !this.#lastSaid.has(id)) {
                    void this.#readLastSaid(id);
                }

                const said = this.#lastSaid.get(id);
                const endedAt = this.#endedAt.get(Number(id) as unknown as ConversationId);
                const counts = countSubagents(subagents.get(id) ?? []);
                const failure = this.#failed.get(Number(id) as unknown as ConversationId);
                const failedAgents = failedSubagents(subagents.get(id) ?? []);
                const ask = asks.get(id);
                // Which of Pi's sessions it continues is the owner's to know (the Pi sessions sheet), not the list's.
                const { fromPi: _fromPi, linkedFrom, ...shown } = meta;
                // Linking does not share the origin: do not leak its id to someone who only sees the new chat.
                const origin =
                    linkedFrom === undefined ? undefined : this.#sessions[String(linkedFrom.id)];
                const visibleOrigin =
                    origin !== undefined &&
                    (user === undefined ||
                        this.canSee(user, linkedFrom!.id as unknown as ConversationId));

                const linkage: { linkedFrom?: SessionMeta["linkedFrom"]; linkedOrigin?: true } =
                    linkedFrom === undefined
                        ? {}
                        : visibleOrigin
                          ? { linkedFrom }
                          : { linkedOrigin: true };
                // A session a bot started works for it (`Bots.of`): its approval cards are the bot's.
                const worksFor =
                    meta.bot === undefined && linkedFrom !== undefined
                        ? this.bots.of(Number(id) as unknown as ConversationId)
                        : undefined;

                return {
                    id: Number(id),
                    ...shown,
                    ...linkage,
                    ...(worksFor === undefined ? {} : { worksFor }),
                    busy,
                    waiting: waiting.has(id),
                    ...(endedAt === undefined ? {} : { endedAt }),
                    ...(failure === undefined ? {} : { failed: true, failure }),
                    ...(failedAgents.length === 0 ? {} : { failedAgents }),
                    ...(ask === undefined ? {} : { approval: ask }),
                    ...(model === undefined ? {} : { model: model.modelId }),
                    ...(here.length === 0 ? {} : { people: here }),
                    ...(chat === undefined ? {} : { chatAt: chat.at, chatBy: chat.userId }),
                    ...(counts === undefined ? {} : { subagents: counts }),
                    ...(said === undefined ? {} : { said }),
                };
            })
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    isBusy(id: ConversationId): boolean {
        return this.#busy.has(id);
    }

    /** The conversations with a run going. */
    busyConversations(): ConversationId[] {
        return [...this.#busy];
    }

    /** The catalogue entry of a session; undefined for subagents and other conversations. */
    sessionMeta(id: ConversationId): SessionMeta | undefined {
        return this.#sessions[String(id)];
    }

    /** Every session's catalogue entry, by id. */
    sessionCatalogue(): Readonly<Record<string, SessionMeta>> {
        return this.#sessions;
    }

    /** When a session's last run ended, since this server started. */
    endedAt(id: ConversationId): number | undefined {
        return this.#endedAt.get(id);
    }

    async conversationTitle(id: ConversationId): Promise<string> {
        const meta = this.#sessions[String(id)];

        if (meta !== undefined) {
            return meta.title ?? "New session";
        }

        return `Conversation ${String(id)}`;
    }

    conversationInfo(room: Room) {
        const meta = this.#sessions[String(room.id)];
        const agent = (room.value?.docs["pi.agent"] ?? {}) as AgentState;
        const forkedFrom = meta?.forkedFrom;
        const root = this.rootOf(room.id);
        const budget = this.#sessions[String(root)]?.budget;

        return {
            id: room.id,
            kind:
                meta === undefined
                    ? room.parent === undefined
                        ? "conversation"
                        : "subagent"
                    : "session",
            title:
                meta?.title ??
                room.subagentName ??
                (meta === undefined ? `Conversation ${String(room.id)}` : "New session"),
            cwd: agent.cwd ?? meta?.cwd ?? this.defaultCwd,
            archived: meta?.archived === true,
            ...(room.parent === undefined ? {} : { parent: room.parent }),
            // A subagent's session, at any depth: whose bot it works for, for its approval cards.
            ...(root === room.id ? {} : { root: Number(root) }),
            ...(room.subagentName === undefined ? {} : { subagentName: room.subagentName }),
            // Each browser finds the source's title in its own session list, so only people who can open it get a link.
            ...(forkedFrom === undefined ? {} : { forkedFrom }),
            // The session's spend with its subagents', and its limit, with what counts against it.
            spend: {
                spent:
                    budget === undefined
                        ? this.spend.sessionSpent(root)
                        : this.spend.budgetSpent(root),
                ...(budget === undefined ? {} : { budget }),
            },
            ...(meta?.worktree === undefined
                ? {}
                : { worktree: { branch: meta.worktree.branch, source: meta.worktree.source } }),
            // Whether a fork could get a worktree of its own.
            ...(meta === undefined
                ? {}
                : { inRepository: this.workspace.inRepository(agent.cwd ?? meta.cwd) }),
        };
    }

    /** What a conversation runs with: its model, thinking level, folder, and instructions. */
    async agentState(id: ConversationId): Promise<AgentState | undefined> {
        return (
            this.#agents.get(id) ??
            ((await this.harness.snapshot(AgentDoc, id, context)) as AgentState | undefined)
        );
    }

    /** A conversation's handle; 404 when it does not exist. */
    async conversation(id: ConversationId): Promise<Conversation> {
        const conversation = await this.harness.conversation(id, context);

        if (conversation === undefined) {
            throw new HttpError(404, `Conversation ${String(id)} does not exist`);
        }

        return conversation;
    }

    /**
     * Why this person may not allow a call, or undefined when they may. With the "others" rule, a guest cannot allow a
     * call their own message led to; the owner always can. Denying is open to anyone who can steer.
     */
    cannotAllow(user: User, request: ApprovalRequest): string | undefined {
        if (user.role === "viewer") {
            return "You can view this session but not steer Pi.";
        }

        // Part of it is not on the card: nobody says yes to what they could not read.
        if (NOT_SHOWN.test(request.subject)) {
            return "This call is too long to show whole: deny it, and ask for it in smaller parts.";
        }

        // A question (Pi's `ask`) is answered by the person Pi works for: it asks what they want. With nobody known (a
        // bot's run, say), the owner answers it. Anyone who can steer can decline it.
        if (request.form !== undefined) {
            return (request.requestedBy ?? ownerOf(this)?.id) === user.id
                ? undefined
                : "Only the person Pi works for here can answer this.";
        }

        if (this.config.approvalRule !== "others" || user.role === "owner") {
            return undefined;
        }

        // Not knowing who asked is not knowing that it was someone else.
        if (request.requestedBy === undefined) {
            return "Nobody is known to have asked for this call, so only the owner can allow it.";
        }

        return request.requestedBy === user.id
            ? "Someone else has to allow a call that your message led to."
            : undefined;
    }

    async answerApproval(
        id: string,
        allow: boolean,
        user: User,
        always = false,
        values?: unknown,
    ): Promise<boolean> {
        this.requireSteer(user);
        const request = this.approvals.all().find((each) => each.id === id);

        if (request === undefined || !this.canSee(user, request.conversationId)) {
            return false;
        }

        const refused = allow ? this.cannotAllow(user, request) : undefined;

        if (refused !== undefined) {
            throw new HttpError(403, refused);
        }

        let given: Record<string, string> | undefined;

        // A question's answer is what was chosen, for each question: a plain Allow (from a notification, say) is not one.
        if (allow && request.form !== undefined) {
            try {
                given = checkValues(request.form.fields, values);
            } catch (error) {
                throw new HttpError(400, describe(error));
            }
        }

        if (
            !this.approvals.answer(id, {
                allow,
                by: user.name,
                ...(given === undefined ? {} : { values: given }),
            })
        ) {
            return false;
        }

        // noid: "Always allow" keeps a rule for this bot and tool; only the owner makes rules.
        const bot = this.bots.of(request.conversationId);

        if (
            allow &&
            always &&
            bot !== undefined &&
            user.role === "owner" &&
            id.startsWith(NOID_APPROVAL) &&
            !id.startsWith(AUTO_REVIEW_APPROVAL) &&
            !id.startsWith(EVERY_TIME_APPROVAL) &&
            !alwaysAsks(request.tool, { action: "remove" }) &&
            // Asked every time when it makes a bot on this machine (its kind is not on the request): a rule would only
            // turn auto review off for the bots it makes on the computer.
            request.tool !== "bot_create"
        ) {
            await this.harness.commit(async (tx) => {
                const doc = await tx.doc(ApprovalRulesDoc);

                if (!doc.rules.some((rule) => rule.bot === bot.id && rule.tool === request.tool)) {
                    doc.rules.push({
                        bot: bot.id,
                        tool: request.tool,
                        at: Date.now(),
                        by: user.id,
                    });
                }
            }, context);
        }

        const conversationId = request.conversationId;

        if (request.callId !== undefined) {
            const callId = request.callId;

            await this.harness
                .commit(async (tx) => {
                    (await tx.doc(DecisionsDoc, conversationId)).calls[callId] = {
                        allow,
                        by: user.name,
                        userId: user.id,
                        at: Date.now(),
                        ...(request.form === undefined ? {} : { ask: true as const }),
                    };
                }, context)
                .catch((error: unknown) => this.#log(`decision not recorded: ${describe(error)}`));
        }

        // A question is answered or declined, and named by what it asks.
        const what =
            request.form === undefined
                ? `${allow ? "allowed" : "denied"} the ${request.tool} call: ${request.subject}`
                : `${allow ? "answered" : "declined"}: ${request.reason}`;

        await this.collab.activity(conversationId, user, snippet(what, 160));

        return true;
    }

    /** The owner changes what someone may do: their role, or which session they may open. */
    setAccess(owner: User, userId: string, patch: { role?: unknown; sessions?: unknown }): void {
        if (owner.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        const target = this.config.userById(userId);

        if (target === undefined) {
            throw new HttpError(404, "No such person");
        }

        if (target.role === "owner") {
            throw new HttpError(400, "The owner can do everything");
        }

        const change: { role?: "guest" | "viewer"; sessions?: string[] | undefined } = {};

        if (patch.role !== undefined) {
            if (patch.role !== "guest" && patch.role !== "viewer") {
                throw new HttpError(400, "role must be guest or viewer");
            }

            change.role = patch.role;
        }

        if (patch.sessions !== undefined) {
            if (patch.sessions === null) {
                change.sessions = undefined;
            } else if (
                Array.isArray(patch.sessions) &&
                patch.sessions.every((each) => this.#sessions[String(each)] !== undefined)
            ) {
                change.sessions = patch.sessions.map(String);
            } else {
                throw new HttpError(400, "sessions must be null or a list of session ids");
            }
        }

        this.config.updateUser(userId, change);
        const updated = this.config.userById(userId);

        for (const client of [...this.#clients]) {
            if (client.user.id !== userId || updated === undefined) {
                continue;
            }

            if (
                client.conversationId !== undefined &&
                !this.canSee(updated, client.conversationId)
            ) {
                this.#evict(client, "This session is no longer shared with you.");
            }

            for (const id of client.peeks ?? []) {
                if (!this.canSee(updated, id)) {
                    client.peeks?.delete(id);
                    this.#unpeek(client, id);
                }
            }
        }

        void this.#refreshUser(userId);
        this.#peopleChanged();
    }

    removeUser(owner: User, userId: string): void {
        if (owner.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (this.config.userById(userId)?.role === "owner") {
            throw new HttpError(400, "The owner cannot be removed");
        }

        this.#forget(userId);
    }

    /**
     * How other devices reach this server, from the launcher. People who signed in through another Cloudflare quick
     * tunnel can never sign in again (its address is gone, and their cookie works only there), so they are removed.
     */
    setReach(access: AccessInfo | undefined): void {
        this.access = access;
        let current: string | undefined;

        try {
            current = access?.url === undefined ? undefined : new URL(access.url).host;
        } catch {}

        for (const user of [...this.config.users]) {
            if (user.role !== "owner" && user.tunnel !== undefined && user.tunnel !== current) {
                this.#forget(user.id);
            }
        }
    }

    #forget(userId: string): void {
        this.config.removeUser(userId);
        this.pushStore?.removeUser(userId);

        // Their open tabs end now; reconnecting fails, so they land on the sign-in screen.
        for (const client of [...this.#clients]) {
            if (client.user.id !== userId) {
                continue;
            }

            client.send("closing", {});
            this.detach(client);
            client.close?.();
        }

        this.#peopleChanged();
    }

    /** Take a tab out of a conversation it may no longer see; it keeps app-wide events. */
    #evict(client: Client, message: string): void {
        const id = client.conversationId;

        if (id === undefined) {
            return;
        }

        client.conversationId = undefined;
        client.send("missing", { conversationId: id, message });
        this.#leaveRoom(client, id);
    }

    /** Someone's rights changed: their tabs get a fresh hello and session list. */
    async #refreshUser(userId: string): Promise<void> {
        const user = this.config.userById(userId);

        if (user === undefined) {
            return;
        }

        for (const client of this.#clients) {
            if (client.user.id !== userId) {
                continue;
            }

            client.send("hello", this.#helloFor(client, await this.hello(user)));
            this.#sendSessions(client, this.sessions(user));

            // An open board too: it must not keep subagents of sessions no longer shared.
            if (client.board === true) {
                client.boardSent = undefined;
                this.#sendBoard(client, this.subagents(user));
            }
        }
    }

    async artifactBody(id: ConversationId, artifact: string, version: number | undefined) {
        const index = await this.harness.snapshot(ArtifactsDoc, id, context);
        const meta = index?.items[artifact] as ArtifactMeta | undefined;

        if (meta === undefined) {
            throw new HttpError(404, "No such artifact");
        }

        const chosen =
            version === undefined
                ? meta.versions.at(-1)
                : meta.versions.find((each) => each.version === version);

        if (chosen === undefined) {
            throw new HttpError(404, "No such version");
        }

        const body = await this.harness.snapshot(
            ArtifactBodyDoc,
            id,
            `${artifact}@${chosen.version}`,
            context,
        );

        if (body === undefined) {
            throw new HttpError(404, "Artifact content is missing");
        }

        return { meta, version: chosen.version, content: body.content };
    }

    /** The folder a conversation works in. */
    /** noid: whether a conversation's browser is the bots' one: a bot's, or a session's on the shared computer. */
    #onComputer(id: number): boolean {
        const conversation = id as unknown as ConversationId;

        return this.bots.of(conversation) !== undefined || onComputer(this.cwdOf(conversation));
    }

    cwdOf(id: ConversationId): string {
        return this.#agents.get(id)?.cwd ?? this.#sessions[String(id)]?.cwd ?? this.defaultCwd;
    }

    /** When Pi's settings were last read: Pi's CLI, or a person, can change them while Pi Pocket runs. */
    #settingsReadAt = Date.now();

    /**
     * What says where Pi's skills are, besides a session's folder: Pi's folder and settings, and the home folder. Pi's
     * settings are read again when the copy is older than `SETTINGS_STALE_MS`, in the background: a change (such as
     * `defaultProjectTrust`) counts from the request after.
     */
    #skillSources(): SkillSources {
        if (Date.now() - this.#settingsReadAt >= SETTINGS_STALE_MS) {
            this.#settingsReadAt = Date.now();
            this.settings.reload().catch(() => {
                // Unreadable now: the last good settings stay.
            });
        }

        let settingsPaths: string[] = [];
        let defaultProjectTrust: SkillSources["defaultProjectTrust"] = "ask";

        try {
            settingsPaths = this.settings.getSkillPaths();
            defaultProjectTrust = this.settings.getDefaultProjectTrust();
        } catch {
            // Unreadable settings: the default folders still count, and no project is trusted unasked.
        }

        return { agentDir: getAgentDir(), home: this.#home, settingsPaths, defaultProjectTrust };
    }

    /** Bring the agent files' bots up to date; a failure is told, and the next look tries again. */
    async #syncAgentFiles(): Promise<void> {
        try {
            await this.bots.syncAgentFiles();
        } catch (error) {
            this.#log(`agent files: ${describe(error)}`);
        }
    }

    /** Pi's skills for a session working in `cwd`, from the places Pi looks (`skills.ts`). */
    skills(cwd: string): Skill[] {
        return loadSessionSkills(cwd, this.#skillSources());
    }

    /**
     * Whether Pi trusts the project a conversation works in, and the project skills that wait for it. The owner's: the
     * skills may be in folders above the session's, which someone invited to it cannot see.
     */
    projectTrust(id: ConversationId, user: User): ProjectTrust {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner decides which projects Pi trusts.");
        }

        return readProjectTrust(this.cwdOf(id), this.#skillSources());
    }

    /** The owner's answer to "trust this project?", saved where Pi's CLI keeps its own, as its `/trust` does. */
    setProjectTrust(id: ConversationId, user: User, choice: TrustChoice): ProjectTrust {
        // Before anything is saved: only the owner may read it, or answer.
        const now = this.projectTrust(id, user);

        if (now.unreadable) {
            throw new HttpError(
                409,
                "Pi's trust store (~/.pi/agent/trust.json) cannot be read, so no answer can be saved. Mend or delete it first.",
            );
        }

        if (choice === "trust-parent" && now.parent === undefined) {
            throw new HttpError(400, "This folder has no folder above it.");
        }

        saveProjectTrust(this.cwdOf(id), getAgentDir(), choice);

        return this.projectTrust(id, user);
    }

    /** Pi's skills in a conversation's folder, to run as `/skill:name`. */
    skillCommands(id: ConversationId): SkillCommand[] {
        try {
            return this.skills(this.cwdOf(id)).map((skill) => ({
                name: skill.name,
                description: skill.description,
                path: skill.filePath,
                baseDir: skill.baseDir,
            }));
        } catch {
            return [];
        }
    }

    /** Pi's prompt templates, as a conversation in its folder offers them. */
    promptTemplates(id: ConversationId): PromptTemplate[] {
        let paths: string[] = [];

        try {
            paths = this.settings.getPromptTemplatePaths();
        } catch {
            // Unreadable settings: the default folders still count.
        }

        const cwd = this.cwdOf(id);

        // A project told "Don't trust" offers none of its own, as its .pi/skills.
        return loadPromptTemplates(cwd, getAgentDir(), paths, {
            project: !projectDistrusted(cwd, this.#skillSources()),
        });
    }

    // ─── Extensions ─────────────────────────────────────────────────────────

    /** Whether Lancet Guard's module is on here; Pi's own setting may still turn the guard off. */
    guardOn(): boolean {
        return this.loader.enabled(GUARD_FILE);
    }

    /** Lancet Guard as it applies here: Pi's own setting, unless the guard extension is off in Pi Pocket. */
    async guardStatus(): Promise<GuardStatus> {
        const status = await this.guard.status();

        if (this.guardOn()) {
            return status;
        }

        return {
            available: status.available,
            enabled: false,
            detail: "Lancet Guard is off in Pi Pocket: bash, write, and edit calls run unchecked here.",
        };
    }

    /** The extension modules, as this person may see them: where the server keeps files is for the owner only. */
    async extensions(
        user: User,
    ): Promise<{ modules: ExtensionInfo[]; guard: GuardStatus; dropIns?: string }> {
        const owner = user.role === "owner";
        // A load error can name the server's folders too.
        // Modules' routes are the owner's to know: others see only whose tabs load a browser module.
        const modules = this.loader.list().map(({ path, error, web, ...module }) =>
            owner
                ? {
                      ...module,
                      ...(path === undefined ? {} : { path }),
                      ...(web === undefined ? {} : { web }),
                      ...(error === undefined ? {} : { error }),
                  }
                : {
                      ...module,
                      ...(web?.client === undefined || !mayUse(user, web.client)
                          ? {}
                          : { web: { routes: [], client: web.client } }),
                      ...(error === undefined ? {} : { error: "It failed to load." }),
                  },
        );

        // The guard row shows Pi's own setting, so the owner can tell "off here" from "off everywhere".
        return {
            modules,
            guard: await this.guard.status(),
            ...(owner ? { dropIns: join(this.dataDir, "extensions") } : {}),
        };
    }

    /** Turn an extension module on or off for every session, now and after restarts. */
    async setExtensionEnabled(user: User, file: string, enabled: boolean): Promise<void> {
        const module = this.loader.list().find((each) => each.file === file);

        if (module === undefined) {
            throw new HttpError(404, `There is no extension module ${file}`);
        }

        if (module.required && !enabled) {
            throw new HttpError(400, `${module.title} is required and cannot be turned off`);
        }

        if (module.enabled === enabled) {
            return;
        }

        this.config.setExtensionEnabled(file, enabled);

        try {
            await this.loader.apply(file);
        } catch (error) {
            throw new HttpError(
                500,
                `${module.title} is on but failed to load: ${describe(error)}`,
            );
        } finally {
            await this.#refreshClients();
        }

        if (file === GUARD_FILE && enabled) {
            void this.guard.warm().catch(() => {});
        }

        if (file === BROWSER_FILE && !enabled) {
            await this.browsers.closeAll();
        }

        if (file === SESSION_TOOLS_FILE && !enabled) {
            await this.sessionTools.stopAll();
        }

        this.notice(
            enabled ? "info" : "warning",
            `${user.name} turned ${module.title} ${enabled ? "on" : "off"}.`,
        );
    }

    async reloadExtension(file: string): Promise<void> {
        const module = this.loader.list().find((each) => each.file === file);

        if (module === undefined) {
            throw new HttpError(404, `There is no extension module ${file}`);
        }

        if (!module.enabled) {
            throw new HttpError(409, `${module.title} is off`);
        }

        try {
            await this.loader.reload(file);
        } catch (error) {
            throw new HttpError(500, `${module.title} failed to load: ${describe(error)}`);
        } finally {
            await this.#refreshClients();
        }
    }

    /** The owner changes who may allow risky calls. */
    async setApprovalRule(user: User, rule: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (rule !== "anyone" && rule !== "others") {
            throw new HttpError(400, "approvalRule must be anyone or others");
        }

        if (rule === this.config.approvalRule) {
            return;
        }

        this.config.approvalRule = rule;
        await this.#refreshClients();
        this.notice(
            "info",
            rule === "others"
                ? `${user.name} made approvals need someone other than who asked.`
                : `${user.name} let anyone who can steer allow risky calls.`,
        );
    }

    /** The owner chooses when Noid compacts itself: above so many tokens of context once idle, or (0) as sessions. */
    async setNoidCompactAt(user: User, tokens: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (typeof tokens !== "number" || !NOID_COMPACT_CHOICES.includes(tokens)) {
            throw new HttpError(
                400,
                `noidCompactAt must be one of ${NOID_COMPACT_CHOICES.join(", ")}`,
            );
        }

        if (tokens === this.noidCompaction.compactAt) {
            return;
        }

        this.config.noidCompactAt = tokens;
        await this.#refreshClients();
    }

    /**
     * The theme and colors browsers start with until their person chooses (`config.themeDefault`): the owner's to set,
     * or `null` for the app's own. Everyone's tabs hear it in `hello`.
     */
    async setThemeDefault(user: User, choice: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner sets the default theme");
        }

        if (choice === null) {
            this.config.themeDefault = undefined;
        } else {
            const { look, colors } = (choice ?? {}) as { look?: unknown; colors?: unknown };

            if (
                typeof look !== "string" ||
                typeof colors !== "string" ||
                !THEME_ID.test(look) ||
                !THEME_ID.test(colors.replace(/@(dark|light)$/, ""))
            ) {
                throw new HttpError(
                    400,
                    "The default is { look, colors }: a theme's id and colors' id, or null",
                );
            }

            if (!this.themes.list().some((each) => each.id === look && each.usable)) {
                throw new HttpError(404, "No such theme");
            }

            // Colors that are not here (the desktop's, on a machine without Omarchy) would leave new browsers on none.
            if (!(await this.themes.hasColors(colors))) {
                throw new HttpError(404, "No such colors here");
            }

            this.config.themeDefault = { look, colors };
        }

        await this.#refreshClients();
    }

    /**
     * The owner's default after a theme went (removed in Appearance or the gallery, or its folder deleted): a theme that
     * is gone gives way to Pocket, and colors that went with it (its own) to the desktop's; with both gone, no default.
     * Everyone's tabs hear it.
     */
    async #themeDefaultStillHere(): Promise<void> {
        const before = this.config.themeDefault;

        // When the owner's themes could not be read at the start, they are not gone: keep the default for the next start.
        if (before === undefined || this.themes.failure !== undefined) {
            return;
        }

        try {
            const lookGone =
                before.look !== BASE_THEME &&
                !this.themes.list().some((each) => each.id === before.look);
            // The desktop's colors are the app's own default: they never go.
            const colorsGone =
                before.colors !== "desktop" && !(await this.themes.hasColors(before.colors));

            if (!lookGone && !colorsGone) {
                return;
            }

            const look = lookGone ? BASE_THEME : before.look;
            // noid: its own colors are what browsers start with, and are always there.
            const colors = colorsGone ? "noid" : before.colors;

            this.config.themeDefault =
                look === BASE_THEME && colors === "noid" ? undefined : { look, colors };
            await this.#refreshClients();
        } catch (error) {
            this.#log(`The default theme could not be checked: ${describe(error)}`);
        }
    }

    /**
     * The owner picks the model and thinking level new sessions start with: a signed-in model, its level kept to one it
     * has. Null leaves it to the last model picked, as before there was a choice.
     */
    async setDefaultModel(user: User, choice: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (choice === null) {
            if (this.config.defaultModel !== undefined) {
                this.config.defaultModel = undefined;
                await this.#refreshClients();
            }

            return;
        }

        const asked = (typeof choice === "object" ? choice : {}) as {
            provider?: unknown;
            modelId?: unknown;
            thinkingLevel?: unknown;
        };

        if (
            typeof asked.provider !== "string" ||
            typeof asked.modelId !== "string" ||
            (asked.thinkingLevel !== undefined && !isThinkingLevel(asked.thinkingLevel))
        ) {
            throw new HttpError(
                400,
                `defaultModel must be null, or { provider, modelId, thinkingLevel? } with thinkingLevel one of ${THINKING_LEVELS.join(", ")}`,
            );
        }

        const model = this.models
            .getAvailableSnapshot()
            .find((each) => each.provider === asked.provider && each.id === asked.modelId);

        if (model === undefined) {
            throw new HttpError(
                400,
                `Model ${asked.provider}/${asked.modelId} is not available: sign in to its provider first.`,
            );
        }

        const thinkingLevel = clampThinkingLevel(
            model,
            (asked.thinkingLevel ?? "off") as ModelThinkingLevel,
        );
        const before = this.config.defaultModel;

        if (
            before?.provider === model.provider &&
            before.modelId === model.id &&
            before.thinkingLevel === thinkingLevel
        ) {
            return;
        }

        this.config.defaultModel = { provider: model.provider, modelId: model.id, thinkingLevel };
        await this.#refreshClients();
    }

    /**
     * Whether a provider's sign-in expired and needs a person to sign in again: the model menu and a session's model chip
     * mark its models, and subagents on another model are refused them (`resolveModel`). A session's own run still tries.
     */
    readonly signInNeeded = (provider: string): boolean =>
        this.providers.needsSignIn(provider) !== undefined;

    /**
     * The owner picks the models Pi may start subagents on besides their session's own (`provider/modelId`, models Pi
     * knows). Empty, the default: none, and the subagent tool offers Pi no choice of model at all. The tool is rebuilt
     * to match, so its description and parameters say what Pi may do. This replaces the whole list; the Providers sheet
     * changes one model at a time (`allowSubagentModel`).
     */
    async setSubagentModels(user: User, models: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (
            !Array.isArray(models) ||
            models.length > MAX_SUBAGENT_MODELS ||
            models.some((each) => typeof each !== "string")
        ) {
            throw new HttpError(
                400,
                `subagentModels must be a list of at most ${String(MAX_SUBAGENT_MODELS)} models, each provider/modelId`,
            );
        }

        const chosen: string[] = [];

        for (const spec of models as string[]) {
            const slash = spec.indexOf("/");
            const model =
                slash > 0
                    ? this.models.getModel(spec.slice(0, slash), spec.slice(slash + 1))
                    : undefined;

            if (model === undefined) {
                throw new HttpError(400, `${spec} is not a model Pi knows (provider/modelId).`);
            }

            const key = `${model.provider}/${model.id}`;

            if (!chosen.includes(key)) {
                chosen.push(key);
            }
        }

        await this.#saveSubagentModels(chosen);
    }

    /**
     * The owner allows one model for subagents, or stops allowing it, and keeps the rest as they are now: what the
     * Providers sheet sends, so two quick taps, or two tabs, never undo each other. The list is read and written with no
     * wait between, so changes that come together all count. A model stopped need not be one Pi still knows. Returns the
     * list as it is then.
     */
    async allowSubagentModel(
        user: User,
        model: unknown,
        allowed: unknown,
    ): Promise<readonly string[]> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (typeof model !== "string" || typeof allowed !== "boolean") {
            throw new HttpError(400, "Send model (provider/modelId) and allowed (true or false).");
        }

        const current = this.config.subagentModels;
        let chosen = current.filter((each) => each !== model);

        if (allowed) {
            const slash = model.indexOf("/");
            const found =
                slash > 0
                    ? this.models.getModel(model.slice(0, slash), model.slice(slash + 1))
                    : undefined;

            if (found === undefined) {
                throw new HttpError(400, `${model} is not a model Pi knows (provider/modelId).`);
            }

            const key = `${found.provider}/${found.id}`;

            chosen = current.includes(key) ? [...current] : [...current, key];

            if (chosen.length > MAX_SUBAGENT_MODELS) {
                throw new HttpError(
                    400,
                    `At most ${String(MAX_SUBAGENT_MODELS)} models can be allowed for subagents.`,
                );
            }
        }

        await this.#saveSubagentModels(chosen);

        return this.config.subagentModels;
    }

    /**
     * Keep the models for subagents, rebuild the subagent tool to match, and tell the owner's tabs, the only ones whose
     * hello carries the list.
     */
    async #saveSubagentModels(chosen: readonly string[]): Promise<void> {
        const before = this.config.subagentModels;

        if (JSON.stringify(before) === JSON.stringify(chosen)) {
            return;
        }

        this.config.subagentModels = chosen;

        // The tool offers a model only while some are allowed: rebuilt now, for the next request of every session.
        if (this.loader.enabled(SUBAGENTS_FILE)) {
            try {
                await this.loader.reload(SUBAGENTS_FILE);
            } catch (error) {
                // A module's error can name the server's folders: the owner's to read.
                this.ownerNotice("error", `Subagents failed to reload: ${describe(error)}`);
            }
        }

        await this.#refreshClients((user) => user.role === "owner");
        // What changed: the checklist shows the rest.
        const added = chosen.filter((each) => !before.includes(each));
        const removed = before.filter((each) => !chosen.includes(each));
        const said = [
            ...(added.length === 0 ? [] : [`${added.join(", ")} allowed for subagents`]),
            ...(removed.length === 0
                ? []
                : [`${removed.join(", ")} no longer allowed for subagents`]),
        ];

        if (said.length > 0) {
            this.ownerNotice("info", `${said.join("; ")}.`);
        }
    }

    /** Send clients a fresh hello, every one or those of the people `to` names: what it carries changed. */
    async #refreshClients(to: (user: User) => boolean = () => true): Promise<void> {
        for (const client of this.#clients) {
            if (to(client.user)) {
                client.send("hello", this.#helloFor(client, await this.hello(client.user)));
            }
        }
    }

    /** The conversation in a run now whose model requests go under provider session `sessionId`, for the cache keeper. */
    async #conversationOfSession(sessionId: string): Promise<number | undefined> {
        for (const id of [...this.#busy]) {
            const mine = await this.harness
                .snapshot(ProviderDoc, id, context)
                .catch(() => undefined);

            if (mine?.sessionId === sessionId) {
                return Number(id);
            }
        }

        return undefined;
    }

    // ─── Browser ────────────────────────────────────────────────────────────

    /** The browser is on while its extension module is: the owner turns both off together in Extensions. */
    browserOn(): boolean {
        return this.loader.extensionNames().includes(BROWSER_EXTENSION);
    }

    #browserEvent(conversationId: ConversationId, state: BrowserState) {
        return { conversationId: Number(conversationId), ...state };
    }

    // ─── Shutdown ───────────────────────────────────────────────────────────

    close(): Promise<void> {
        this.#closing ??= (async () => {
            clearTimeout(this.#sessionsTimer);
            clearInterval(this.#agentFilesTimer);
            this.alerts.close();
            this.themes.close();
            await this.cacheKeeper.close();
            this.spend.close();
            this.#unsubscribeCommits?.();
            this.#unsubscribeApprovals?.();
            this.#unsubscribeBrowsers?.();

            // Modules' cleanups may wait (closing a connection), but not for long: the rest must close too.
            const cleaned = this.loader?.close();

            // After the loader: its last changes could set it again.
            clearTimeout(this.#websTimer);

            for (const client of this.#clients) {
                client.send("closing", {});
            }

            for (const pending of this.#rooms.values()) {
                void pending.then(
                    (room) => room.close(),
                    () => {},
                );
            }

            this.providers.close();

            // A timer that holds the process: with nothing else to do, Node would end it here, before the rest closed.
            let limit: NodeJS.Timeout | undefined;

            await Promise.race([
                cleaned,
                new Promise<void>((resolve) => {
                    limit = setTimeout(resolve, CLEANUP_LIMIT_MS);
                }),
            ]);
            clearTimeout(limit);
            let storageClosed = false;

            try {
                // Close writes no outcome: running work resumes when the next process opens the storage.
                if (this.harness !== undefined) {
                    await this.harness.close(context);
                } else {
                    await this.#openingStorage?.close(context);
                }

                storageClosed = true;

                for (const env of this.#envs.values()) {
                    await env.cleanup(context);
                }

                // The container keeps running: the next server finds it (or it stops itself when idle).
                this.#stopIdleWatch();
                this.terminals.closeAll();
                stopClaudeCli();
                await this.computer.close(context);
            } finally {
                // After the harness: a browser call cut off by the stop resumes as interrupted, not as failed.
                await this.browsers.closeAll({ final: true }).catch(() => {});

                if (storageClosed) {
                    this.#releaseLock?.();
                }
            }
        })();

        return this.#closing;
    }
}
