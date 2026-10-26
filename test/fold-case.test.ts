// noid: a search's place in the text as written, though lowercasing may change its length (`web/fold-case.js`).
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: a browser module, without types.
import { foldedMatch } from "../web/fold-case.js";

const marked = (text: string, needle: string) => {
    const found = foldedMatch(text, needle) as [number, number] | null;

    return found === null ? null : text.slice(found[0], found[1]);
};

test("the match is marked where it is written, after a letter lowercasing makes longer", () => {
    // "İ" lowercases to two characters: the old way marked "rep" here.
    assert.equal("İstanbul report".toLowerCase().length, 16);
    assert.equal(marked("İstanbul report", "report"), "report");
    assert.equal(marked("İİİ Deploy notes", "deploy"), "Deploy");
    // A match that starts inside the letter that grew takes the whole letter.
    assert.equal(marked("İstanbul", "i̇st"), "İst");
    assert.equal(marked("Plain Title", "title"), "Title");
    assert.equal(marked("Plain Title", "nope"), null);
});

test("a match only the whole text lowercased finds is not lost", () => {
    // A capital sigma at a word's end lowercases whole to a final sigma (ς), alone to a plain one (σ).
    assert.equal("ΟΔΟΣ İ".toLowerCase().slice(0, 4), "οδος");
    assert.equal(marked("ΟΔΟΣ İ", "οδος"), "ΟΔΟΣ");
    assert.equal(marked("ΟΔΟΣ İ", "οδοσ"), "ΟΔΟΣ");
});
