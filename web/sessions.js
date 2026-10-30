// The sidebar: the rail (Pi, the tools, and you; folded, numbered sessions too) and the session list beside it, in the
// sidebar, the drawer, and a phone's home screen; and the order and archiving of sessions.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Avatar, FACE_SCALE, folderColor, initials } from "./avatar.js";
import { goHome, useBack } from "./back.js";
import { ExtensionRailButtons } from "./extension-ui.js";
import { Face } from "./faces/face.js";
import { useDragToClose } from "./gestures.js";
import { foldedMatch } from "./fold-case.js";
import { wholeOnTile } from "./peeks.js";
import { foldedUnder, sessionForest, unfolded } from "./session-tree.js";
import { Splitter } from "./splitter.js";
import {
    actions,
    attempt,
    canSteer,
    chatReadStored,
    collab,
    navigate,
    notify,
    isUnread,
    openSheet,
    openTool,
    closeTool,
    foldsNow,
    holdsOpen,
    scoped,
    sessionUnread,
    setChatReadAt,
    setUnread,
    stillMoving,
    store,
    toggleFoldedLinked,
    workspaceOrder,
} from "./store.js";
import { finishedUnseen, fromServer, markSeen, restoreSeen, seenSnapshot } from "./seen.js";
import { dismiss as dismissSubagent } from "./subagents.js";
import {
    isPinned,
    prefs,
    setPrefs,
    SIDEBAR_MAX,
    SIDEBAR_MIN,
    SIDEBAR_WIDTH,
    togglePin,
} from "./theme.js";
import {
    APPLE,
    apartFromViews,
    html,
    Icon,
    NoidMark,
    railState,
    scrimPress,
    shortPath,
    Slide,
    timeAgo,
    usePresence,
    useSide,
    useSlide,
} from "./ui.js";
import { cutWhole } from "./cut.js";

/**
 * Back to the session list, where it is not beside the conversation: back past the sessions opened from it, as a
 * phone's back would go, or to it in this session's place when history does not lead there.
 */
export const toSessions = () => goHome(() => navigate(null, { replace: true }));

/** The session list on its way: rows shaped like sessions, lit in turn. */
function LoadingSessions() {
    return html`<div role="status" aria-label="Loading sessions">
        ${[72, 54, 64, 46, 58].map(
            (width, index) =>
                html`<div
                    class="session-placeholder"
                    aria-hidden="true"
                    style=${`--width: ${width}%; --delay: ${index * 0.12}s`}
                >
                    <span></span>
                </div>`,
        )}
    </div>`;
}

/** `text` cut to `length` characters at most, with an ellipsis: a title or a command in a notice. */
const truncate = (text, length) => (text.length > length ? `${cutWhole(text, length - 1)}…` : text);

/** "Tap" or "Click", for a notice's "… to undo". */
const undoWord = () => (matchMedia("(pointer: coarse)").matches ? "Tap" : "Click");

/**
 * Archive sessions, or bring them back, then say so in a notice that undoes it. Archiving the open session leaves it
 * for the home screen; undoing that opens it again.
 */
export async function setArchived(ids, archived, { undo = true } = {}) {
    if (ids.length === 0) {
        return;
    }

    const titles = new Map(
        store.state.sessions.map((session) => [session.id, session.title ?? "New session"]),
    );

    markMoving(ids, archived);
    const results = await Promise.allSettled(
        ids.map((id) => actions.updateSession(id, { archived })),
    );
    const done = ids.filter((_, index) => results[index].status === "fulfilled");

    // Rows that failed come back at once; the rest stay dimmed until the server's list shows them moved.
    unmarkMoving(
        ids.filter((id) => !done.includes(id)),
        archived,
    );
    const failed = results.find((result) => result.status === "rejected");

    if (failed) {
        notify("error", failed.reason?.message ?? String(failed.reason));
    }

    const open = store.state.conversationId;
    const left = undo && archived && done.includes(open);

    if (left) {
        navigate(null);
    }

    if (!undo || done.length === 0) {
        return;
    }

    const what =
        done.length === 1
            ? `“${truncate(titles.get(done[0]) ?? "", 48)}”`
            : `${done.length} sessions`;

    notify(
        "info",
        `${archived ? "Archived" : "Unarchived"} ${what}. ${undoWord()} to undo.`,
        async () => {
            await setArchived(done, !archived, { undo: false });

            if (left && store.state.conversationId === null) {
                navigate(open);
            }
        },
    );
}

/**
 * Mark sessions as on their way into the archive (true) or out of it (false). The store drops a mark once the list
 * shows the session where it was going; should that never happen (someone moved it straight back, or the request
 * hangs), the mark goes after a while anyway.
 */
function markMoving(ids, archived) {
    store.set((state) => ({
        moving: stillMoving(
            { ...state.moving, ...Object.fromEntries(ids.map((id) => [id, archived])) },
            state.sessions,
        ),
    }));
    setTimeout(() => unmarkMoving(ids, archived), 10_000);
}

/** Drop the marks, but not ones made since the other way (an undo, say). */
function unmarkMoving(ids, archived) {
    if (!ids.some((id) => store.state.moving[id] === archived)) {
        return;
    }

    store.set((state) => {
        const moving = { ...state.moving };

        for (const id of ids) {
            if (moving[id] === archived) {
                delete moving[id];
            }
        }

        return { moving };
    });
}

const CLOSED_KEY = "pocket.closedGroups";

const readClosed = () => {
    try {
        return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]"));
    } catch {
        return new Set();
    }
};

/** The fold's name for a screen reader: how many, and what its dot says (`aria-expanded` says whether they show). */
function foldLabel(kids, trouble) {
    const count = `${kids} linked ${kids === 1 ? "session" : "sessions"}`;

    return trouble === "waiting"
        ? `${count}, one needs you`
        : trouble === "failed"
          ? `${count}, one failed`
          : count;
}

/**
 * Whether a session folded away under each row waits for you or failed, by row id: the fold shows it, as a folded group
 * does. The first such session under a row, in list order, is the one told. noid: one pass over the group, not one per
 * folded row (noid draws the whole list again on every change).
 */
function hiddenTroubles(group) {
    const troubles = new Map();
    const above = [];

    for (const row of group.hidden) {
        const depth = row.branches.length;

        while (above.length > 0 && above.at(-1).depth >= depth) {
            above.pop();
        }

        const shape = sessionMark(row.session).shape;

        if (shape === "waiting" || shape === "failed") {
            for (const each of above) {
                if (!troubles.has(each.id)) {
                    troubles.set(each.id, shape);
                }
            }
        }

        above.push({ id: row.session.id, depth });
    }

    return troubles;
}

const DAY = 86_400_000;

/** Which day bucket a time falls in, in this device's time zone. */
function dayGroup(ms) {
    const today = new Date();

    today.setHours(0, 0, 0, 0);
    const start = today.getTime();

    if (ms >= start) {
        return "Today";
    }

    if (ms >= start - DAY) {
        return "Yesterday";
    }

    if (ms >= start - 6 * DAY) {
        return "This week";
    }

    if (ms >= start - 29 * DAY) {
        return "This month";
    }

    return "Earlier";
}

/** `~/Development/pi-pocket` with its last part bold, for a folder group's name. */
function FolderName({ path }) {
    const at = path.lastIndexOf("/");

    if (at <= 0) {
        return html`<b class="last">${path}</b>`;
    }

    // A long path gives way before its last part does.
    return html`<span class="first">${path.slice(0, at + 1)}</span>
        <b class="last">${path.slice(at + 1)}</b>`;
}

/** The text with what matched the search marked. */
function Highlight({ text, needle }) {
    if (!needle) {
        return text;
    }

    // noid: the place in the text as written, which lowercasing may have moved.
    const found = foldedMatch(text, needle);

    if (found === null) {
        return text;
    }

    const [at, end] = found;

    return html`${text.slice(0, at)}
    <mark>${text.slice(at, end)}</mark>
    ${text.slice(end)}`;
}

/** Failed subagents nobody has dealt with (seen or dismissed), of a session's counts or the rail's totals. */
const failing = (counts) => (counts.failed ?? 0) - (counts.dealt ?? 0);

// ─── Priority: sessions by what they ask of you ──────────────────────────────────────────────────────────────────────

/** A failed run this browser has not seen yet, or marked unread: its cross is solid, and it needs you. */
const failedRun = (session, state = store.state) =>
    session.failed === true && (isUnread(session.id) || finishedUnseen(session, state));

/**
 * What a session asks of you: a call to answer, a failed run to see, or failed subagents nobody dealt with. The ask
 * tool's questions: once the list carries one as `waiting` (and its `approval`), it is an "ask" here too, with nothing
 * else to change; one that waits some other way would be one more case before the rest.
 */
function needOf(session, state = store.state) {
    if (session.waiting) {
        return "ask";
    }

    if (failedRun(session, state)) {
        return "failed";
    }

    return failing(session.subagents ?? {}) > 0 ? "agents" : null;
}

/** How many sessions need you, as the Priority tab and the rail say: bots' too. Archived sessions are left out. */
function needsYouCount(sessions = store.state.sessions, state = store.state) {
    return sessions.reduce(
        (sum, session) => sum + (!session.archived && needOf(session, state) ? 1 : 0),
        0,
    );
}

/** Where a session goes in Priority: `needs`, `ready` (to read), `working`, or `quiet`. The first that holds wins. */
function slotOf(session, { state, collabs, answered }) {
    const need = needOf(session, state);
    const ask = session.approval;
    // A call answered from here is no longer yours while the list has not heard yet, unless more wait behind it.
    const answeredNow =
        need === "ask" && ask !== undefined && answered.has(ask.id) && ask.count <= 1;

    if (need !== null && !answeredNow) {
        return "needs";
    }

    if (
        isUnread(session.id) ||
        finishedUnseen(session, state) ||
        (collabs && session.id !== state.conversationId && sessionUnread(session, state))
    ) {
        return "ready";
    }

    const counts = session.subagents ?? {};

    return session.busy || (counts.working ?? 0) + (counts.waiting ?? 0) > 0 ? "working" : "quiet";
}

/** The order of Needs you: calls waiting longest first, then failed runs, then failed subagents, newest first. */
const NEED_RANK = { ask: 0, failed: 1, agents: 2 };

