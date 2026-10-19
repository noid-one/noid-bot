// noid: group threads, the owner and several bots in one room, as a page in the conversation's place: the groups down
// the left, as a chat app lists its chats, and the one open beside them (what was said, refreshed while it is open,
// and a message to the bots in it, all of them or those named with @). On a phone, the list, then a thread.
import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar } from "../avatar.js";
import { Face } from "../faces/face.js";
import { usePoll } from "../poll.js";
import { api, attempt, openSheet, store } from "../store.js";
import { ToolFrame } from "../tool-page.js";
import { BOTTOM_SHEETS, formatWhen, html, Icon } from "../ui.js";

const EVERY_MS = 2000;

/** The bots, live and not archived, by id. */
function botsById() {
    return new Map(
        store.state.sessions
            .filter((session) => session.bot !== undefined && !session.archived)
            .map((session) => [session.bot.id, session.bot]),
    );
}

function NewGroup({ onMade, onCancel }) {
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
        <h3>New group</h3>
        <label class="field">
            <span class="label">Name</span>
            <input
                autofocus
                placeholder="Launch, Research, Trip…"
                value=${name}
                onInput=${(event) => setName(event.currentTarget.value)}
            />
        </label>
        <div class="field">
            <span class="label">Bots, two or more: they answer in the order picked</span>
            <div class="group-picks">
                ${bots.map((bot) => {
                    const at = members.indexOf(bot.id);

                    return html`<button
                        type="button"
                        class=${`group-pick ${at >= 0 ? "on" : ""}`}
                        key=${bot.id}
                        aria-pressed=${at >= 0 ? "true" : "false"}
                        onClick=${() => flip(bot.id)}
                    >
                        <${Face}
                            id=${bot.id}
                            color=${bot.color}
                            skin=${bot.skin}
                            eyes=${bot.eyes}
                            size=${36}
                            label=${bot.name}
                        />
                        <span>${bot.name}</span>
                        ${at >= 0 && html`<span class="group-pick-order">${at + 1}</span>`}
                    </button>`;
                })}
            </div>
            ${
                bots.length < 2 &&
                html`<p class="muted small">A group needs two bots or more: make another first.</p>`
            }
        </div>
        <div class="row">
            <button class="button ghost" onClick=${onCancel}>Cancel</button>
            <button
                class="button primary"
                disabled=${name.trim() === "" || members.length < 2}
                onClick=${make}
            >
                Make the group
            </button>
        </div>
    </div>`;
}

/** A group's bots as a small stack of faces. */
function Faces({ members, bots, size = 22 }) {
    return html`<span class="group-faces">
        ${members.slice(0, 3).map((id) => {
            const bot = bots.get(id);

            return bot
                ? html`<${Face}
                      key=${id}
                      id=${bot.id}
                      color=${bot.color}
                      skin=${bot.skin}
                      eyes=${bot.eyes}
                      size=${size}
                      label=${bot.name}
                  />`
                : null;
        })}
    </span>`;
}

/** Messages by id, in order: what a refresh brought, with any just sent that it did not have yet. */
function merged(found, now) {
    const ids = new Set(found.messages.map((message) => message.id));
    const extra = (now?.messages ?? []).filter(
        (message) => !ids.has(message.id) && message.at >= (found.messages.at(-1)?.at ?? 0),
    );

    return { ...found, messages: [...found.messages, ...extra] };
}

function Thread({ id, onBack, onSaid }) {
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
        // The list beside it shows each group's last line: it reads them again.
        onSaid?.();
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
        return html`<p class="group-empty muted small" role="status">Loading…</p>`;
    }

    const names = group.members.map((member) => bots.get(member)?.name ?? "a bot gone");
    const me = store.state.me;

    return html`<div class="group-thread">
        <header class="group-thread-head">
            ${
                BOTTOM_SHEETS.matches &&
                html`<button class="icon-button" aria-label="All groups" onClick=${onBack}>
                    <${Icon} name="back" size=${18} />
                </button>`
            }
            <${Faces} members=${group.members} bots=${bots} size=${26} />
            <div class="grow group-thread-title">
                <strong>${group.name}</strong>
                <span class="muted small">${names.join(", ")}</span>
            </div>
            ${
                group.answering &&
                html`<button class="button ghost small" onClick=${stop}>Stop</button>`
            }
            <button class="button ghost small danger" onClick=${remove}>Delete</button>
        </header>
        <div class="group-messages" ref=${list}>
            ${
                group.messages.length === 0 &&
                html`<p class="group-empty muted small">
                    Write to the group: each bot answers in turn, after reading what the others said.
                    Name one with @ to ask it alone.
                </p>`
            }
            ${group.messages.map((message) => {
                const bot = bots.get(message.from);
                const mine = message.from === "owner";

                return html`<div
                    class=${`group-message ${mine ? "mine" : ""} ${message.failed ? "failed" : ""}`}
                    key=${message.id}
                >
                    ${
                        bot
                            ? html`<${Face}
                                  id=${bot.id}
                                  color=${bot.color}
                                  skin=${bot.skin}
                                  eyes=${bot.eyes}
                                  size=${28}
                                  label=${bot.name}
                              />`
                            : mine && me
                              ? html`<${Avatar} person=${me} size=${28} />`
                              : null
                    }
                    <div class="group-bubble">
                        <div class="group-meta">${message.name} · ${formatWhen(message.at)}</div>
                        <div class="group-text">${message.text}</div>
                    </div>
                </div>`;
            })}
            ${
                group.answering &&
                html`<p class="group-answering muted small" role="status">The bots are answering…</p>`
            }
        </div>
        <div class="group-compose">
            <input
                placeholder=${`Write to ${group.name}; @Name for one bot`}
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
    </div>`;
}

/** Group threads: the groups, and the one open or a new one beside them. */
export function GroupsPage() {
    const [groups, setGroups] = useState(undefined);
    const [open, setOpen] = useState(undefined);
    const [making, setMaking] = useState(false);
    const bots = botsById();
    const phone = BOTTOM_SHEETS.matches;
    const none = groups?.length === 0;
    const enough = bots.size >= 2;
    const load = () =>
        api("groups")
            .then((found) => setGroups(found.groups))
            .catch(() => setGroups([]));

    useEffect(() => {
        void load();
    }, [open, making]);

    // Wide, the newest group opens at first, so the page is never half empty.
    useEffect(() => {
        if (!phone && open === undefined && !making && groups?.length > 0) {
            setOpen(groups[0].id);
        }
    }, [groups]);

    const main = making
        ? html`<${NewGroup}
              onCancel=${() => setMaking(false)}
              onMade=${(group) => {
                  setMaking(false);
                  setOpen(group.id);
              }}
          />`
        : open !== undefined
          ? html`<${Thread}
                key=${open}
                id=${open}
                onBack=${() => setOpen(undefined)}
                onSaid=${load}
            />`
          : (!phone || none) &&
            html`<div class="group-empty">
                <${Icon} name="chats" size=${28} />
                <strong>You and several bots in one room</strong>
                ${
                    enough
                        ? html`<span>
                              Each bot answers in turn, after reading what the others said.
                          </span>
                          <button class="button primary" onClick=${() => setMaking(true)}>
                              New group
                          </button>`
                        : html`<span>
                              A group needs two bots or more, and you have
                              ${bots.size === 1 ? " one" : " none"}. Make another, then a group.
                          </span>
                          <button class="button primary" onClick=${() => openSheet({ type: "bot" })}>
                              New bot
                          </button>`
                }
            </div>`;
    // No groups yet: the welcome alone, without an empty list beside it.
    const showList = !none && (!phone || (open === undefined && !making));

    return html`<${ToolFrame}
        kind="groups"
        title="Group threads"
        sub="You and several bots in one room"
        actions=${
            enough &&
            html`<button
                class="button ghost small"
                onClick=${() => {
                    setOpen(undefined);
                    setMaking(true);
                }}
            >
                <${Icon} name="plus" size=${14} /> New group
            </button>`
        }
    >
        <div class=${`groups-split ${showList ? "" : "single"}`}>
            ${
                showList &&
                html`<nav class="groups-list" aria-label="Groups">
                    ${(groups ?? []).map(
                        (group) => html`<button
                            class="group-row"
                            key=${group.id}
                            aria-current=${open === group.id ? "true" : undefined}
                            onClick=${() => {
                                setMaking(false);
                                setOpen(group.id);
                            }}
                        >
                            <${Faces} members=${group.members} bots=${bots} />
                            <span class="group-row-text">
                                <span class="group-row-name">${group.name}</span>
                                <span class="group-row-last">
                                    ${group.last ? `${group.last.name}: ${group.last.text}` : "Nothing said yet"}
                                </span>
                            </span>
                        </button>`,
                    )}
                </nav>`
            }
            ${main && html`<div class="groups-main">${main}</div>`}
        </div>
    <//>`;
}
