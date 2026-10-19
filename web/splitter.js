// The edge between two panes, dragged to resize the one it belongs to: the sidebar, the browser, the files tile. One
// handle for all three, so each drags, steps by keyboard, and resets the same way. The width lives in a CSS variable on
// the root while it moves, and is kept by `commit` once it stops.
import { html } from "./ui.js";

/** How far the arrow keys move the edge, and with Shift. */
const STEP = 16;
const BIG_STEP = 64;

/**
 * A vertical splitter on one edge of its parent. `edge` is the side it sits on: "right" grows the pane as it moves
 * right (a sidebar on the left), "left" as it moves left (a panel on the right). `min` and `max()` bound the pane's
 * width, `variable` is the CSS variable that sizes it, `commit(width)` keeps a width, and `reset()` puts back the usual
 * one (a double click, or Enter).
 */
export function Splitter({ edge, label, variable, min, max, commit, reset, className = "" }) {
    // The handle says where it is as it moves: it does not draw again while it does.
    const set = (handle, next) => {
        const value = Math.round(Math.min(max(), Math.max(min, next)));

        document.documentElement.style.setProperty(variable, `${value}px`);
        handle.setAttribute("aria-valuenow", String(value));

        return value;
    };

    const start = (event) => {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        const root = document.documentElement;
        const handle = event.currentTarget;
        const box = handle.parentElement.getBoundingClientRect();
        let value = 0;

        root.classList.add("resizing");

        const move = (each) => {
            value = set(
                handle,
                edge === "right" ? each.clientX - box.left : box.right - each.clientX,
            );
        };

        const stop = () => {
            root.classList.remove("resizing");
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", stop);
            removeEventListener("pointercancel", stop);

            if (value > 0) {
                commit(value);
            }
        };

        addEventListener("pointermove", move);
        addEventListener("pointerup", stop);
        addEventListener("pointercancel", stop);
    };

    // Back to the usual width: the next step measures it, as the handle no longer knows it.
    const back = (handle) => {
        reset();
        handle.removeAttribute("aria-valuenow");
    };

    const key = (event) => {
        const step = event.shiftKey ? BIG_STEP : STEP;
        // The key that points away from the pane widens it.
        const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
        const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
        // From where the last step set it: the pane may still be easing toward that width.
        const last = Number(event.currentTarget.getAttribute("aria-valuenow"));
        const now =
            last > 0 ? last : event.currentTarget.parentElement.getBoundingClientRect().width;
        const next =
            event.key === grow
                ? now + step
                : event.key === shrink
                  ? now - step
                  : event.key === "Home"
                    ? min
                    : event.key === "End"
                      ? max()
                      : undefined;

        if (event.key === "Enter") {
            event.preventDefault();
            back(event.currentTarget);
        } else if (next !== undefined) {
            event.preventDefault();
            commit(set(event.currentTarget, next));
        }
    };

    return html`<div
        class=${`splitter at-${edge} ${className}`}
        role="separator"
        tabindex="0"
        aria-label=${label}
        aria-orientation="vertical"
        aria-valuemin=${min}
        aria-valuemax=${Math.round(max())}
        onFocus=${(event) => {
            const handle = event.currentTarget;

            handle.setAttribute(
                "aria-valuenow",
                String(Math.round(handle.parentElement.getBoundingClientRect().width)),
            );
        }}
        title="Drag to resize · double-click to reset"
        onPointerDown=${start}
        onDblClick=${(event) => back(event.currentTarget)}
        onKeyDown=${key}
    ></div>`;
}
