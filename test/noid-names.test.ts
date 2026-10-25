// noid: a new install's owner is not "Owner" but two words picked at random, which they can change.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigStore, funName } from "../src/server/config.ts";

after(cleanUp);

test("the owner starts with a fun two-word name, kept across restarts", () => {
    assert.equal(
        funName(() => 0),
        "Brisk Badger",
    );
    assert.match(funName(), /^[A-Z][a-z]+ [A-Z][a-z]+$/);

    const dir = join(root, "names-config");
    const first = new ConfigStore(dir).users.find((user) => user.role === "owner")!;

    assert.notEqual(first.name, "Owner");
    assert.match(first.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.equal(
        new ConfigStore(dir).users.find((user) => user.role === "owner")!.name,
        first.name,
        "picked once, when the install is made",
    );
});

test("an install from before Noid compacted as sessions do keeps its 60k limit; a new one, and a choice, stay as they are", () => {
    const write = (name: string, config: object) => {
        const dir = join(root, name);

        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "config.json"), JSON.stringify(config));

        return dir;
    };

    const before = { version: 1, ownerToken: "t", users: [] };
    const old = write("compact-old", before);

    assert.equal(new ConfigStore(old).noidCompactAt, 60_000);
    assert.equal(JSON.parse(readFileSync(join(old, "config.json"), "utf8")).version, 2);
    // Once: what the owner picks after is theirs.
    const store = new ConfigStore(old);

    store.noidCompactAt = 0;
    assert.equal(new ConfigStore(old).noidCompactAt, 0);
    assert.equal(
        new ConfigStore(write("compact-chose", { ...before, noidCompactAt: 0 })).noidCompactAt,
        0,
    );
    assert.equal(
        new ConfigStore(write("compact-chose-100k", { ...before, noidCompactAt: 100_000 }))
            .noidCompactAt,
        100_000,
    );

    const fresh = join(root, "compact-new");

    assert.equal(new ConfigStore(fresh).noidCompactAt, undefined);
    assert.equal(
        new ConfigStore(fresh).noidCompactAt,
        undefined,
        "not taken for an old install when it starts again",
    );
});
