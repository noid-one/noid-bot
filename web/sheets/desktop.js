// noid: the shared computer's desktop, for the owner, as a page in the conversation's place: what it shows, refreshed
// while it is in view, and the owner's own clicks and typing, which take it over from any bot for a while.
import { useRef, useState } from "preact/hooks";
import { usePoll } from "../poll.js";
import { api, attempt, store } from "../store.js";
import { ToolFrame } from "../tool-page.js";
import { html, Icon } from "../ui.js";
import { onComputer } from "./terminal.js";

const WIDTH = 1280;
const HEIGHT = 800;
/** How often the picture is refreshed, and how long to wait after a failure. */
const EVERY_MS = 1500;
const AFTER_FAILURE_MS = 6000;

/**
 * What the owner can open on the desktop with a tap: it has no window manager or wallpaper, so with nothing open it is
 * all black. The browser has a profile of its own, apart from the bots' browser on its own display.
 */
const PROGRAMS = [
    { label: "Terminal window", icon: "terminal", command: "xterm" },
    {
        label: "Browser",
        icon: "globe",
        command:
            "chromium --no-sandbox --no-first-run --user-data-dir=/tmp/desktop-browser --window-position=0,0 --window-size=1280,800 about:blank",
    },
];

/** Whether a screenshot is all black: nothing open on the desktop. Read from a small copy, so it is cheap. */
async function isBlank(source) {
    const picture = new Image();

    picture.src = source;
    await picture.decode();

    const canvas = document.createElement("canvas");

    canvas.width = 64;
    canvas.height = 40;

    const context = canvas.getContext("2d", { willReadFrequently: true });

    context.drawImage(picture, 0, 0, 64, 40);

    const pixels = context.getImageData(0, 0, 64, 40).data;

    for (let at = 0; at < pixels.length; at += 4) {
        if (pixels[at] + pixels[at + 1] + pixels[at + 2] > 24) {
            return false;
        }
    }

    return true;
}

export function DesktopPage() {
    const [shot, setShot] = useState(undefined);
    const [blank, setBlank] = useState(false);
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
        (session) => session.bot !== undefined && !session.archived && onComputer(session.cwd),
    );

    usePoll(
        async (gone) => {
            try {
                const view = await api("desktop");

                if (gone()) {
                    return false;
                }

                const source = `data:image/png;base64,${view.image}`;

                setShot(source);
                setBlank(await isBlank(source).catch(() => false));
                setHolder(view.holder);
                setTeaching(view.teaching);
                setError(undefined);
            } catch (failure) {
                setError({ status: failure.status, message: failure.message });

                // Only the owner sees it: anyone else has nothing to wait for.
                if (failure.status === 403) {
                    return false;
                }

                throw failure;
            }

            return true;
        },
        { every: EVERY_MS, afterFailure: AFTER_FAILURE_MS },
    );

    const act = (input) => attempt(() => api("desktop/input", input));

    // Opened by the owner: it shows at the next picture, and is closed when the desktop is given back.
    const open = (command) => {
        setBlank(false);
        void act({ action: "open", command });
    };

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

    return html`<${ToolFrame}
        kind="desktop"
        title="Desktop"
        sub=${`${holder ? `${holder} is using it` : "Nobody is using it"} · a click or typing here takes it over for two minutes`}
        actions=${html`${PROGRAMS.map(
            (program) => html`<button
                class="button ghost small"
                title=${`Open a ${program.label.toLowerCase()} on the desktop`}
                onClick=${() => open(program.command)}
            >
                <${Icon} name=${program.icon} size=${14} />
                ${program.label}
            </button>`,
        )}
        <button
            class="button ghost small"
            title="Let the bots have it again; what you opened closes"
            onClick=${() => act({ action: "release" })}
        >
            Give back
        </button>`}
    >
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
                ? html`<div class="desktop-frame">
                      <img
                          class="desktop-shot"
                          ref=${image}
                          src=${shot}
                          alt="The computer's desktop"
                          onClick=${click}
                      />
                      ${
                          blank &&
                          html`<div class="desktop-empty">
                              <${Icon} name="monitor" size=${28} />
                              <strong>Nothing is open on the desktop</strong>
                              <span>
                                  Programs with windows that bots start show here, and you can use
                                  them too. Open one:
                              </span>
                              <div class="row">
                                  ${PROGRAMS.map(
                                      (program) => html`<button
                                          class="button"
                                          onClick=${() => open(program.command)}
                                      >
                                          <${Icon} name=${program.icon} size=${16} />
                                          ${program.label}
                                      </button>`,
                                  )}
                              </div>
                          </div>`
                      }
                  </div>`
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
                html`<label class="check-label small">
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