/**
 * Priority's groups: Needs you, Ready to read, Working, and Quiet, each only while it holds a session. `held` is the
 * open session, the group it was in before it was opened, and whether it waited on a call then or since (`asked`):
 * reading it there does not move it until another opens.
 */
function priorityGroups(shown, ctx, held) {
    const slots = { needs: [], ready: [], working: [], quiet: [] };

    for (const session of shown) {
        let slot = slotOf(session, ctx);

        // Reading the open session moves it nowhere until another opens. A new need still comes first, and a call
        // answered goes where it goes now.
        if (
            session.id === held.id &&
            held.slot !== null &&
            slot !== held.slot &&
            slot !== "needs" &&
            !(held.slot === "needs" && held.asked)
        ) {
            slot = held.slot;
        }

        slots[slot].push(session);
    }

    const rank = (session) => NEED_RANK[needOf(session, ctx.state)] ?? 3;

    slots.needs.sort((a, b) => {
        const kinds = rank(a) - rank(b);

        if (kinds !== 0) {
            return kinds;
        }

        return rank(a) === 0
            ? (a.approval?.at ?? 0) - (b.approval?.at ?? 0)
            : (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt);
    });

    const rowsOf = (list) => list.map((session) => ({ session, branches: [], descendants: 0 }));
    const groups = [];

    for (const [slot, label] of [
        ["needs", "Needs you"],
        ["ready", "Ready to read"],
        ["working", "Working"],
        ["quiet", "Quiet"],
    ]) {
        if (slots[slot].length > 0) {
            const rows = rowsOf(slots[slot]);

            groups.push({
                key: `priority:${slot}`,
                slot,
                label,
                total: rows.length,
                rows,
                hidden: rows,
            });
        }
    }

    return {
        groups,
        slots: new Map(
            groups.flatMap((group) => group.rows.map((row) => [row.session.id, group.slot])),
        ),
    };
}

/** Groups that start folded: the person's first unfolding is kept as `!key` in the same stored set as the folds. */
const FOLDED_AT_FIRST = new Set(["priority:quiet"]);

/** How long the focus waits for the next call's Review to draw after an answer, before the list takes it. */
const FOCUS_WAIT_MS = 1000;

/** The most rows Needs you shows before "Show N more": a flood of calls would push everything else away. */
const NEEDS_SHOWN = 6;

/** The rows of a group that show: Needs you cuts off after a few, but for the row whose call is open. */
function visibleRows(group, asking, all) {
    return group.slot !== "needs" || all || group.rows.length <= NEEDS_SHOWN
        ? group.rows
        : group.rows.filter((row, index) => index < NEEDS_SHOWN || row.session.id === asking);
}

/** Whether this person can dismiss what a row of Needs you asks: a failed run anyone sees; subagents, who steers. */
const dismissable = (session, need = needOf(session)) =>
    need === "failed" ||
    (need === "agents" && canSteer() && (session.failedAgents ?? []).length > 0);

/** A failed run seen, and its failed subagents dealt with: what leaves Needs you. Undone only for the run. */
async function dismissFailures(list) {
    const runs = list.filter((session) => failedRun(session));
    const ids = runs.map((session) => session.id);
    const seen = seenSnapshot(ids);
    const marked = ids.filter((id) => isUnread(id));
    const agents = canSteer() ? list.flatMap((session) => session.failedAgents ?? []) : [];

    for (const id of ids) {
        markSeen(id);
    }

    const set = seenSnapshot(ids);

    for (const id of marked) {
        setUnread(id, false);
    }

    const results = await Promise.allSettled(
        agents.map((agent) =>
            dismissSubagent({ conversationId: agent.conversationId, answeredAt: agent.at }),
        ),
    );
    const refused = results.find((result) => result.status === "rejected");

    if (refused) {
        notify("error", refused.reason?.message ?? String(refused.reason));
    }

    const what =
        list.length === 1
            ? `“${truncate(list[0].title ?? "New session", 48)}”`
            : `${list.length} failed`;

    // A subagent's failure that was dealt with stays dealt with: there is no way back, so no undo.
    if (agents.length > 0 || ids.length === 0) {
        notify("info", `Dismissed ${what}.`);

        return;
    }

    notify("info", `Dismissed ${what}. ${undoWord()} to undo.`, () => {
        const back = restoreSeen(seen, set);

        for (const id of marked.filter((each) => back.has(each))) {
            setUnread(id, true);
        }
    });
}

/** Mark sessions read: a finished run seen, a mark cleared, new chat read. Says so in a notice that undoes it. */
function markRead(list, { say = true } = {}) {
    const ids = list.map((session) => session.id);
    const seen = seenSnapshot(ids);
    const marked = ids.filter((id) => isUnread(id));
    const chats = list
        .filter((session) => session.chatAt !== undefined && sessionUnread(session))
        .map((session) => [session.id, chatReadStored(session.id), session.chatAt]);

    for (const id of ids) {
        markSeen(id);
    }

    const set = seenSnapshot(ids);

    for (const id of marked) {
        setUnread(id, false);
    }

    for (const [id, , read] of chats) {
        setChatReadAt(id, read);
    }

    if (!say) {
        return;
    }

    // Undo puts back only what is still as this made it: a session read since, here or in another tab, stays read.
    notify("info", `Marked ${list.length} read. ${undoWord()} to undo.`, () => {
        const back = restoreSeen(seen, set);

        for (const id of marked.filter((each) => back.has(each) && !isUnread(each))) {
            setUnread(id, true);
        }

        for (const [id, before, read] of chats) {
            if (chatReadStored(id) === read) {
                setChatReadAt(id, before);
            }
        }
    });
}

/** "2 working · 1 failed subagents": a session's subagents, for the ⑂ mark's tooltip. */
function subagentsTip(counts) {
    const shown = { ...counts, failed: failing(counts) };
    const kinds = ["working", "waiting", "failed"].filter((kind) => shown[kind] > 0);
    const total = kinds.reduce((sum, kind) => sum + shown[kind], 0);

    return `${kinds.map((kind) => `${shown[kind]} ${kind}`).join(" · ")} subagent${total === 1 ? "" : "s"}`;
}

/**
 * How long a finger rests on a row before its actions open; how far it may stray meanwhile (as far as a scroll, or the
 * drawer's drag); and how long before the row shows the press, so a scroll's start does not light it.
 */
const PRESS_MS = 450;
const PRESS_SLOP = 8;
const PRESS_SHOWS_MS = 100;

/** The list whose row a finger last held: Select in that row's sheet selects there. */
let pressedIn = null;

/**
 * Select a session in the list where its row was held, and let taps there select more (or let go), as Ctrl/⌘+click
 * does with a mouse. From the sheet a long press opens.
 */
export function selectFromList(id) {
    pressedIn?.current?.(id);
}

/**
 * The square at the start of a session's row: its folder's color, in the shape of where the session is. The first that
 * holds wins: a call waiting for you, Pi or its subagents at work, a failed run (solid while new, drawn once seen),
 * finished since this browser last looked or marked unread (solid), and read or never run (hollow).
 */
function stateMark(session, working, marked) {
    const fresh = marked || finishedUnseen(session);

    if (session.waiting) {
        return { shape: "waiting", label: "Waiting for approval" };
    }

    if (session.busy || working) {
        return { shape: "working", label: "Working" };
    }

    if (session.failed) {
        return fresh
            ? { shape: "failed", label: "Failed, not read" }
            : { shape: "failed seen", label: "Failed" };
    }

    return fresh ? { shape: "fresh", label: "Not read" } : { shape: "seen", label: "" };
}

/** A row's state for themes (`data-state`), by its square's shape: a documented name that stays when the squares change. */
const ROW_STATES = {
    waiting: "waiting",
    working: "working",
    failed: "failed",
    fresh: "done",
    seen: "idle",
};

/** A session's square, as its row in the list draws it (the home screen's Jump back in too). */
export function sessionMark(session) {
    const counts = session.subagents ?? {};

    return stateMark(
        session,
        (counts.working ?? 0) + (counts.waiting ?? 0) > 0,
        isUnread(session.id),
    );
}

/**
 * One session on one line: its folder's color in the shape of its state, its title, and on the right what goes on there (its working subagents,
 * who else is in it, Pi working, a call waiting for you), unread chat, and how long ago. Its folder and model are in
 * its tooltip.
 */
