// noid: the shared computer's tools (its terminal, its desktop) as pages in the conversation's place, as the subagents
// board shows: room for a shell or a screen, where a dialog over the conversation was cramped. Back, or ×, goes back to
// the conversation; Esc is the tool's own (a shell's editor needs it).
import { useBack } from "./back.js";
import { closeTool, store } from "./store.js";
import { html, Icon } from "./ui.js";
import { DesktopPage } from "./sheets/desktop.js";
import { TerminalPage } from "./sheets/terminal.js";

/** A tool's page: a head with its name, a line under it, and its actions; the tool fills the rest. */
export function ToolFrame({ kind, title, sub, actions = null, children }) {
    useBack(true, closeTool);

    return html`<section class="tool-page" data-part="tool-page" data-tool=${kind} aria-label=${title}>
        <header class="board-head tool-head">
            <div class="board-title">
                <h2>${title}</h2>
                ${sub && html`<div class="board-sub">${sub}</div>`}
            </div>
            ${actions}
            <button
                class="icon-button"
                title="Back to the conversation"
                aria-label="Close"
                onClick=${closeTool}
            >
                <${Icon} name="close" />
            </button>
        </header>
        <div class="tool-body">${children}</div>
    </section>`;
}

/** The tool open now, by its kind. */
export function ToolPage() {
    const { tool } = store.state;

    return tool.kind === "desktop"
        ? html`<${DesktopPage} />`
        : html`<${TerminalPage} key=${tool.cwd ?? ""} cwd=${tool.cwd} />`;
}
