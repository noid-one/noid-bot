// noid: the shared computer's desktop, for the owner, as a page in the conversation's place: what it shows, and the
// owner's own mouse and keys on it, which take it over from any bot for a while. Used as a screen is: a click, a
// right click, a drag, the wheel, and keys typed while it has the focus. Each goes out in order, a fresh picture comes
// right after, and pictures come a few times a second while it is in use (every 1.5 s when it is not).
import { useEffect, useRef, useState } from "preact/hooks";
import { api, attempt, store } from "../store.js";
import { ToolFrame } from "../tool-page.js";
import { html, Icon } from "../ui.js";
import { onComputer } from "./terminal.js";

const WIDTH = 1280;
const HEIGHT = 800;
/** How often the picture is refreshed: while in use (for a while after the last input), at rest, after a failure. */
const BUSY_MS = 250;
const BUSY_FOR_MS = 6000;
const EVERY_MS = 1500;
const AFTER_FAILURE_MS = 6000;
/** How far the pointer moves before a press is a drag, in screen pixels; how much wheel is one step. */
const DRAG_PX = 6;
const WHEEL_STEP = 60;

/** Keys by their names in the browser, as xdotool calls them; a printable key not here is typed as text. */
const KEYS = {
    Enter: "Return",
    Backspace: "BackSpace",
    Tab: "Tab",
    Escape: "Escape",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "Prior",
    PageDown: "Next",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    ArrowDown: "Down",
    " ": "space",
    "/": "slash",
    ".": "period",
    ",": "comma",
    "-": "minus",
    "=": "equal",
    ";": "semicolon",
    "'": "apostrophe",
    "[": "bracketleft",
    "]": "bracketright",
    "\\": "backslash",
    "`": "grave",
};

/** A key pressed with Ctrl, Alt, or the Super key, or one that types nothing, as xdotool's: ctrl+a, Return, F5. */
function keysOf(event) {
    const base =
        KEYS[event.key] ??
        (/^F\d{1,2}$/.test(event.key) ? event.key : null) ??
        (/^[a-z0-9]$/i.test(event.key) ? event.key.toLowerCase() : null);

    if (base === null) {
        return null;
    }

    return [
        event.ctrlKey && "ctrl",
        event.altKey && "alt",
        event.metaKey && "super",
        event.shiftKey && base.length > 1 && "shift",
        base,
    ]
        .filter(Boolean)
        .join("+");
}

/**
 * What the owner can open on the desktop with a tap: it has no window manager or wallpaper, so with nothing open it is
 * all black. The browser has a profile of its own, apart from the bots' browser on its own display.
 */
