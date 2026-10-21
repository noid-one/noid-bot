// People's avatars: a face as bots have (noid); a color of the theme for each person, the same everywhere, which marks
// their messages; and the colors of folders, which mark their sessions the same way.

import { Face } from "./faces/face.js";
import { store } from "./store.js";
import { html } from "./ui.js";

// The theme's own colors, so people keep their colors in every theme and each one fits it.
const COLORS = [
    "var(--o-blue)",
    "var(--o-green)",
    "var(--o-yellow)",
    "var(--o-magenta)",
    "var(--o-cyan)",
    "var(--o-red)",
    "var(--o-orange)",
    "var(--o-fg-bright)",
];

/** Folders' colors: the same, without yellow and red, which mark sessions waiting for you and subagents that failed. */
const FOLDER_COLORS = [
    "var(--o-blue)",
    "var(--o-green)",
    "var(--o-magenta)",
    "var(--o-cyan)",
    "var(--o-orange)",
    "var(--o-fg-bright)",
];

function hashOf(text) {
    let hash = 0;

    for (const char of String(text)) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }

    return hash;
}

/** A steady color per person, so the same person looks the same on every device. */
export function personColor(id) {
    return COLORS[hashOf(id) % COLORS.length];
}

/** A steady color per folder, from its last part, for the mark on its sessions' rows. */
export function folderColor(path) {
    const name = String(path ?? "")
        .replace(/\/+$/, "")
        .split("/")
        .pop();

    return FOLDER_COLORS[hashOf(name) % FOLDER_COLORS.length];
}

/** "Tanner - Mac" → "TM", "alex" → "AL". */
export function initials(name) {
    const words = String(name ?? "?")
        .trim()
        .split(/[\s\-_.]+/)
        .filter(Boolean);
    const first = words[0] ?? "?";

    return (first[0] + (words.length > 1 ? words[1][0] : (first[1] ?? ""))).toUpperCase();
}

/** A face's body fills about 60% of its canvas: drawn this much bigger than its box, the body fills the box. */
export const FACE_SCALE = 1.6;

/** noid: a person's face picks: their own, else the people list's, which changes when they pick another. */
export function faceOf(person) {
    return person.face ?? store.state.users?.find((each) => each.id === person.id)?.face ?? {};
}

/** A person: a face as a bot's, from their id or their picks. It works while they type, and sleeps while they are away. */
export function Avatar({ person, size = 24 }) {
    const state = person.typing ? "typing" : person.away ? "away" : "";
    const title = person.typing
        ? `${person.name} is typing`
        : person.away
          ? `${person.name} (away)`
          : person.name;
    const face = faceOf(person);

    return html`<span
        class=${`avatar ${state}`}
        style=${`--who:${personColor(person.id)};width:${size}px;height:${size}px`}
        title=${title}
    >
        <${Face}
            id=${person.id}
            color=${face.color}
            skin=${face.skin}
            eyes=${face.eyes}
            shape=${face.shape}
            state=${person.typing ? "working" : person.away ? "asleep" : "idle"}
            size=${Math.round(size * FACE_SCALE)}
            label=${person.name}
        />
    </span>`;
}
