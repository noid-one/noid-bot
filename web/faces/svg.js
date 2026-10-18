// A face as SVG, for pages without WebGL2, for reduced data (a notification icon), and for tests: the same body shape
// as the shader (sampled from `bodyRadius`), a two-tone gradient, and the eyes. It blinks with CSS (style.css,
// `noid-face-blink`), and it does not otherwise move.

import { bodyRadius } from "./params.js";

const css = (rgb) => `rgb(${rgb.map((channel) => Math.round(channel * 255)).join(" ")})`;

/** The body's outline as SVG path data in a 100x100 box, with `points` samples around it. */
export function bodyPath(traits, points = 48) {
    const coordinates = [];

    for (let index = 0; index < points; index++) {
        const theta = (index / points) * Math.PI * 2;
        const radius = bodyRadius(traits, theta) * 72;

        coordinates.push([50 + Math.cos(theta) * radius, 54 - Math.sin(theta) * radius]);
    }

    return `M${coordinates.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}Z`;
}

/** The face's SVG markup, for a bot with these traits in this state. `uid` keeps gradient ids apart on one page. */
export function faceSvg(traits, state = "idle", uid = traits.seed.toString(36)) {
    const { palette, eyes, eyeGap, eyeHeight, aspect } = traits;
    const gap = eyeGap * Math.min(aspect, 1.05) * 72;
    const eyeY = 54 - eyeHeight * 72;
    const asleep = state === "asleep";
    const happy = state === "done";
    const upset = state === "error";
    const eyeColor = eyes === "visor" ? css(palette.glow) : css(palette.eye);
    const width = eyes === "dots" ? 7 : 9.4;
    const height = asleep ? 1.6 : eyes === "dots" ? 7 : upset ? 8 : 15;

    const eye = (x, side) => {
        if (happy) {
            return `<path d="M${x - 5} ${eyeY + 2}q5 -8 10 0" fill="none" stroke="${eyeColor}" stroke-width="3" stroke-linecap="round"/>`;
        }

        const tilt = upset ? `transform="rotate(${side * 18} ${x} ${eyeY})"` : "";

        return `<rect class="noid-face-eye" x="${x - width / 2}" y="${eyeY - height / 2}" width="${width}" height="${height}" rx="${Math.min(width, height) / 2}" fill="${eyeColor}" ${tilt}/>`;
    };

    const visor =
        eyes === "visor"
            ? `<rect x="${50 - 0.34 * aspect * 72}" y="${eyeY - 9.5}" width="${0.68 * aspect * 72}" height="19" rx="7" fill="rgb(10 12 16)"/>`
            : "";

    return [
        `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="noid-face-svg" data-state="${state}">`,
        `<defs><linearGradient id="noid-face-${uid}" x1="0.2" y1="0" x2="0.8" y2="1">`,
        `<stop offset="0" stop-color="${css(palette.light)}"/><stop offset="1" stop-color="${css(palette.dark)}"/>`,
        `</linearGradient></defs>`,
        `<ellipse cx="50" cy="94" rx="${26 * aspect}" ry="4" fill="rgb(0 0 0 / 0.25)"/>`,
        `<path d="${bodyPath(traits)}" fill="url(#noid-face-${uid})"${asleep ? ' opacity="0.7"' : ""}/>`,
        visor,
        `<g class="noid-face-eyes">${eye(50 - gap, 1)}${eye(50 + gap, -1)}</g>`,
        `</svg>`,
    ].join("");
}
