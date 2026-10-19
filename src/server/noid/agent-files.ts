/**
 * Agent files: a Markdown file per agent, as Claude Code, pi-web-desktop, and others keep them, with a `name` and a
 * `description` in its frontmatter and its instructions as the body. noid makes each one a bot (`Bots.syncAgentFiles`):
 * people talk to it in its thread, and Pi hands it work with `bot_message`, or starts a subagent with its instructions
 * (`subagent` with `agent`). The file stays where it is said what the bot is: edit it, and the bot changes; delete it,
 * and the bot goes to the archive.
 *
 * Looked for in, the first of each name winning: `~/.agents/agents/`, Pi's `agents/` (`~/.pi/agent/agents/`), and
 * Claude Code's `~/.claude/agents/`. What else a file says (`model`, `tools`) is left out: people choose bots' models,
 * and a bot has the tools its kind has.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentFile = {
    name: string;
    /** The frontmatter's `description`: the bot's role. */
    description: string;
    /** The body: the bot's instructions. */
    instructions: string;
    path: string;
};

/** Where agent files are, in the order the first of a name wins. */
export function agentFolders(home: string, agentDir: string): string[] {
    return [
        join(home, ".agents", "agents"),
        join(agentDir, "agents"),
        join(home, ".claude", "agents"),
    ];
}

/** What changes when a file does: its path, size, and time, for each file in the folders. */
export function agentFilesSignature(folders: readonly string[]): string {
    return folders
        .flatMap((folder) =>
            markdownIn(folder).map((path) => {
                try {
                    const stat = statSync(path);

                    return `${path}:${stat.size}:${stat.mtimeMs}`;
                } catch {
                    return path;
                }
            }),
        )
        .join("\n");
}

function markdownIn(folder: string): string[] {
    try {
        return readdirSync(folder, { withFileTypes: true })
            .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".md"))
            .map((entry) => join(folder, entry.name))
            .sort();
    } catch {
        return [];
    }
}

/** The agent files in `folders`: the first of each name (any case). One that cannot be read is left out. */
export function loadAgentFiles(folders: readonly string[]): AgentFile[] {
    const found = new Map<string, AgentFile>();

    for (const path of folders.flatMap(markdownIn)) {
        let frontmatter: Record<string, unknown>;
        let body: string;

        try {
            ({ frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8")) as {
                frontmatter: Record<string, unknown>;
                body: string;
            });
        } catch {
            continue;
        }

        const named = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
        const name = named || basename(path, ".md");
        const key = name.toLowerCase();

        if (!found.has(key)) {
            found.set(key, {
                name,
                description:
                    typeof frontmatter.description === "string"
                        ? frontmatter.description.replace(/\s+/g, " ").trim()
                        : "",
                instructions: body.trim(),
                path,
            });
        }
    }

    return [...found.values()];
}
