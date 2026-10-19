// The edge between two panes, dragged to resize the one it belongs to: the sidebar, the browser, and the files tile.
// One handle for all, so each drags, steps by keyboard, and resets the same way. The size lives
// in a CSS variable on the root while it moves, and is kept by `commit` once it stops.
import { html } from "./ui.js";

/** How far the arrow keys move the edge, and with Shift. */
const STEP = 16;
const BIG_STEP = 64;

/** Per edge: the key that grows the pane (pointing away from it), and the one that shrinks it. */
const EDGES = {
    right: { grow: "ArrowRight", shrink: "ArrowLeft" },
    left: { grow: "ArrowLeft", shrink: "ArrowRight" },
};

/** How wide the pane is as a pointer at `x` would make it, from the pane's box. */
const reach = (edge, box, x) => (edge === "right" ? x - box.left : box.right - x);

/**
 * A splitter on one edge of a pane. `edge` is the side it sits on: "right" grows the pane as it moves right (a sidebar
 * on the left), "left" as it moves left (a panel on the right). The
 * pane is the handle's parent unless `of(handle)` names another. `min` and `max()` bound its size, `variable` is the CSS
 * variable that sizes it, `commit(size)` keeps a size, and `reset()` puts back the usual one (a double click, or Enter).
 */
export function Splitter({
    edge,
    label,
    variable,
    min,
    max,
    commit,
    reset,
    of = (handle) => handle.parentElement,
    className = "",
}) {
    const { grow, shrink } = EDGES[edge];
    const measure = (handle) => of(handle).getBoundingClientRect().width;

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
        const box = of(handle).getBoundingClientRect();
        let value = 0;

        root.classList.add("resizing");

        const move = (each) => {
            value = set(handle, reach(edge, box, each.clientX));
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

    // Back to the usual size: the next step measures it, as the handle no longer knows it.
    const back = (handle) => {
        reset();
        handle.removeAttribute("aria-valuenow");
    };

    const key = (event) => {
        const step = event.shiftKey ? BIG_STEP : STEP;
        // From where the last step set it: the pane may still be easing toward that size.
        const last = Number(event.currentTarget.getAttribute("aria-valuenow"));
        const now = last > 0 ? last : measure(event.currentTarget);
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
        onFocus=${(event) =>
            event.currentTarget.setAttribute(
                "aria-valuenow",
                String(Math.round(measure(event.currentTarget))),
            )}
        title="Drag to resize · double-click to reset"
        onPointerDown=${start}
        onDblClick=${(event) => back(event.currentTarget)}
        onKeyDown=${key}
    ></div>`;
}
