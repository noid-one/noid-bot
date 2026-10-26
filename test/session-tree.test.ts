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

test("noid: a chain of links however long is counted, not run out of stack", () => {
    const length = 15_000;
    const chain = Array.from({ length }, (_, index) =>
        session(index + 1, index, index === 0 ? undefined : index),
    );
    const { rows } = sessionForest(chain) as { rows: Map<number, Row[]> };

    assert.equal(rows.get(1)![0]!.descendants, length - 1);
});

test("links that loop still show every session once, with what is under each counted", () => {
    // 1 and 2 name each other; 3 hangs off 1, 4 off 3, and 6 off the loop 5 ↔ 6 by way of 7.
    const looped = [
        session(1, 10, 2),
        session(2, 20, 1),
        session(3, 30, 1),
        session(4, 40, 3),
        session(5, 50, 6),
        session(6, 60, 7),
        session(7, 70, 6),
    ];
    const { roots, rows } = sessionForest(looped) as {
        roots: { id: number }[];
        rows: Map<number, Row[]>;
    };
    const shape = roots.map((root) =>
        rows.get(root.id)!.map((row) => [row.session.id, row.descendants]),
    );

    assert.deepEqual(
        shape
            .flat()
            .map(([id]) => id)
            .sort(),
        [1, 2, 3, 4, 5, 6, 7],
    );
    // As before links that end were remembered: each loop is broken where it was found first.
    assert.deepEqual(shape, [
        [
            [6, 1],
            [7, 0],
        ],
        [[5, 0]],
        [
            [1, 3],
            [2, 0],
            [3, 1],
            [4, 0],
        ],
    ]);
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
    // A mark asked for first wins over one found before it.
    assert.deepEqual(
        [
            ...foldedUnder(
                [linked(1), linked(2, 1), linked(3, 1)],
                new Set([1]),
                (session: { id: number }) => (session.id === 2 ? "failed" : "waiting"),
                "waiting",
            ),
        ],
        [[1, "waiting"]],
    );
    // A loop of links ends.
    assert.deepEqual(
        [...foldedUnder([linked(1, 2), linked(2, 1)], new Set(), () => "waiting")],
        [],
    );
});
