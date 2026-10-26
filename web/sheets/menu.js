// The menus: the top bar's ⋯ (this conversation), the rail's avatar (you, and Settings), and the phone's places.
import { useLayoutEffect, useRef } from "preact/hooks";
import { Avatar } from "../avatar.js";
import { browserAvailable, setBrowserOpen } from "../browser.js";
import { chatUnread } from "../chat.js";
import { schedulesAvailable, watchAvailable, watchPr } from "../commands.js";
import { useChanges } from "../diff.js";
import { filesAvailable, setFilesOpen } from "../files-panel.js";
import { peeksOn, togglePeeks } from "../peeks.js";
import { fromServer } from "../seen.js";
import { workingRuns } from "../subagent-runs.js";
import { openSubagent } from "../subagents.js";
import {
    actions,
    attempt,
    canSteer,
    canToggleTurns,
    closeSheet,
    collab,
    notify,
    openSettings,
    openSheet,
    openTool,
    scoped,
    signOut,
    store,
} from "../store.js";
import { isPinned, lookLabel, togglePin } from "../theme.js";
import { currentTrust, trustAvailable } from "../trust.js";
import { branchAvailable } from "./branch.js";
import { memoryAvailable, useMemory } from "./memory.js";
import { Face } from "../faces/face.js";
import { botFaceState, setArchived } from "../sessions.js";
import { copyText, html, Icon, item, Keys, modelLabel, Sheet } from "../ui.js";

// Key hints are for people with a keyboard: a touch screen has none.
const touch = matchMedia("(pointer: coarse)").matches;

/**
 * The session's places as big tiles at the top of the menu: Files, Changes, the browser, artifacts, the chat, find,
 * the branch, and peek tiles. The top bar keeps only the buttons with something to say; these are always here, a
 * thumb's width each.
 */
function Places() {
    if (!store.state.view.conversation) {
        return null;
    }

    return filesAvailable() ? html`<${PlacesWithChanges} />` : html`<${PlacesGrid} />`;
}

/** Only people who can open Files request its shared changes data, just as the top bar does. */
function PlacesWithChanges() {
    const { changes } = useChanges();

    return html`<${PlacesGrid} changes=${changes} />`;
}

function PlacesGrid({ changes = null }) {
    const { view, browser, browserOpen, server, filesOpen, filesTab } = store.state;
    // Match the top bar: uncommitted files in a repository, Pi's edits elsewhere, plus any unlisted files.
    const changeCount = changes
        ? changes.files.length + (changes.repo ? 0 : changes.piOnly.length) + (changes.more ?? 0)
        : 0;
    const live = browser?.open && browser.url !== "" && browser.url !== "about:blank";
    const unread = collab() ? chatUnread() : 0;
    const places = [
        filesAvailable() && {
            id: "files",
            icon: "folder",
            label: "Files",
            on: filesOpen && filesTab === "files",
            run: () => setFilesOpen(true, "files"),
        },
        filesAvailable() && {
            id: "changes",
            icon: "diff",
            label: "Changes",
            count: changeCount,
            counted: changeCount === 1 ? "changed file" : "changed files",
            on: filesOpen && filesTab === "changes",
            run: () => setFilesOpen(true, "changes"),
        },
        browserAvailable() && {
            id: "browser",
            icon: "globe",
            label: "Browser",
            on: browserOpen,
            dot: live,
            run: () => {
                setBrowserOpen(true);
                closeSheet();
            },
        },
        {
            id: "artifacts",
            icon: "artifact",
            label: "Artifacts",
            count: view.artifacts.length,
            run: () => openSheet({ type: "artifacts" }),
        },
        collab() && {
            id: "chat",
            icon: "chat",
            label: "Chat",
            count: unread,
            counted: "unread",
            run: () => openSheet({ type: "chat" }),
        },
        { id: "find", icon: "search", label: "Find", run: () => openSheet({ type: "find" }) },
        branchAvailable() && {
            id: "branch",
            icon: "fork",
            label: "Branch",
            run: () => openSheet({ type: "branch" }),
        },
        server?.peeks === true && {
            id: "peeks",
            icon: "tiles",
            label: "Peeks",
            on: peeksOn(),
            run: () => {
                togglePeeks();
                closeSheet();
            },
        },
    ].filter(Boolean);

    return html`<nav class="places" aria-label="Places">
        ${places.map(
            (place) => html`<button
                key=${place.id}
                type="button"
                class=${`place ${place.on ? "on" : ""}`}
                data-place=${place.id}
                aria-label=${place.count > 0 ? `${place.label}, ${place.count} ${place.counted ?? ""}`.trim() : place.dot ? `${place.label}, a page open` : place.label}
                aria-pressed=${place.on === undefined ? undefined : place.on ? "true" : "false"}
                onClick=${place.run}
            >
                <span class="place-icon badge-host">
                    <${Icon} name=${place.icon} size=${20} />
                    ${place.count > 0 && html`<span class="badge">${place.count}</span>`}
                    ${place.dot && html`<span class="browser-dot" aria-hidden="true"></span>`}
                </span>
                <span class="place-label">${place.label}</span>
            </button>`,
        )}
    </nav>`;
}

