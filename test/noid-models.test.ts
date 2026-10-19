// noid: the model picker shows each provider's current models, the catalogs having no dates: those within half a
// version of its newest, and no dated snapshots, "chat-latest" aliases, or realtime models.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecent, modelVersion } from "../src/server/models.ts";

test("a model's version is read from its id", () => {
    assert.equal(modelVersion("gpt-5.6-sol"), 5.6);
    assert.equal(modelVersion("gpt-6-luna"), 6);
    assert.equal(modelVersion("claude-opus-4-5-20251101"), 4.5);
    assert.equal(modelVersion("grok-4.7"), 4.7);
    assert.equal(modelVersion("o4-mini"), 4);
    assert.equal(modelVersion("sonnet"), undefined);
});

test("only each provider's current models are recent", () => {
    const recent = (ids: string[]) => {
        const newest = Math.max(...ids.map((id) => modelVersion(id) ?? 0));

        return ids.filter((id) => isRecent(id, newest));
    };

    assert.deepEqual(
        recent(["gpt-4o", "o3", "gpt-5.5", "gpt-5.6-sol", "gpt-6.1-sol", "gpt-realtime-2.1"]),
        ["gpt-5.6-sol", "gpt-6.1-sol"],
    );
    assert.deepEqual(
        recent([
            "claude-opus-4-8",
            "claude-sonnet-5",
            "claude-opus-5-5",
            "claude-sonnet-4-5-20250929",
        ]),
        ["claude-sonnet-5", "claude-opus-5-5"],
    );
    assert.deepEqual(recent(["sonnet", "opus"]), ["sonnet", "opus"], "no version: current");
});
