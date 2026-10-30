/**
 * The system prompt: who the agent is, how to behave on a phone-sized screen, where Pi Pocket's documentation is, the
 * project's AGENTS.md files, Pi's skills, and the working directory. Sections render before every request; only
 * changed sections are sent again, so everything here is stable between requests unless a file on disk changed.
 *
 * Edit freely: saving this file reloads it into the running server.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getDocsPath, loadProjectContextFiles, type Skill } from "@earendil-works/pi-coding-agent";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import { APP_ROOT } from "../config.ts";
import type { PocketHost } from "../host.ts";
import type { BotProfile } from "../noid/bots.ts";
import { COMPUTER_HOME } from "../noid/computer.ts";
import { contextFilesIn, skillFoldersIn, skillsIn } from "../noid/env-files.ts";

const PREAMBLE = `You are Pi, a coding agent running inside Pi Pocket: a durable, multiplayer web app built on Pi Durable. People talk to you from a browser, often a phone, and several people can share one conversation. When more than one person uses this server, each message starts with [from: Name].

You work in the conversation's working directory with the tools you are given. Your work is durable: if the server restarts, you continue where you left off. A tool call cut off by a restart comes back as an "interrupted" error when it was not safe to repeat; check what actually happened before you retry it.`;

/**
 * noid: a bot's preamble: who it is, what it is for, and where it works: where its folder is now, as approvals decide,
 * not the kind it was made as (a folder can move).
 */
function botPreamble(bot: BotProfile, cwd: string, computer: boolean): string {
    const role = bot.role === "" ? "" : ` Your role: ${bot.role}.`;
    const place = computer
        ? `You work on the shared computer, a Linux machine the owner's bots share. Your home there is ${cwd}: relative paths and shell commands start there. Put work meant for other bots under ${COMPUTER_HOME}/shared. Other bots' folders are under ${COMPUTER_HOME}/bots; treat them as their working areas. You can install command-line tools for yourself (uv tool install, or into ~/.local/bin). A skill is a folder with a SKILL.md (name and description in its front matter): under ${COMPUTER_HOME}/.agents/skills every bot gets it, under .agents/skills in your folder only you do.`
        : `You work on the owner's own machine, in ${cwd}. Commands and edits that change something wait for the owner's approval.`;

    return `You are ${bot.name}, one of the owner's bots in noid: a persistent teammate with one continuous conversation, your own memory, and routines.${role} People talk to you from a browser, often a phone. When more than one person uses this server, each message starts with [from: Name].

${place}

Your work is durable: if the server restarts, you continue where you left off. A tool call cut off by a restart comes back as an "interrupted" error when it was not safe to repeat; check what actually happened before you retry it.`;
}

const GUIDELINES = `- Keep replies short and easy to read on a small screen. Lead with the answer; use short paragraphs, lists, and small code blocks.
- Use read to look at files instead of cat or sed. Use edit for precise changes and write for new files or full rewrites.
- Show file paths clearly when you work with files.
- To show an image file from this machine, embed it: ![short description](/absolute/or/relative/path.png). Files the user attaches are saved on the server; the message lists their paths.
- Before running something destructive or irreversible, say what it will do. A guard may ask a human to approve risky commands; if a call is blocked, do not try to get around the block.
- Do not commit, push, publish, or deploy unless asked.`;

/**
 * Where Pi Pocket's documentation for agents is, as Pi's prompt says where Pi's is: to read only when it is
 * needed.
 */
function docs(dataDir: string): string {
    const code = resolve(APP_ROOT);
    const folder = join(code, "docs");

    // docs/index.md routes each kind of question to its page: the prompt names only the way in (pp 1c3bc2b2).
    return `Pi Pocket's docs, only for questions about Pi Pocket itself (how it works, changing how you behave in it, extending it, changing its code): start at ${join(folder, "index.md")}, an index (follow only the links your task needs), and read a doc completely before changing anything.
- Code: ${code}. Data: ${dataDir}; change it through the app, never by editing its files, except extensions/ (drop-ins) and themes/.
- Pi's own docs (skills, prompt templates, models, providers, settings): ${getDocsPath()}`;
}