function SessionRow({
    session,
    branches,
    kids = 0,
    folded = false,
    foldHeld = false,
    foldTrouble,
    index,
    number,
    needle,
    selected,
    pressing,
    folders,
    onPick,
    onSelect,
    slot,
    need = null,
    expanded = false,
    answering = false,
    glow = false,
    ownCall = false,
    onReview,
    onAnswer,
    onDismiss,
    onRead,
}) {
    const { conversationId, server, me } = store.state;
    const pinned = isPinned(session.id);
    const open = session.id === conversationId && !session.archived;
    const marked = isUnread(session.id);
    const unread = collab() && sessionUnread(session) && !open;
    const moving = store.state.moving[session.id] !== undefined;
    const title = session.title ?? "New session";
    const path = shortPath(session.cwd, server?.home);
    const where = [
        session.worktree ? `${path} ⎇ ${session.worktree.branch}` : path,
        session.model,
    ].filter(Boolean);
    // A search can match the folder or model instead of the title: the row shows which.
    let hit =
        needle && !title.toLowerCase().includes(needle)
            ? [path, session.cwd, session.model].find((text) =>
                  text?.toLowerCase().includes(needle),
              )
            : undefined;

    // A path from the folder that matched: its start is the same in every row, and would push the match out of sight.
    if (hit && hit !== session.model) {
        const parts = hit.split("/");
        const at = parts.findLastIndex((part) => part.toLowerCase().includes(needle));

        hit = at > 0 ? `…/${parts.slice(at).join("/")}` : hit;
    }

    const counts = session.subagents ?? {};
    const live = (counts.working ?? 0) + (counts.waiting ?? 0);
    const failed = failing(counts);
    // Subagents at work, or failed ones nobody dealt with, but not over a call waiting for you: that says more.
    const fork = !session.waiting && (live > 0 || failed > 0);
    const person = collab() ? (session.people ?? []).find((each) => each.id !== me?.id) : undefined;
    const mark = stateMark(session, live > 0, marked);
    // Finished since this browser last looked: its result is unread, so its title reads bold.
    const unseen = finishedUnseen(session);
    const steers = canSteer();
    // In Priority's Needs you, what the session asks of you (`need`, from `needOf`): its row has a button at its right,
    // and says why in its tooltip.
    const ask = need === "ask" ? session.approval : undefined;
    const names = (session.failedAgents ?? []).map((agent) => agent.name);
    const why =
        need === "ask"
            ? ask && `${ask.tool} · ${ask.subject}`
            : need === "failed"
              ? `Run failed${session.failure ? `: ${session.failure}` : ""}`
              : need === "agents"
                ? failed === 1 && names.length > 0
                    ? `Subagent ${names[0]} failed`
                    : `${failed} subagents failed`
                : undefined;
    // A failed subagent is dealt with by someone who steers; a failed run is only seen, which anyone can do.
    const dismisses = need !== null && need !== "ask" && dismissable(session, need);
    // The Folders tab names the folder above the row already: its model comes first. And why the row needs you.
    const tip = [title, ...(why ? [why] : []), ...(folders ? where.reverse() : where)].join(" · ");
    // Archive, pin, and mark-unread show on hover; an archived session only comes back, and only for people who steer.
    // In Priority a row that needs you has its button instead, and one to read marks itself read in pin's place.
    const acts =
        slot === "needs"
            ? 0
            : slot === "ready"
              ? (steers ? 1 : 0) + 1
              : (steers ? 1 : 0) + (session.archived ? 0 : 2);

    return html`<div
        class=${`session-row ${kids > 0 ? "with-fold" : ""} ${slot === "needs" ? "needs-you" : ""} ${expanded ? "asking" : ""} ${glow ? "glow" : ""} ${open ? "active" : ""} ${selected ? "selected" : ""} ${pressing ? "pressing" : ""} ${moving ? "moving" : ""} ${marked ? "marked-unread" : ""} ${unseen ? "unseen" : ""} ${["no-acts", "one-act", "", "three-acts"][acts]}`}
        data-part="session-row"
        data-state=${ROW_STATES[mark.shape.split(" ")[0]]}
        data-id=${session.id}
        style=${`--i:${index};--linked-depth:${Math.min(branches.length, 3)}`}
    >
        ${
            branches.length > 0 &&
            html`<span class="session-branches" data-part="session-branches" aria-hidden="true">
                ${branches.slice(-3).map(
                    (continues, index, visible) => html`<span
                        class=${`${continues ? "continues" : ""} ${index === visible.length - 1 ? "elbow" : ""}`}
                    ></span>`,
                )}
            </span>`
        }
        <button
            class=${`session ${unread ? "unread" : ""}`}
            data-part="session-button"
            aria-current=${open ? "page" : undefined}
            onPointerDown=${(event) => onSelect(event, session.id)}
            onClick=${(event) => onPick(event, session.id)}
            onContextMenu=${(event) => event.ctrlKey && event.preventDefault()}
            title=${tip}
        >
            <span class="session-mark">
                ${
                    selected
                        ? html`<span class="state-check" role="img" aria-label="Selected">
                            <${Icon} name="check" size=${9} />
                        </span>`
                        : html`<span
                            class=${`state-mark ${mark.shape}`}
                            data-part="session-mark"
                            style=${`--folder:${folderColor(session.cwd)}`}
                            role=${mark.label ? "img" : undefined}
                            aria-label=${mark.label || undefined}
                            aria-hidden=${mark.label ? undefined : "true"}
                        ></span>`
                }
            </span>
            <span class=${`session-title ${hit ? "with-hit" : ""}`}>
                ${
                    hit
                        ? html`<span class="session-name">${title}</span>
                            <span class="session-hit">
                                <${Highlight} text=${hit} needle=${needle} />
                            </span>`
                        : html`<${Highlight} text=${title} needle=${needle} />`
                }
            </span>
            <span class="session-side">
                ${
                    fork &&
                    html`<span
                        class=${`session-fork ${live > 0 ? "" : "failed"}`}
                        title=${subagentsTip(counts)}
                    >
                        <${Icon} name="fork" size=${10} />${live > 0 ? live : failed}
                    </span>`
                }
                ${
                    slot !== "needs" &&
                    !fork &&
                    person &&
                    html`<${Avatar} person=${person} size=${18} />`
                }
                ${
                    slot !== "needs" &&
                    session.busy &&
                    !session.waiting &&
                    !fork &&
                    html`<span class="session-working" title="Working"></span>`
                }
                ${
                    slot === undefined &&
                    session.waiting &&
                    html`<span class="session-needs" title="Waiting for approval">
                        ${steers ? "needs you" : "waiting"}
                    </span>`
                }
                ${
                    slot !== "needs" &&
                    (unread || marked) &&
                    html`<span
                        class="unread-dot"
                        title=${marked ? "Marked unread" : "New chat messages"}
                    ></span>`
                }
                ${
                    slot !== "needs" &&
                    html`<span class="session-time">${timeAgo(session.updatedAt)}</span>`
                }
                ${
                    number !== undefined &&
                    number < 9 &&
                    html`<kbd class="session-num">${number + 1}</kbd>`
                }
            </span>
        </button>
        ${
            kids > 0 &&
            html`<button
                class=${`session-fold ${folded ? "folded" : ""}`}
                data-part="session-fold"
                aria-expanded=${!folded}
                aria-label=${foldLabel(kids, foldTrouble)}
                title=${
                    foldHeld
                        ? "The open session is among them, so they show"
                        : `${folded ? "Show" : "Hide"} ${kids} linked ${kids === 1 ? "session" : "sessions"}`
                }
                disabled=${foldHeld}
                onClick=${() => toggleFoldedLinked(session.id)}
            >
                ${
                    foldTrouble &&
                    html`<span class=${`group-trouble ${foldTrouble}`} aria-hidden="true"></span>`
                }
                <span class="session-fold-pill">
                    ${kids}
                    <${Icon} name="down" size=${10} />
                </span>
            </button>`
        }
        ${
            ask &&
            html`<span class="session-quick" data-part="session-quick">
                <button
                    class="quick-pill attn"
                    data-part="session-review"
                    data-review=${session.id}
                    aria-expanded=${expanded}
                    title="See the call, then allow or deny it"
                    onClick=${() => onReview(session.id)}
                >
                    Review
                </button>
            </span>`
        }
        ${
            dismisses &&
            html`<span class="session-quick" data-part="session-quick">
                <button
                    class="quick-pill icon-only"
                    data-part="session-dismiss"
                    title=${`Dismiss: ${why}`}
                    aria-label=${`Dismiss: ${why}`}
                    onClick=${() => onDismiss(session.id)}
                >
                    <${Icon} name="close" size=${12} />
                </button>
            </span>`
        }
        ${
            slot !== "needs" &&
            html`<span class="session-actions">
            ${
                steers &&
                html`<button
                    class="session-act"
                    title=${session.archived ? "Unarchive" : "Archive"}
                    aria-label=${session.archived ? "Unarchive" : "Archive"}
                    onClick=${() => setArchived([session.id], !session.archived)}
                >
                    <${Icon} name=${session.archived ? "unarchive" : "archive"} size=${14} />
                </button>`
            }
            ${
                slot === "ready" &&
                html`<button
                    class="session-act"
                    data-part="session-read"
                    title="Mark read"
                    aria-label="Mark read"
                    onClick=${() => onRead(session.id)}
                >
                    <${Icon} name="check" size=${14} />
                </button>`
            }
            ${
                slot !== "ready" &&
                !session.archived &&
                html`<button
                    class=${`session-act session-pin ${pinned ? "on" : ""}`}
                    title=${pinned ? "Unpin" : "Pin to the top"}
                    aria-label=${pinned ? "Unpin" : "Pin"}
                    onClick=${() => togglePin(session.id)}
                >
                    <${Icon} name="pin" size=${14} />
                </button>`
            }
            ${
                slot !== "ready" &&
                !session.archived &&
                html`<button
                    class=${`session-act session-unread ${marked ? "on" : ""}`}
                    title=${marked ? "Mark read" : "Mark unread"}
                    aria-label=${marked ? "Mark read" : "Mark unread"}
                    onClick=${() => setUnread(session.id, !marked)}
                >
                    <${Icon} name=${marked ? "check" : "unread"} size=${14} />
                </button>`
            }
        </span>`
        }
        ${
            expanded &&
            ask &&
            html`<${NeedAsk}
                session=${session}
                ask=${ask}
                steers=${steers}
                ownCall=${ownCall}
                answering=${answering}
                onAnswer=${onAnswer}
            />`
        }
    </div>`;
}

/**
 * The call a row in Needs you waits on, open in the row: the tool and the whole command, who asks (Lancet Guard or a
 * bot), why, and how long ago, with Deny and Allow. The rules are its card's (`ApprovalCard`) and a peek tile's
 * (`PeekApproval`): only someone who steers answers; a command that does not show whole is not allowed from here (Open
 * shows it where it waits), and neither is a call that the "others" rule keeps from this person. "Always allow", for a
 * bot's call, is only on its card. A question (`form`) is only opened: its fields are on its card.
 */
function NeedAsk({ session, ask, steers, ownCall, answering, onAnswer }) {
    const whole = wholeOnTile(ask);
    const ago = timeAgo(fromServer(ask.at));
    const more = ask.count > 1 ? ` · +${ask.count - 1}` : "";
    // noid: a bot's call asks as the bot the session is, or works for; Lancet Guard asks with ids of its own.
    const bot = ask.id.startsWith("noid:") ? (session.bot ?? session.worksFor) : undefined;
    const why = [bot && `${bot.name} asks`, ask.reason].filter(Boolean).join(" · ");
    const tooLong = ask.form || whole ? "" : `${why ? " · " : ""}too long to allow from here`;
    const answers = steers && !ask.form;

    return html`<div class="need-ask" data-part="session-ask">
        <div
            class=${`need-command ${whole ? "" : "long"}`}
            data-part="session-ask-command"
            title=${ask.subject}
        >
            <code>
                <span class="need-tool"><${Icon} name="shield" size=${11} />${ask.tool}</span>
                ${ask.subject}
            </code>
        </div>
        <div class="need-why" data-part="session-ask-reason">${why}${tooLong}</div>
        <div class="need-foot">
            <span
                class="need-when"
                title=${ask.count > 1 ? `${ask.count - 1} more waiting in this session` : undefined}
            >${ago === "now" ? "just now" : `${ago} ago`}${more}</span>
            ${
                answers &&
                html`<button
                    class="need-button"
                    data-part="session-deny"
                    disabled=${answering}
                    onClick=${() => onAnswer(session.id, ask.id, false)}
                >
                    Deny
                </button>`
            }
            ${
                answers && whole && !ownCall
                    ? html`<button
                          class="need-button primary"
                          data-part="session-allow"
                          disabled=${answering}
                          onClick=${() => onAnswer(session.id, ask.id, true)}
                      >
                          Allow
                      </button>`
                    : html`<button
                          class=${`need-button ${answers ? "" : "primary"}`}
                          data-part="session-ask-open"
                          title="See the whole call where it waits"
                          onClick=${() => navigate(ask.conversationId)}
                      >
                          Open
                      </button>`
            }
        </div>
    </div>`;
}