const PROGRAMS = [
    {
        label: "Terminal window",
        icon: "terminal",
        // Dark, as the app's own terminal, and the whole screen: with no window manager, xdotool finds it by a
        // class name of its own (bash's prompt changes its title) and sizes it.
        command:
            "xterm -fa 'DejaVu Sans Mono' -fs 11 -bg '#16161e' -fg '#c0caf5' -cr '#7aa2f7' -b 6 -name term-$$ & w=$!; xdotool search --sync --onlyvisible --classname ^term-$$$ windowmove 0 0 windowsize 1280 800; wait $w",
    },
    {
        label: "Browser",
        icon: "globe",
        command:
            "chromium --no-sandbox --test-type --no-first-run --user-data-dir=/tmp/desktop-browser --window-position=0,0 --window-size=1280,800 https://www.google.com",
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
    const [focused, setFocused] = useState(false);
    const [restarting, setRestarting] = useState(false);
    // A demonstration: under way (from the server), the form to start one, and where the last one was saved.
    const [teaching, setTeaching] = useState(null);
    const [lesson, setLesson] = useState(undefined);
    const [saved, setSaved] = useState(undefined);
    // While showing: what is typed now is a secret, typed but never kept in the skill.
    const [secret, setSecret] = useState(false);
    const image = useRef(null);
    // The refresh loop: when the last input went out, and how to wake it for a picture now.
    const lastInput = useRef(0);
    const wake = useRef(() => {});
    // Inputs go out one after another, in the order they were made.
    const queue = useRef(Promise.resolve());
    // Letters typed: sent together a moment later, so a word is one request, not one per key.
    const typed = useRef({ text: "", timer: 0 });
    const press = useRef(null);
    const wheel = useRef(0);
    const computerBots = store.state.sessions.filter(
        (session) => session.bot !== undefined && !session.archived && onComputer(session.cwd),
    );

    useEffect(() => {
        let gone = false;

        void (async () => {
            while (!gone) {
                let next = Date.now() - lastInput.current < BUSY_FOR_MS ? BUSY_MS : EVERY_MS;

                if (!document.hidden) {
                    try {
                        const view = await api("desktop");

                        if (gone) {
                            return;
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
                            return;
                        }

                        next = AFTER_FAILURE_MS;
                    }
                }

                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, next);

                    wake.current = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                });
            }
        })();

        return () => {
            gone = true;
            wake.current();
        };
    }, []);

    /** Send an input after those before it, then look at once. */
    const act = (input) => {
        lastInput.current = Date.now();
        queue.current = queue.current
            .then(() => attempt(() => api("desktop/input", input)))
            .then(() => wake.current());

        return queue.current;
    };

    const flushTyped = () => {
        const { text } = typed.current;

        clearTimeout(typed.current.timer);
        typed.current = { text: "", timer: 0 };

        if (text !== "") {
            void act({ action: "type", text, ...(teaching && secret ? { secret: true } : {}) });
        }
    };

    const typeText = (text) => {
        typed.current.text += text;
        clearTimeout(typed.current.timer);
        typed.current.timer = setTimeout(flushTyped, 60);
    };

    // Opened by the owner: it shows at the next picture, and is closed when the desktop is given back.
    const open = (command) => {
        setBlank(false);
        void act({ action: "open", command });
    };

    /** Where a pointer event is on the screen, in its own pixels. */
    const at = (event) => {
        const box = image.current.getBoundingClientRect();

        return {
            x: Math.max(
                0,
                Math.min(WIDTH - 1, Math.round(((event.clientX - box.left) / box.width) * WIDTH)),
            ),
            y: Math.max(
                0,
                Math.min(HEIGHT - 1, Math.round(((event.clientY - box.top) / box.height) * HEIGHT)),
            ),
        };
    };

    const onPointerDown = (event) => {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        press.current = { ...at(event), clientX: event.clientX, clientY: event.clientY };
    };

    const onPointerUp = (event) => {
        const start = press.current;

        press.current = null;

        if (start === null || event.button !== 0) {
            return;
        }

        flushTyped();

        const end = at(event);
        const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);

        void act(
            moved > DRAG_PX
                ? { action: "drag", x: start.x, y: start.y, to_x: end.x, to_y: end.y }
                : { action: "click", x: end.x, y: end.y },
        );
    };

    const onContextMenu = (event) => {
        event.preventDefault();
        flushTyped();
        void act({ action: "right_click", ...at(event) });
    };

    const onWheel = (event) => {
        event.preventDefault();
        wheel.current += event.deltaY;

        const steps = Math.trunc(wheel.current / WHEEL_STEP);

        if (steps !== 0) {
            wheel.current -= steps * WHEEL_STEP;
            void act({ action: "scroll", ...at(event), dy: Math.max(-50, Math.min(50, steps)) });
        }
    };

    const onKeyDown = (event) => {
        if (
            event.isComposing ||
            ["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)
        ) {
            return;
        }

        const mod = event.ctrlKey || event.metaKey;

        // Paste comes as its own event, with the text.
        if (mod && !event.altKey && event.key.toLowerCase() === "v") {
            return;
        }

        if (event.key.length === 1 && !mod && !event.altKey) {
            event.preventDefault();
            typeText(event.key);

            return;
        }

        const keys = keysOf(event);

        if (keys !== null) {
            event.preventDefault();
            flushTyped();
            void act({ action: "key", keys });
        }
    };

    const onPaste = (event) => {
        const text = event.clipboardData?.getData("text") ?? "";

        event.preventDefault();

        if (text !== "") {
            flushTyped();

            for (let from = 0; from < text.length; from += 1000) {
                void act({ action: "type", text: text.slice(from, from + 1000) });
            }
        }
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
                ? html`<div
                      class=${`desktop-frame ${focused ? "focused" : ""}`}
                      tabindex="0"
                      role="application"
                      aria-label="The computer's desktop: click it, then type"
                      onPointerDown=${onPointerDown}
                      onPointerUp=${onPointerUp}
                      onContextMenu=${onContextMenu}
                      onWheel=${onWheel}
                      onKeyDown=${onKeyDown}
                      onPaste=${onPaste}
                      onFocus=${() => setFocused(true)}
                      onBlur=${() => {
                          flushTyped();
                          setFocused(false);
                      }}
                  >
                      <img
                          class="desktop-shot"
                          ref=${image}
                          src=${shot}
                          alt=""
                          draggable="false"
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
        <div class="row desktop-foot">
            <span class="grow muted small">
                ${
                    focused
                        ? "Your keys go to the desktop. Click outside it to stop."
                        : "Click the screen to use it: clicks, right clicks, drags, the wheel, and keys."
                }
            </span>
            ${
                teaching &&
                html`<label class="check-label small">
                    <input
                        type="checkbox"
                        checked=${secret}
                        onChange=${() => setSecret(!secret)}
                    />
                    What I type is secret
                </label>`
            }
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
