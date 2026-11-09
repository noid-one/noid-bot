// A room follows its conversation's view: one that fails to open follows nothing, so retries do not pile up watches.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../src/server/app.ts";
import { Room } from "../src/server/room.ts";

test("a room that fails to open stops following its view (pi-pocket ca9fe5ac)", async () => {
    let following = 0;
    const view = {
        subscribe: () => {
            following++;

            return () => {
                following--;
            };
        },
    };
    const conversation = { viewState: async () => view } as unknown as Conversation;
    // A storage read that fails after the view is followed.
    const app = {
        harness: {
            snapshot: async () => {
                throw new Error("the disk is gone");
            },
        },
    } as unknown as PocketApp;
    const room = new Room(app, 1 as unknown as ConversationId);

    await assert.rejects(room.open(conversation), /the disk is gone/);
    await assert.rejects(room.open(conversation), /the disk is gone/);
    assert.equal(following, 0, "nothing follows the view after the failed opens");
});