/** Sessions in groups: pinned, then by day or by folder. While searching, one flat list of matches. */
function groupsOf(shown, { tab, needle, home, pinned }) {
    if (needle !== "" || tab === "archived") {
        return [{ key: "flat", label: needle ? "Matches" : "Archived", rows: shown }];
    }

    const groups = [];
    const byId = new Map(shown.map((session) => [session.id, session]));
    // In the order they were pinned, as the workspace order (`sessionOrder`) and the launcher count them.
    const pins = pinned.map((id) => byId.get(id)).filter(Boolean);

    if (pins.length > 0) {
        groups.push({ key: "pinned", label: "Pinned", rows: pins });
    }

    const rest = shown.filter((session) => !pinned.includes(session.id));
    const byKey = new Map();

    for (const session of rest) {
        const key = tab === "folders" ? `dir:${session.cwd}` : `day:${dayGroup(session.updatedAt)}`;

        if (!byKey.has(key)) {
            byKey.set(key, {
                key,
                label:
                    tab === "folders"
                        ? html`<${FolderName} path=${shortPath(session.cwd, home)} />`
                        : dayGroup(session.updatedAt),
                rows: [],
            });
        }

        byKey.get(key).rows.push(session);
    }

    return [...groups, ...byKey.values()];
}

const TABS = [
    ["priority", "Priority"],
    ["recent", "Recent"],
    ["folders", "Folders"],
    ["archived", "Archived"],
];

/** The tab a browser starts on, from the choice it kept (`prefs().group`): Recent when it kept none. */
const tabOf = (group) =>
    group === "folder" ? "folders" : group === "priority" ? "priority" : "recent";

/**
 * What the full list searched for and how far it was scrolled, kept while the tab lives: on a phone the list goes when a
 * session opens, and back from the session shows it again as it was.
 */
const listKept = { query: "", scroll: 0 };

/** noid: the size of faces on the rail, bots' and yours alike. */
const RAIL_FACE = 52;

/** A bot's face shows how it is: at work, waiting for you, failed, or idle. */
const FACE_STATES = { waiting: "waiting", working: "working", failed: "error" };

/** The face state of a bot's session, from its list item. */
export function botFaceState(session) {
    return FACE_STATES[sessionMark(session).shape.split(" ")[0]] ?? "idle";
}

/**
 * noid: a section's head in the sidebar, as an editor's side bar has them: its name and count fold what is under it
 * (kept with the folded day groups), and a plus adds to it.
 */
function SectionHead({ name, count, part, folded, onFold, add, onAdd }) {
    return html`<div class="sessions-head">
        ${
            onFold === undefined
                ? html`<span class="section-fold" data-part=${part}>
                      <span class="sessions-name">${name}</span>
                      <span class="sessions-count">${count}</span>
                  </span>`
                : html`<button
            class="section-fold"
            data-part=${part}
            aria-expanded=${!folded}
            title=${folded ? `Show ${name.toLowerCase()}` : `Hide ${name.toLowerCase()}`}
            onClick=${onFold}
        >
            <${Icon} name="chevron" size=${12} />
            <span class="sessions-name">${name}</span>
            <span class="sessions-count">${count}</span>
        </button>`
        }
        ${
            onAdd &&
            html`<button class="new-button" title=${add} aria-label=${add} onClick=${onAdd}>
                <${Icon} name="plus" size=${15} />
            </button>`
        }
    </div>`;
}

/** noid: which list the sidebar shows, bots or sessions, as its tabs last chose. */
const PANE_KEY = "pocket.sidebarPane";

function readPane() {
    try {
        return localStorage.getItem(PANE_KEY) === "sessions" ? "sessions" : "bots";
    } catch {
        return "bots";
    }
}

/**
 * noid: the sidebar's tabs, as Claude's chat and code ones: an icon each for the bots and the sessions, the one shown
 * pressed. A dot on one that is hidden says something there is at work or needs you.
 */
function PaneTabs({ pane, onPane }) {
    const { sessions } = store.state;
    const busy = (bots) =>
        sessions.some(
            (session) =>
                !session.archived &&
                (session.bot !== undefined) === bots &&
                (session.busy || session.waiting),
        );
    const tabs = [
        ["bots", "bot", "Bots"],
        ["sessions", "terminal", "Sessions"],
    ];

    return html`<div class="pane-tabs" role="tablist" aria-label="Show" data-part="pane-tabs">
        ${tabs.map(
            ([key, icon, label]) => html`<button
                role="tab"
                class=${`pane-tab ${pane === key ? "on" : ""}`}
                aria-selected=${pane === key}
                title=${label}
                aria-label=${label}
                onClick=${() => onPane(key)}
            >
                <${Icon} name=${icon} size=${17} />
                ${pane !== key && busy(key === "bots") && html`<span class="pane-dot"></span>`}
            </button>`,
        )}
    </div>`;
}

/** noid: the bots' sessions, as the Bots tab and the folded rail show them: Noid first, then by name. */
const botSessions = (sessions) =>
    sessions
        .filter((session) => session.bot !== undefined && !session.archived)
        .sort(
            (a, b) =>
                Number(b.bot.main === true) - Number(a.bot.main === true) ||
                a.bot.name.localeCompare(b.bot.name),
        );

/** noid: the bots, in the sidebar's Bots tab: Noid first, then by name. */
function BotList({ compact, canStart }) {
    const { sessions, conversationId } = store.state;
    const bots = botSessions(sessions);

    if (bots.length === 0 && !canStart) {
        return null;
    }

    // Noid on its own, above the others, as Grok's list puts Grok.
    const main = bots[0]?.bot.main === true ? bots[0] : undefined;
    const others = main === undefined ? bots : bots.slice(1);

    return html`<div class="bots" data-part="bot-list">
        <${SectionHead}
            name="Bots"
            count=${bots.length}
            part="bot-list-title"
            add="New bot"
            onAdd=${canStart && (() => openSheet({ type: "bot" }))}
        />
        <div class="bot-items">
            ${
                main &&
                html`<${MainBot}
                    session=${main}
                    active=${main.id === conversationId}
                    size=${compact ? 64 : 72}
                />`
            }
            ${others.map(
                (session) => html`<${BotRow}
                    key=${session.id}
                    session=${session}
                    active=${session.id === conversationId}
                    size=${compact ? 52 : 56}
                />`,
            )}
        </div>
    </div>`;
}

/** What a bot is doing, when that matters: working, waiting for approval, or failed; else undefined. */
export function botDoing(session) {
    const mark = sessionMark(session);

    return ["working", "waiting", "failed"].includes(mark.shape.split(" ")[0])
        ? mark.label
        : undefined;
}

/** What a bot's row says under its name: what it is doing when that matters, else what it last said, else its role. */
const botLine = (session) => botDoing(session) ?? session.said ?? session.bot.role;

/** noid: Noid, the main bot, at the top of the list: a big face and its name. */
function MainBot({ session, active, size }) {
    const { bot } = session;

    return html`<button
        class=${`bot-main ${active ? "active" : ""}`}
        data-part="bot-row"
        data-state=${botFaceState(session)}
        aria-current=${active ? "page" : undefined}
        title=${session.said ?? bot.role}
        onClick=${() => navigate(session.id)}
    >
        <${Face}
            id=${bot.id}
            color=${bot.color}
            skin=${bot.skin}
            eyes=${bot.eyes}
            shape=${bot.shape}
            state=${botFaceState(session)}
            size=${size}
            label=${bot.name}
        />
        <span class="bot-name">${bot.name}</span>
    </button>`;
}

function BotRow({ session, active, size }) {
    const { bot } = session;
    const mark = sessionMark(session);
    const row = useRef(null);

    // The open bot stays in sight in its scrolling section.
    useEffect(() => {
        if (active) {
            row.current?.scrollIntoView({ block: "nearest" });
        }
    }, [active]);

    return html`<button
        ref=${row}
        class=${`bot-row ${active ? "active" : ""} ${mark.shape.startsWith("fresh") ? "fresh" : ""}`}
        data-part="bot-row"
        data-state=${botFaceState(session)}
        aria-current=${active ? "page" : undefined}
        title=${bot.role || bot.name}
        onClick=${() => navigate(session.id)}
    >
        <${Face}
            id=${bot.id}
            color=${bot.color}
            skin=${bot.skin}
            eyes=${bot.eyes}
            shape=${bot.shape}
            state=${botFaceState(session)}
            size=${size}
            label=${bot.name}
        />
        <span class="bot-text">
            <span class="bot-name">${bot.name}</span>
            <span class="bot-role">${botLine(session)}</span>
        </span>
    </button>`;
}

