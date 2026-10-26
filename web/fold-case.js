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

    // Where each character of the lowercased text came from: each character lowercases to as many as it does alone
    // (context changes which letter, a Greek final sigma, never how many), so the whole text lowercased lines up.
    const origin = [];
    let start = 0;

    for (const character of text) {
        for (let unit = 0; unit < character.toLowerCase().length; unit++) {
            origin.push({ start, end: start + character.length });
        }

        start += character.length;
    }

    const at = lowered.indexOf(needle);

    if (at === -1 || needle.length === 0) {
        return null;
    }

    // Should they not line up after all, the place as found, as before: the match is still shown.
    if (origin.length !== lowered.length) {
        return [Math.min(at, text.length), Math.min(at + needle.length, text.length)];
    }

    // From the character the match starts in to the end of the one it ends in.
    return [origin[at].start, origin[at + needle.length - 1].end];
}
