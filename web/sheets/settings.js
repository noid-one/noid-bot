// Settings: the app's own, apart from any conversation. Each row opens its sheet, and back comes here again.
import { triggersOn } from "../commands.js";
import { extensionMenuItems, safeMode } from "../extension-ui.js";
import { modelRefreshAvailable, refreshModels } from "../model-refresh.js";
import { api, attempt, closeSheet, collab, notify, openSheet, signOut, store } from "../store.js";
import { lookLabel } from "../theme.js";
import { html, Icon, Sheet } from "../ui.js";
import { defaultLabel, defaultsKept } from "./model.js";

const touch = matchMedia("(pointer: coarse)").matches;

/** The Extensions row's value: that this tab loads none of their browser parts (safe mode), and Lancet Guard. */
function extensionsValue() {
    const { guard } = store.state;

    return [
        safeMode() && "Browser parts off",
        guard?.enabled ? "Lancet Guard on" : guard?.available ? "Lancet Guard off" : "",
    ]
        .filter(Boolean)
        .join(" · ");
}

/** One setting: an icon, its name, what it is now, and a chevron when it opens a page of its own. */
function Row({ id, icon, label, value, run, danger = false, opens = true }) {
    return html`<button
        type="button"
        class=${`settings-row ${danger ? "danger" : ""}`}
        data-row=${id}
        onClick=${run}
    >
        <span class="settings-icon"><${Icon} name=${icon} size=${16} /></span>
        <span class="settings-label">${label}</span>
        ${value && html`<span class="settings-value">${value}</span>`}
        ${opens && html`<${Icon} name="chevron" size=${14} class="settings-chevron" />`}
    </button>`;
}

/** Settings, in groups with a name each, as rakazo's and pi-web-desktop's settings pages. */
export function SettingsSheet() {
    const { me, server, models, modelRefresh } = store.state;
    const owner = me?.role === "owner";
    const open = (sheet) => () => openSheet(sheet);
    const groups = [
        {
            title: "You",
            rows: [
                {
                    id: "name",
                    icon: "pencil",
                    label: "Your name",
                    value: me?.name,
                    run: open({ type: "name" }),
                },
                {
                    id: "appearance",
                    icon: "palette",
                    label: "Appearance",
                    value: lookLabel(),
                    run: open({ type: "appearance" }),
                },
                collab() && {
                    id: "notifications",
                    icon: "bell",
                    label: "Notifications",
                    run: open({ type: "notifications" }),
                },
                !touch && {
                    id: "shortcuts",
                    icon: "keyboard",
                    label: "Keyboard shortcuts",
                    run: open({ type: "shortcuts" }),
                },
            ],
        },
        {
            title: "Models",
            rows: [
                owner && {
                    id: "providers",
                    icon: "key",
                    label: "Providers",
                    run: open({ type: "providers" }),
                },
                owner &&
                    defaultsKept() && {
                        id: "default-model",
                        icon: "sparkle",
                        label: "Default model",
                        value: defaultLabel(server?.defaultModel, models) || "Pi's own",
                        run: open({ type: "model", id: "default", forDefault: true }),
                    },
                owner && {
                    id: "auto-review",
                    icon: "eye",
                    label: "Auto review",
                    run: open({ type: "auto-review" }),
                },
                modelRefreshAvailable() && {
                    id: "refresh-models",
                    icon: "reload",
                    label: "Refresh models",
                    value: modelRefresh.loading ? "Refreshing…" : "",
                    opens: false,
                    run: refreshModels,
                },
            ],
        },
        {
            title: "Bots and the computer",
            rows: [
                owner && {
                    id: "groups",
                    icon: "users",
                    label: "Group threads",
                    run: open({ type: "groups" }),
                },
                owner && {
                    id: "desktop",
                    icon: "monitor",
                    label: "Desktop",
                    run: open({ type: "desktop" }),
                },
                owner && {
                    id: "terminal",
                    icon: "terminal",
                    label: "Terminal",
                    run: open({ type: "terminal" }),
                },
                {
                    id: "running",
                    icon: "pulse",
                    label: "Running now",
                    run: open({ type: "running" }),
                },
                {
                    id: "spend",
                    icon: "coin",
                    label: "Spend",
                    value: owner ? "" : "Yours",
                    run: open({ type: "spend" }),
                },
            ],
        },
        {
            title: "Connections",
            rows: [
                collab()
                    ? {
                          id: "people",
                          icon: "users",
                          label: "People",
                          value: me?.role === "viewer" ? "You can view" : "",
                          run: open({ type: "people" }),
                      }
                    : {
                          id: "invite",
                          icon: "phone",
                          label: "Sign in another device",
                          run: open({ type: "invite" }),
                      },
                triggersOn() &&
                    me?.role !== "viewer" && {
                        id: "hooks",
                        icon: "link",
                        label: "Webhooks and watches",
                        run: open({ type: "hooks" }),
                    },
                {
                    id: "extensions",
                    icon: "plug",
                    label: "Extensions",
                    value: extensionsValue(),
                    run: open({ type: "extensions" }),
                },
                // What extensions' browser modules added to the menu (`extension-ui.js`).
                ...extensionMenuItems().map((each) => ({
                    id: `ext:${each.key}`,
                    icon: "tiles",
                    label: each.label,
                    value: each.hint,
                    run: each.run,
                })),
            ],
        },
        {
            title: "Server",
            rows: [
                owner &&
                    server?.supervised && {
                        id: "restart",
                        icon: "reload",
                        label: "Restart server",
                        opens: false,
                        run: () =>
                            attempt(async () => {
                                await api("restart", {});
                                closeSheet();
                                notify(
                                    "info",
                                    "Restarting. Running work continues after the restart.",
                                );
                            }),
                    },
            ],
        },
        {
            title: "",
            rows: [
                {
                    id: "signout",
                    icon: "logout",
                    label: "Sign out",
                    danger: true,
                    opens: false,
                    run: signOut,
                },
            ],
        },
    ];

    return html`<${Sheet} title="Settings" onClose=${closeSheet} className="settings-sheet">
        ${groups.map(({ title, rows }) => {
            const shown = rows.filter(Boolean);

            return (
                shown.length > 0 &&
                html`<section class="settings-group" key=${title} aria-label=${title || undefined}>
                    ${title && html`<h3 class="settings-title">${title}</h3>`}
                    <div class="settings-card">
                        ${shown.map((row) => html`<${Row} key=${row.id} ...${row} />`)}
                    </div>
                </section>`
            );
        })}
    <//>`;
}
