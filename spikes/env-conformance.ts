/**
 * Phase 0, spike A: Pi Durable's own ExecutionEnv conformance suite, run against pi-env's RemoteExecutionEnv inside a
 * container over `docker exec -i` (or against the local daemon). Each case gets a fresh empty folder on the computer.
 *
 *   NOID_SPIKE_TRANSPORT=docker:noid-spike NOID_DOCKER=docker node --test spikes/env-conformance.ts
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { Connection, localDaemon, RemoteExecutionEnv } from "@earendil-works/pi-env";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const transport = process.env.NOID_SPIKE_TRANSPORT ?? "local";
const docker = process.env.NOID_DOCKER ?? "docker";
const connection = new Connection({
    command:
        transport === "local"
            ? [localDaemon()]
            : [docker, "exec", "-i", transport.slice("docker:".length), "/opt/pi-env/pi-env"],
});
const base =
    transport === "local" ? mkdtempSync(join(tmpdir(), "noid-conformance-")) : "/home/noid";
const root = new RemoteExecutionEnv({ connection, id: "noid:conformance", cwd: base });
let count = 0;

after(() => connection.close());

/** `partial` holds only some of `actual`'s fields: every field it has must match. */
function partialDeepEqual(actual: unknown, partial: unknown): void {
    if (partial === null || typeof partial !== "object") {
        assert.deepEqual(actual, partial);

        return;
    }

    assert.ok(actual !== null && typeof actual === "object", "expected an object");

    for (const [key, value] of Object.entries(partial)) {
        partialDeepEqual((actual as Record<string, unknown>)[key], value);
    }
}

const cases = createEnvConformance({
    assertions: {
        ok: (value, message) => assert.ok(value, message ?? "expected a truthy value"),
        strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
        deepEqual: (actual, expected) => assert.deepEqual(actual, expected),
        partialDeepEqual,
        greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
        rejects: async (operation, includes) => {
            await assert.rejects(operation, (error: Error) =>
                String(error?.message ?? error).includes(includes),
            );
        },
    },
    listFiles: true,
    withEnv: async (use) => {
        count += 1;

        const folder = `${base}/conformance-${process.pid}-${count}`;

        await root.exec(`rm -rf '${folder}' && mkdir -p '${folder}'`, undefined, context);

        try {
            await use(
                new RemoteExecutionEnv({
                    connection,
                    id: `noid:conformance:${count}`,
                    cwd: folder,
                }),
            );
        } finally {
            await root.exec(`rm -rf '${folder}'`, undefined, context);
        }
    },
});

for (const each of cases) {
    test(each.name, { timeout: each.timeoutMs ?? 30_000 }, () => each.run());
}
