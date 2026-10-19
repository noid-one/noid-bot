// noid: the shared computer's desktop, for the owner: what it shows, refreshed while it is in view, and the owner's own
// clicks and typing, which take it over from any bot for a while.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, attempt, closeSheet } from "../store.js";
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
    const image = useRef(null);

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

        void act({ action: "type", text });
        setText("");
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

    return html`<${Sheet} title="Computer desktop" onClose=${closeSheet} wide>
        <p class="muted small">
            Programs with windows that bots run on the shared computer.
            ${holder ? ` ${holder} is using it.` : " Nobody is using it."} A click or typing here
            takes it over from any bot for two minutes.
        </p>
        ${error && html`<p class="muted small" role="status">${error.message}</p>`}
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
            <button class="button" onClick=${type}>Type</button>
            <button class="button" onClick=${() => act({ action: "key", keys: "Return" })}>
                Enter
            </button>
            <button class="button ghost" onClick=${() => act({ action: "release" })}>
                Give back
            </button>
        </div>
    <//>`;
}
