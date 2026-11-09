// A room follows its conversation's view: it keeps the active transcript from the view's window, and one that fails to
// open follows nothing, so retries do not pile up watches.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../src/server/app.ts";
import { Room } from "../src/server/room.ts";

test("a room that fails to open stops following its view (pi-pocket ca9fe5ac)", async () => {
    let following = 0;
    // Pi Durable 1.5's watch: started, it follows the view until stopped.
    const conversation = {
        watch: async () => {
            following++;

            return {
                value: { conversation: {}, docs: {}, entries: [] },
                start: () => {},
                stop: async () => {
                    following--;
                },
            };
        },
        context: async () => ({ entries: [] }),
    } as unknown as Conversation;
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

/** An entry of the active transcript; `head` marks a compaction that heads at that entry. */
const entry = (id: number, head?: number) => ({ id, ...(head === undefined ? {} : { head }) });

test("a room follows appends, and reads the transcript again on a gap or a compaction", async () => {
    let listener: ((call: unknown) => Promise<void>) | undefined;
    let active = [entry(1), entry(2), entry(3)];
    let reads = 0;
    const conversation = {
        watch: async () => ({
            value: { conversation: {}, docs: {}, entries: active },
            start: (started: typeof listener) => {
                listener = started;
            },
            stop: async () => {},
        }),
        context: async () => {
            reads++;

            return { entries: active };
        },
    } as unknown as Conversation;
    const app = {
        harness: { snapshot: async () => undefined },
        rootOf: () => 1,
        log: () => {},
    } as unknown as PocketApp;
    const room = new Room(app, 1 as unknown as ConversationId);
    /** The view's window: its newest entries, after entry `before`. */
    const view = (entries: ReturnType<typeof entry>[], before: number) =>
        listener!({ kind: "value", value: { conversation: {}, docs: {}, entries, before } });
    const ids = () => room.value!.entries.map((each) => each.id);

    room.schedule = () => {};

    await room.open(conversation).catch(() => {});
    assert.ok(listener);

    // An append: the window overlaps what the room has.
    await view([entry(2), entry(3), entry(4)], 1);
    assert.deepEqual(ids(), [1, 2, 3, 4]);

    // A gap: the window starts after what the room has, so it reads the transcript again.
    active = [entry(1), entry(2), entry(3), entry(4), entry(5), entry(6), entry(7)];
    await view([entry(6), entry(7)], 5);
    assert.deepEqual(ids(), [1, 2, 3, 4, 5, 6, 7]);

    // A compaction: entry 8 heads at 6, so the active transcript starts over from it.
    active = [entry(8, 6), entry(6), entry(7)];
    await view([entry(7), entry(8, 6)], 6);
    assert.deepEqual(ids(), [8, 6, 7]);

    // Then an append after it.
    await view([entry(7), entry(8, 6), entry(9)], 6);
    assert.deepEqual(ids(), [8, 6, 7, 9]);
    assert.equal(reads, 3, "the open, the gap, and the compaction");
});
