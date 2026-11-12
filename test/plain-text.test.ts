// Plain text for previews, quotes, and notifications: HTML comments go, as chat shows none, but stay inside code
// (rakazo 60c7eaae0). The browser's copy (web/ui.js) does the same.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { plainText } from "../src/server/projection.ts";

const flat = (text: string) => plainText(text).replace(/\s+/g, " ").trim();

test("HTML comments leave previews, finished or not", () => {
    for (const source of [
        "a <!-- x > hidden --> b",
        "a <!-- x > hidden\nmore --> b",
        "a <!-- an unmatched ' quote > hidden --> b",
        "a <!-- <b>hidden</b> --> b",
        "a <!-- x > hidden --> <!-- more > hidden --> b",
    ]) {
        assert.equal(flat(source), "a b", source);
    }

    assert.equal(flat("a <!-- hidden"), "a");
    assert.equal(flat("a <!-- x > hidden"), "a");
});

test("a comment in code stays, and the rest still reads as before", () => {
    assert.equal(flat("`<!-- x > hidden -->`"), "<!-- x > hidden -->");
    assert.equal(flat("```html\n<!-- kept -->\n```"), "<!-- kept -->");
    assert.equal(flat("**bold** and [a link](https://example.com)"), "bold and a link");
});

test("the browser's plainText strips them the same way", () => {
    const body = (file: string, start: string) => {
        const text = readFileSync(new URL(file, import.meta.url), "utf8");
        const from = text.indexOf(start);

        return text
            .slice(from, text.indexOf("\n}\n", from))
            .split("\n")
            .filter((line) => line.trim().startsWith(".replace") || line.includes("<!--"))
            .map((line) => line.trim());
    };

    assert.deepEqual(
        body("../web/ui.js", "export function plainText("),
        body("../src/server/projection.ts", "export function plainText("),
    );
});
