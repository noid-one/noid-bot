// One WebGL2 renderer for every face on screen. Browsers allow only a few WebGL contexts per page, and a bots list can
// show dozens of faces, so each face gets a plain 2D canvas and this renderer draws them in turn on one hidden WebGL
// canvas, copying each frame into the face's own. Faces off screen, and every face while the page is hidden, are not
// drawn. Without WebGL2 (or after the context is lost for good), faces fall back to SVG (face.js).

import { createMotion, DONE_SECONDS } from "./motion.js";
import { EYES, SKINS, traitsOf } from "./params.js";
import { FRAGMENT, VERTEX } from "./shader.js";

/** Frames per second faces animate at: smooth enough for breathing and blinks, light on batteries. */
const FPS = 30;

/**
 * Frames per second while every face in sight rests (idle or asleep) and the pointer is still: breathing and the
 * shimmer are slow enough for it, and a page left open costs a third as much. Work, a change, or the pointer brings
 * back the full rate at once.
 */
const RESTING_FPS = 10;
/** And once nothing has moved for a while (a page left open): breathing still reads at this rate. */
const DROWSY_FPS = 4;
const DROWSY_AFTER_MS = 20_000;
const AT_REST = new Set(["idle", "asleep"]);
/** How long after the pointer moves the eyes may still be following it. */
const POINTER_SETTLE_MS = 1500;

/** The largest backing-store scale used, so a 4x screen does not draw 16 times the pixels. */
const MAX_SCALE = 2;

/** How far from a face, in face widths, its eyes still follow the pointer. */
const POINTER_REACH = 8;

/** Glow colors for states that want attention: amber when a bot waits for you, red when it failed. */
const GLOW_TONES = [undefined, [1, 0.72, 0.25], [1, 0.38, 0.36]];

const UNIFORMS = [
    "u_resolution",
    "u_clock",
    "u_time",
    "u_ripple",
    "u_amp",
    "u_phase",
    "u_roundness",
    "u_aspect",
    "u_offset",
    "u_squash",
    "u_tilt",
    "u_base",
    "u_light",
    "u_dark",
    "u_eyeColor",
    "u_glowColor",
    "u_glow",
    "u_dim",
    "u_open",
    "u_look",
    "u_smile",
    "u_sad",
    "u_eyeHeight",
    "u_eyeGap",
    "u_skin",
    "u_eyes",
];

let renderer;

/** Whether this page can draw faces with WebGL2. */
export function supported() {
    return getRenderer() !== undefined;
}

function getRenderer() {
    if (renderer === undefined && typeof document !== "undefined") {
        renderer = createRenderer() ?? null;
    }

    return renderer ?? undefined;
}

function compile(gl, type, source) {
    const shader = gl.createShader(type);

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("[faces] shader:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);

        return undefined;
    }

    return shader;
}

function createProgram(gl) {
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);

    if (vertex === undefined || fragment === undefined) {
        return undefined;
    }

    const program = gl.createProgram();

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("[faces] program:", gl.getProgramInfoLog(program));

        return undefined;
    }

    const locations = {};

    for (const name of UNIFORMS) {
        locations[name] = gl.getUniformLocation(program, name);
    }

    return { program, locations };
}