/**
 * The places alone, in a short sheet that stays near the bottom edge: what the button beside the message box and a
 * swipe up from it open on a phone, a thumb's reach away. The rest of the menu is a row below.
 */
export function PlacesSheet() {
    const conversation = store.state.view.conversation;

    return html`<${Sheet}
        title=${conversation?.title ?? "Open"}
        onClose=${closeSheet}
        className="places-sheet"
    >
        <${Places} />
        ${item("More", instead({ type: "menu" }), "rename, context, export")}
    <//>`;
}

/**
 * Open `sheet` in the menu's place: what a menu row opens is not a step after the menu, so back and Esc from it go to
 * the conversation, not to a menu that was only a way there.
 */
const instead = (sheet) => () => {
    closeSheet();
    openSheet(sheet);
};

/**
 * A small menu by the button that opened it, as rakazo's and pi-web-desktop's: rows of an icon, a label, and maybe a
 * value or keys at the end, in groups between rules. On a phone it is a sheet from the bottom edge. It is a Sheet
 * underneath, for Esc, dragging down, and focus.
 *
 * `anchor` is the selector of the button that opens it. `beside` puts it to that button's right, its bottom at the
 * button's (the rail's avatar); otherwise it hangs below the button, right edges together (the top bar's ⋯). `groups`
 * are lists of rows, `{ id, icon, label, value?, keys?, run?, href?, danger? }`, or a heading, `{ id, heading }`: falsy
 * rows and empty groups are left out.
 */
function PopMenu({ title, anchor, beside = false, width, label, header = null, groups }) {
    const host = useRef(null);

    useLayoutEffect(() => {
        const element = host.current;
        const button = document.querySelector(anchor);
        const active = document.activeElement;
        const opener = active === document.body ? button : active;

        const place = () => {
            const rect = button?.getBoundingClientRect();
            const top = visualViewport?.offsetTop ?? 0;
            const bottom = top + (visualViewport?.height ?? innerHeight);

            if (beside) {
                const edge = Math.min(rect?.bottom ?? bottom - 8, bottom - 8);

                element.style.setProperty("--menu-left", `${(rect?.right ?? 56) + 8}px`);
                element.style.setProperty("--menu-top", "auto");
                element.style.setProperty("--menu-bottom", `${innerHeight - edge}px`);
                element.style.setProperty("--menu-height", `${Math.max(120, edge - top - 8)}px`);
            } else {
                // Opened from the top bar's title, it hangs under the title, left edges together.
                const title = opener?.closest?.(".topbar .title")?.getBoundingClientRect();
                const below = (title?.bottom ?? rect?.bottom ?? 52) + 6;
                const left = Math.max(
                    8,
                    Math.min(
                        title ? title.left : (rect?.right ?? innerWidth - 8) - width,
                        innerWidth - width - 8,
                    ),
                );

                element.style.setProperty("--menu-left", `${left}px`);
                element.style.setProperty("--menu-top", `${below}px`);
                element.style.setProperty("--menu-bottom", "auto");
                element.style.setProperty(
                    "--menu-height",
                    `${Math.max(120, bottom - below - 8)}px`,
                );
            }
        };

        place();
        addEventListener("resize", place);
        visualViewport?.addEventListener("resize", place);

        return () => {
            removeEventListener("resize", place);
            visualViewport?.removeEventListener("resize", place);

            const focused = document.activeElement;
            const back = opener?.isConnected ? opener : button;
            // As sheets.js does: not behind a sheet the menu opened, and not into a text field on a touch screen,
            // where its keyboard would pop up.
            const field = touch && back?.matches("input, textarea, [contenteditable]");

            if (
                !store.state.sheet &&
                !field &&
                (focused === document.body || element.contains(focused)) &&
                back?.isConnected
            ) {
                back.focus({ preventScroll: true });
            }
        };
    }, []);

    // Arrows, Home, and End move between the rows; Tab goes round them and the close button.
    const onKey = (event) => {
        if (
            event.defaultPrevented ||
            event.isComposing ||
            event.keyCode === 229 ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
        ) {
            return;
        }

        const rows = [...host.current.querySelectorAll(".pop-row")];
        const index = rows.indexOf(document.activeElement);
        let target;

        if (event.key === "Tab") {
            const controls = [...rows, ...host.current.querySelectorAll(".sheet-head button")];
            const at = controls.indexOf(document.activeElement);
            const step = event.shiftKey ? -1 : 1;

            target =
                controls[
                    at < 0
                        ? event.shiftKey
                            ? controls.length - 1
                            : 0
                        : (at + step + controls.length) % controls.length
                ];
        } else if (event.key === "Home") {
            target = rows[0];
        } else if (event.key === "End") {
            target = rows.at(-1);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const down = event.key === "ArrowDown";
            const next = index < 0 ? (down ? 0 : rows.length - 1) : index + (down ? 1 : -1);

            target = rows[(next + rows.length) % rows.length];
        }

        if (target) {
            event.preventDefault();
            target.focus();
        }
    };

    const shown = groups.map((group) => group.filter(Boolean)).filter((group) => group.length > 0);

    return html`<div
        class="act-menu-host"
        data-part="menu"
        ref=${host}
        style=${`--menu-width:${width}px`}
        onKeyDown=${onKey}
    >
        <${Sheet} title=${title} onClose=${closeSheet} className=${`act-menu ${beside ? "beside" : ""}`}>
            ${header}
            <div role="menu" aria-label=${label ?? title}>
                ${shown.map(
                    // Keyed by their first row, so a group put in before others leaves their rows (and focus) be.
                    (group, at) => html`<div
                        class="pop-group"
                        role="group"
                        key=${group[0]?.id ?? at}
                        aria-labelledby=${group[0]?.heading ? `pop-${group[0].id}` : undefined}
                    >
                        ${group.map((row) =>
                            row.heading
                                ? html`<div class="pop-heading" id=${`pop-${row.id}`} key=${row.id}>
                                      ${row.heading}
                                  </div>`
                                : html`<${PopRow} key=${row.id} ...${row} />`,
                        )}
                    </div>`,
                )}
            </div>
        <//>
    </div>`;
}

