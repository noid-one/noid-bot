// Text cut short never splits an emoji: a lone half of a surrogate pair shows as "�" (idea of rakazo 724f83f56, #2667).
// web/cut.js is the browser's copy. No imports.

/** The first `end` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair (an emoji). */
export function cutWhole(text: string, end: number): string {
    return /[\uD800-\uDBFF]/.test(text.charAt(end - 1))
        ? text.slice(0, end - 1)
        : text.slice(0, end);
}

/** The last `count` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair (an emoji). */
export function tailWhole(text: string, count: number): string {
    const start = Math.max(0, text.length - count);

    return /[\uDC00-\uDFFF]/.test(text.charAt(start)) ? text.slice(start + 1) : text.slice(start);
}
