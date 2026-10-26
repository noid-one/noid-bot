// noid: the conversation menu's subagents at work, a group per run (`web/subagent-runs.js`).
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: a browser module, without types.
import { workingRuns } from "../web/subagent-runs.js";

type Agent = { conversationId: number; busy: boolean; askedAt?: number };

const agent = (conversationId: number, askedAt: number | undefined, busy = true): Agent => ({
    conversationId,
    busy,
    ...(askedAt === undefined ? {} : { askedAt }),
});
const ids = (runs: Agent[][]) => runs.map((run) => run.map((each) => each.conversationId));

test("subagents asked together are one run, the newest run first, each in the order Pi asked them", () => {
    const minute = 60_000;
    // Given out of order: the board's order is not the asking order.
    const agents = [
        agent(5, 10 * minute + 2),
        agent(1, 0),
        agent(4, 10 * minute),
        agent(2, 30_000),
        // Each within a minute of the one before: still one run, however long the chain.
        agent(3, 30_000 + minute),
    ];

    assert.deepEqual(ids(workingRuns(agents)), [
        [4, 5],
        [1, 2, 3],
    ]);
    // The list it was given is left as it was.
    assert.deepEqual(
        agents.map((each) => each.conversationId),
        [5, 1, 4, 2, 3],
    );
});

test("only the subagents at work count, and a finished one does not join or part runs", () => {
    const agents = [agent(1, 0), agent(2, 50_000, false), agent(3, 100_000)];

    // 2 finished: 3 was asked more than a minute after 1, so it starts a run of its own.
    assert.deepEqual(ids(workingRuns(agents)), [[3], [1]]);
    assert.deepEqual(workingRuns([agent(1, 0, false)]), []);
    assert.deepEqual(workingRuns([]), []);
});

test("subagents asked at the same moment keep the order they were given; one with no time is the oldest", () => {
    assert.deepEqual(
        ids(workingRuns([agent(2, 600_000), agent(1, 600_000), agent(3, undefined)])),
        [[2, 1], [3]],
    );
});
