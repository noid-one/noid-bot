// noid: how a step on the timeline reads, after pi-web-desktop's process view: an icon for its kind, a verb, and what it
// acts on ("Read transcript.js", "Search “mainBot”", "Run npm test", "Message Researcher"), and calls of a kind one
// after another as one line ("Read a.js, b.js", "Edit style.css +3"). A plain module, so its tests can load it.
import { describeCall } from "./calls.js";

/** A path's last part: what a line names a file by (its whole path is the line's title). */
export const basename = (path) =>
    String(path ?? "")
        .replace(/[/\\]+$/, "")
        .split(/[/\\]/)
        .pop() || String(path ?? "");

const short = (text, max = 60) => {
    const flat = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const quoted = (text) => (text ? `“${short(text, 48)}”` : "");

/** A command's words, with quotes kept together: enough to tell what it does, not a shell's parse. */
function words(command) {
    return [...command.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)].map(
        (match) => match[1] ?? match[2] ?? match[3],
    );
}

const LIST = new Set(["ls", "tree", "du", "exa", "eza"]);
const SEARCH = new Set(["grep", "egrep", "rg", "ag", "ack"]);
const FIND = new Set(["find", "fd", "fdfind", "locate"]);
const READ = new Set([
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "bat",
    "nl",
    "wc",
    "sed",
    "awk",
    "jq",
]);
const FETCH = new Set(["curl", "wget", "http", "xh"]);
const DELETE = new Set(["rm", "rmdir", "unlink", "trash"]);
const SHELL = new Set(["for", "while", "if", "until", "case", "{", "("]);

/**
 * What a shell command does, by the program it runs first: list, search, find, read, fetch, delete, copy, move, or run;
 * its program, and the argument that says what it acts on. Moving into a folder first, setting variables, and `sudo`
 * are passed over.
 */
export function classifyShell(command) {
    const text = String(command ?? "").trim();
    const first =
        text
            .split(/\s*(?:&&|\|\||;|\n)\s*/)
            .find((part) => part !== "" && !/^(?:cd|pushd|source|\.|export|set)\b/.test(part)) ??
        text;
    const all = words(first.split(/\s*\|\s*/)[0]);

    while (all.length > 1 && (/^\w+=/.test(all[0]) || all[0] === "sudo" || all[0] === "env")) {
        all.shift();
    }

    const binary = basename(all[0] ?? "");
    const rest = all.slice(1);
    const plain = rest.filter((word) => !word.startsWith("-"));

    if (SHELL.has(binary) || /^\w+\(\)/.test(binary)) {
        return { kind: "run", binary: "", argument: short(text) };
    }

    if (binary === "git" && plain[0] === "grep") {
        return { kind: "search", binary, argument: plain[1] ?? "" };
    }

    if (LIST.has(binary)) {
        return { kind: "list", binary, argument: plain[0] ?? "." };
    }

    if (SEARCH.has(binary)) {
        // The pattern: after -e when it is given so, else the first word that is not a flag.
        const at = rest.findIndex((word) => word === "-e" || word === "--regexp");

        return {
            kind: "search",
            binary,
            argument: at >= 0 ? (rest[at + 1] ?? "") : (plain[0] ?? ""),
        };
    }

    if (FIND.has(binary)) {
        const at = rest.findIndex((word) => /^-i?(?:name|path|regex)$/.test(word));

        return {
            kind: "find",
            binary,
            argument: at >= 0 ? (rest[at + 1] ?? "") : binary === "find" ? "" : (plain[0] ?? ""),
        };
    }

    if (READ.has(binary)) {
        // The file read is the last word: `sed -n 1,80p file`, `head -50 file`.
        const file = plain.at(-1) ?? "";

        return { kind: "read", binary, argument: file };
    }

    if (FETCH.has(binary)) {
        return {
            kind: "fetch",
            binary,
            argument: rest.find((word) => /^https?:/.test(word)) ?? plain[0] ?? "",
        };
    }

    if (DELETE.has(binary)) {
        return { kind: "delete", binary, argument: plain.join(" ") };
    }

    if (binary === "cp" || binary === "mv") {
        return { kind: binary === "cp" ? "copy" : "move", binary, argument: plain.join(" → ") };
    }

    return { kind: "run", binary, argument: plain.slice(0, 2).join(" ") };
}