function createRenderer() {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        preserveDrawingBuffer: true,
        powerPreference: "low-power",
    });

    if (gl === null) {
        return undefined;
    }

    let built = createProgram(gl);

    if (built === undefined) {
        return undefined;
    }

    const faces = new Set();
    const pointer = { x: 0, y: 0, known: false, at: 0 };
    const systemReduced = matchMedia("(prefers-reduced-motion: reduce)");

    // Appearance → Motion, which theme.js puts on the root (Auto follows the system's setting there); before it has,
    // the system's.
    const reduced = () => {
        const motion = document.documentElement.dataset.motion;

        return motion === undefined ? systemReduced.matches : motion === "reduced";
    };

    // The setting changed: each face moves, or keeps still, from now on, as it is. theme.js writes the attribute with
    // every appearance change, the same value too: only a real change starts the faces anew.
    let wasReduced = reduced();

    new MutationObserver(() => {
        const still = reduced();

        if (still === wasReduced) {
            return;
        }

        wasReduced = still;
        const now = performance.now() / 1000;

        for (const face of faces) {
            const state = face.motion.state;

            face.motion = createMotion(face.traits, { reducedMotion: still });
            face.motion.setState(state, now);
            face.dirty = true;

            // Kept still, a face is drawn only on a change: one in its happy moment is drawn again as it ends.
            if (still && state === "done") {
                setTimeout(
                    () => {
                        face.dirty = true;
                        schedule();
                    },
                    DONE_SECONDS * 1000 + 50,
                );
            }
        }

        schedule();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    let frame = 0;
    /** While every face rests: the wait for the next frame, so no frame is asked for in between. */
    let resting = 0;
    let lastDraw = 0;
    let lost = false;
    const fallbacks = new Set();

    const visibility = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const face = entry.target.noidFace;

            if (face !== undefined) {
                face.visible = entry.isIntersecting;
                face.dirty = true;
            }
        }

        schedule();
    });

    addEventListener(
        "pointermove",
        (event) => {
            pointer.x = event.clientX;
            pointer.y = event.clientY;
            pointer.known = true;
            pointer.at = performance.now();
            // The eyes follow it: back to the full rate now, not at the next resting frame.
            schedule();
        },
        { passive: true },
    );
    document.addEventListener("pointerleave", () => {
        pointer.known = false;
    });
    document.addEventListener("visibilitychange", schedule);

    canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        lost = true;
        cancelAnimationFrame(frame);
        frame = 0;
    });
    canvas.addEventListener("webglcontextrestored", () => {
        built = createProgram(gl);
        lost = built === undefined;

        if (lost) {
            for (const fallback of fallbacks) {
                fallback();
            }
        }

        for (const face of faces) {
            face.dirty = true;
        }

        schedule();
    });

    /** Whether some face is on screen: with none, no frames are asked for (seeing one again asks). */
    function anyVisible() {
        for (const face of faces) {
            if (face.visible) {
                return true;
            }
        }

        return false;
    }

    function schedule() {
        if (frame === 0 && !lost && document.visibilityState !== "hidden" && anyVisible()) {
            frame = requestAnimationFrame(tick);
        }
    }

    function pointerFor(face) {
        if (!pointer.known) {
            return undefined;
        }

        const box = face.canvas.getBoundingClientRect();

        if (box.width === 0) {
            return undefined;
        }

        const dx = (pointer.x - (box.left + box.width / 2)) / box.width;
        const dy = (pointer.y - (box.top + box.height / 2)) / box.height;

        return Math.hypot(dx, dy) > POINTER_REACH ? undefined : [dx, dy];
    }

    function draw(face, clock) {
        const { traits, motion, context, canvas: target } = face;
        const pose = motion.pose;
        const width = target.width;
        const height = target.height;
        const { locations } = built;
        const palette = traits.palette;
        const glowColor = GLOW_TONES[pose.glowTone] ?? palette.glow;

        if (canvas.width < width || canvas.height < height) {
            canvas.width = Math.max(canvas.width, width);
            canvas.height = Math.max(canvas.height, height);
        }

        gl.viewport(0, 0, width, height);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, width, height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(built.program);
        gl.uniform2f(locations.u_resolution, width, height);
        gl.uniform1f(locations.u_clock, clock);
        gl.uniform1f(locations.u_time, pose.time);
        gl.uniform1f(locations.u_ripple, pose.ripple);
        gl.uniform3f(locations.u_amp, ...traits.wobble.map((wave) => wave.amplitude));
        gl.uniform3f(locations.u_phase, ...traits.wobble.map((wave) => wave.phase));
        gl.uniform1f(locations.u_roundness, traits.roundness);
        gl.uniform1f(locations.u_aspect, traits.aspect);
        gl.uniform2f(locations.u_offset, pose.offset[0], pose.offset[1]);
        gl.uniform2f(locations.u_squash, pose.squash[0], pose.squash[1]);
        gl.uniform1f(locations.u_tilt, pose.tilt);
        gl.uniform3f(locations.u_base, ...palette.base);
        gl.uniform3f(locations.u_light, ...palette.light);
        gl.uniform3f(locations.u_dark, ...palette.dark);
        gl.uniform3f(locations.u_eyeColor, ...palette.eye);
        gl.uniform3f(locations.u_glowColor, ...glowColor);
        gl.uniform1f(locations.u_glow, pose.glow);
        gl.uniform1f(locations.u_dim, pose.dim);
        gl.uniform1f(locations.u_open, pose.open);
        gl.uniform2f(locations.u_look, pose.look[0], pose.look[1]);
        gl.uniform1f(locations.u_smile, pose.smile);
        gl.uniform1f(locations.u_sad, pose.sad);
        gl.uniform1f(locations.u_eyeHeight, traits.eyeHeight);
        gl.uniform1f(locations.u_eyeGap, traits.eyeGap);
        gl.uniform1i(locations.u_skin, SKINS.indexOf(traits.skin));
        gl.uniform1i(locations.u_eyes, EYES.indexOf(traits.eyes));
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // GL's origin is bottom-left; the region drawn is the canvas's bottom `height` rows.
        context.clearRect(0, 0, width, height);
        context.drawImage(canvas, 0, canvas.height - height, width, height, 0, 0, width, height);
    }

    function tick(now) {
        frame = 0;

        if (lost || document.visibilityState === "hidden") {
            return;
        }

        const elapsed = now - lastDraw;
        const still = reduced();

        // A face off screen that changed is drawn when it shows again: it does not lift the frame cap meanwhile.
        let dirty = false;
        let calm = now - pointer.at > POINTER_SETTLE_MS;

        for (const face of faces) {
            dirty ||= face.visible && face.dirty;
            calm &&= !face.visible || AT_REST.has(face.motion.state);
        }

        const fps = !calm ? FPS : now - pointer.at > DROWSY_AFTER_MS ? DROWSY_FPS : RESTING_FPS;

        if (elapsed >= 1000 / fps - 2 || dirty) {
            const clock = now / 1000;
            const dt = Math.min(0.1, elapsed / 1000);

            lastDraw = now;

            for (const face of faces) {
                if (!face.visible || (still && !face.dirty)) {
                    continue;
                }

                face.motion.step(clock, dt, pointerFor(face));
                draw(face, still ? 0 : clock);
                face.dirty = false;
            }
        }

        // With reduced motion, faces are drawn only when something changes. At rest, nothing until the next frame is
        // due: a change, a face coming into sight, or the pointer asks for one sooner (`schedule`).
        if (still) {
            return;
        }

        if (calm) {
            clearTimeout(resting);
            resting = setTimeout(
                () => {
                    resting = 0;
                    schedule();
                },
                Math.max(0, 1000 / fps - (performance.now() - lastDraw) - 8),
            );
        } else {
            schedule();
        }
    }

    function add(face) {
        faces.add(face);
        face.canvas.noidFace = face;
        visibility.observe(face.canvas);
        schedule();
    }

    function remove(face) {
        faces.delete(face);
        visibility.unobserve(face.canvas);
        delete face.canvas.noidFace;
    }

    return {
        add,
        remove,
        schedule,
        /** Something moved a face (a tap, which moves no pointer): the full frame rate for a while. */
        stir: () => {
            pointer.at = performance.now();
        },
        reducedMotion: reduced,
        onFallback: (callback) => {
            fallbacks.add(callback);

            return () => fallbacks.delete(callback);
        },
    };
}

