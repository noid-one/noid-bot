// noid: the conversation menu's subagents at work, grouped by run (Pi Pocket lists them all). No imports, so the
// tests can load it.

/** Subagents asked within this long of the one before belong to one run: those Pi started together. */
const RUN_GAP = 60_000;

/**
 * noid: the subagents at work, as runs: those asked together (each within RUN_GAP of the one before), the newest run
 * first, each run in the order Pi asked them.
 */
export function workingRuns(agents) {
    const working = agents
        .filter((agent) => agent.busy)
        .sort((a, b) => (a.askedAt ?? 0) - (b.askedAt ?? 0));
    const runs = [];

    for (const agent of working) {
        const run = runs.at(-1);
        const last = run?.at(-1);

        if (run && (agent.askedAt ?? 0) - (last.askedAt ?? 0) <= RUN_GAP) {
            run.push(agent);
        } else {
            runs.push([agent]);
        }
    }

    return runs.reverse();
}
