// One text field and a button: renaming, resetting, instructions, compacting, and your name.
import { useContext, useState } from "preact/hooks";
import { attempt, closeSheet, notify } from "../store.js";
import { html, Sheet, SheetEmbed } from "../ui.js";

export function TextSheet({
    title,
    label,
    hint = "",
    initial = "",
    placeholder = "",
    submit,
    multiline = false,
    button = "Save",
    footer = null,
}) {
    const [value, setValue] = useState(initial);
    const [saved, setSaved] = useState(initial);
    // A page of Settings: nothing to cancel, and saving keeps the page.
    const embedded = useContext(SheetEmbed) !== null;
    const save = () =>
        attempt(async () => {
            await submit(value);

            if (embedded) {
                setSaved(value);
                notify("info", "Saved.");
            } else {
                closeSheet();
            }
        });

    return html`<${Sheet} title=${title} onClose=${closeSheet}>
        ${hint && html`<p class="muted small">${hint}</p>`}
        <div class="field">
            <div class="label">${label}</div>
            ${
                multiline
                    ? html`<textarea
                        rows="4"
                        aria-label=${label}
                        value=${value}
                        placeholder=${placeholder}
                        onInput=${(event) => setValue(event.currentTarget.value)}
                    ></textarea>`
                    : html`<input
                        autofocus
                        aria-label=${label}
                        value=${value}
                        placeholder=${placeholder}
                        onInput=${(event) => setValue(event.currentTarget.value)}
                        onKeyDown=${(event) => event.key === "Enter" && save()}
                    />`
            }
        </div>
        <div class="sheet-actions">
            ${!embedded && html`<button class="button" onClick=${closeSheet}>Cancel</button>`}
            <button
                class="button primary"
                disabled=${embedded && value.trim() === saved.trim()}
                onClick=${save}
            >
                ${button}
            </button>
        </div>
        ${footer}
    <//>`;
}