/** noid: a run of working subagents' heading: "3 subagents working · since 14:23" (no time when it is not known). */
function runHeading(run) {
    const count = run.length === 1 ? "1 subagent" : `${run.length} subagents`;

    if (run[0].askedAt === undefined) {
        return `${count} working`;
    }

    const since = new Date(fromServer(run[0].askedAt)).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
    });

    return `${count} working · since ${since}`;
}

/** One row of a menu: a button, or a link when it downloads something. */
function PopRow({ id, icon, label, value, keys, run, href, danger = false }) {
    const parts = html`<${Icon} name=${icon} size=${16} class="pop-icon" />
        <span class="pop-label">${label}</span>
        ${value !== undefined && value !== "" && html`<span class="pop-value">${value}</span>`}
        ${keys && !touch && html`<span class="pop-keys" aria-hidden="true"><${Keys} keys=${keys} /></span>`}`;
    const className = `pop-row ${danger ? "danger" : ""}`;

    return href
        ? html`<a class=${className} role="menuitem" data-row=${id} href=${href} download onClick=${closeSheet}>
              ${parts}
          </a>`
        : html`<button type="button" class=${className} role="menuitem" data-row=${id} onClick=${run}>
              ${parts}
          </button>`;
}

/** The project's trust in a word, once the server said. */
function trustHint() {
    const info = currentTrust();

    if (!info) {
        return "";
    }

    if (info.ask) {
        return "Not decided";
    }

    // No decision, and nothing waiting for one: there is nothing to say.
    if (info.saved === null && info.defaultProjectTrust === "ask") {
        return "";
    }

    return info.trusted ? "Trusted" : "Not trusted";
}

/** Memory at a glance: what waits for the owner's yes, else how many lessons Pi keeps for this conversation. */
function memoryCount(data) {
    if (!data) {
        return "";
    }

    const waiting = data.owner
        ? data.lessons.filter((lesson) => lesson.pending || lesson.proposal).length
        : 0;

    if (waiting > 0) {
        return `${waiting} to approve`;
    }

    const live = data.lessons.filter((lesson) => !lesson.pending).length;

    return live > 0 ? String(live) : "";
}

/** The last folder of a path: enough to say where, in a menu row. */
const folderName = (path) => path?.split("/").filter(Boolean).at(-1) ?? "";

