// The session list's tree (`web/session-tree.js`): linked sessions under the one that started them, how many each row
// has under it, and folding them away.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: a browser module, without types.
import { foldedUnder, sessionForest, unfolded } from "../web/session-tree.js";

type Row = { session: { id: number }; branches: boolean[]; descendants: number };

const session = (id: number, updatedAt: number, from?: number) => ({
    id,
    updatedAt,
    cwd: "/work",
    ...(from === undefined ? {} : { linkedFrom: { id: from } }),
});

const sessions = [
    session(1, 10),
    session(2, 20, 1),
    session(3, 30, 1),
    session(4, 40, 3),
    session(5, 5),
];

test("each row counts the rows under it, at any depth", () => {
    const { rows } = sessionForest(sessions) as { rows: Map<number, Row[]> };
    const counts = Object.fromEntries(rows.get(1)!.map((row) => [row.session.id, row.descendants]));

    assert.deepEqual(counts, { 1: 3, 2: 0, 3: 1, 4: 0 });
    assert.equal(rows.get(5)![0]!.descendants, 0);
});

test("a folded row hides the rows under it, and only those", () => {
    const { rows } = sessionForest(sessions) as { rows: Map<number, Row[]> };
    const family = rows.get(1)!;
    const ids = (folded: number[]) =>
        (unfolded(family, new Set(folded)) as Row[]).map((row) => row.session.id);

    assert.deepEqual(ids([]), [1, 2, 3, 4]);
    assert.deepEqual(ids([1]), [1]);
    assert.deepEqual(ids([3]), [1, 2, 3]);
    // A fold on a row with nothing under it changes nothing.
    assert.deepEqual(ids([2]), [1, 2, 3, 4]);
});

test("noid: what waits under a fold is told on the nearest session that shows, however deep", () => {
    const linked = (id: number, from?: number) => ({
        id,
        ...(from === undefined ? {} : { linkedFrom: { id: from } }),
    });
    // 1 shows; 2 and 3 are folded under it, 3 under 2; 4 shows on its own; 5 is linked to a session that is gone.
    const sessions = [linked(1), linked(2, 1), linked(3, 2), linked(4), linked(5, 99)];
    const waits = new Map([
        [3, "waiting"],
        [4, "failed"],
        [5, "failed"],
    ]);
    const marks = foldedUnder(sessions, new Set([1, 4]), (session: { id: number }) =>
        waits.get(session.id),
    );

    // 4 shows its own mark: it is not folded under anything. 5 has nowhere to show.
    assert.deepEqual([...marks], [[1, "waiting"]]);
    // A loop of links ends.
    assert.deepEqual(
        [...foldedUnder([linked(1, 2), linked(2, 1)], new Set(), () => "waiting")],
        [],
    );
});