/** Pixels the face's canvas needs for a CSS size, on this screen. */
export function backingSize(size) {
    const scale = Math.min(MAX_SCALE, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);

    return Math.max(8, Math.round(size * scale));
}

/**
 * Starts drawing a face on `canvas` (a 2D canvas the caller sized). `options` are the bot's id, color, skin, eyes, and
 * state. Returns controls to change them, boop it, and stop; or undefined when WebGL2 is unavailable.
 */
export function attach(canvas, options, onFallback) {
    const shared = getRenderer();

    if (shared === undefined) {
        return undefined;
    }

    const context = canvas.getContext("2d");
    let traits = traitsOf(options.id, options);
    const face = {
        canvas,
        context,
        traits,
        motion: createMotion(traits, { reducedMotion: shared.reducedMotion() }),
        visible: true,
        dirty: true,
    };

    face.motion.setState(options.state ?? "idle", performance.now() / 1000);
    shared.add(face);

    const stopFallback = shared.onFallback(() => onFallback?.());

    return {
        update(next) {
            const changed =
                next.id !== options.id ||
                next.color !== options.color ||
                next.skin !== options.skin ||
                next.eyes !== options.eyes;

            if (changed) {
                traits = traitsOf(next.id, next);
                face.traits = traits;
                face.motion = createMotion(traits, { reducedMotion: shared.reducedMotion() });
            }

            face.motion.setState(next.state ?? "idle", performance.now() / 1000);
            options = next;
            face.dirty = true;
            shared.schedule();

            // With reduced motion a face is drawn only when something changes: work that ended shows its happy moment,
            // and then nothing would draw it back to idle.
            if (shared.reducedMotion()) {
                setTimeout(
                    () => {
                        face.dirty = true;
                        shared.schedule();
                    },
                    DONE_SECONDS * 1000 + 50,
                );
            }
        },
        boop(strength) {
            shared.stir();
            face.motion.boop(strength);
            face.dirty = true;
            shared.schedule();
        },
        detach() {
            stopFallback();
            shared.remove(face);
        },
    };
}
