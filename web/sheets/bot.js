// A bot: make one, or change one's name, role, face, and instructions. The face shows as it will look, as you pick.
import { useState } from "preact/hooks";
import { Face } from "../faces/face.js";
import { EYES, SKINS } from "../faces/params.js";
import { actions, attempt, closeSheet, navigate, store } from "../store.js";
import { html, Sheet } from "../ui.js";

const COLORS = [
    "#7aa2f7",
    "#9ece6a",
    "#ff9e64",
    "#bb9af7",
    "#7dcfff",
    "#f7768e",
    "#e0af68",
    "#2ac3de",
];

/** `id`: the bot's session, to change it; none to make a new one. */
export function BotSheet({ id }) {
    const { sessions, view } = store.state;
    const editing = sessions.find((session) => session.id === id && session.bot !== undefined);
    const bot = editing?.bot;
    const [name, setName] = useState(bot?.name ?? "");
    const [role, setRole] = useState(bot?.role ?? "");
    const [instructions, setInstructions] = useState(
        bot !== undefined && view.conversation?.id === id ? (view.agent?.instructions ?? "") : "",
    );
    const [kind, setKind] = useState(bot?.kind ?? "computer");
    const [folder, setFolder] = useState("");
    const [color, setColor] = useState(
        bot?.color ?? COLORS[Math.floor(Math.random() * COLORS.length)],
    );
    const [skin, setSkin] = useState(bot?.skin ?? "");
    const [eyes, setEyes] = useState(bot?.eyes ?? "");
    const faceId = bot?.id ?? `new:${name || "bot"}`;

    const save = () =>
        attempt(async () => {
            const body = { name, role, color, skin, eyes };

            if (bot !== undefined) {
                // Instructions only change when they were shown here (this bot's session is open).
                await actions.updateBot(
                    id,
                    view.conversation?.id === id ? { ...body, instructions } : body,
                );
                closeSheet();

                return;
            }

            const made = await actions.createBot({
                ...body,
                instructions,
                kind,
                ...(kind === "host" ? { folder } : {}),
            });

            closeSheet();
            navigate(made.id);
        });

    const field = (label, input) => html`<div class="field">
        <div class="label">${label}</div>
        ${input}
    </div>`;

    return html`<${Sheet}
        title=${bot === undefined ? "New bot" : `Edit ${bot.name}`}
        onClose=${closeSheet}
        className="bot-sheet"
    >
        <div class="bot-preview">
            <${Face}
                id=${faceId}
                color=${color}
                skin=${skin || undefined}
                eyes=${eyes || undefined}
                state="idle"
                size=${88}
                label=${name || "New bot"}
            />
            <div class="bot-face-picks">
                <label class="bot-pick">
                    <span class="label">Color</span>
                    <input
                        type="color"
                        value=${color}
                        aria-label="Color"
                        onInput=${(event) => setColor(event.currentTarget.value)}
                    />
                </label>
                <label class="bot-pick">
                    <span class="label">Skin</span>
                    <select
                        value=${skin}
                        aria-label="Skin"
                        onChange=${(event) => setSkin(event.currentTarget.value)}
                    >
                        <option value="">From its name</option>
                        ${SKINS.map((each) => html`<option value=${each}>${each}</option>`)}
                    </select>
                </label>
                <label class="bot-pick">
                    <span class="label">Eyes</span>
                    <select
                        value=${eyes}
                        aria-label="Eyes"
                        onChange=${(event) => setEyes(event.currentTarget.value)}
                    >
                        <option value="">From its name</option>
                        ${EYES.map((each) => html`<option value=${each}>${each}</option>`)}
                    </select>
                </label>
            </div>
        </div>
        ${field(
            "Name",
            html`<input
                autofocus
                aria-label="Name"
                value=${name}
                maxlength="40"
                placeholder="e.g. Researcher"
                onInput=${(event) => setName(event.currentTarget.value)}
            />`,
        )}
        ${field(
            "Role",
            html`<input
                aria-label="Role"
                value=${role}
                maxlength="160"
                placeholder="e.g. Finds things out and writes them up"
                onInput=${(event) => setRole(event.currentTarget.value)}
            />`,
        )}
        ${
            (bot === undefined || view.conversation?.id === id) &&
            field(
                "Instructions",
                html`<textarea
                    rows="4"
                    aria-label="Instructions"
                    value=${instructions}
                    placeholder="e.g. Cite every source."
                    onInput=${(event) => setInstructions(event.currentTarget.value)}
                ></textarea>`,
            )
        }
        ${
            bot === undefined &&
            html`<div class="field">
                    <div class="label">Works on</div>
                    <div class="bot-kinds" role="radiogroup" aria-label="Works on">
                        <button
                            class=${`button ${kind === "computer" ? "primary" : ""}`}
                            role="radio"
                            aria-checked=${String(kind === "computer")}
                            onClick=${() => setKind("computer")}
                        >
                            The shared computer
                        </button>
                        <button
                            class=${`button ${kind === "host" ? "primary" : ""}`}
                            role="radio"
                            aria-checked=${String(kind === "host")}
                            onClick=${() => setKind("host")}
                        >
                            This machine
                        </button>
                    </div>
                </div>
                ${
                    kind === "host" &&
                    field(
                        "Folder",
                        html`<input
                            aria-label="Folder"
                            value=${folder}
                            placeholder="e.g. ~/code/my-app"
                            onInput=${(event) => setFolder(event.currentTarget.value)}
                        />`,
                    )
                }`
        }
        <div class="sheet-actions">
            <button class="button" onClick=${closeSheet}>Cancel</button>
            <button class="button primary" disabled=${name.trim() === ""} onClick=${save}>
                ${bot === undefined ? "Make the bot" : "Save"}
            </button>
        </div>
    <//>`;
}
