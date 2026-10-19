// noid: a new install's owner is not "Owner" but two words picked at random, which they can change.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
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