/**
 * The top bar's ⋯: what can be done with this conversation, and nothing else. The app's settings are in Settings
 * (the rail's avatar); the places (Files, Changes, the browser…) are buttons in the top bar, and by the message box on
 * a phone.
 */
export function MenuSheet() {
    const { view, me, sessions, browserOpen, users, presence } = store.state;
    const conversation = view.conversation;
    const steer = canSteer();
    const session = conversation?.kind === "session";
    const bot = sessions.find(
        (each) => each.id === conversation?.id && each.bot !== undefined,
    )?.bot;
    const owner = me?.role === "owner";
    const turns = view.turns;
    // While take turns is on, settings belong to the driver.
    const driving = !turns?.on || turns.driver === me?.id;
    const context = conversation && steer && driving;
    const memory = useMemory();
    const unread = conversation && collab() ? chatUnread() : 0;
    // Chat and take turns are for when there is someone else: people with access, and someone here now.
    const others = presence.some((person) => person.id !== me?.id);
    const company = collab() && (users.length > 1 || unread > 0);

    if (!conversation) {
        return null;
    }

    const botSession = bot && sessions.find((each) => each.id === conversation.id);
    const edit = bot
        ? instead({ type: "bot", id: conversation.id })
        : session && steer
          ? instead({ type: "rename" })
          : null;
    const where = [folderName(view.agent?.cwd), view.agent?.model && modelLabel(view.agent)]
        .filter(Boolean)
        .join(" · ");

    return html`<${PopMenu}
        title="Conversation"
        anchor='.topbar [aria-label="Menu"]'
        width=${272}
        header=${html`<button
            type="button"
            class="pop-card pop-row"
            role="menuitem"
            data-row="edit"
            disabled=${edit === null}
            onClick=${edit}
        >
            <span class="pop-card-mark">
                ${
                    bot
                        ? html`<${Face}
                              id=${bot.id}
                              color=${bot.color}
                              skin=${bot.skin}
                              eyes=${bot.eyes}
                              shape=${bot.shape}
                              state=${botFaceState(botSession)}
                              size=${30}
                              label=${bot.name}
                          />`
                        : html`<${Icon} name="chat" size=${16} />`
                }
            </span>
            <span class="pop-card-text">
                <span class="pop-card-name">${bot?.name ?? conversation.title ?? "New session"}</span>
                ${where && html`<span class="pop-card-sub">${where}</span>`}
            </span>
            ${edit && html`<span class="pop-card-edit">${bot ? "Edit" : "Rename"}</span>`}
        </button>`}
        groups=${[
            [
                {
                    id: "find",
                    icon: "search",
                    label: "Find in conversation",
                    keys: "Mod F",
                    run: instead({ type: "find" }),
                },
                {
                    id: "artifacts",
                    icon: "artifact",
                    label: "Artifacts",
                    value: view.artifacts.length > 0 ? String(view.artifacts.length) : "",
                    run: instead({ type: "artifacts" }),
                },
                browserAvailable() && {
                    id: "browser",
                    icon: "globe",
                    label: browserOpen ? "Close the browser" : "Browser",
                    keys: "Alt B",
                    run: () => {
                        setBrowserOpen(!browserOpen);
                        closeSheet();
                    },
                },
                owner && {
                    id: "terminal",
                    icon: "terminal",
                    label: "Terminal",
                    run: () => openTool("terminal", { cwd: view.agent?.cwd }),
                },
                company && {
                    id: "chat",
                    icon: "chat",
                    label: "Chat with people here",
                    value: unread > 0 ? String(unread) : "",
                    run: instead({ type: "chat" }),
                },
                company &&
                    canToggleTurns() &&
                    (turns?.on || others) && {
                        id: "turns",
                        icon: "wheel",
                        label: turns?.on ? "Stop taking turns" : "Take turns",
                        run: () =>
                            attempt(async () => {
                                await actions.turns(turns?.on ? "off" : "on");
                                closeSheet();
                            }),
                    },
            ],
            [
                session &&
                    context && {
                        id: "instructions",
                        icon: "book",
                        label: "Instructions",
                        value: view.agent?.instructions ? "On" : "",
                        run: instead({ type: "instructions" }),
                    },
                memoryAvailable() && {
                    id: "memory",
                    icon: "memory",
                    label: "Memory",
                    value: memoryCount(memory),
                    run: instead({ type: "memory" }),
                },
                schedulesAvailable() && {
                    id: "schedules",
                    icon: "clock",
                    label: bot ? "Routines" : "Scheduled messages",
                    value: view.schedules.length > 0 ? String(view.schedules.length) : "",
                    run: instead({ type: "schedules" }),
                },
                context && {
                    id: "compact",
                    icon: "compact",
                    label: "Compact context",
                    run: instead({ type: "compact" }),
                },
                context && {
                    id: "reset",
                    icon: "reload",
                    label: "New context",
                    run: instead({ type: "reset" }),
                },
            ],
            [
                conversation.worktree && steer
                    ? {
                          id: "worktree",
                          icon: "fork",
                          label: "Worktree",
                          value: conversation.worktree.branch,
                          run: instead({ type: "worktree" }),
                      }
                    : context &&
                      !scoped() && {
                          id: "cwd",
                          icon: "folder",
                          label: "Working directory",
                          value: folderName(view.agent?.cwd),
                          run: instead({ type: "cwd", mode: "change" }),
                      },
                trustAvailable() && {
                    id: "trust",
                    icon: "shield",
                    label: "Project trust",
                    value: trustHint(),
                    run: instead({ type: "trust" }),
                },
                watchAvailable() &&
                    steer &&
                    view.branch?.branch &&
                    view.watch?.status !== "watching" && {
                        id: "watch",
                        icon: "eye",
                        label: "Watch pull request",
                        run: () => {
                            closeSheet();
                            attempt(() => watchPr());
                        },
                    },
            ],
            // noid: only the subagents at work, a group per run; the rest are on the subagents board.
            ...workingRuns(view.subagents).map((run) => [
                { id: `run:${run[0].conversationId}`, heading: runHeading(run) },
                ...run.map((agent) => ({
                    id: `subagent:${agent.conversationId}`,
                    icon: "bot",
                    label: agent.name,
                    run: () => {
                        closeSheet();
                        openSubagent(agent.conversationId);
                    },
                })),
            ]),
            [
                !bot &&
                    session && {
                        id: "pin",
                        icon: "pin",
                        label: isPinned(conversation.id) ? "Unpin" : "Pin to the top",
                        run: () => {
                            togglePin(conversation.id);
                            closeSheet();
                        },
                    },
                {
                    id: "link",
                    icon: "link",
                    label: "Copy link",
                    run: () => {
                        closeSheet();
                        copyText(location.href).then(
                            () =>
                                notify("info", "Link copied. Other signed-in devices can open it."),
                            () => notify("error", "Could not copy."),
                        );
                    },
                },
                {
                    id: "export",
                    icon: "download",
                    label: "Export as Markdown",
                    href: `/api/c/${conversation.id}/export`,
                },
            ],
            [
                // Noid, the main bot, is never archived (the server refuses).
                session &&
                    steer &&
                    bot?.main !== true && {
                        id: "archive",
                        icon: conversation.archived ? "unarchive" : "archive",
                        label: conversation.archived ? "Unarchive" : "Archive",
                        run: () => {
                            closeSheet();
                            setArchived([conversation.id], !conversation.archived);
                        },
                    },
            ],
        ]}
    />`;
}

