// What a bot's face is made of, worked out from its identity: shape, palette, skin, and eyes. Pure functions, no DOM, so
// the server and the tests can use them too. The idea of seeding every face from the bot's id, so each bot looks
// different by default, comes from rakazo's avatars (Apache-2.0); the shapes and skins here are noid's own.

/** Surfaces the shader draws: a glossy jelly, matte clay, mirrored chrome, an iridescent hologram, and pixel art. */
export const SKINS = ["jelly", "clay", "chrome", "holo", "pixel"];

/** Eyes: solid capsules, a dark visor with glowing eyes (the robot look), or two small dots. */
export const EYES = ["capsule", "visor", "dots"];

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

    return {
        seed,
        skin,
        eyes,
        roundness,
        aspect,
        wobble,
        // Where the eyes sit (up from the middle) and how far apart, so faces differ in expression too.
        eyeHeight: 0.1 + random() * 0.1,
        eyeGap: 0.21 + random() * 0.08,
        // Idle rhythms, so bots on one screen never breathe or blink together.
        breathPeriod: 3.6 + random() * 1.8,
        blinkMin: 2.2 + random() * 1.2,
        blinkSpread: 2.5 + random() * 2.5,
        palette: paletteOf(overrides.color, seed),
    };
}

/**
 * The body's radius toward angle `theta` at time `time` in seconds, the same function the shader and the SVG fallback
 * use: a superellipse with three slow ripples on top.
 */
export function bodyRadius(traits, theta, time = 0, ripple = 1) {
    const { roundness, aspect, wobble } = traits;
    const x = Math.abs(Math.cos(theta)) / aspect;
    const y = Math.abs(Math.sin(theta));
    const superellipse =
        1 / Math.pow(Math.pow(x, roundness) + Math.pow(y, roundness), 1 / roundness);
    let wave = 0;

    wobble.forEach(({ amplitude, phase }, index) => {
        const harmonic = index + 2;

        wave +=
            amplitude * ripple * Math.sin(harmonic * theta + phase + time * (0.7 + index * 0.35));
    });

    return 0.5 * superellipse * (1 + wave);
}
