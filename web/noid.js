// noid: Noid, the main bot, which looks after the other sessions with its session tools. Alt+A goes to it; webhooks and
// repository watches to Noid reach it.
import { api, attempt, navigate, notify, store, uid } from "./store.js";

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
// `pip`: the server's name for it, which older tabs know.
export const noidWatches = () => store.state.server?.pip === true;

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
