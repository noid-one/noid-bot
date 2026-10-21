// noid: you: your name, and your face, picked as a bot's is. Both show at once wherever you are, to everyone here.
import { useContext, useState } from "preact/hooks";
import { Avatar } from "../avatar.js";
import { DEFAULT_COLORS, hashOf } from "../faces/params.js";
import { api, attempt, closeSheet, notify, signOut, store } from "../store.js";
import { html, Icon, Sheet, SheetEmbed } from "../ui.js";
import { FacePicks } from "./bot.js";

/** The color a face has from its id (`paletteOf`'s), for the color input until you pick one. */
const colorFrom = (id) => DEFAULT_COLORS[hashOf(id) % DEFAULT_COLORS.length];

export function MeSheet() {
    const { me } = store.state;
    const face = me?.face ?? {};
    const [name, setName] = useState(me?.name ?? "");
    const [picks, setPicks] = useState({
        color: face.color ?? "",
        skin: face.skin ?? "",
        eyes: face.eyes ?? "",
        shape: face.shape ?? "",
    });
    const [saved, setSaved] = useState({ name, picks });
    // A page of Settings: nothing to cancel, and saving keeps the page.
    const embedded = useContext(SheetEmbed) !== null;
    const changed =
        name.trim() !== saved.name.trim() || JSON.stringify(picks) !== JSON.stringify(saved.picks);
    const shown = {
        color: picks.color || undefined,
        skin: picks.skin || undefined,
        eyes: picks.eyes || undefined,
        shape: picks.shape || undefined,
    };

    const save = () =>
        attempt(async () => {
            await api("me", { name, face: picks });
            const hello = await api("me");

            store.set({ me: hello.user, users: hello.users });

            if (embedded) {
                setSaved({ name, picks });
                notify("info", "Saved.");
            } else {
                closeSheet();
            }
        });

    return html`<${Sheet} title="You" onClose=${closeSheet} className="bot-sheet me-sheet">
        <div class="bot-preview">
            <${Avatar} person=${{ id: me?.id ?? "", name: name || "You", face: shown }} size=${88} />
            <${FacePicks}
                color=${picks.color || colorFrom(me?.id ?? "")}
                skin=${picks.skin}
                eyes=${picks.eyes}
                shape=${picks.shape}
                from="From your id"
                onPick=${(pick) => setPicks({ ...picks, ...pick })}
            />
        </div>
        <div class="field">
            <div class="label">Your name, shown on your messages to others</div>
            <input
                autofocus
                aria-label="Your name"
                value=${name}
                maxlength="40"
                onInput=${(event) => setName(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && save()}
            />
        </div>
        <div class="sheet-actions">
            ${
                picks.color !== "" &&
                html`<button class="button ghost" onClick=${() => setPicks({ ...picks, color: "" })}>
                    Color from your id
                </button>`
            }
            ${!embedded && html`<button class="button" onClick=${closeSheet}>Cancel</button>`}
            <button
                class="button primary"
                disabled=${name.trim() === "" || (embedded && !changed)}
                onClick=${save}
            >
                Save
            </button>
        </div>
        <button class="button ghost wide sheet-footer signout" onClick=${signOut}>
            <${Icon} name="logout" size=${16} /> Sign out
        </button>
    <//>`;
}
