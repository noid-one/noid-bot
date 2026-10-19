// noid: the model picker shows each provider's current models, the catalogs having no dates: those within half a
// version of its newest, and no dated snapshots, "chat-latest" aliases, or realtime models. OpenAI signed in with
// ChatGPT lists the subscription's models only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecent, modelList, modelVersion } from "../src/server/models.ts";

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

test("OpenAI signed in with ChatGPT lists the subscription's models only, all of them current", () => {
    const model = (provider: string, id: string) => ({
        provider,
        id,
        name: id,
        contextWindow: 1000,
        reasoning: false,
        input: ["text"],
    });
    const runtime = (subscription: boolean) =>
        ({
            getAvailableSnapshot: () => [
                model("openai", "gpt-4o"),
                model("openai", "gpt-5.5"),
                model("openai", "gpt-6.1-sol"),
                model("claude-code", "sonnet"),
            ],
            isUsingSubscription: (provider: string) => subscription && provider === "openai",
        }) as never;
    const listed = (subscription: boolean) =>
        modelList(runtime(subscription)).map((each) => `${each.id}${each.recent ? "" : " (old)"}`);

    assert.deepEqual(listed(true), ["gpt-5.5", "gpt-6.1-sol", "sonnet"]);
    assert.deepEqual(listed(false), ["gpt-4o (old)", "gpt-5.5 (old)", "gpt-6.1-sol", "sonnet"]);
});