/** Who you are here, in a word. */
const roleLabel = (role) => (role === "owner" ? "Owner" : role === "viewer" ? "Can view" : "Guest");

/**
 * The rail's avatar: you, and the way to the app's settings, as rakazo's and pi-web-desktop's user menus at the foot of
 * their sidebars.
 */
export function AccountSheet() {
    const { me } = store.state;

    return html`<${PopMenu}
        title="Account"
        anchor=".rail-me"
        beside=${true}
        width=${240}
        header=${html`<button
            type="button"
            class="pop-me pop-row"
            role="menuitem"
            data-row="me"
            title="Your name and face"
            onClick=${() => openSettings("name")}
        >
            ${me && html`<${Avatar} person=${me} size=${32} />`}
            <span class="pop-me-text">
                <span class="pop-me-name">${me?.name ?? "You"}</span>
                <span class="pop-me-role">${roleLabel(me?.role)}</span>
            </span>
        </button>`}
        groups=${[
            [
                {
                    id: "settings",
                    icon: "sliders",
                    label: "Settings",
                    keys: "Mod ,",
                    run: () => openSettings(),
                },
                {
                    id: "appearance",
                    icon: "palette",
                    label: "Appearance",
                    value: lookLabel(),
                    run: () => openSettings("appearance"),
                },
                !touch && {
                    id: "shortcuts",
                    icon: "keyboard",
                    label: "Keyboard shortcuts",
                    keys: "?",
                    run: () => openSettings("shortcuts"),
                },
            ],
            [{ id: "signout", icon: "logout", label: "Sign out", danger: true, run: signOut }],
        ]}
    />`;
}
