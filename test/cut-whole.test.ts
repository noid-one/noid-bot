// Text cut short never splits an emoji: a lone half of a surrogate pair shows as "�" in push previews, titles, and the
// lines Noid reads (idea of rakazo 724f83f56, #2667).
import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, quoted } from "../src/server/fence.ts";
import { cutWhole, snippet } from "../src/server/projection.ts";

test("cutWhole keeps a surrogate pair whole, and cuts plain text where asked", () => {
    assert.equal(cutWhole("ab😀c", 3), "ab");
    assert.equal(cutWhole("ab😀c", 4), "ab😀");
    assert.equal(cutWhole("abcdef", 3), "abc");
    assert.equal(cutWhole("a𠀀", 2), "a");
    assert.equal(cutWhole("😀", 0), "");
});

test("snippet, clip, and quoted never end in half an emoji", () => {
    for (let pad = 75; pad <= 82; pad += 1) {
        const text = `${"a".repeat(pad)}😀😀 tail`;
        const short = snippet(text, 80);

        assert.ok(short.endsWith("…"));
        assert.ok(short.length <= 80);
        assert.ok(short.isWellFormed(), JSON.stringify(short));
        assert.ok(clip(text, 80).isWellFormed());
        assert.ok(quoted(text, 80).isWellFormed());
    }
});
