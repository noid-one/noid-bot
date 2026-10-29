// noid: text cut short never splits an emoji (a lone half of a surrogate pair shows as "�"); the server's own copy is
// `cutWhole` in src/server/cut.ts. No imports, so the tests can load it.

/** The first `end` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair (an emoji). */
export function cutWhole(text, end) {
    return /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) ? text.slice(0, end - 1) : text.slice(0, end);
}