/** By kind of shell command: the icon, and the verb its line says. */
const SHELL_LOOK = {
    list: { icon: "folder", verb: "List" },
    search: { icon: "search", verb: "Search" },
    find: { icon: "search", verb: "Find" },
    read: { icon: "book", verb: "Read" },
    fetch: { icon: "download", verb: "Fetch" },
    delete: { icon: "trash", verb: "Delete" },
    copy: { icon: "copy", verb: "Copy" },
    move: { icon: "copy", verb: "Move" },
    run: { icon: "terminal", verb: "Run" },
};

const sessionOf = (args) => (args.session === undefined ? "" : `#${args.session}`);
const capital = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/** What Pi did with its memory tool. */
const MEMORY_VERBS = {
    add: "Save lesson",
    update: "Change lesson",
    remove: "Forget lesson",
    list: "Read lessons",
};

/**
 * A call's line: `{ icon, verb, target, detail, path, kind }`. `target` is what it acts on, `path` the file when it is
 * one (it shows as a file, and opens), `detail` more words, dimmer, and `kind` what calls must share to make one line.
 */
export function stepView(call) {
    const args = call.args ?? {};
    const view = (icon, verb, target = "", more = {}) => ({
        icon,
        verb,
        target: target === undefined || target === null ? "" : String(target),
        detail: "",
        path: undefined,
        kind: verb,
        ...more,
    });

    switch (call.name) {
        case "read": {
            const range = args.offset ? `:${args.offset}${args.limit ? `+${args.limit}` : ""}` : "";

            return view("book", "Read", `${basename(args.path)}${range}`, { path: args.path });
        }

        case "edit":
            return view("pencil", "Edit", basename(args.path), { path: args.path });
        case "write":
            return view("file-plus", "Write", basename(args.path), { path: args.path });
        case "ls":
            return view("folder", "List", args.path ?? ".");
        case "grep":
            return view("search", "Search", quoted(args.pattern), {
                detail: args.path ? `in ${args.path}` : "",
            });
        case "find":
            return view("search", "Find", quoted(args.pattern), {
                detail: args.path ? `in ${args.path}` : "",
            });

        case "bash": {
            const shell = classifyShell(args.command);
            const look = SHELL_LOOK[shell.kind];
            const target =
                shell.kind === "search" || shell.kind === "find"
                    ? quoted(shell.argument)
                    : shell.kind === "run"
                      ? short([shell.binary, shell.argument].filter(Boolean).join(" "))
                      : short(shell.argument);
            const file =
                shell.kind === "read" && shell.argument !== "" ? shell.argument : undefined;

            return view(look.icon, look.verb, file ? basename(file) : target, {
                path: file,
                mono: true,
            });
        }

        case "codemode": {
            const line = String(args.code ?? "")
                .split("\n")
                .map((each) => each.trim())
                .find((each) => each !== "" && !each.startsWith("//"));

            return view("command", "Run script", short(line ?? ""), { mono: true });
        }

        case "browser": {
            const { subject } = describeCall(call);

            return view(
                "globe",
                args.action ? `Browser ${args.action}` : "Browser",
                short(subject, 80),
                { mono: true },
            );
        }

        case "subagent":
            return args.action && args.action !== "spawn" && args.action !== "send"
                ? view("fork", "Check subagents", args.name ?? "", { detail: args.action })
                : view("fork", "Ask", args.name ?? "subagent", {
                      detail: short(args.message, 120),
                  });
        case "artifact":
            return view("artifact", "Publish", args.title ?? args.id ?? "");
        case "memory":
            return view(
                "star",
                MEMORY_VERBS[args.action] ?? "Memory",
                short(args.text ?? args.id ?? "", 80),
            );

        // noid's bots.
        case "bots":
            return view("users", "List bots");
        case "bot_message":
            return view("chat", "Message", args.to ?? "", { detail: short(args.message, 120) });
        case "bot_brief":
            return view("eye", "Check on", args.name ?? "every bot");
        case "bot_create":
            return view("plus", "Create bot", args.name ?? "", { detail: short(args.role, 80) });
        case "bot_update":
            return view("pencil", "Update bot", args.name ?? "");
        case "bot_archive":
            return view("archive", "Archive bot", args.name ?? "");

        // Noid's session tools.
        case "sessions":
            return view("tiles", "List sessions");
        case "session_read":
            return view("eye", "Read session", sessionOf(args));
        case "session_start":
            return view(
                "plus",
                "Start session",
                short(args.title ?? args.folder ?? args.repo ?? ""),
                {
                    detail: short(args.message, 120),
                },
            );
        case "session_send":
            return view("chat", "Message session", sessionOf(args), {
                detail: short(args.message, 120),
            });
        case "session_follow":
            return view("eye", "Follow session", sessionOf(args));
        case "session_stop":
            return view("stop", "Stop session", sessionOf(args));
        case "session_archive":
            return view("archive", "Archive session", sessionOf(args));
        case "session_schedule":
        case "schedule":
            return view(
                "clock",
                args.action === "list"
                    ? "Check schedules"
                    : args.action === "cancel"
                      ? "Cancel schedule"
                      : "Schedule",
                [sessionOf(args), args.when ?? args.id ?? ""].filter(Boolean).join(" "),
                { detail: short(args.message ?? args.text, 120) },
            );
        case "approvals":
            return args.action === "deny"
                ? view("shield", "Deny call", args.id ?? "")
                : view("shield", "Check approvals");
        case "watch_pr":
        case "session_watch_pr":
            return view(
                "eye",
                "Watch PR",
                [sessionOf(args), args.pr ?? ""].filter(Boolean).join(" "),
                {
                    detail: args.action && args.action !== "start" ? args.action : "",
                },
            );
        case "repo_watch":
            return view("eye", "Watch repo", args.repo ?? args.id ?? "", {
                detail: args.action && args.action !== "add" ? args.action : "",
            });

        default: {
            const described = describeCall(call);

            if (described.own) {
                return view("wheel", capital(described.label || call.name), described.subject);
            }

            // The first thing it was given in words, rather than its arguments as JSON.
            const said = Object.values(args).find(
                (value) => typeof value === "string" || typeof value === "number",
            );

            return view("wheel", call.name, said === undefined ? "" : short(said, 80));
        }
    }
}

