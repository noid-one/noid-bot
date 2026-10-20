// A bot: make one, or change one's name, role, face, and instructions. The face shows as it will look, as you pick.
import { useState } from "preact/hooks";
import { Face } from "../faces/face.js";
import { EYES, SHAPES, SKINS } from "../faces/params.js";
import { actions, api, attempt, closeSheet, navigate, store, uid } from "../store.js";
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
    // noid: a bot made from an agent file is what its file says; only its face is changed here.
    const file = bot?.file;
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
    const [shape, setShape] = useState(bot?.shape ?? "");
    // A new bot's id, made here so its face is the one shown: the server keeps it.
    const [newId] = useState(() => uid().slice(0, 8));
    const faceId = bot?.id ?? newId;
    // A model at work: naming a new bot as it is made, or suggesting a name for this one.
    const [naming, setNaming] = useState(false);
    // Saving: one click makes one bot.
    const [saving, setSaving] = useState(false);
    const named = name.trim() !== "";
    const canMake = named || role.trim() !== "" || instructions.trim() !== "";

    // noid: a name a model writes from what the bot does, for the owner to keep or change.
    const suggest = () => {
        setNaming(true);
        attempt(async () => setName((await api(`bots/${id}/name`, {})).name)).finally(() =>
            setNaming(false),
        );
    };

    const save = () => {
        setSaving(true);
        setNaming(!named);
        attempt(async () => {
            const body = { name, role, color, skin, eyes, shape };

            if (bot !== undefined) {
                // Instructions only change when they were shown here (this bot's session is open).
                await actions.updateBot(
                    id,
                    view.conversation?.id === id && file === undefined
                        ? { ...body, instructions }
                        : body,
                );
                closeSheet();

                return;
            }

            const made = await actions.createBot({
                ...body,
                id: newId,
                instructions,
                kind,
                ...(kind === "host" ? { folder } : {}),
            });

            closeSheet();
            navigate(made.id);
        }).finally(() => {
            setNaming(false);
            setSaving(false);
        });
    };

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
                shape=${shape || undefined}
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
                <label class="bot-pick">
                    <span class="label">Shape</span>
                    <select
                        value=${shape}
                        aria-label="Shape"
                        onChange=${(event) => setShape(event.currentTarget.value)}
                    >
                        <option value="">From its name</option>
                        ${SHAPES.map((each) => html`<option value=${each}>${each}</option>`)}
                    </select>
                </label>
            </div>
        </div>
        ${
            file !== undefined &&
            html`<p class="bot-file muted">
                From the agent file <code>${shortPath(file)}</code>. Its name, role, and instructions
                are the file's: edit it to change them.
            </p>`
        }
        ${field(
            "Name",
            html`<div class="bot-name-field">
                <input
                    autofocus=${file === undefined}
                    readonly=${file !== undefined}
                    aria-label="Name"
                    value=${name}
                    maxlength="40"
                    placeholder=${bot === undefined ? "Leave it empty to name it for what it does" : "e.g. Researcher"}
                    onInput=${(event) => setName(event.currentTarget.value)}
                />
                ${
                    bot !== undefined &&
                    file === undefined &&
                    html`<button
                        class="button"
                        disabled=${naming}
                        title="A name for what it does, from its role and instructions"
                        onClick=${suggest}
                    >
                        ${naming ? "Naming…" : "Name it for me"}
                    </button>`
                }
            </div>`,
        )}
        ${field(
            "Role",
            html`<input
                aria-label="Role"
                readonly=${file !== undefined}
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
                    readonly=${file !== undefined}
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
            ${
                bot !== undefined &&
                html`<button
                    class="button ghost"
                    onClick=${() => navigate(id, { sheet: { type: "schedules" } })}
                >
                    Routines
                </button>`
            }
            <button class="button" onClick=${closeSheet}>Cancel</button>
            <button
                class="button primary"
                disabled=${naming || saving || (bot === undefined ? !canMake : !named)}
                onClick=${save}
            >
                ${bot === undefined ? (naming ? "Naming it…" : "Make the bot") : "Save"}
            </button>
        </div>
    <//>`;
}

/** An agent file's path from its dot folder on (`.agents/agents/x.md`): enough to find it, without the home folder. */
function shortPath(path) {
    const at = path.search(/\/\.(agents|pi|claude)\//);

    return at === -1 ? path : `~${path.slice(at)}`;
}
