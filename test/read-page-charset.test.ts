// The read-page example reads a page in the charset its type declares, not always UTF-8 (rakazo 1621d80ba).
import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyText } from "../docs/examples/read-page.ts";

// "café" in windows-1252: é is the single byte 0xe9, which is no UTF-8.
const cafe = new Uint8Array([0x63, 0x61, 0x66, 0xe9]).buffer;

test("a page's declared charset decodes it", () => {
    assert.equal(bodyText(cafe, "text/html; charset=windows-1252"), "café");
    assert.equal(bodyText(cafe, 'text/plain; charset="ISO-8859-1"'), "café");
});

test("no charset, an unknown one, or a malformed type reads UTF-8", () => {
    const utf8 = new TextEncoder().encode("café").buffer;

    assert.equal(bodyText(utf8, "text/html"), "café");
    assert.equal(bodyText(utf8, ""), "café");
    assert.equal(bodyText(utf8, "text/html; charset=no-such-charset"), "café");
    assert.equal(bodyText(utf8, "not a type"), "café");
    assert.equal(bodyText(cafe, "text/html"), "caf�", "what Response.text() gave");
});
