// noid: group threads, the owner and several bots in one room. The list of groups, a new one, and a thread: what was
// said, refreshed while it is open, and a message to the bots in it (all of them, or those named with @).
import { useEffect, useRef, useState } from "preact/hooks";
import { Face } from "../faces/face.js";
import { usePoll } from "../poll.js";
import { api, attempt, closeSheet, store } from "../store.js";
import { formatWhen, html, Sheet } from "../ui.js";

const EVERY_MS = 2000;

/** The bots, live and not archived, by id. */
function botsById() {
    return new Map(
        store.state.sessions
            .filter((session) => session.bot !== undefined && !session.archived)
            .map((session) => [session.bot.id, session.bot]),
    );
}

function NewGroup({ onMade }) {
    const bots = [...botsById().values()];
    const [name, setName] = useState("");
    const [members, setMembers] = useState([]);
    const flip = (id) =>
        setMembers(members.includes(id) ? members.filter((each) => each !== id) : [...members, id]);
    const make = () =>
        attempt(async () => {
            onMade(await api("groups", { name, members }));
        });

    return html`<div class="group-new">
        <input
            placeholder="Group name, such as Launch"
            value=${name}
            onInput=${(event) => setName(event.currentTarget.value)}
        />
        <div class="group-members">
            ${bots.map(
                (bot) => html`<label class="group-member" key=${bot.id}>
                    <input
                        type="checkbox"
                        checked=${members.includes(bot.id)}
                        onChange=${() => flip(bot.id)}
                    />
                    ${bot.name}
                </label>`,
            )}
        </div>
        <button
            class="button primary"
            disabled=${name.trim() === "" || members.length < 2}
            onClick=${make}
        >
            Make the group
        </button>
        <p class="muted small">Pick two bots or more. They answer in this order.</p>
    </div>`;
}

/** Messages by id, in order: what a refresh brought, with any just sent that it did not have yet. */
function merged(found, now) {
    const ids = new Set(found.messages.map((message) => message.id));
    const extra = (now?.messages ?? []).filter(
        (message) => !ids.has(message.id) && message.at >= (found.messages.at(-1)?.at ?? 0),
    );

    return { ...found, messages: [...found.messages, ...extra] };
}

function Thread({ id, onBack }) {
    const [group, setGroup] = useState(undefined);
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    // One key per draft: a send retried after a lost answer finds the message, rather than post it again.
    const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());
    const list = useRef(null);
    const bots = botsById();

    usePoll(
        async (gone) => {
            try {
                const found = await api(`groups/${encodeURIComponent(id)}`);

                if (!gone()) {
                    setGroup((now) => merged(found, now));
                }
            } catch (failure) {
                // Deleted (in another tab, say): back to the list. Anything else is tried again in a moment.
                if (failure.status === 404 || failure.status === 403) {
                    onBack();

                    return false;
                }

                throw failure;
            }

            return true;
        },
        { every: EVERY_MS },
        [id],
    );

    // New answers come in below: keep them in view.
    const count = group?.messages.length ?? 0;

    useEffect(() => {
        list.current?.scrollTo({ top: list.current.scrollHeight });
    }, [count]);

    // One at a time, with a key: a retry of the same send posts it once.
    const send = () => {
        if (sending || text.trim() === "") {
            return;
        }

        const requestId = draftKey;

        setSending(true);
        void attempt(async () => {
            const message = await api(`groups/${encodeURIComponent(id)}/messages`, {
                text,
                requestId,
            });

            setText("");
            setDraftKey(crypto.randomUUID());
            setGroup((now) =>
                now && !now.messages.some((each) => each.id === message.id)
                    ? { ...now, messages: [...now.messages, message], answering: true }
                    : now,
            );
        }).finally(() => setSending(false));
    };

    const stop = () => attempt(() => api(`groups/${encodeURIComponent(id)}/stop`, {}));
    const remove = () =>
        attempt(async () => {
            await api(`groups/${encodeURIComponent(id)}/delete`, {});
            onBack();
        });

    if (group === undefined) {
        return html`<p class="muted small" role="status">Loading…</p>`;
    }

    const names = group.members.map((member) => bots.get(member)?.name ?? "a bot gone");

    return html`<div class="group-thread">
        <div class="row">
            <button class="button ghost small" onClick=${onBack}>All groups</button>
            <span class="grow muted small">${names.join(", ")}</span>
            <button class="button ghost small" onClick=${remove}>Delete</button>
        </div>
        <div class="group-messages" ref=${list}>
            ${
                group.messages.length === 0 &&
                html`<p class="muted small">
                Write to the group: each bot answers in turn, after reading what the others said.
            </p>`
            }
            ${group.messages.map((message) => {
                const bot = bots.get(message.from);

                return html`<div
                    class=${`group-message ${message.from === "owner" ? "mine" : ""} ${message.failed ? "failed" : ""}`}
                    key=${message.id}
                >
                    ${
                        bot &&
                        html`<${Face}
                        id=${bot.id}
                        color=${bot.color}
                        skin=${bot.skin}
                        eyes=${bot.eyes}
                        size=${24}
                        label=${bot.name}
                    />`
                    }
                    <div class="grow">
                        <div class="muted small">${message.name} · ${formatWhen(message.at)}</div>
                        <div class="group-text">${message.text}</div>
                    </div>
                </div>`;
            })}
        </div>
        <div class="row">
            <input
                placeholder="Write to the group; @Name for one bot"
                value=${text}
                onInput=${(event) => setText(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && !event.isComposing && send()}
            />
            <button
                class="button primary"
                disabled=${sending || text.trim() === ""}
                onClick=${send}
            >
                Send
            </button>
        </div>
        ${
            group.answering &&
            html`<div class="row">
                <span class="grow muted small">The bots are answering…</span>
                <button class="button ghost small" onClick=${stop}>Stop</button>
            </div>`
        }
    </div>`;
}

/** Group threads: the list, a new one, or one open. */
export function GroupsSheet() {
    const [groups, setGroups] = useState(undefined);
    const [open, setOpen] = useState(undefined);
    const [making, setMaking] = useState(false);
    const load = () =>
        api("groups")
            .then((found) => setGroups(found.groups))
            .catch(() => setGroups([]));

    useEffect(() => {
        void load();
    }, [open, making]);

    const body =
        open !== undefined
            ? html`<${Thread} id=${open} onBack=${() => setOpen(undefined)} />`
            : making
              ? html`<${NewGroup}
                    onMade=${(group) => {
                        setMaking(false);
                        setOpen(group.id);
                    }}
                />`
              : html`<div class="sheet-list">
                    ${(groups ?? []).map(
                        (group) => html`<button
                            class="group-row"
                            key=${group.id}
                            onClick=${() => setOpen(group.id)}
                        >
                            <div class="grow">
                                <div>${group.name}</div>
                                <div class="muted small">
                                    ${
                                        group.last
                                            ? `${group.last.name}: ${group.last.text.slice(0, 80)}`
                                            : "Nothing said yet"
                                    }
                                </div>
                            </div>
                        </button>`,
                    )}
                    ${
                        groups?.length === 0 &&
                        html`<p class="muted small">
                        No groups yet. A group is you and several bots in one room.
                    </p>`
                    }
                    <button class="button" onClick=${() => setMaking(true)}>New group</button>
                </div>`;

    return html`<${Sheet} title="Group threads" onClose=${closeSheet} wide>${body}<//>`;
}
