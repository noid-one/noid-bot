import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { downloadIn } from "../src/server/noid/env-files.ts";

test("noid: a file on the computer downloads in parts, whole; a folder is not a download", async () => {
    const folder = mkdtempSync(join(tmpdir(), "noid-download-"));
    const env = new NodeExecutionEnv({ cwd: folder });
    // Larger than one part, so it is read more than once.
    const bytes = Buffer.alloc(2.5 * 1024 * 1024, 7);

    bytes[0] = 0;
    bytes[bytes.length - 1] = 255;
    writeFileSync(join(folder, "big.bin"), bytes);
    writeFileSync(join(folder, "empty.txt"), "");
    mkdirSync(join(folder, "sub"));

    try {
        const download = await downloadIn(env, join(folder, "big.bin"), context);
        const parts: Uint8Array[] = [];

        assert.equal(download?.size, bytes.length);

        for await (const part of download!.chunks) {
            parts.push(part);
        }

        assert.equal(parts.length, 3);
        assert.deepEqual(Buffer.concat(parts), bytes);

        const empty = await downloadIn(env, join(folder, "empty.txt"), context);

        assert.equal(empty?.size, 0);

        for await (const _ of empty!.chunks) {
            assert.fail("an empty file has no parts");
        }

        assert.equal(await downloadIn(env, join(folder, "sub"), context), undefined);
        await assert.rejects(downloadIn(env, join(folder, "missing"), context));
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});