/**
 * The skills the model may pick, one line each. Pi's own format (XML, a location per skill) costs about 150
 * characters more for each; here a folder that holds several skills as `<folder>/<name>/SKILL.md` is named once.
 * Skills that ask not to be picked by the model (`disable-model-invocation`) stay out, as in Pi (pp 3d2e96b4).
 */
export function formatSkills(skills: readonly Skill[]): string {
    const visible = skills.filter((skill) => !skill.disableModelInvocation);

    if (visible.length === 0) {
        return "";
    }

    // A description cannot close the block early.
    const oneLine = (text: string) =>
        text.replace(/\s+/g, " ").replaceAll("</skills", "&lt;/skills").trim();
    const groups = new Map<string, string[]>();
    const others: string[] = [];

    for (const skill of visible) {
        const folder = dirname(dirname(skill.filePath));
        const usual =
            basename(skill.filePath) === "SKILL.md" &&
            basename(dirname(skill.filePath)) === skill.name;

        if (usual) {
            groups.set(folder, [
                ...(groups.get(folder) ?? []),
                `- ${skill.name}: ${oneLine(skill.description)}`,
            ]);
        } else {
            others.push(`- ${skill.name} (${skill.filePath}): ${oneLine(skill.description)}`);
        }
    }

    const blocks = [...groups].map(
        ([folder, lines]) => `In ${join(folder, "<name>", "SKILL.md")}:\n${lines.join("\n")}`,
    );

    if (others.length > 0) {
        blocks.push(`At their own paths:\n${others.join("\n")}`);
    }

    return `<skills>\nWhen a task matches a skill's description, read its SKILL.md with the read tool and follow it. Resolve a relative path in it against the skill's folder.\n\n${blocks.join("\n\n")}\n</skills>`;
}

const STALE_MS = 30_000;

type Resources = {
    at: number;
    trust: number;
    context: string | undefined;
    skills: string | undefined;
};

