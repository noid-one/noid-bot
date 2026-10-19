// The panel beside the conversation, as one: Files, Changes, and the Browser as tabs on its head, which sits on the
// same line as the top bar. Each tab's own tools (the browser's address bar) go under it. One panel shows at a time
// (`setFilesOpen`, `setBrowserOpen`), so a tab opens its panel in the other's place.
import { browserAvailable, setBrowserOpen } from "./browser.js";
import { filesAvailable, setFilesOpen } from "./files-panel.js";
import { html, Icon } from "./ui.js";

/**
 * The panel's head. `active` is "files", "changes", or "browser"; `beside` says whether the panel sits beside the
 * conversation (a close button at the end) or covers it (a back button first); `count` is the changes' count when it
 * is known; `extra` goes between the tabs and the close button (the folder, for files).
 */
export function PanelTabs({ active, beside, count = 0, extra = null }) {
    const close = () => (active === "browser" ? setBrowserOpen(false) : setFilesOpen(false));
    const keys = active === "browser" ? "Alt+B" : "Alt+E";
    const tabs = [
        filesAvailable() && ["files", "Files", () => setFilesOpen(true, "files")],
        filesAvailable() && ["changes", "Changes", () => setFilesOpen(true, "changes")],
        browserAvailable() && ["browser", "Browser", () => setBrowserOpen(true)],
    ].filter(Boolean);

    return html`<header class="panel-tabs" data-part="panel-tabs">
        ${
            !beside &&
            html`<button
                class="icon-button panel-back"
                type="button"
                aria-label="Back to the conversation"
                title=${`Back (${keys})`}
                onClick=${close}
            >
                <${Icon} name="back" size=${22} />
            </button>`
        }
        <div class="panel-tablist" role="tablist" aria-label="Panel">
            ${tabs.map(
                ([id, label, open]) => html`<button
                    key=${id}
                    type="button"
                    role="tab"
                    aria-selected=${id === active ? "true" : "false"}
                    class=${id === active ? "on" : ""}
                    onClick=${() => {
                        if (id !== active) {
                            open();
                            // The tab's panel takes the other's place: the keys stay on the tabs.
                            requestAnimationFrame(() =>
                                document
                                    .querySelector('.panel-tablist [aria-selected="true"]')
                                    ?.focus({ preventScroll: true }),
                            );
                        }
                    }}
                >
                    ${label}
                    ${id === "changes" && count > 0 && html`<span class="files-count">${count}</span>`}
                </button>`,
            )}
        </div>
        ${extra}
        ${
            beside &&
            html`<button
                class="icon-button panel-close"
                type="button"
                aria-label=${active === "browser" ? "Close the browser" : "Close the files"}
                title=${`Close (${keys})`}
                onClick=${close}
            >
                <${Icon} name="close" size=${17} />
            </button>`
        }
    </header>`;
}
