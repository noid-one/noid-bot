// noid: Noid, the main bot, which looks after the other sessions with its session tools. Alt+A goes to it; webhooks and
// repository watches to Noid reach it.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, navigate, notify, store, uid } from "./store.js";
import { html } from "./ui.js";

/** Noid's session, when there is one. */
export const mainBot = () =>
    store.state.sessions.find((session) => session.bot?.main === true && !session.archived);

/** Go to Noid's conversation. */
export function toNoid() {
    const noid = mainBot();

    if (noid !== undefined && store.state.conversationId !== noid.id) {
        navigate(noid.id);
    }
}

/** Whether webhooks and watches can go to Noid: the server has the session tools on. */
export const noidWatches = () => store.state.server?.sessionTools === true;

/** Send Noid a message from anywhere (`/noid …`), then go there to see what it says. */
export async function askNoid(text) {
    const noid = mainBot();

    if (noid === undefined) {
        notify("error", "There is no Noid here.");

        return;
    }

    await attempt(() => api(`c/${noid.id}/submit`, { text, requestId: uid() }));
    toNoid();
}

/** A bot's changes, one request for all its cards: kept a little, and dropped once one is undone here. */
const changesOf = new Map();
const CHANGES_KEPT_MS = 30_000;

function botChanges(id) {
    if (!changesOf.has(id)) {
        changesOf.set(id, api(`bots/${id}/changes`).then(({ changes }) => changes));
        setTimeout(() => changesOf.delete(id), CHANGES_KEPT_MS);
    }

    return changesOf.get(id);
}

/**
 * Under a bot's `bot_settings` call that changed something: what changed and, for the owner, Undo, which puts back what
 * it replaced. Whether it was undone comes from the server, so a reload shows the same.
 */
export function BotChangeCall({ change, summary, conversationId }) {
    const id = conversationId ?? store.state.conversationId;
    const owner = store.state.me?.role === "owner";
    const [undone, setUndone] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!owner) {
            return;
        }

        botChanges(id)
            .then((changes) => setUndone(changes.some((each) => each.id === change && each.undone)))
            .catch(() => changesOf.delete(id));
    }, [id, change, owner]);

    const undo = () => {
        setBusy(true);
        attempt(async () => {
            await api(`bots/${id}/changes/${encodeURIComponent(change)}/undo`, {});
            changesOf.delete(id);
            setUndone(true);
            notify("info", "Undone: the bot's settings are as they were.");
        }).finally(() => setBusy(false));
    };

    return html`<div class="lesson-call bot-change">
        <span>${summary}${undone ? " · undone" : ""}</span>
        ${
            owner &&
            !undone &&
            html`<button class="button small ghost" disabled=${busy} onClick=${undo}>Undo</button>`
        }
    </div>`;
}