export default function createPrompt(host: PocketHost) {
    // Context files and skills load once per directory, and again when the copy is older than STALE_MS, or Pi's trust
    // store changed since: a project trusted now has skills it did not have, from the next request on. Only answers to
    // "trust this project?" show at once; other changes (a new skill, Pi's defaultProjectTrust) wait for STALE_MS, or
    // a request more (the app reads Pi's settings again in the background as often).
    const resources = new Map<string, Resources>();

    const trustChanged = () => {
        try {
            return statSync(join(host.agentDir, "trust.json")).mtimeMs;
        } catch {
            return 0;
        }
    };

    const load = (cwd: string): Resources => {
        const cached = resources.get(cwd);
        const trust = trustChanged();

        if (cached !== undefined && Date.now() - cached.at < STALE_MS && cached.trust === trust) {
            return cached;
        }

        let context: string | undefined;
        let skills: string | undefined;

        try {
            const files = loadProjectContextFiles({ cwd, agentDir: host.agentDir });

            if (files.length > 0) {
                context = files
                    .map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`)
                    .join("\n\n");
            }
        } catch (error) {
            host.notice("warning", `Could not load AGENTS.md files for ${cwd}: ${String(error)}`);
        }

        try {
            const text = formatSkills(host.skills(cwd));

            skills = text === "" ? undefined : text;
        } catch (error) {
            host.notice("warning", `Could not load skills for ${cwd}: ${String(error)}`);
        }

        const fresh = { at: Date.now(), trust, context, skills };

        resources.set(cwd, fresh);

        return fresh;
    };

    const cwdOf = (input: PromptInput) => input.env?.cwd ?? input.agent.cwd ?? process.cwd();

    // noid: a session on the shared computer reads its AGENTS.md files there (through its environment), after Pi's
    // global one from this machine. Kept for STALE_MS per folder, as on this machine.
    const remote = new Map<string, { at: number; context: Promise<string | undefined> }>();

    const formatted = (files: { path: string; content: string }[]) =>
        files.length === 0
            ? undefined
            : files
                  .map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`)
                  .join("\n\n");

    const globalContext = () => {
        for (const name of [
            "AGENTS.override.md",
            "AGENTS.md",
            "AGENTS.MD",
            "CLAUDE.md",
            "CLAUDE.MD",
        ]) {
            const path = join(host.agentDir, name);

            try {
                if (statSync(path).isFile()) {
                    return [{ path, content: readFileSync(path, "utf8").replace(/^\uFEFF/, "") }];
                }
            } catch {
                // Not there: the next name.
            }
        }

        return [];
    };

    /** What a folder on the computer gives the prompt, kept for STALE_MS; a failure is said once and tried again. */
    const perFolder = (
        cache: typeof remote,
        cwd: string,
        what: string,
        load: () => Promise<string | undefined>,
    ) => {
        const cached = cache.get(cwd);

        if (cached !== undefined && Date.now() - cached.at < STALE_MS) {
            return cached.context;
        }

        const loading = load().catch((error: unknown) => {
            host.notice("warning", `Could not load ${what} for ${cwd}: ${String(error)}`);
            cache.delete(cwd);

            return undefined;
        });

        cache.set(cwd, { at: Date.now(), context: loading });

        return loading;
    };

    const remoteContext = (
        input: PromptInput,
        cwd: string,
        context: Parameters<typeof contextFilesIn>[2],
    ) =>
        perFolder(remote, cwd, "AGENTS.md files", () =>
            contextFilesIn(input.env!, cwd, context).then((files) =>
                formatted([...globalContext(), ...files]),
            ),
        );

    // Skills on the computer are files there: the session's folder's own, then those all bots share in its home.
    const remoteSkillTexts: typeof remote = new Map();
    const remoteSkills = (
        input: PromptInput,
        cwd: string,
        context: Parameters<typeof contextFilesIn>[2],
    ) =>
        perFolder(remoteSkillTexts, cwd, "skills", async () => {
            const skills = await skillsIn(input.env!, skillFoldersIn(cwd, COMPUTER_HOME), context);

            return formatSkills(skills) || undefined;
        });

    const onComputer = (input: PromptInput) =>
        input.env !== undefined && !host.onHost(input.conversationId);

    return defineExtension({
        name: "pocket-prompt",
        sections: [
            section(
                "preamble",
                (input) => {
                    const bot = host.botOf(input.conversationId);

                    return bot === undefined
                        ? PREAMBLE
                        : botPreamble(bot, cwdOf(input), !host.onHost(input.conversationId));
                },
                { tag: false },
            ),
            section("guidelines", () => GUIDELINES),
            // noid: Pi Pocket's docs and this machine's skills are files of this machine, which tools on the shared
            // computer cannot read; sessions there get the skills on the computer instead.
            section("pocket_docs", (input) => (onComputer(input) ? undefined : docs(host.dataDir))),
            section("project_context", (input, context) =>
                onComputer(input)
                    ? remoteContext(input, cwdOf(input), context)
                    : load(cwdOf(input)).context,
            ),
            section(
                "skills",
                (input, context) =>
                    onComputer(input)
                        ? remoteSkills(input, cwdOf(input), context)
                        : load(cwdOf(input)).skills,
                {
                    tag: false,
                },
            ),
            section("environment", (input) => {
                // The date only, so the prompt stays cache-friendly through the day: in the server's time zone, which
                // schedules' clock times use too, not UTC's, a day off for an hour or more each night.
                const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                const today = new Date().toLocaleDateString("en-CA", { timeZone: zone });
                const platform = onComputer(input)
                    ? "linux (the shared computer: a container that other bots use too)"
                    : process.platform;

                return `Working directory: ${cwdOf(input)}\nPlatform: ${platform}\nToday: ${today}\nTime zone: ${zone}`;
            }),
        ],
    });
}
