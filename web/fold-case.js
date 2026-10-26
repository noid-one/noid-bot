// noid: where a lowercased search matches in the text as written (rakazo d5bbad976). Lowercasing can change a string's
// length ("İ" becomes two characters), so a place found in `text.toLowerCase()` may not be the same place in `text`.
// No imports, so the tests can load it.

/** Where `needle` (lowercased already) is in `text`, as [start, end) of `text`, or null. */
export function foldedMatch(text, needle) {
    const lowered = text.toLowerCase();

    // Almost always: the same length, and so the same places.
    if (lowered.length === text.length) {
        const at = lowered.indexOf(needle);

        return at === -1 ? null : [at, at + needle.length];
    }

    // Each character lowercased on its own, with where it came from.
    let low = "";
    const origin = [];

    for (const character of text) {
        const start = origin.length === 0 ? 0 : origin.at(-1).end;
        const lower = character.toLowerCase();

        for (let unit = 0; unit < lower.length; unit++) {
            origin.push({ start, end: start + character.length });
        }

        low += lower;
    }

    const at = low.indexOf(needle);

    if (at === -1 || needle.length === 0) {
        // Lowercased whole, a letter can read otherwise (a Greek final sigma): found there, it is not lost, near enough.
        const whole = lowered.indexOf(needle);

        return whole === -1
            ? null
            : [Math.min(whole, text.length), Math.min(whole + needle.length, text.length)];
    }

    // From the character the match starts in to the end of the one it ends in.
    return [origin[at].start, origin[at + needle.length - 1].end];
}
