// What a bot's face is made of, worked out from its identity: shape, palette, skin, and eyes. Pure functions, no DOM, so
// the server and the tests can use them too. The idea of seeding every face from the bot's id, so each bot looks
// different by default, comes from rakazo's avatars (Apache-2.0); the shapes and skins here are noid's own.

/** Surfaces the shader draws: a glossy jelly, matte clay, mirrored chrome, an iridescent hologram, and pixel art. */
export const SKINS = ["jelly", "clay", "chrome", "holo", "pixel"];

/** Eyes: solid capsules, a dark visor with glowing eyes (the robot look), or two small dots. */
export const EYES = ["capsule", "visor", "dots"];

/**
 * Body shapes: a soft blob (the superellipse), polygons, a star, and things: a flower, a pumpkin, a cat's and a dog's
 * head, a water drop, a cloud, a ghost. Each is a radius by angle about its own middle (`shapeRadius`), so the shader, the SVG
 * fallback, and the tests draw the same outline.
 */
export const SHAPES = [
    "blob",
    "rectangle",
    "triangle",
    "diamond",
    "pentagon",
    "hexagon",
    "octagon",
    "star",
    "flower",
    "pumpkin",
    "cat",
    "dog",
    "drop",
    "cloud",
    "ghost",
];

/**
 * Where each shape sits and where its eyes go: `center` raises or lowers its middle so its bottom rests on the ground,
 * `lift` moves the eyes up or down from where the id put them, `spread` brings them closer together where the shape
 * is narrow, `ripple` keeps built shapes' edges straighter than soft ones', and `nose` is an animal's nose: its half width,
 * half height, and how far under its eyes.
 */
const SHAPE_FIT = {
    blob: { center: 0, lift: 0, spread: 1, ripple: 1 },
    rectangle: { center: -0.04, lift: 0, spread: 1, ripple: 0.4 },
    triangle: { center: -0.13, lift: -0.17, spread: 0.78, ripple: 0.3 },
    diamond: { center: 0.06, lift: -0.04, spread: 0.85, ripple: 0.3 },
    pentagon: { center: -0.03, lift: -0.02, spread: 0.95, ripple: 0.3 },
    hexagon: { center: -0.03, lift: 0, spread: 1, ripple: 0.25 },
    octagon: { center: -0.03, lift: 0, spread: 1, ripple: 0.25 },
    star: { center: 0.03, lift: -0.06, spread: 0.72, ripple: 0.3 },
    flower: { center: -0.02, lift: -0.03, spread: 0.9, ripple: 0.6 },
    pumpkin: { center: -0.06, lift: -0.04, spread: 1, ripple: 0.5 },
    cat: { center: -0.06, lift: -0.04, spread: 0.95, ripple: 0.6, nose: [0.04, 0.026, 0.12] },
    dog: { center: -0.05, lift: -0.01, spread: 0.9, ripple: 0.5, nose: [0.06, 0.04, 0.17] },
    drop: { center: -0.08, lift: -0.06, spread: 0.92, ripple: 0.6 },
    cloud: { center: -0.06, lift: -0.05, spread: 1.05, ripple: 0.6 },
    ghost: { center: 0.05, lift: 0, spread: 0.92, ripple: 0.7 },
};

/** What a bot is doing, as its face shows it. `done` plays once when work ends, then the face goes back to idle. */
export const STATES = ["idle", "working", "waiting", "done", "error", "asleep"];

/** A steady 32-bit hash of any text (FNV-1a), so the same id gives the same face on every device. */
export function hashOf(text) {
    let hash = 0x811c9dc5;

    for (const char of String(text)) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash >>> 0;
}

/** A small deterministic random generator (mulberry32): the same seed gives the same numbers. */
export function randomFrom(seed) {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = state;

        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

/** `#rgb` or `#rrggbb` as [r, g, b] in 0…1, or undefined when it is not a color. */
export function parseHex(color) {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color ?? "").trim());

    if (match === null) {
        return undefined;
    }

    const digits =
        match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];

    return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16) / 255);
}

