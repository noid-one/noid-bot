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
 * What the owner can open on the desktop with a tap. The browser is the computer's one, which the bots use too (a tab
 * each): this starts it, or brings it to the front.
 */
const PROGRAMS = [
    {
        label: "Terminal window",
        icon: "terminal",
        // Dark, as the app's own terminal, in color (bash colors its prompt for a 256-color terminal), and the whole
        // screen with the keys: with no window manager, xdotool finds it by a class name of its own (bash's prompt
        // changes its title), sizes it, and focuses it.
        command:
            "xterm -tn xterm-256color -fa 'DejaVu Sans Mono' -fs 11 -bg '#16161e' -fg '#c0caf5' -cr '#7aa2f7' -b 6 -name term-$$ & w=$!; xdotool search --sync --onlyvisible --classname ^term-$$$ windowmove 0 0 windowsize 1280 800 windowfocus; wait $w",
    },
    {
        label: "Browser",
        icon: "globe",
        command: "noid-browser",
    },
];

/** Whether a screenshot is all black: nothing open on the desktop. Read from a small copy, so it is cheap. */
/** The small canvas `isBlank` reads a screen in, made once. */
let blankCanvas;

async function isBlank(source) {
    const picture = new Image();

    picture.src = source;
    await picture.decode();

    blankCanvas ??= Object.assign(document.createElement("canvas"), { width: 64, height: 40 });

    const context = blankCanvas.getContext("2d", { willReadFrequently: true });

    context.drawImage(picture, 0, 0, 64, 40);

    const pixels = context.getImageData(0, 0, 64, 40).data;

    // The taskbar along the bottom (its last rows here) is always there: the screen above it is what counts.
    for (let at = 0; at < 64 * 37 * 4; at += 4) {
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
    // Whether the owner holds it now, and has programs open on it: only then is there anything to be done with.
    const [yours, setYours] = useState(false);
    const [opened, setOpened] = useState(false);
    const [error, setError] = useState(undefined);
    const [focused, setFocused] = useState(false);
    const [restarting, setRestarting] = useState(false);
    // A demonstration: under way (from the server), the form to start one, and where the last one was saved.
    const [teaching, setTeaching] = useState(null);
    const [lesson, setLesson] = useState(undefined);
    const [saved, setSaved] = useState(undefined);
    // While showing: what is typed now is a secret, typed but never kept in the skill.
    const [secret, setSecret] = useState(false);
    // Signing in for the bots: the site asked for, then where it opened ({ where, url }): on this desktop
    // ("desktop"), in the owner's own Chrome when the bots use that ("chrome"), in it to bring the sign-in here after
    // ("bring"), or brought ("brought"). Some sites refuse a sign-in here (X does, from a container) and take one in
    // the owner's Chrome: with it there (noid in WSL), either way is on offer, first or after trying here.
    const [site, setSite] = useState(undefined);
    const [signingIn, setSigningIn] = useState(null);
    const [chrome, setChrome] = useState(false);
    const image = useRef(null);
    const frame = useRef(null);
    // The refresh loop: when the last input went out, and how to wake it for a picture now.
    const lastInput = useRef(0);
    const wake = useRef(() => {});
    // Inputs go out one after another, in the order they were made.
    const queue = useRef(Promise.resolve());
    // Letters typed: sent together a moment later, so a word is one request, not one per key.
    const typed = useRef({ text: "", timer: 0 });
    const press = useRef(null);
    const wheel = useRef(0);
    // The screen last shown: one that has not changed is not decoded again (four times a second while busy).
    const shown = useRef("");
    const [starting, setStarting] = useState(false);
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

                        if (view.image !== shown.current) {
                            const source = `data:image/png;base64,${view.image}`;

                            shown.current = view.image;
                            setShot(source);
                            setBlank(await isBlank(source).catch(() => false));
                        }

                        setHolder(view.holder);
                        setYours(view.yours);
                        setOpened(view.opened);
                        setTeaching(view.teaching);
                        setChrome(view.chrome === true);
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

    // Opened by the owner: it shows at the next picture, and closes when you are done with the desktop. Keys go to the
    // screen, where the program is.
    const open = (command) => {
        setBlank(false);
        frame.current?.focus({ preventScroll: true });
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
        // A button over the screen (the programs to open on an empty desktop) is the page's, not the desktop's: holding
        // the pointer here would take its click away.
        if (event.button !== 0 || event.target.closest?.("button")) {
            return;
        }

        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        // A drag let go past the screen's edge still ends, at the edge.
        event.currentTarget.setPointerCapture?.(event.pointerId);
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
                void act({
                    action: "type",
                    text: text.slice(from, from + 1000),
                    // A pasted password (from a password manager) is as secret as a typed one.
                    ...(teaching && secret ? { secret: true } : {}),
                });
            }
        }
    };

    const signIn = (url, inChrome) =>
        attempt(async () => {
            const { where } = await api("desktop/input", {
                action: "signin",
                url,
                ...(inChrome ? { in: "chrome" } : {}),
            });

            setSigningIn({ where: where ?? "desktop", url: url.trim() });
            setSite(undefined);
            wake.current();
        });

    const bring = () =>
        attempt(async () => {
            const { copied } = await api("desktop/input", { action: "bring", url: signingIn.url });

            if (!copied) {
                throw new Error(
                    `You're not signed in to ${signingIn.url} in Chrome yet: sign in there first.`,
                );
            }

            setSigningIn({ where: "brought", url: signingIn.url });
            wake.current();
        });

    const restart = () =>
        attempt(async () => {
            setRestarting(true);

            try {
                await api("computer/restart", {});
            } finally {
                setRestarting(false);
            }
        });

    const begin = () => {
        setStarting(true);
        attempt(async () => {
            await api("desktop/teach", lesson);
            setTeaching({ name: lesson.name, steps: 0 });
            setLesson(undefined);
            setSaved(undefined);
        }).finally(() => setStarting(false));
    };

    const finish = (save) =>
        attempt(async () => {
            const result = await api("desktop/learned", { save });

            setTeaching(null);
            setSaved(result.folder);
        });

    return html`<${ToolFrame}
        kind="desktop"
        title="Desktop"
        sub=${
            yours
                ? "You're using it · bots can have it when you're done, or two minutes after you last use it"
                : `${holder ? `${holder} is using it` : "Nobody is using it"} · a click or typing here takes it over for two minutes`
        }
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
        ${
            teaching
                ? html`<span class="recording small" role="status">
                      <span class="record-dot" aria-hidden="true"></span>
                      Recording · ${teaching.steps} step${teaching.steps === 1 ? "" : "s"}
                  </span>`
                : html`<button
                      class="button ghost small"
                      title="Do a task here and keep it as a skill the bots can repeat"
                      aria-expanded=${lesson !== undefined}
                      onClick=${() =>
                          setLesson(
                              lesson === undefined ? { name: "", goal: "", bot: "" } : undefined,
                          )}
                  >
                      <span class="record-dot" aria-hidden="true"></span>
                      Record a skill
                  </button>`
        }
        ${
            !teaching &&
            !signingIn &&
            html`<button
                class="button ghost small"
                title="Sign in to a site by hand, here or in your Chrome: the bots share the computer's browser's sign-ins"
                aria-expanded=${site !== undefined}
                onClick=${() => setSite(site === undefined ? "" : undefined)}
            >
                <${Icon} name="key" size=${14} />
                Sign in for the bots
            </button>`
        }
        ${
            (yours || opened) &&
            !teaching &&
            html`<button
                class="button ghost small"
                title="Close what you opened, and let the bots have the desktop now"
                onClick=${() => {
                    setYours(false);
                    setOpened(false);
                    setSigningIn(null);
                    void act({ action: "release" });
                }}
            >
                I'm done
            </button>`
        }`}
    >
        ${error && html`<p class="muted small" role="status">${error.message}</p>`}
        ${
            teaching &&
            html`<div class="row teach-banner">
                <span class="grow small">
                    Recording “${teaching.name}”. What you do on the screen is kept, and how it looked before
                    and after is saved with the skill: close anything private before you save.
                </span>
                <button class="button primary small" onClick=${() => finish(true)}>
                    Stop and save
                </button>
                <button class="button ghost small" onClick=${() => finish(false)}>Discard</button>
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
                        disabled=${starting || lesson.name.trim() === "" || lesson.goal.trim() === ""}
                        onClick=${begin}
                    >
                        Start recording
                    </button>
                    <button class="button ghost" onClick=${() => setLesson(undefined)}>Cancel</button>
                </div>
            </div>`
        }
        ${
            site !== undefined &&
            html`<form
                class="row"
                onSubmit=${(event) => {
                    event.preventDefault();
                    void signIn(site, false);
                }}
            >
                <input
                    class="grow"
                    placeholder="Site to sign in to, such as x.com"
                    value=${site}
                    onInput=${(event) => setSite(event.currentTarget.value)}
                />
                <button
                    class="button primary"
                    disabled=${site.trim() === ""}
                    title="Open it in the computer's browser, below, and sign in there"
                >
                    Open here
                </button>
                ${
                    chrome &&
                    html`<button
                        class="button"
                        type="button"
                        disabled=${site.trim() === ""}
                        title="Some sites won't let you sign in on this desktop: sign in in Chrome on your computer, then bring the sign-in here"
                        onClick=${() => signIn(site, true)}
                    >
                        Use my Chrome
                    </button>`
                }
                <button class="button ghost" type="button" onClick=${() => setSite(undefined)}>
                    Cancel
                </button>
            </form>`
        }
        ${
            signingIn?.where === "desktop" &&
            html`<div class="row teach-banner">
                <span class="grow small">
                    It's open in the computer's browser below, which the bots use too: sign in by hand, as in any
                    browser, and they have the sign-in as soon as you do.
                    ${chrome && " Won't it let you in here? Use your Chrome instead."}
                </span>
                ${
                    chrome &&
                    html`<button
                        class="button ghost small"
                        title="Sign in in Chrome on your computer, then bring the sign-in here"
                        onClick=${() => signIn(signingIn.url, true)}
                    >
                        Use my Chrome
                    </button>`
                }
                <button class="button ghost small" onClick=${() => setSigningIn(null)}>OK</button>
            </div>`
        }
        ${
            signingIn?.where === "bring" &&
            html`<div class="row teach-banner">
                <span class="grow small">
                    It opened in Chrome on your computer: sign in there, as in any browser (signed in already? Then
                    there's nothing to do), and bring the sign-in here. Only ${signingIn.url}'s sign-in comes,
                    nothing else of yours.
                </span>
                <button class="button primary small" onClick=${bring}>Bring it here</button>
                <button class="button ghost small" onClick=${() => setSigningIn(null)}>Cancel</button>
            </div>`
        }
        ${
            signingIn?.where === "brought" &&
            html`<div class="row teach-banner">
                <span class="grow small">
                    You're signed in to ${signingIn.url} here now, and the bots are too. Should it ask you to sign
                    in again, do the same. Signing out in either browser signs out both.
                </span>
                <button class="button ghost small" onClick=${() => setSigningIn(null)}>OK</button>
            </div>`
        }
        ${
            signingIn?.where === "chrome" &&
            html`<div class="row teach-banner">
                <span class="grow small">
                    It opened in the bots' Chrome on your computer: sign in there, as in any browser. The bots
                    have the sign-in as soon as you do.
                </span>
                <button class="button ghost small" onClick=${() => setSigningIn(null)}>OK</button>
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
                      ref=${frame}
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
        </div>
    <//>`;
}