/**
 * A run of calls of one kind as one line: "Read a.js", "Read a.js, b.js", "Read a.js +3", or "Read a.js ×2" when they
 * act on one thing. `views` are their `stepView`s.
 */
export function runLabel(views) {
    const targets = [...new Set(views.map((view) => view.target).filter(Boolean))];
    const { verb } = views[0];

    if (targets.length === 0) {
        return { verb, target: "", more: views.length > 1 ? `×${views.length}` : "" };
    }

    if (targets.length === 1) {
        return { verb, target: targets[0], more: views.length > 1 ? `×${views.length}` : "" };
    }

    if (targets.length === 2) {
        return { verb, target: `${targets[0]}, ${targets[1]}`, more: "" };
    }

    return { verb, target: targets[0], more: `+${targets.length - 1}` };
}

/**
 * Steps in runs: those one after another that `joins` says may share a line and are of one kind (`kindOf`) go in one
 * run; every other step is a run of its own. Each run is an array of the steps.
 */
export function runsOf(steps, kindOf, joins) {
    const runs = [];

    for (const step of steps) {
        const last = runs.at(-1);
        const kind = joins(step) ? kindOf(step) : undefined;

        if (kind !== undefined && last?.kind === kind) {
            last.steps.push(step);
        } else {
            runs.push({ kind, steps: [step] });
        }
    }

    return runs.map((run) => run.steps);
}