function rgbToHsl([r, g, b]) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const light = (max + min) / 2;

    if (max === min) {
        return [0, 0, light];
    }

    const delta = max - min;
    const saturation = light > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    let hue;

    if (max === r) {
        hue = (g - b) / delta + (g < b ? 6 : 0);
    } else if (max === g) {
        hue = (b - r) / delta + 2;
    } else {
        hue = (r - g) / delta + 4;
    }

    return [hue / 6, saturation, light];
}

function hslToRgb([hue, saturation, light]) {
    if (saturation === 0) {
        return [light, light, light];
    }

    const q = light < 0.5 ? light * (1 + saturation) : light + saturation - light * saturation;
    const p = 2 * light - q;

    const channel = (t) => {
        const at = t < 0 ? t + 1 : t > 1 ? t - 1 : t;

        if (at < 1 / 6) {
            return p + (q - p) * 6 * at;
        }

        if (at < 1 / 2) {
            return q;
        }

        if (at < 2 / 3) {
            return p + (q - p) * (2 / 3 - at) * 6;
        }

        return p;
    };

    return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Colors bots get when they have none: bright enough to read on dark and light themes. */
export const DEFAULT_COLORS = [
    "#7aa2f7",
    "#9ece6a",
    "#ff9e64",
    "#bb9af7",
    "#7dcfff",
    "#f7768e",
    "#e0af68",
    "#2ac3de",
];

/**
 * The palette a face is shaded with, from the bot's color: the body's base, a lighter and a darker tone for light and
 * shadow, the eyes, and the glow. Every color is [r, g, b] in 0…1.
 */
export function paletteOf(color, seed = 0) {
    const rgb = parseHex(color) ?? parseHex(DEFAULT_COLORS[seed % DEFAULT_COLORS.length]);
    const [hue, saturation, light] = rgbToHsl(rgb);
    // Keep bodies in a middle band of lightness, so eyes and highlights always read.
    const base = clamp01(Math.min(0.68, Math.max(0.42, light)));
    const tone = (lift, saturate = 0) =>
        hslToRgb([hue, clamp01(saturation + saturate), clamp01(base + lift)]);

    return {
        base: tone(0),
        light: tone(0.2, -0.05),
        dark: tone(-0.24, 0.08),
        eye: hslToRgb([hue, clamp01(saturation * 0.6), 0.1]),
        glow: tone(0.28, 0.1),
    };
}

/**
 * A face's fixed traits from the bot's id (and optional overrides the owner picked in the face editor): its skin, its
 * eyes, and its body shape. Shape numbers are what the shader takes: `roundness` is the superellipse exponent (2 is an
 * ellipse, higher is squarer), `aspect` widens or narrows the body, and `wobble` holds the amplitudes and phases of the
 * three ripples that make organic bodies uneven.
 */
export function traitsOf(id, overrides = {}) {
    const seed = hashOf(id);
    const random = randomFrom(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const skin = SKINS.includes(overrides.skin) ? overrides.skin : pick(SKINS.slice(0, 4));
    const eyes = EYES.includes(overrides.eyes)
        ? overrides.eyes
        : pick(["capsule", "capsule", "visor", "dots"]);
    // Visors sit on squarer, robot-like bodies; the others on softer ones.
    const robot = eyes === "visor";
    const roundness = robot ? 3.2 + random() * 1.6 : 2 + random() * 0.9;
    const aspect = 0.88 + random() * 0.26;
    const ripple = robot ? 0.008 : 0.025 + random() * 0.035;
    const wobble = [0, 1, 2].map(() => ({
        amplitude: ripple * (0.4 + random() * 0.6),
        phase: random() * Math.PI * 2,
    }));
    const eyeHeight = 0.1 + random() * 0.1;
    const eyeGap = 0.21 + random() * 0.08;
    const breathPeriod = 3.6 + random() * 1.8;
    const blinkMin = 2.2 + random() * 1.2;
    const blinkSpread = 2.5 + random() * 2.5;
    // Drawn last and always, so a face drawn before shapes existed keeps everything else; a blob is likelier than
    // any one other shape, and a visor's robot gets a built one.
    const drawn = robot
        ? pick(["blob", "blob", "rectangle", "hexagon", "octagon", "pentagon", "diamond"])
        : pick(["blob", "blob", "blob", ...SHAPES.slice(1)]);
    const shape = SHAPES.includes(overrides.shape) ? overrides.shape : drawn;
    const fit = SHAPE_FIT[shape];

    for (const wave of wobble) {
        wave.amplitude *= fit.ripple;
    }

    return {
        seed,
        skin,
        eyes,
        shape,
        roundness,
        aspect,
        wobble,
        // How far the shape's middle is from the body's.
        center: fit.center,
        // Where the eyes sit (up from the middle) and how far apart, so faces differ in expression too.
        eyeHeight: eyeHeight + fit.lift,
        eyeGap: eyeGap * fit.spread,
        nose: fit.nose ?? [0, 0, 0],
        // Idle rhythms, so bots on one screen never breathe or blink together.
        breathPeriod,
        blinkMin,
        blinkSpread,
        palette: paletteOf(overrides.color, seed),
    };
}

const TAU = Math.PI * 2;
const modulo = (value, by) => value - by * Math.floor(value / by);
const bump = (offset, width) => Math.exp(-(offset * offset) / (width * width));

const smoothstep = (from, to, value) => {
    const t = Math.min(1, Math.max(0, (value - from) / (to - from)));

    return t * t * (3 - 2 * t);
};

/** A dog's ear by the angle from its middle: rising slowly from the top of the head, ending sharply at its tip. */
const floppyEar = (offset) =>
    (1 - smoothstep(0.15, 0.95, offset)) * smoothstep(-0.62, -0.42, offset);

/** Like `bump`, with a flat top and steeper sides. */
const plateau = (offset, width) => Math.exp(-Math.pow(offset / width, 4));
const tent = (offset, width) => Math.max(0, 1 - Math.abs(offset) / width);

/** The angle between two angles, from -π to π. */
const turn = (from, to) => modulo(from - to + Math.PI, TAU) - Math.PI;

/** A smooth minimum: like `min`, with the corner where `a` and `b` meet rounded over `k`. */
function smoothMin(a, b, k) {
    const h = Math.max(k - Math.abs(a - b), 0) / k;

    return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * A regular polygon or star's radius toward `theta`: `sides` points at radius `outer`, and between each two a point at
 * radius `inner` (a polygon when `inner` is `outer · cos(π / sides)`). `start` is the angle of the first point.
 */
function starRadius(theta, sides, outer, inner, start) {
    const sector = TAU / sides;
    let phi = modulo(theta - start, sector);

    phi = phi > sector / 2 ? sector - phi : phi;
    const edgeX = inner * Math.cos(sector / 2) - outer;
    const edgeY = inner * Math.sin(sector / 2);

    return (outer * edgeY) / (Math.cos(phi) * edgeY - Math.sin(phi) * edgeX);
}

const polygon = (theta, sides, outer, start, round) =>
    smoothMin(
        starRadius(theta, sides, outer, outer * Math.cos(Math.PI / sides), start),
        outer,
        round,
    );

/** A superellipse's radius: 2 is an ellipse, higher is squarer; `wide` stretches it sideways. */
function superellipse(theta, exponent, wide) {
    const x = Math.abs(Math.cos(theta)) / wide;
    const y = Math.abs(Math.sin(theta));

    return 1 / Math.pow(Math.pow(x, exponent) + Math.pow(y, exponent), 1 / exponent);
}

/**
 * A shape's radius toward `theta`, before it is stretched by the aspect and rippled: `bodyRadius` and the shader's
 * `shapeRadius` both draw from it. Angles count from the right, counterclockwise, so up is π / 2.
 */
export function shapeRadius(shape, theta, roundness = 2) {
    const up = turn(theta, Math.PI / 2);

    switch (shape) {
        case "rectangle":
            return 0.47 * superellipse(theta, 7, 1.14);
        case "triangle":
            return polygon(theta, 3, 0.7, Math.PI / 2, 0.14);
        case "diamond":
            return polygon(theta, 4, 0.62, Math.PI / 2, 0.08);
        case "pentagon":
            return polygon(theta, 5, 0.57, Math.PI / 2, 0.08);
        case "hexagon":
            return polygon(theta, 6, 0.55, 0, 0.06);
        case "octagon":
            return polygon(theta, 8, 0.53, Math.PI / 8, 0.04);
        case "star":
            return smoothMin(starRadius(theta, 5, 0.7, 0.38, Math.PI / 2), 0.66, 0.08);
        case "flower":
            // Six round petals, one at the top.
            return 0.41 + 0.13 * Math.sqrt(Math.abs(Math.cos(3 * up)));

        case "pumpkin": {
            // Wide, with lobes (notches where its ribs meet the top and bottom), a dip at the top, and a stem.
            const down = turn(theta, -Math.PI / 2);
            const lobes =
                1 -
                0.08 * bump(up, 0.3) -
                0.09 * (bump(up - 0.8, 0.14) + bump(up + 0.8, 0.14)) -
                0.05 * (bump(down - 0.85, 0.2) + bump(down + 0.85, 0.2));
            const stem = 0.14 * plateau(turn(theta, Math.PI / 2 - 0.05), 0.11);

            return 0.48 * superellipse(theta, 2.3, 1.2) * lobes + stem;
        }

        case "cat":
            // A round head with two pointed ears.
            return (
                0.47 * superellipse(theta, 2.2, 1.06) +
                0.23 * tent(turn(theta, Math.PI / 2 - 0.62), 0.3) +
                0.23 * tent(turn(theta, Math.PI / 2 + 0.62), 0.3)
            );
        case "dog":
            // A round head, ears that hang from its top down its sides, and a muzzle.
            return (
                0.43 * superellipse(theta, 2.2, 0.86) +
                0.15 * floppyEar(turn(theta, 0.3)) +
                0.15 * floppyEar(turn(Math.PI - theta, 0.3)) +
                0.04 * bump(turn(theta, -Math.PI / 2), 0.4)
            );

        case "drop": {
            // A circle, and the two lines from a point above it that just touch it.
            const radius = 0.44;
            const apex = 0.76;
            const touch = Math.asin(radius / apex);

            if (Math.abs(up) >= Math.PI / 2 - touch) {
                return radius;
            }

            // The ray toward theta meets the line from the apex (0, apex) to where it touches the circle.
            const side = up < 0 ? 1 : -1;
            const toX = side * radius * Math.cos(touch);
            const toY = radius * Math.sin(touch) - apex;

            return (-apex * toX) / (Math.cos(theta) * toY - Math.sin(theta) * toX);
        }

        case "cloud": {
            // Puffs on top, a flatter bottom.
            const puffs = 0.15 * Math.sqrt(Math.abs(Math.cos(2.5 * up)));
            const top = Math.min(1, Math.max(0, (Math.sin(theta) + 0.15) / 0.45));

            return 0.38 * superellipse(theta, 3, 1.4) + puffs * top * top;
        }

        case "ghost": {
            // A round dome, straight sides that hang down, and a hem of scallops.
            const down = turn(theta, -Math.PI / 2);
            const below = Math.max(0, -Math.sin(theta));
            const hem =
                0.12 * Math.sqrt(Math.abs(Math.cos(3.5 * down))) * smoothstep(0.4, 0.85, below);

            return (
                0.44 *
                    superellipse(theta, Math.sin(theta) > 0 ? 2.1 : 4.5, 0.88) *
                    (1 + 0.16 * below) +
                hem
            );
        }

        default:
            return 0.5 * superellipse(theta, roundness, 1);
    }
}

/**
 * The body's radius toward angle `theta` (about the shape's middle, `traits.center` up from the body's) at time `time`
 * in seconds, the same function the shader and the SVG fallback use: the shape, stretched sideways by the aspect, with
 * three slow ripples on top.
 */
export function bodyRadius(traits, theta, time = 0, ripple = 1) {
    const { roundness, aspect, wobble } = traits;
    // The angle on the unstretched shape that the stretch carries to theta, and how much longer it gets.
    const along = Math.atan2(Math.sin(theta) * aspect, Math.cos(theta));
    const stretch = Math.hypot(Math.cos(along) * aspect, Math.sin(along));
    const shape = shapeRadius(traits.shape, along, roundness) * stretch;
    let wave = 0;

    wobble.forEach(({ amplitude, phase }, index) => {
        const harmonic = index + 2;

        wave +=
            amplitude * ripple * Math.sin(harmonic * theta + phase + time * (0.7 + index * 0.35));
    });

    return shape * (1 + wave);
}
