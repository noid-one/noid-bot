// A bot's face as a Preact component: drawn by the shared WebGL renderer (renderer.js) when it can be, else as SVG.
// It reacts to the pointer (eyes follow it, a hover or a click gives a small boop), and its state comes from what the
// bot is doing.

import { h } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { traitsOf } from "./params.js";
import { attach, backingSize, supported } from "./renderer.js";
import { faceSvg } from "./svg.js";

let uids = 0;

/**
 * `id` is the bot's id (it seeds the face), `color` its color, `skin` and `eyes` the owner's picks (else from the id),
 * `state` one of STATES, `size` the CSS size in pixels, and `label` the accessible name (the bot's name).
 */
export function Face({
    id,
    color,
    skin,
    eyes,
    state = "idle",
    size = 32,
    label,
    class: className = "",
}) {
    const canvas = useRef(null);
    const controls = useRef(undefined);
    const [vector, setVector] = useState(() => !supported());
    const uid = useMemo(() => `f${(uids += 1).toString(36)}`, []);
    const pixels = backingSize(size);
    const options = { id, color, skin, eyes, state };

    useEffect(() => {
        if (vector || canvas.current === null) {
            return undefined;
        }

        controls.current = attach(canvas.current, options, () => setVector(true));

        if (controls.current === undefined) {
            setVector(true);
        }

        return () => {
            controls.current?.detach();
            controls.current = undefined;
        };
    }, [vector]);

    // A new size clears the canvas: it is drawn again then too.
    useEffect(() => {
        controls.current?.update(options);
    }, [id, color, skin, eyes, state, pixels]);

    const style = `width:${size}px;height:${size}px`;
    const common = {
        class: `noid-face ${className}`.trim(),
        role: "img",
        "aria-label": label ?? "bot",
        "data-state": state,
        onPointerEnter: () => controls.current?.boop(0.35),
        onClick: () => controls.current?.boop(0.9),
    };

    if (vector) {
        const markup = faceSvg(traitsOf(id, { color, skin, eyes }), state, uid);

        return h("span", { ...common, style, dangerouslySetInnerHTML: { __html: markup } });
    }

    return h("canvas", { ...common, ref: canvas, width: pixels, height: pixels, style });
}