function AllSessions({ compact = false }) {
    const { sessions, sessionsLoaded, server, pinned } = store.state;
    const canStart = canSteer() && !scoped();
    const [query, setQueryState] = useState(() => (compact ? "" : listKept.query));
    const [tab, setTabState] = useState(() => tabOf(prefs().group));
    const [closed, setClosed] = useState(readClosed);
    // Priority: the row whose call is open in it, calls answered from here that the list has not heard of yet, the row
    // that just moved after an answer, the row to give the focus, and whether all of Needs you shows.
    const [asking, setAsking] = useState(null);
    const [answered, setAnswered] = useState(() => new Set());
    const [moved, setMoved] = useState(null);
    const [focusReview, setFocusReview] = useState(null);
    const [allNeeds, setAllNeeds] = useState(false);
    // The open session and the group it was in before it opened: it stays there while it is open, though opening it
    // reads it.
    const opened = useRef({ id: null, slot: null, asked: false });
    const slotsShown = useRef(new Map());
    // The order of the calls in Needs you, for the one that opens next.
    const askOrder = useRef([]);
    const [selected, setSelectedState] = useState(() => new Set());
    // Taps select rows instead of opening them: a selection started from a long press's sheet, on a touch screen.
    const [tapSelects, setTapSelects] = useState(false);
    // The row a finger holds down, before its actions open.
    const [pressing, setPressing] = useState(null);
    // The selection as drags and clicks see it between renders; the row a Shift+click extends from; the row a Ctrl/⌘ press
    // already selected, whose click then does nothing; the rows in view, in order.
    const picked = useRef(selected);
    const anchor = useRef(null);
    const held = useRef(null);
    const visible = useRef([]);
    const list = useRef(null);
    const tabs = useRef(null);
    const needle = query.trim().toLowerCase();
    const archived = tab === "archived";
    const [chosenPane, setPaneState] = useState(readPane);
    // Bots are the owner's alone: anyone else has only sessions, and no tabs to choose between.
    const guest =
        store.state.me !== undefined && store.state.me !== null && store.state.me.role !== "owner";
    const pane = guest ? "sessions" : chosenPane;
    const conversationId = store.state.conversationId;

    const setPane = (next) => {
        try {
            localStorage.setItem(PANE_KEY, next);
        } catch {
            // Kept for this page only.
        }

        // What was chosen in the other list is not in sight: the bar would act on rows nobody sees.
        clearSelection();
        setPaneState(next);
    };

    // Opening a bot or a session, from anywhere, shows its list; after a reload, once the list is there to say which.
    useEffect(() => {
        const open = sessions.find((session) => session.id === conversationId);

        if (open !== undefined && !open.archived) {
            setPaneState(open.bot === undefined ? "sessions" : "bots");
        }
    }, [conversationId, sessionsLoaded]);

    const setQuery = (next) => {
        if (!compact) {
            listKept.query = next;
        }

        setQueryState(next);
    };

    // Scrolled back to where it was, once its rows are there.
    useLayoutEffect(() => {
        if (!compact && sessionsLoaded && list.current) {
            list.current.scrollTop = listKept.scroll;
        }
    }, [sessionsLoaded]);

    const setSelected = (next) => {
        picked.current = next;
        setSelectedState(next);

        if (next.size === 0) {
            setTapSelects(false);
        }
    };

    // What Select in a held row's sheet does here; and what lets go of a press under way.
    const startSelect = useRef(null);
    const unpress = useRef(null);

    startSelect.current = (id) => {
        anchor.current = id;
        setSelected(new Set([...picked.current, id]));
        setTapSelects(true);
    };

    useEffect(
        () => () => {
            unpress.current?.();

            if (pressedIn === startSelect) {
                pressedIn = null;
            }
        },
        [],
    );

    const clearSelection = () => {
        anchor.current = null;
        setSelected(new Set());
    };

    const setTab = (next) => {
        setTabState(next);
        clearSelection();

        if (next !== "archived") {
            setPrefs({
                group: next === "folders" ? "folder" : next === "priority" ? "priority" : "recent",
            });
        }
    };

    // Priority: by what a session asks of you, so pins and links do not shape it; a search lists the matches.
    const priority = tab === "priority" && needle === "";
    // noid: bots are listed above, in their own list; an archived one shows here, to bring it back, and in Priority one
    // that needs you shows in Needs you.
    const shown = sessions.filter(
        (session) =>
            Boolean(session.archived) === archived &&
            (session.bot === undefined || archived || (priority && needOf(session) !== null)) &&
            (needle === "" ||
                `${session.title ?? ""} ${session.cwd} ${shortPath(session.cwd, server?.home)} ${session.model ?? ""}`
                    .toLowerCase()
                    .includes(needle)),
    );
    const forest = sessionForest(shown, { pinned, folders: tab === "folders" });
    // Linked sessions folded away (`store.js`), but never above the open session, which always shows.
    const folded = foldsNow();
    const above = holdsOpen();
    let groups;

    if (priority) {
        // Opened just now: the group it was in as last drawn.
        if (opened.current.id !== conversationId) {
            opened.current = {
                id: conversationId,
                slot: slotsShown.current.get(conversationId) ?? null,
                asked: false,
            };
        }

        // A call that waits there, then or since: once it is answered, the row goes where it goes now.
        if (shown.some((session) => session.id === conversationId && session.waiting)) {
            opened.current.asked = true;
        }

        const laid = priorityGroups(
            shown,
            { state: store.state, collabs: collab(), answered },
            opened.current,
        );

        groups = laid.groups;
        slotsShown.current = laid.slots;
        askOrder.current = groups
            .filter((group) => group.slot === "needs")
            .flatMap((group) => group.rows.map((row) => row.session))
            .filter((session) => session.waiting && session.approval)
            .map((session) => session.id);
    } else {
        groups = groupsOf(forest.roots, { tab, needle, home: server?.home, pinned }).map(
            (group) => {
                const rows = group.rows.flatMap((root) => forest.rows.get(root.id));

                return {
                    ...group,
                    total: rows.length,
                    rows: needle === "" ? unfolded(rows, folded) : rows,
                    // What each folded row hides, for the marks it stands in for.
                    hidden: needle === "" ? rows : [],
                };
            },
        );
    }

    // Folded groups: a group's key is in `closed`; Quiet starts folded, and `!key` there says it was opened.
    const isClosed = (key) =>
        key !== "flat" && (closed.has(key) || (FOLDED_AT_FIRST.has(key) && !closed.has(`!${key}`)));

    visible.current = groups.flatMap((group) =>
        isClosed(group.key)
            ? []
            : visibleRows(group, asking, allNeeds).map(({ session }) => session.id),
    );
    // A row a fold hides is not chosen: an action runs only on rows the person can see were picked.
    const listed = new Set(groups.flatMap((group) => group.rows.map(({ session }) => session.id)));
    const chosen = shown
        .filter((session) => selected.has(session.id) && listed.has(session.id))
        .map((session) => session.id);
    // Taps select while the bar shows: not for rows selected and then hidden (archived, searched away, or folded).
    const tapping = tapSelects && chosen.length > 0;
    const numbers = new Map(workspaceOrder().map((session, index) => [session.id, index]));

    /** The rows from `from` to `to` as they show, or just `to` when either is out of view. */
    const span = (from, to) => {
        const ids = visible.current;
        const a = ids.indexOf(from);
        const b = ids.indexOf(to);

        return a === -1 || b === -1 ? [to] : ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    };

    /**
     * A plain click opens the session. Shift+click selects from the last row picked (or the open one) to this row;
     * Ctrl/⌘+Enter on a focused row selects it or lets it go.
     */
    const pick = (event, id) => {
        // The press already selected, even if Ctrl/⌘ was let go before the button.
        if (held.current === id && event.detail > 0) {
            held.current = null;

            return;
        }

        if (event.shiftKey) {
            // From the last row picked, or else the open session, if it shows; or else from this row on.
            if (!visible.current.includes(anchor.current)) {
                const open = store.state.conversationId;

                anchor.current = visible.current.includes(open) ? open : id;
            }

            setSelected(new Set([...picked.current, ...span(anchor.current, id)]));

            return;
        }

        if (event.ctrlKey || event.metaKey || tapping) {
            const next = new Set(picked.current);

            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }

            anchor.current = id;
            setSelected(next);

            return;
        }

        clearSelection();
        navigate(id);
    };

    /**
     * A finger (or a pen) held on a row opens its actions in a sheet, as hovering shows them to a mouse: touch screens
     * have no hover. The row shows the press while it is held; moving (a scroll, a drag) lets it go. The click the lift
     * may then make, on the row or on the scrim that rose under it, does nothing. While the finger is held nothing on
     * the page can be selected: the sheet rises under the finger, and Android's own long press would otherwise select
     * the word there and raise its Copy bar over the sheet.
     */
    const press = (event, id) => {
        const session = sessions.find((each) => each.id === id);

        // Nothing to offer: an archived session, for someone who cannot bring it back.
        if (!event.isPrimary || !session || (session.archived && !canSteer())) {
            return;
        }

        const { pointerId, clientX: x, clientY: y } = event;
        let fired = false;
        let after = 0;
        const root = document.documentElement;
        const shows = setTimeout(() => setPressing(id), PRESS_SHOWS_MS);

        const open = setTimeout(() => {
            // Gone meanwhile (someone deleted it): nothing to open.
            if (!store.state.sessions.some((each) => each.id === id)) {
                return stop();
            }

            fired = true;
            setPressing(null);
            pressedIn = startSelect;
            // Over the drawer, which stays: Select goes on there.
            store.set({ sheet: { type: "session", id } });
        }, PRESS_MS);

        const move = (each) => {
            if (
                each.pointerId === pointerId &&
                !fired &&
                Math.hypot(each.clientX - x, each.clientY - y) >= PRESS_SLOP
            ) {
                stop();
            }
        };

        const lift = (each) => {
            if (each.pointerId !== pointerId) {
                return;
            }

            if (!fired) {
                return stop();
            }

            // The lift's click comes at once, if at all; the next press is someone else's tap.
            removeEventListener("pointerup", lift, true);
            removeEventListener("pointercancel", lift, true);
            addEventListener("pointerdown", stop, true);
            after = setTimeout(stop, 400);
        };

        // A finger's mouse events only: its mousedown can close the scrim before the click, and Enter on a sheet's
        // item is a click too. Keep the guard through mousedown so the click cannot act on an item under the lift.
        const eat = (each) => {
            if (fired && each.detail > 0) {
                each.preventDefault();
                each.stopPropagation();

                if (each.type === "click") {
                    stop();
                }
            }
        };

        // Android's own long press: no menu, and no text selection. The row's own text cannot be selected already,
        // but the sheet this press opens, rising under the finger, could be: Android would select the word under it
        // and raise its Copy bar over the sheet. So, while the finger is held, the page selects nothing.
        const quiet = (each) => each.preventDefault();
        const hold = (each) => each.preventDefault();

        const stop = () => {
            unpress.current = null;
            clearTimeout(shows);
            clearTimeout(open);
            clearTimeout(after);
            setPressing((now) => (now === id ? null : now));
            root.classList.remove("holding");
            removeEventListener("pointermove", move, true);
            removeEventListener("pointerup", lift, true);
            removeEventListener("pointercancel", lift, true);
            removeEventListener("pointerdown", stop, true);
            removeEventListener("mousedown", eat, true);
            removeEventListener("click", eat, true);
            removeEventListener("contextmenu", quiet, true);
            removeEventListener("selectstart", hold, true);
        };

        unpress.current?.();
        unpress.current = stop;
        root.classList.add("holding");
        addEventListener("pointermove", move, true);
        addEventListener("pointerup", lift, true);
        addEventListener("pointercancel", lift, true);
        addEventListener("mousedown", eat, true);
        addEventListener("click", eat, true);
        addEventListener("contextmenu", quiet, true);
        addEventListener("selectstart", hold, true);
    };

    /**
     * Ctrl/⌘+press on a row selects it (or, if it was selected, unselects it); dragging on does the same to every row
     * between it and the pointer. Once the pointer moves, the list scrolls along near its top or bottom edge. A finger
     * held on a row opens its actions instead.
     */
    const select = (event, id) => {
        held.current = null;

        if (event.button !== 0) {
            return;
        }

        if (event.pointerType !== "mouse") {
            press(event, id);

            return;
        }

        if (event.shiftKey) {
            // No text selection: the click extends the session selection instead.
            event.preventDefault();

            return;
        }

        if (!event.ctrlKey && !event.metaKey) {
            return;
        }

        event.preventDefault();
        held.current = id;
        const box = list.current;
        const root = document.documentElement;
        const before = picked.current;
        const adding = !before.has(id);

        anchor.current = id;
        let reached = null;

        const reach = (to) => {
            if (to === reached) {
                return;
            }

            reached = to;
            const next = new Set(before);

            for (const each of span(id, to)) {
                if (adding) {
                    next.add(each);
                } else {
                    next.delete(each);
                }
            }

            setSelected(next);
        };

        reach(id);
        const start = event.clientY;
        let y = start;

        // The row at the pointer's height, held inside the list so a drag past its sides or ends still counts.
        const under = () => {
            const rect = box.getBoundingClientRect();
            const row = document
                .elementFromPoint(
                    rect.left + box.clientWidth / 2,
                    Math.min(rect.bottom - 2, Math.max(rect.top + 2, y)),
                )
                ?.closest?.(".session-row[data-id]");

            if (!row || !box.contains(row)) {
                return;
            }

            const found = visible.current.find((each) => String(each) === row.dataset.id);

            if (found !== undefined) {
                reach(found);
            }
        };

        // No frame until the pointer moves: a press near an edge is not a drag.
        let frame = 0;

        const scroll = () => {
            const rect = box.getBoundingClientRect();
            const edge = 36;
            const past =
                y < rect.top + edge
                    ? y - rect.top - edge
                    : y > rect.bottom - edge
                      ? y - rect.bottom + edge
                      : 0;

            if (past !== 0) {
                box.scrollTop += Math.max(-24, Math.min(24, past / 2));
                under();
            }

            frame = requestAnimationFrame(scroll);
        };

        const move = (each) => {
            // The button came up where this page did not hear it, say in another window.
            if ((each.buttons & 1) === 0) {
                return stop();
            }

            y = each.clientY;

            if (frame === 0 && Math.abs(y - start) > 4) {
                frame = requestAnimationFrame(scroll);
            }

            under();
        };

        const stop = () => {
            cancelAnimationFrame(frame);
            root.classList.remove("selecting");
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", stop);
            removeEventListener("pointercancel", stop);
            removeEventListener("blur", stop);
        };

        root.classList.add("selecting");
        getSelection()?.removeAllRanges();
        addEventListener("pointermove", move);
        addEventListener("pointerup", stop);
        addEventListener("pointercancel", stop);
        addEventListener("blur", stop);
    };

    const archiveChosen = () => {
        clearSelection();
        setArchived(chosen, !archived);
    };

    const allPinned = chosen.length > 0 && chosen.every((id) => pinned.includes(id));

    const pinChosen = () => {
        for (const id of chosen) {
            if (isPinned(id) === allPinned) {
                togglePin(id);
            }
        }

        clearSelection();
    };

    // Esc lets go of the selection, unless something else takes it: a sheet, the launcher, a text field, or a menu.
    const selecting = selected.size > 0;

    // On a touch screen, so does back.
    useBack(tapping, clearSelection);

    useEffect(() => {
        if (!selecting) {
            return;
        }

        const onKey = (event) => {
            if (
                event.key !== "Escape" ||
                event.defaultPrevented ||
                store.state.sheet ||
                store.state.launcher
            ) {
                return;
            }

            // Taken: this Esc lets go of the selection, and closes nothing else.
            event.preventDefault();
            clearSelection();
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [selecting]);

    const toggleGroup = (key) => {
        const next = new Set(closed);

        if (isClosed(key)) {
            next.delete(key);
            next.add(`!${key}`);
        } else {
            next.add(key);
            next.delete(`!${key}`);
        }

        localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
        setClosed(next);
    };

    // Priority. A row's Review opens its call (one at a time).
    const review = (id) => setAsking((now) => (now === id ? null : id));

    // Allow or deny a call from its row. The next call opens by itself with the focus on its Review (the same
    // session's, when more wait there); the answered row glows in the group it goes to. An answer cannot be undone.
    const answer = async (id, askId, allow) => {
        const ask = store.state.sessions.find((each) => each.id === id)?.approval;

        // The row answers the call it showed, never another: one answered elsewhere meanwhile is not answered for it.
        if (ask?.id !== askId) {
            notify(
                "info",
                "That call was answered elsewhere. Look at the next one before you answer it.",
            );

            return;
        }

        if (answered.has(ask.id)) {
            return;
        }

        const next = ask.count > 1 ? id : (askOrder.current.find((each) => each !== id) ?? null);

        const settle = (change) =>
            setAnswered((now) => {
                const copy = new Set(now);

                change(copy);

                return copy;
            });

        settle((copy) => copy.add(ask.id));

        if ((await attempt(() => actions.approve(ask.id, allow))) === undefined) {
            settle((copy) => copy.delete(ask.id));

            return;
        }

        notify("info", `${allow ? "Allowed" : "Denied"}: ${truncate(ask.subject, 60)}`);
        setMoved(id);
        setTimeout(() => setMoved((now) => (now === id ? null : now)), 2500);
        setAsking(next);
        setFocusReview(next ?? "list");
    };

    // The focus follows an answer: onto the next Review, or the list when none is left.
    useEffect(() => {
        if (focusReview === null) {
            return undefined;
        }

        const box = list.current;
        const target =
            focusReview === "list"
                ? box?.querySelector("button.session")
                : box?.querySelector(`[data-review="${focusReview}"]`);

        if (target) {
            target.focus();
            setFocusReview(null);

            return undefined;
        }

        // Not drawn yet (the list has not heard of the answer): each new list looks again, and after a while the list
        // takes the focus (its first row, or the list itself when no row shows), so it never stays on a button that
        // went away.
        const timer = setTimeout(() => {
            (box?.querySelector("button.session") ?? box)?.focus();
            setFocusReview(null);
        }, FOCUS_WAIT_MS);

        return () => clearTimeout(timer);
    }, [focusReview, sessions]);

    // Answers the list has heard of are forgotten, and so is a call open in a row that no longer asks.
    useEffect(() => {
        const pending = new Set(sessions.map((session) => session.approval?.id).filter(Boolean));

        setAnswered((now) =>
            [...now].every((id) => pending.has(id))
                ? now
                : new Set([...now].filter((id) => pending.has(id))),
        );

        if (
            asking !== null &&
            !sessions.some((session) => session.id === asking && session.approval)
        ) {
            setAsking(null);
        }
    }, [sessions]);

    const dismissOne = (id) => {
        const session = sessions.find((each) => each.id === id);

        if (session) {
            dismissFailures([session]);
        }
    };

    const readOne = (id) => {
        const session = sessions.find((each) => each.id === id);

        if (session) {
            markRead([session], { say: false });
        }
    };

    // Under the "others" rule, a call this person's own message led to is someone else's to allow; one nobody is known
    // to have asked for is the owner's (`cannotAllow` on the server).
    const ownCall = (session) =>
        session.approval !== undefined &&
        server?.approvalRule === "others" &&
        store.state.me?.role !== "owner" &&
        (session.approval.requestedBy === undefined ||
            session.approval.requestedBy === store.state.me?.id);

    // How many sessions need you: Priority's tab says. The tab's width changes with that count, and the marker under
    // the chosen tab is measured again as each draw lays it out.
    const needCount = needsYouCount(sessions);
    const tabBar = useSlide(tabs, "button.on", "x");
    const count = sessions.filter(
        (session) => !session.archived && session.bot === undefined,
    ).length;
    let index = 0;
    const tabsHead = guest ? null : html`<${PaneTabs} pane=${pane} onPane=${setPane} />`;

    return html`<div
        class=${`sessions ${compact ? "compact" : ""} pane-${pane}`}
        data-part="session-list"
    >
        <div class="sidebar-head" data-part="sidebar-head">
            ${tabsHead}
        </div>
        ${pane === "bots" && html`<${BotList} compact=${compact} canStart=${canStart} />`}
        ${
            pane === "sessions" &&
            html`<${SectionHead}
            name="Sessions"
            count=${sessionsLoaded ? count : ""}
            part="session-list-title"
            add="New session (Alt+N)"
            onAdd=${canStart && (() => openSheet({ type: "cwd", mode: "new" }))}
        />
        <label class=${`search ${query ? "filled" : ""}`} data-part="session-search">
            <${Icon} name="search" size=${14} />
            <input
                placeholder="Search sessions"
                aria-label="Search sessions"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
                onKeyDown=${(event) => {
                    if (event.key !== "Escape" || query === "") {
                        return;
                    }

                    // Taken: this Esc clears the search, not the selection.
                    event.preventDefault();
                    setQuery("");
                }}
            />
            ${
                query
                    ? html`<button
                        class="search-clear"
                        aria-label="Clear"
                        onClick=${() => setQuery("")}
                    >
                        <${Icon} name="close" size=${13} />
                    </button>`
                    : html`<span
                            class="search-keys"
                            title="Launcher"
                            aria-hidden="true"
                            onClick=${(event) => {
                                event.preventDefault();
                                store.set({ launcher: true, drawer: false });
                            }}
                        >
                            ${APPLE ? "⌘K" : "Ctrl K"}
                        </span>
                        <button
                            class="search-launcher"
                            title="Launcher"
                            aria-label="Open the launcher"
                            onClick=${(event) => {
                                event.preventDefault();
                                store.set({ launcher: true, drawer: false });
                            }}
                        >
                            <${Icon} name="command" size=${14} />
                        </button>`
            }
        </label>
        <div class="session-tabs" data-part="session-tabs" role="tablist" ref=${tabs}>
            ${TABS.map(
                ([key, label]) => html`<button
                    key=${key}
                    role="tab"
                    data-part="session-tab"
                    data-tab=${key}
                    aria-selected=${tab === key}
                    aria-label=${
                        key === "archived"
                            ? "Archived"
                            : key === "priority" && needCount > 0
                              ? `Priority, ${needCount} ${needCount === 1 ? "needs" : "need"} you`
                              : undefined
                    }
                    title=${key === "archived" ? "Archived" : undefined}
                    class=${tab === key ? "on" : ""}
                    onClick=${() => setTab(key)}
                >
                    ${key === "archived" ? html`<${Icon} name="archive" size=${14} />` : label}
                    ${
                        key === "priority" &&
                        needCount > 0 &&
                        html`<span
                            class="tab-count"
                            data-part="session-tab-count"
                            aria-hidden="true"
                        >
                            ${needCount}
                        </span>`
                    }
                </button>`,
            )}
            <${Slide} box=${tabBar} axis="x" />
        </div>
        <div
            class="session-items"
            ref=${list}
            tabindex="-1"
            onScroll=${(event) => !compact && (listKept.scroll = event.currentTarget.scrollTop)}
        >
            ${!sessionsLoaded && html`<${LoadingSessions} />`}
            ${
                sessionsLoaded &&
                shown.length === 0 &&
                html`<div class="sessions-empty">
                    ${archived ? "No archived sessions." : needle ? "No matches." : "No sessions yet. Start one with New."}
                </div>`
            }
            ${
                sessionsLoaded &&
                priority &&
                shown.length > 0 &&
                !groups.some((group) => group.slot === "needs") &&
                html`<div class="priority-clear" data-part="session-clear">
                    <${Icon} name="check" size=${13} />
                    <span>Nothing needs you</span>
                </div>`
            }
            ${groups.map((group) => {
                const folding = isClosed(group.key);
                // Needs you does not fold, and its head is no button: what waits there must show. A search's flat list
                // keeps its head a button, as before, that folds nothing.
                const still = group.slot === "needs";
                const foldable = group.key !== "flat" && !still;
                const toggle = still ? undefined : () => foldable && toggleGroup(group.key);
                const rows = visibleRows(group, asking, allNeeds);
                // Priority's head buttons: dismiss what failed, mark what finished read. Only the failures this person
                // can deal with: a viewer cannot dismiss a failed subagent.
                const failedRows = still
                    ? group.rows.filter((row) => dismissable(row.session))
                    : [];
                const action =
                    still && failedRows.length > 1
                        ? {
                              label: `Dismiss ${failedRows.length} failed`,
                              run: () => dismissFailures(failedRows.map((row) => row.session)),
                          }
                        : group.slot === "ready"
                          ? {
                                label: "Mark all read",
                                run: () => markRead(group.rows.map((row) => row.session)),
                            }
                          : undefined;
                // A folded group hides its rows' marks: say when one waits for you or its run failed.
                const trouble = folding
                    ? group.hidden
                          .map((row) => sessionMark(row.session).shape)
                          .find((shape) => shape === "waiting" || shape === "failed")
                    : undefined;
                // What waits or failed under each folded row.
                const troubles =
                    !folding && needle === "" && folded.size > 0
                        ? hiddenTroubles(group)
                        : undefined;

                const head =
                    group.key !== "flat" || needle
                        ? html`<${still ? "div" : "button"}
                              class=${`group-head ${still ? "attn" : ""}`}
                              data-part="session-group-head"
                              onClick=${toggle}
                              aria-expanded=${still ? undefined : !folding}
                          >
                              <span class="group-name" data-part="session-group-name">
                                  ${
                                      typeof group.label === "string"
                                          ? html`<b>${group.label}</b>`
                                          : group.label
                                  }
                              </span>
                              ${
                                  trouble &&
                                  html`<span
                                      class=${`group-trouble ${trouble}`}
                                      role="img"
                                      aria-label=${trouble === "waiting" ? "A session needs you" : "A session failed"}
                                      title=${trouble === "waiting" ? "A session here needs you" : "A session here failed"}
                                  ></span>`
                              }
                              <span class="group-count" data-part="session-group-count">
                                  ${group.total}
                              </span>
                              ${foldable && html`<${Icon} name="down" size=${11} />`}
                          <//>`
                        : null;

                return html`<section
                    class=${`session-group ${folding ? "closed" : ""}`}
                    data-part="session-group"
                    data-group=${group.slot}
                    key=${`${tab}:${group.key}`}
                >
                    ${
                        action
                            ? html`<div class="group-bar" data-part="session-group-bar">
                                  ${head}
                                  <button
                                      class="group-action"
                                      data-part="session-group-action"
                                      onClick=${action.run}
                                  >
                                      ${action.label}
                                  </button>
                              </div>`
                            : head
                    }
                    <div class="group-body" inert=${folding}>
                        <div>
                            ${rows.map(({ session, branches, descendants }) => {
                                // Linked sessions fold under the one that started them; a search shows them all,
                                // with nothing to fold.
                                const kids = needle === "" ? descendants : 0;
                                const isFolded = kids > 0 && folded.has(session.id);

                                return html`<${SessionRow}
                                        key=${session.id}
                                        session=${session}
                                        branches=${branches}
                                        kids=${kids}
                                        folded=${isFolded}
                                        foldHeld=${above.has(session.id)}
                                        foldTrouble=${isFolded ? troubles?.get(session.id) : undefined}
                                        index=${index++}
                                        number=${numbers.get(session.id)}
                                        needle=${needle}
                                        selected=${selected.has(session.id)}
                                        pressing=${pressing === session.id}
                                        folders=${tab === "folders" && needle === ""}
                                        onPick=${pick}
                                        onSelect=${select}
                                        slot=${group.slot}
                                        need=${still ? needOf(session) : null}
                                        expanded=${asking === session.id && still}
                                        answering=${
                                            session.approval !== undefined &&
                                            answered.has(session.approval.id)
                                        }
                                        glow=${moved === session.id && !still}
                                        ownCall=${ownCall(session)}
                                        onReview=${review}
                                        onAnswer=${answer}
                                        onDismiss=${dismissOne}
                                        onRead=${readOne}
                                    />`;
                            })}
                            ${
                                rows.length < group.rows.length &&
                                html`<button
                                    class="more-needs"
                                    data-part="session-more"
                                    onClick=${() => setAllNeeds(true)}
                                >
                                    Show ${group.rows.length - rows.length} more
                                </button>`
                            }
                        </div>
                    </div>
                </section>`;
            })}
        </div>
        `
        }
        ${
            chosen.length > 0 &&
            html`<div class="select-bar" role="group" aria-label="Selected sessions">
                <span class="select-count">
                    <b>${chosen.length}</b>
                    <span class="select-word"> selected</span>
                </span>
                ${
                    canSteer() &&
                    html`<button class="button" onClick=${archiveChosen}>
                        ${archived ? "Unarchive" : "Archive"}
                    </button>`
                }
                ${
                    !archived &&
                    html`<button class="button" onClick=${pinChosen}>
                        ${allPinned ? "Unpin" : "Pin"}
                    </button>`
                }
                <button
                    class="select-clear"
                    title="Clear the selection (Esc)"
                    aria-label="Clear the selection"
                    onClick=${clearSelection}
                >
                    <${Icon} name="close" size=${14} />
                </button>
            </div>`
        }
    </div>`;
}

/** Not drawn again as an answer streams: it reads no conversation's view, and on a phone it stays drawn off-screen. */
export const SessionList = apartFromViews(AllSessions);

/**
 * Subagents across the sessions, by state, as the rail counts them: archived sessions only while a subagent works
 * there, as the subagents board shows them.
 */
export function subagentTotals(sessions = store.state.sessions) {
    const totals = { working: 0, waiting: 0, failed: 0, stopped: 0, done: 0, dealt: 0 };

    for (const session of sessions) {
        const counts = session.subagents;

        if (!counts || (session.archived && !counts.working && !counts.waiting)) {
            continue;
        }

        for (const state of Object.keys(totals)) {
            totals[state] += counts[state] ?? 0;
        }
    }

    return totals;
}

/** Open the subagents board in the conversation's place, or close it. */
export const toggleBoard = () =>
    store.set((state) =>
        state.board
            ? { board: false, boardAgents: null }
            : { board: true, drawer: false, page: null },
    );

/**
 * noid: what waits for you or failed among the sessions folded away, by the shown session they are folded under: the
 * rail leaves them out, as the list does, and its tile says so with a dot.
 */
function railTroubles(sessions, order) {
    if (foldsNow().size === 0) {
        return new Map();
    }

    return foldedUnder(
        sessions.filter((session) => !session.archived),
        new Set(order.map((session) => session.id)),
        (session) => {
            const shape = sessionMark(session).shape;

            return shape === "waiting" || shape === "failed" ? shape : undefined;
        },
        // One that needs you is told before one that failed.
        "waiting",
    );
}

/**
 * The folded sidebar's sessions: noid: the bots first, by their faces, as Grok's folded sidebar keeps them; then the
 * other sessions, numbered like Waybar's workspaces (their Alt+1…9 places, which count the bots too).
 */
function RailTiles() {
    const { sessions, conversationId } = store.state;
    const items = useRef(null);
    const order = workspaceOrder();
    const troubles = railTroubles(sessions, order);
    const bots = botSessions(sessions);
    const indicator = useSlide(items, ".ws.active");
    const unread = (session) =>
        ((collab() && sessionUnread(session)) || isUnread(session.id)) &&
        session.id !== conversationId;

    return html`<div class="rail-items" ref=${items}>
        <${Slide} box=${indicator} />
        ${bots.map(
            (session, index) => html`<button
                key=${session.id}
                class=${`ws ws-bot ${session.id === conversationId ? "active" : ""}`}
                data-part="rail-bot"
                data-state=${botFaceState(session)}
                style=${`--i:${index}`}
                title=${botDoing(session) ? `${session.bot.name}: ${botDoing(session)}` : session.bot.name}
                aria-label=${`${session.bot.name}${botDoing(session) ? `, ${botDoing(session)}` : ""}`}
                aria-current=${session.id === conversationId ? "page" : undefined}
                onClick=${() => navigate(session.id)}
            >
                <${Face}
                    id=${session.bot.id}
                    color=${session.bot.color}
                    skin=${session.bot.skin}
                    eyes=${session.bot.eyes}
                    shape=${session.bot.shape}
                    state=${botFaceState(session)}
                    size=${RAIL_FACE}
                    label=${session.bot.name}
                />
                ${unread(session) && html`<span class="unread-dot"></span>`}
            </button>`,
        )}
        ${
            bots.length > 0 &&
            order.some((session) => session.bot === undefined) &&
            html`<span class="ws-rule" aria-hidden="true"></span>`
        }
        ${order.map(
            (session, index) =>
                session.bot === undefined &&
                html`<button
                key=${session.id}
                class=${`ws ${session.id === conversationId ? "active" : ""} ${session.busy ? "busy" : ""} ${session.waiting ? "waiting" : ""}`}
                style=${`--i:${index}`}
                title=${`${session.title ?? "New session"}${index < 9 ? ` (Alt+${index + 1})` : ""}`}
                aria-label=${`${session.title ?? "New session"}${session.waiting ? ", needs you" : session.busy ? ", working" : ""}${
                    troubles.get(session.id) === "waiting"
                        ? ", one folded under it needs you"
                        : troubles.get(session.id) === "failed"
                          ? ", one folded under it failed"
                          : ""
                }`}
                aria-current=${session.id === conversationId ? "page" : undefined}
                onClick=${() => navigate(session.id)}
            >
                ${index < 9 ? index + 1 : initials(session.title ?? "New session")}
                ${unread(session) && html`<span class="unread-dot"></span>`}
                ${troubles.has(session.id) && html`<span class="rail-trouble" aria-hidden="true"></span>`}
            </button>`,
        )}
    </div>`;
}

/**
 * The rail beside the session list: the mark (home), the sessions (which fold the sidebar), then the subagents board,
 * extensions' buttons, the theme, and you. Folded, it holds the sessions too, numbered. In the drawer and on a phone's
 * home screen it does not fold, and the mark is a mark. noid: no more than that; running now, people, and providers are
 * in the launcher, peek tiles in the top bar, and Noid heads the bot list.
 */
function Rail({ foldable = false, folded = false }) {
    const { sessions, board, me } = store.state;
    const canStart = canSteer() && !scoped();
    const agents = subagentTotals(sessions);
    const live = agents.working + agents.waiting;
    const failed = failing(agents);
    // The Sessions button counts the sessions that need you, as Priority's tab does.
    const needs = needsYouCount(sessions);
    const sessionsLabel =
        needs > 0 ? `Sessions, ${needs} ${needs === 1 ? "needs" : "need"} you` : "Sessions";
    const needsBadge =
        needs > 0 && html`<span class="rail-count attn" data-part="rail-needs">${needs}</span>`;
    const keys = APPLE ? "⌘B" : "Ctrl+B";
    const fold = () => setPrefs({ sidebar: folded ? "open" : "rail" });
    const role = me?.role === "owner" ? "owner" : me?.role === "viewer" ? "view only" : "guest";

    return html`<nav class="rail" data-part="rail" aria-label="Sessions and tools">
        ${
            foldable
                ? html`<button
                    class="rail-brand"
                    title="Home"
                    aria-label="Home"
                    onClick=${toSessions}
                >
                    <${NoidMark} size=${20} />
                </button>`
                : html`<span class="rail-brand" aria-hidden="true"><${NoidMark} size=${20} /></span>`
        }
        <span class="rail-gap"></span>
        ${
            foldable
                ? html`<button
                    class=${`rail-button ${folded ? "" : "on"}`}
                    data-part="rail-button"
                    data-state=${railState(!folded)}
                    title=${`Sessions (${keys} ${folded ? "unfolds" : "folds"} the list)`}
                    aria-label=${sessionsLabel}
                    aria-expanded=${!folded}
                    onClick=${fold}
                >
                    <${Icon} name="chat" size=${19} />
                    ${needsBadge}
                </button>`
                : html`<span
                    class="rail-button on"
                    data-part="rail-button"
                    data-state="open"
                    title="Sessions"
                    aria-label=${sessionsLabel}
                    aria-current="page"
                >
                    <${Icon} name="chat" size=${19} />
                    ${needsBadge}
                </span>`
        }
        ${!folded && html`<span class="rail-fill"></span>`}
        ${
            folded &&
            canStart &&
            html`<button
                class="rail-button rail-new"
                data-part="rail-button"
                title="New session (Alt+N)"
                aria-label="New session"
                onClick=${() => openSheet({ type: "cwd", mode: "new" })}
            >
                <${Icon} name="plus" size=${19} />
            </button>`
        }
        ${folded && html`<${RailTiles} />`}
        <button
            class=${`rail-button rail-agents ${live > 0 ? "lit" : ""} ${board ? "open" : ""}`}
            data-part="rail-button"
            data-state=${railState(board, live > 0)}
            title="Subagents in every session"
            aria-label=${[
                "Subagents",
                live > 0 && `${live} at work`,
                agents.waiting > 0 && `${agents.waiting} waiting for approval`,
                failed > 0 && `${failed} failed`,
            ]
                .filter(Boolean)
                .join(", ")}
            aria-pressed=${board}
            onClick=${toggleBoard}
        >
            <${Icon} name="fork" size=${19} />
            ${live > 0 && html`<span class="rail-count">${live}</span>`}
            ${
                (failed > 0 || agents.waiting > 0) &&
                html`<span class="rail-trouble" aria-hidden="true"></span>`
            }
        </button>
        ${me?.role === "owner" && html`<${ComputerRailButtons} />`}
        <${ExtensionRailButtons} />
        <button
            class="rail-button rail-me"
            data-part="rail-button"
            title=${`${me?.name ?? ""} · ${role}`}
            aria-label="You and settings"
            aria-haspopup="menu"
            aria-expanded=${store.state.sheet?.type === "account"}
            onClick=${() => openSheet({ type: "account" })}
        >
            ${me && html`<${Avatar} person=${me} size=${RAIL_FACE / FACE_SCALE} />`}
        </button>
    </nav>`;
}

/** Not drawn again as an answer streams: it reads no conversation's view. */
export const RailNav = apartFromViews(Rail);

/**
 * noid: the owner's tools, on the rail as rakazo keeps its agent computer by hand: group threads, and the shared
 * computer's terminal and desktop, each a page in the conversation's place, lit while it is open.
 */
function ComputerRailButtons() {
    // The view is read at the click, not as the rail draws: the rail is not drawn again as an answer streams.
    const { tool } = store.state;
    const buttons = [
        {
            id: "groups",
            icon: "chats",
            label: "Group threads",
            title: "Group threads: you and several bots",
            open: tool?.kind === "groups",
            run: () => (tool?.kind === "groups" ? closeTool() : openTool("groups")),
        },
        {
            id: "terminal",
            icon: "terminal",
            label: "Terminal",
            title: "Terminal on the shared computer",
            open: tool?.kind === "terminal",
            run: () =>
                tool?.kind === "terminal"
                    ? closeTool()
                    : openTool("terminal", { cwd: store.state.view?.agent?.cwd }),
        },
        {
            id: "desktop",
            icon: "monitor",
            label: "Desktop",
            title: "The shared computer's desktop",
            open: tool?.kind === "desktop",
            run: () => (tool?.kind === "desktop" ? closeTool() : openTool("desktop")),
        },
    ];

    return buttons.map(
        (each) => html`<button
            key=${each.id}
            class=${`rail-button ${each.open ? "open" : ""}`}
            data-part="rail-button"
            data-rail=${each.id}
            title=${each.title}
            aria-label=${each.label}
            aria-pressed=${each.open ? "true" : "false"}
            onClick=${each.run}
        >
            <${Icon} name=${each.icon} size=${19} />
        </button>`,
    );
}

/**
 * Drag the sidebar's edge to resize it, or step it with the arrow keys; a double click puts back its usual width. No
 * wider than the stylesheet lets it be: 40% of the screen.
 */
export function ResizeHandle() {
    const ref = useRef(null);
    // A theme may put the sidebar on the right: the handle goes to its other edge, and drags the other way.
    const side = useSide(ref, (handle) => handle.parentElement);

    return html`<span class="splitter-host" ref=${ref} hidden></span>
        <${Splitter}
            edge=${side === "right" ? "left" : "right"}
            label="Resize the sidebar"
            variable="--sidebar-w"
            min=${SIDEBAR_MIN}
            max=${() => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_WIDTH, innerWidth * 0.4))}
            commit=${(width) => setPrefs({ sidebarWidth: width })}
            reset=${() => setPrefs({ sidebarWidth: SIDEBAR_WIDTH })}
        />`;
}

/** The rail and the session list, sliding in from the left on narrow screens. */
export function Drawer() {
    const [open, leaving] = usePresence(store.state.drawer || null, 200);
    const ref = useRef(null);
    const close = () => store.set({ drawer: false });
    // A theme may slide it in from the right: it is dragged back that way.
    const side = useSide(ref);

    useBack(store.state.drawer === true, close);
    // Not under a row's actions, which a long press opens over it: the finger that opened them may still move.
    useDragToClose(ref, {
        dir: side,
        onClose: close,
        enabled: Boolean(open) && !leaving && !store.state.sheet,
    });
    // Esc closes it, as it does a sheet; one over it closes first.
    useEffect(() => {
        if (!open || leaving) {
            return undefined;
        }

        const onKey = (event) => {
            if (
                event.key === "Escape" &&
                !event.defaultPrevented &&
                !store.state.sheet &&
                !store.state.launcher
            ) {
                event.preventDefault();
                close();
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [open, leaving]);

    if (!open) {
        return null;
    }

    return html`<div class=${leaving ? "leaving" : ""} inert=${leaving}>
        <div
            class="overlay drawer-overlay"
            data-part="scrim"
            data-for="drawer"
            onMouseDown=${scrimPress(close)}
        >
            <aside
                class="drawer"
                data-part="drawer"
                data-state=${leaving ? "closing" : undefined}
                ref=${ref}
            >
                <${RailNav} />
                <${SessionList} compact=${true} />
            </aside>
        </div>
    </div>`;
}
