// noid: Settings, as pi-web-desktop has them: a large dialog over the app, its pages in groups down the left and the
// page chosen beside them, under a head that says where you are (Settings / Models / Providers). Each page is the
// sheet it stands for, drawn in place (`SheetEmbed`): what it opens (a sign-in, a picker) comes over Settings. On a
// phone it fills the screen: the list first, then a page, with back to the list.
import { useEffect, useRef, useState } from "preact/hooks";
import { useBack } from "../back.js";
import { triggersOn } from "../commands.js";
import { extensionMenuItems, safeMode } from "../extension-ui.js";
import { modelRefreshAvailable, refreshModels } from "../model-refresh.js";
import { sheetBody } from "../sheets.js";
import { api, attempt, closeSettings, collab, notify, store } from "../store.js";
import { Boundary, BOTTOM_SHEETS, html, Icon, scrimPress, SheetEmbed, SheetInfo } from "../ui.js";
import { defaultsKept } from "./model.js";

const touch = matchMedia("(pointer: coarse)").matches;

/** Whether a media query matches, kept up to date. */
function useMatches(query) {
    const [matches, setMatches] = useState(query.matches);

    useEffect(() => {
        const change = () => setMatches(query.matches);

        query.addEventListener("change", change);

        return () => query.removeEventListener("change", change);
    }, []);

    return matches;
}

/** The Extensions page's badge: that this tab loads none of their browser parts (safe mode). */
const extensionsBadge = () => (safeMode() ? "off here" : "");

/** One setting, as pi-web-desktop lays it out: its name with the control at its end, and what it does under them. */
function Row({ title, about, children }) {
    return html`<div class="settings-row">
        <div class="settings-row-head">
            <span class="settings-row-title">${title}</span>
            ${children}
        </div>
        <div class="settings-row-description">${about}</div>
    </div>`;
}

