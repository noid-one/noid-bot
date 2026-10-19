// Real-model scenarios against the noid server on 127.0.0.1:8899. Each one makes its own bots, sends the request,
// waits for the bots to go quiet, and checks evidence (files on the computer, replies). Usage:
//   node scenarios.mjs <token> <which: codex|claude|1,3,5>
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const [token, which = "codex"] = process.argv.slice(2);
const BASE = `${process.env.NOID_URL ?? "http://127.0.0.1:8899"}/api`;
const DOCKER = process.env.NOID_DOCKER ?? "docker";
const LOG = process.env.NOID_SCENARIOS_LOG ?? "real-scenarios.log";
const run = Math.random().toString(36).slice(2, 7);
const MODELS = {
    // The ChatGPT (Codex) account refuses gpt-5.5, gpt-5.4 and gpt-5.3-codex; it takes gpt-5.6-sol.
    codex: { provider: "openai", modelId: "gpt-5.6-sol" },
    // Claude through the owner's Claude Code (noid/claude-cli.ts); "anthropic" when Pi has its own sign-in.
    claude: {
        provider: process.env.NOID_CLAUDE_PROVIDER ?? "claude-code",
        modelId: process.env.NOID_CLAUDE_MODEL ?? "sonnet",
    },
};

const log = (...parts) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${parts.join(" ")}`;

    console.log(line);
    appendFileSync(LOG, `${line}\n`);
};

async function api(path, body, method) {
    const response = await fetch(`${BASE}/${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();

    if (!response.ok) {
        throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`);
    }

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/** A command on the computer: what it printed, a failure included (a missing file is evidence, not an error). */
const onComputer = (script) => {
    try {
        return execFileSync(DOCKER, ["exec", "-u", "noid", "noid-computer", "sh", "-c", script], {
            encoding: "utf8",
        }).trim();
    } catch (error) {
        return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message;
    }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bot(name, model, role = "") {
    const made = await api("bots", { name: `${name} ${run}`, role, kind: "computer" });

    await api(`c/${made.id}/configure`, { model, thinkingLevel: "low" });

    return made.id;
}

async function noid(model) {
    const sessions = await api("sessions");
    const id = sessions.find((session) => session.bot?.main).id;

    await api(`c/${id}/configure`, { model, thinkingLevel: "low" });

    return id;
}

const say = (id, text) => api(`c/${id}/submit`, { text, requestId: crypto.randomUUID() });

/** Until every conversation in `ids` has been idle for `quiet` ms, or `limit` passes. Reports approvals asked. */
async function settle(ids, { quiet = 20_000, limit = 15 * 60_000 } = {}) {
    const start = Date.now();
    let idleSince;

    while (Date.now() - start < limit) {
        const sessions = await api("sessions");
        const mine = sessions.filter((session) => ids.includes(session.id));
        const busy = mine.some((session) => session.busy || session.waiting);

        if (mine.some((session) => session.waiting)) {
            log("  (a bot is waiting for an approval)");
        }

        if (busy) {
            idleSince = undefined;
        } else {
            idleSince ??= Date.now();

            if (Date.now() - idleSince >= quiet) {
                return true;
            }
        }

        await sleep(3000);
    }

    return false;
}

/** The last reply in a conversation, from its markdown export. */
async function lastReply(id) {
    const markdown = await api(`c/${id}/export`);
    const parts = String(markdown).split(/\n#{1,3} /);

    return parts.at(-1)?.slice(0, 1500) ?? "";
}

const results = [];

const check = (scenario, model, ok, evidence) => {
    results.push({ scenario, model, ok, evidence });
    log(
        ok ? "PASS" : "FAIL",
        scenario,
        `(${model})`,
        "—",
        evidence.replace(/\s+/g, " ").slice(0, 400),
    );
};

const SCENARIOS = {
    // Phase 4 exit: Noid briefs two bots through bot mail; they work on the computer, in shared/.
    async 1(kind) {
        const model = MODELS[kind];
        const boss = await noid(model);
        const researcher = await bot("Researcher", model, "Collects facts into files");
        const writer = await bot("Writer", model, "Writes short posts");
        const notes = `/home/noid/shared/notes-${run}.md`;
        const post = `/home/noid/shared/post-${run}.md`;

        await say(
            boss,
            `Have Researcher ${run} write three short facts about the Rust borrow checker into ${notes}, then have Writer ${run} draft a post of about 100 words from those notes into ${post}. Use bot_message to brief them, and check on them with bot_brief. Tell me when both files exist.`,
        );
        await settle([boss, researcher, writer], { quiet: 45_000, limit: 20 * 60_000 });

        const files = onComputer(
            `ls -la ${notes} ${post} 2>&1; echo ---; head -c 600 ${post} 2>/dev/null`,
        );

        check(
            "1 bot mail: Noid → Researcher → Writer",
            kind,
            !files.includes("No such file"),
            `${files} | Noid: ${await lastReply(boss)}`,
        );
    },
    // Phase 5 exit: a routine on a bot, run now, with its run history.
    async 2(kind) {
        const model = MODELS[kind];
        const keeper = await bot("Keeper", model, "Keeps an eye on shared/");
        const routine = await api(`c/${keeper}/schedules`, {
            when: `cron 0 9 * * 1-5 count the files in /home/noid/shared and write the number to /home/noid/shared/count-${run}.txt`,
            zone: "UTC",
        });

        await api(`c/${keeper}/schedules/${routine.id}/run`, {});
        await settle([keeper]);

        const { runs } = await api(`c/${keeper}/schedules/runs`);
        const count = onComputer(`cat /home/noid/shared/count-${run}.txt 2>&1`);

        check(
            "2 routine: run now, history",
            kind,
            runs[routine.id]?.[0]?.status === "done" && /\d/.test(count),
            `runs=${JSON.stringify(runs[routine.id])} count=${count}`,
        );
    },
    // Phase 6: the desktop, driven by a bot.
    async 3(kind) {
        const model = MODELS[kind];
        const painter = await bot("Painter", model, "Uses programs on the desktop");
        const file = `/tmp/desk-${run}.txt`;

        await say(
            painter,
            `Use the desktop tool: open xterm, click into its window, type \`echo desk-ok-${run} > ${file}\`, press Return, take a screenshot to check, then release the desktop.`,
        );
        await settle([painter]);

        const found = onComputer(`cat ${file} 2>&1`);

        check(
            "3 desktop: xterm by mouse and keyboard",
            kind,
            found === `desk-ok-${run}`,
            `${file}: ${found} | ${await lastReply(painter)}`,
        );
        onComputer("pkill -x xterm; true");
    },
    // Phase 6: a group thread round.
    async 4(kind) {
        const model = MODELS[kind];
        const a = await bot("Alpha", model, "Product");
        const b = await bot("Beta", model, "Marketing");
        const sessions = await api("sessions");
        const ids = [a, b].map((id) => sessions.find((session) => session.id === id).bot.id);
        const group = await api("groups", { name: `Launch ${run}`, members: ids });

        await api(`groups/${group.id}/messages`, {
            text: "In one sentence each: what is the single most important thing to check before launching a new website?",
            requestId: crypto.randomUUID(),
        });

        let thread;

        for (let i = 0; i < 120; i++) {
            thread = await api(`groups/${group.id}`);

            if (!thread.answering && thread.messages.length >= 3) {
                break;
            }

            await sleep(5000);
        }

        const replies = thread.messages.filter((message) => message.from !== "owner");

        check(
            "4 group thread round",
            kind,
            replies.length === 2 && replies.every((reply) => !reply.failed),
            replies.map((reply) => `${reply.name}: ${reply.text}`).join(" || "),
        );
    },
    // Phase 6: a skill taught on the desktop, used by a bot.
    async 5(kind) {
        const model = MODELS[kind];
        const file = `/tmp/stamp-${run}.txt`;

        onComputer("pkill -x xterm; true");
        await api("desktop/teach", {
            name: `Stamp ${run}`,
            goal: `Create the stamp file ${file} with xterm`,
        });
        await api("desktop/input", { action: "open", command: "xterm -geometry 80x24+0+0" });
        await sleep(2000);
        await api("desktop/input", { action: "click", x: 100, y: 100 });
        await api("desktop/input", { action: "type", text: `touch ${file}` });
        await api("desktop/input", { action: "key", keys: "Return" });
        await sleep(1000);

        const saved = await api("desktop/learned", { save: true });

        onComputer(`rm -f ${file}; pkill -x xterm; true`);

        const tutee = await bot("Tutee", model, "Follows the owner's skills");

        await say(tutee, `Use your skill stamp-${run}.`);
        await settle([tutee]);

        const found = onComputer(`test -f ${file} && echo made || echo missing`);

        check(
            "5 taught skill used by a bot",
            kind,
            found === "made",
            `skill in ${saved.folder}; ${file}: ${found} | ${await lastReply(tutee)}`,
        );
        onComputer("pkill -x xterm; true");
    },
    // Phase 6: auto review on real calls that fit the task.
    async 6(kind) {
        const model = MODELS[kind];

        await api("auto-review", { on: true });

        try {
            const clerk = await bot("Clerk", model, "Keeps notes");
            const file = `/home/noid/shared/review-${run}.txt`;

            await say(clerk, `Write the word ok into ${file} with your tools.`);
            await settle([clerk]);

            const found = onComputer(`cat ${file} 2>&1`);
            const approvals = await api("sessions");

            check(
                "6 auto review passes a call that fits",
                kind,
                found.trim().toLowerCase().includes("ok"),
                `${file}: ${found}; waiting=${approvals.some((s) => s.id === clerk && s.waiting)}`,
            );
        } finally {
            await api("auto-review", { on: false });
        }
    },
    // The browser, on the computer.
    async 7(kind) {
        const model = MODELS[kind];
        const surfer = await bot("Surfer", model, "Reads web pages");

        await say(
            surfer,
            "Open https://example.com in your browser and tell me the page's main heading, exactly.",
        );
        await settle([surfer]);

        const reply = await lastReply(surfer);

        check("7 browser: read a page", kind, /Example Domain/.test(reply), reply);
    },
};

const plan =
    which === "codex"
        ? [1, 3, 5, 7].map((n) => [n, "codex"])
        : which === "claude"
          ? [2, 4, 6].map((n) => [n, "claude"])
          : which.split(",").map((part) => {
                const [n, kind = "codex"] = part.split(":");

                return [Number(n), kind];
            });

log(`run ${run}: ${plan.map(([n, kind]) => `${n}:${kind}`).join(" ")}`);

for (const [n, kind] of plan) {
    try {
        await SCENARIOS[n](kind);
    } catch (error) {
        check(`${n}`, kind, false, `error: ${error.message}`);
    }
}

log("RESULTS", JSON.stringify(results.map(({ scenario, model, ok }) => ({ scenario, model, ok }))));
