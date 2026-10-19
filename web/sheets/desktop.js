// noid: the shared computer's desktop, for the owner: what it shows, refreshed while it is in view, and the owner's own
// clicks and typing, which take it over from any bot for a while.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Sheet } from "../ui.js";

const WIDTH = 1280;
const HEIGHT = 800;
/** How often the picture is refreshed, and how long to wait after a failure. */
const EVERY_MS = 1500;
const AFTER_FAILURE_MS = 6000;

export function DesktopSheet() {
    const [shot, setShot] = useState(undefined);
    const [holder, setHolder] = useState(null);
    const [error, setError] = useState(undefined);
    const [text, setText] = useState("");
    const [restarting, setRestarting] = useState(false);
    // A demonstration: under way (from the server), the form to start one, and where the last one was saved.
    const [teaching, setTeaching] = useState(null);
    const [lesson, setLesson] = useState(undefined);
    const [saved, setSaved] = useState(undefined);
    // While showing: what is typed now is a secret, typed but never kept in the skill.
    const [secret, setSecret] = useState(false);
    const image = useRef(null);
    const computerBots = store.state.sessions.filter(
        (session) =>
            session.bot !== undefined &&
            !session.archived &&
            (session.cwd === "/home/noid" || session.cwd?.startsWith("/home/noid/")),
    );

    useEffect(() => {
        let gone = false;

        void (async () => {
            while (!gone) {
                // Nothing to show while the tab is hidden: no screenshots for nobody.
                if (document.hidden) {
                    await new Promise((resolve) => setTimeout(resolve, EVERY_MS));
                    continue;
                }

                try {
                    const view = await api("desktop");

                    if (gone) {
                        return;
                    }

                    setShot(`data:image/png;base64,${view.image}`);
                    setHolder(view.holder);
                    setTeaching(view.teaching);
                    setError(undefined);
                } catch (failure) {
                    setError({ status: failure.status, message: failure.message });

                    // Only the owner sees it: anyone else has nothing to wait for.
                    if (failure.status === 403) {
                        return;
                    }

                    await new Promise((resolve) => setTimeout(resolve, AFTER_FAILURE_MS));
                    continue;
                }

                await new Promise((resolve) => setTimeout(resolve, EVERY_MS));
            }
        })();

        return () => {
            gone = true;
        };
    }, []);

    const act = (input) => attempt(() => api("desktop/input", input));

    // A click on the picture is a click at that point of the screen.
    const click = (event) => {
        const box = image.current.getBoundingClientRect();
        const x = Math.round(((event.clientX - box.left) / box.width) * WIDTH);
        const y = Math.round(((event.clientY - box.top) / box.height) * HEIGHT);

        void act({ action: "click", x: Math.min(WIDTH - 1, x), y: Math.min(HEIGHT - 1, y) });
    };

    const type = () => {
        if (text === "") {
            return;
        }

        void act({ action: "type", text, ...(teaching && secret ? { secret: true } : {}) });
        setText("");
        setSecret(false);
    };

    const restart = () =>
        attempt(async () => {
            setRestarting(true);

            try {
                await api("computer/restart", {});
            } finally {
                setRestarting(false);
            }
        });

    const begin = () =>
        attempt(async () => {
            await api("desktop/teach", lesson);
            setTeaching({ name: lesson.name, steps: 0 });
            setLesson(undefined);
            setSaved(undefined);
        });
    const finish = (save) =>
        attempt(async () => {
            const result = await api("desktop/learned", { save });

            setTeaching(null);
            setSaved(result.folder);
        });

    return html`<${Sheet} title="Computer desktop" onClose=${closeSheet} wide>
        <p class="muted small">
            Programs with windows that bots run on the shared computer.
            ${holder ? ` ${holder} is using it.` : " Nobody is using it."} A click or typing here
            takes it over from any bot for two minutes.
        </p>
        ${error && html`<p class="muted small" role="status">${error.message}</p>`}
        ${
            teaching &&
            html`<div class="row teach-banner">
                <span class="grow small">
                    Showing “${teaching.name}”: ${teaching.steps} step${teaching.steps === 1 ? "" : "s"} so far.
                    What you do here is kept, and the screen before and after is saved with the skill:
                    close anything private before you save.
                </span>
                <button class="button primary small" onClick=${() => finish(true)}>
                    Save as a skill
                </button>
                <button class="button ghost small" onClick=${() => finish(false)}>Drop it</button>
            </div>`
        }
        ${
            !teaching &&
            lesson !== undefined &&
            html`<div class="teach-form">
                <input
                    placeholder="Skill name, such as Export the weekly report"
                    value=${lesson.name}
                    onInput=${(event) => setLesson({ ...lesson, name: event.currentTarget.value })}
                />
                <input
                    placeholder="What it does, and when to use it"
                    value=${lesson.goal}
                    onInput=${(event) => setLesson({ ...lesson, goal: event.currentTarget.value })}
                />
                <div class="row">
                    <select
                        aria-label="Who learns it"
                        value=${lesson.bot}
                        onChange=${(event) => setLesson({ ...lesson, bot: event.currentTarget.value })}
                    >
                        <option value="">Every bot</option>
                        ${computerBots.map(
                            (session) =>
                                html`<option value=${session.bot.id}>${session.bot.name}</option>`,
                        )}
                    </select>
                    <button
                        class="button primary"
                        disabled=${lesson.name.trim() === "" || lesson.goal.trim() === ""}
                        onClick=${begin}
                    >
                        Start showing
                    </button>
                    <button class="button ghost" onClick=${() => setLesson(undefined)}>Cancel</button>
                </div>
            </div>`
        }
        ${saved && html`<p class="muted small">Saved in ${saved}. Bots find it with their skills; a routine can ask for it by name.</p>`}
        ${
            error?.status === 409 &&
            html`<div class="row">
                <button class="button" disabled=${restarting} onClick=${restart}>
                    ${restarting ? "Restarting…" : "Restart the computer"}
                </button>
                <span class="muted small">What bots are running on it stops.</span>
            </div>`
        }
        ${
            shot
                ? html`<img
                      class="desktop-shot"
                      ref=${image}
                      src=${shot}
                      alt="The computer's desktop"
                      onClick=${click}
                  />`
                : !error && html`<p class="muted small" role="status">Starting the computer…</p>`
        }
        <div class="row">
            <input
                placeholder="Type into the window under the mouse"
                value=${text}
                onInput=${(event) => setText(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && type()}
            />
            ${
                teaching &&
                html`<label class="group-member small">
                    <input
                        type="checkbox"
                        checked=${secret}
                        onChange=${() => setSecret(!secret)}
                    />
                    Secret
                </label>`
            }
            <button class="button" onClick=${type}>Type</button>
            <button class="button" onClick=${() => act({ action: "key", keys: "Return" })}>
                Enter
            </button>
            <button class="button ghost" onClick=${() => act({ action: "release" })}>
                Give back
            </button>
            ${
                !teaching &&
                lesson === undefined &&
                html`<button
                    class="button ghost"
                    onClick=${() => setLesson({ name: "", goal: "", bot: "" })}
                >
                    Teach a skill
                </button>`
            }
        </div>
    <//>`;
}