/** The server's page: what the owner does to the server itself. */
function ServerPage() {
    const { server, modelRefresh } = store.state;

    return html`<div class="settings-rows">
        ${
            server?.supervised &&
            html`<${Row}
                title="Restart server"
                about="For changes to the server's own code. Running work resumes after it."
            >
                <button
                    class="button small"
                    onClick=${() =>
                        attempt(async () => {
                            await api("restart", {});
                            closeSettings();
                            notify("info", "Restarting. Running work continues after the restart.");
                        })}
                >
                    Restart
                </button>
            <//>`
        }
        ${
            modelRefreshAvailable() &&
            html`<${Row}
                title="Refresh models"
                about="Read models.json and Pi's sign-ins again, and ask providers for their models."
            >
                <button class="button small" disabled=${modelRefresh.loading} onClick=${refreshModels}>
                    ${modelRefresh.loading ? "Refreshing…" : "Refresh"}
                </button>
            <//>`
        }
    </div>`;
}

/**
 * The pages, in groups: `{ title, pages: [{ id, icon, label, about, sheet | page | run, badge }] }`. A page is a sheet
 * drawn in place, or a component; rows that extensions add run what they do, as the menu's rows did.
 */
function groupsOf() {
    const { me, server } = store.state;
    const owner = me?.role === "owner";
    const groups = [
        {
            title: "General",
            pages: [
                {
                    id: "name",
                    icon: "pencil",
                    label: "Your name",
                    about: "How people on this server see you.",
                    sheet: { type: "name" },
                },
                {
                    id: "appearance",
                    icon: "palette",
                    label: "Appearance",
                    about: "Theme, colors, and layout, in this browser.",
                    sheet: { type: "appearance" },
                },
                collab() && {
                    id: "notifications",
                    icon: "bell",
                    label: "Notifications",
                    about: "Pushes to this device when Pi finishes, needs you, or someone writes.",
                    sheet: { type: "notifications" },
                },
                !touch && {
                    id: "shortcuts",
                    icon: "keyboard",
                    label: "Keyboard shortcuts",
                    about: "Every key the app knows.",
                    sheet: { type: "shortcuts" },
                },
            ],
        },
        {
            title: "Models",
            pages: [
                owner && {
                    id: "providers",
                    icon: "key",
                    label: "Providers",
                    about: "Sign in to model providers, and choose the models subagents may use.",
                    sheet: { type: "providers" },
                },
                owner &&
                    defaultsKept() && {
                        id: "default-model",
                        icon: "sparkle",
                        label: "Default model",
                        about: "What new sessions and bots start with.",
                        sheet: { type: "model", id: "default", forDefault: true },
                    },
                owner && {
                    id: "auto-review",
                    icon: "eye",
                    label: "Auto review",
                    about: "A model checks the calls bots make before they run.",
                    sheet: { type: "auto-review" },
                },
            ],
        },
        {
            title: "Usage",
            pages: [
                {
                    id: "spend",
                    icon: "coin",
                    label: "Spend",
                    about: owner
                        ? "What Pi spent, by person and session, and limits."
                        : "What Pi spent for you.",
                    sheet: { type: "spend" },
                },
                {
                    id: "running",
                    icon: "pulse",
                    label: "Running now",
                    about: "Everything Pi is doing in the sessions you can see.",
                    sheet: { type: "running" },
                },
            ],
        },
        {
            title: "Connections",
            pages: [
                collab()
                    ? {
                          id: "people",
                          icon: "users",
                          label: "People",
                          about: "Who can use this server, and invites.",
                          sheet: { type: "people" },
                      }
                    : {
                          id: "invite",
                          icon: "phone",
                          label: "Other devices",
                          about: "Sign in another device of yours.",
                          sheet: { type: "invite" },
                      },
                triggersOn() &&
                    me?.role !== "viewer" && {
                        id: "hooks",
                        icon: "link",
                        label: "Webhooks and watches",
                        about: "Addresses other services post to, and what is watched on GitHub.",
                        sheet: { type: "hooks" },
                    },
                {
                    id: "extensions",
                    icon: "plug",
                    label: "Extensions",
                    about: "Modules that add to Pi and to the app.",
                    badge: extensionsBadge(),
                    sheet: { type: "extensions" },
                },
            ],
        },
        {
            title: "Server",
            pages: [
                owner &&
                    (server?.supervised || modelRefreshAvailable()) && {
                        id: "server",
                        icon: "monitor",
                        label: "Server",
                        about: "This noid server.",
                        page: ServerPage,
                    },
            ],
        },
        {
            title: "From extensions",
            pages: extensionMenuItems().map((each) => ({
                id: `ext:${each.key}`,
                icon: "tiles",
                label: each.label,
                run: () => {
                    closeSettings();
                    each.run();
                },
            })),
        },
    ];

    return groups
        .map((group) => ({ ...group, pages: group.pages.filter(Boolean) }))
        .filter((group) => group.pages.length > 0);
}

export function Settings() {
    const { settings } = store.state;
    const phone = useMatches(BOTTOM_SHEETS);
    const dialog = useRef(null);
    const body = useRef(null);
    const groups = groupsOf();
    const pages = groups.flatMap((group) =>
        group.pages.filter((each) => !each.run).map((each) => ({ ...each, group: group.title })),
    );
    // Wide, a page always shows (the first, at first); on a phone, the list until one is chosen.
    const current = pages.find((each) => each.id === settings.page) ?? (phone ? null : pages[0]);
    const choose = (id) => store.set({ settings: { page: id } });
    const type = current?.sheet?.type ?? current?.id;
    const Page = current?.page;

    useBack(true, closeSettings);
    useBack(phone && current !== null, () => choose(null));

    // Esc closes Settings, unless a sheet it opened is over it (that sheet takes its own Esc).
    useEffect(() => {
        const onKey = (event) => {
            if (
                event.key === "Escape" &&
                !event.isComposing &&
                event.keyCode !== 229 &&
                !store.state.sheet &&
                !store.state.launcher
            ) {
                closeSettings();
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    // Keys go to Settings when it opens, and back to what had them when it closes.
    useEffect(() => {
        const before = document.activeElement;

        dialog.current?.focus({ preventScroll: true });

        return () => {
            if (before?.isConnected && !store.state.sheet) {
                before.focus({ preventScroll: true });
            }
        };
    }, []);

    // A new page starts at its top.
    useEffect(() => body.current?.scrollTo(0, 0), [current?.id]);

    return html`<div
        class="overlay settings-overlay"
        data-part="scrim"
        data-for="settings"
        onMouseDown=${scrimPress(closeSettings)}
    >
        <section
            class="settings-dialog"
            data-part="settings"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            tabindex="-1"
            ref=${dialog}
        >
            <header class="settings-head">
                ${
                    phone &&
                    current &&
                    html`<button
                        class="icon-button"
                        aria-label="Back to Settings"
                        onClick=${() => choose(null)}
                    >
                        <${Icon} name="back" size=${18} />
                    </button>`
                }
                <nav class="settings-crumbs" aria-label="Where you are">
                    <span class="crumb-root">Settings</span>
                    ${
                        current &&
                        html`<span class="crumb-sep" aria-hidden="true">/</span>
                            <span class="crumb-group">${current.group}</span>
                            <span class="crumb-sep" aria-hidden="true">/</span>
                            <span class="crumb-current" aria-current="page">${current.label}</span>`
                    }
                </nav>
                <button
                    class="icon-button"
                    aria-label="Close Settings"
                    title="Close (Esc)"
                    onClick=${closeSettings}
                >
                    <${Icon} name="close" />
                </button>
            </header>
            <div class="settings-split">
                ${
                    (!phone || !current) &&
                    html`<nav class="settings-nav" aria-label="Settings pages">
                        ${groups.map(
                            (group) => html`<div class="settings-nav-section" key=${group.title}>
                                <div class="settings-nav-group">${group.title}</div>
                                ${group.pages.map(
                                    (each) => html`<button
                                        key=${each.id}
                                        type="button"
                                        class="settings-nav-item"
                                        data-page=${each.id}
                                        aria-current=${current?.id === each.id ? "page" : undefined}
                                        onClick=${each.run ?? (() => choose(each.id))}
                                    >
                                        <${Icon} name=${each.icon} size=${16} />
                                        <span class="settings-nav-label">${each.label}</span>
                                        ${
                                            each.badge &&
                                            html`<span class="settings-nav-badge">${each.badge}</span>`
                                        }
                                        ${
                                            phone &&
                                            html`<${Icon}
                                                name="chevron"
                                                size=${14}
                                                class="settings-nav-chevron"
                                            />`
                                        }
                                    </button>`,
                                )}
                            </div>`,
                        )}
                    </nav>`
                }
                ${
                    current &&
                    html`<div class="settings-body" ref=${body}>
                        <div class="settings-page" key=${current.id} data-page=${current.id}>
                            <div class="settings-page-head">
                                <h2>${current.label}</h2>
                                <p>${current.about}</p>
                            </div>
                            <${SheetEmbed.Provider} value=${{ type }}>
                                <${SheetInfo.Provider} value=${{ type, closing: false }}>
                                    <${Boundary} reset=${current.id}>
                                        ${Page ? html`<${Page} />` : sheetBody(current.sheet)}
                                    <//>
                                <//>
                            <//>
                        </div>
                    </div>`
                }
            </div>
        </section>
    </div>`;
}
