// noid: Noid, the main bot. It does what Pi Pocket's PiP did, in its own conversation (`Pip.idOf` on the server): there
// is no PiP panel. Alt+A goes to it; webhooks and repository watches that the server sends "to PiP" reach it.
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

/** Whether Noid takes PiP's work here: the server has PiP's extension on, which gives Noid its tools. */
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
