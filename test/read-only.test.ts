// Which calls only read: the shell commands that only look, and the tools that change nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandWords, onlyReads, readOnlyCommand } from "../src/server/noid/read-only.ts";

test("anything beyond plain words in a command line is refused", () => {
    for (const refused of ["ls > out", 'echo "$(id)"', "echo `id`", "ls *.ts", "ls &"]) {
        const words = commandWords(refused);

        assert.ok(words === undefined || !readOnlyCommand(refused), refused);
    }
});

test("only commands that read pass, with arguments that keep them reading", () => {
    const reads = [
        "ls -la ~/src",
        "cat package.json | head -20",
        "cd src && grep -rn TODO .",
        "find . -name '*.ts' -not -path './node_modules/*'",
        "git status",
        "rg --glob '*.md' pi",
    ];

    for (const command of reads) {
        assert.equal(readOnlyCommand(command), true, command);
    }

    const changes = [
        "rm -rf build",
        "git commit -am x",
        "git -c core.pager=evil log",
        "git diff --output=patch.diff",
        "find . -name x -delete",
        "sort -o out.txt in.txt",
        "rg --pre ./run.sh foo",
        "rg --hostname-bin ./run.sh foo",
        // Long options shortened, as getopt and git accept them.
        "git log --outp=log.txt",
        "sort --compress=sh big.txt",
        // The subscript of a name runs what it substitutes.
        "printf -v 'a[$(touch pwned)]' x",
        "sed -i s/a/b/ f",
        "ls && rm x",
        "",
    ];

    for (const command of changes) {
        assert.equal(readOnlyCommand(command), false, command);
    }
});

test("only tools that read pass", () => {
    assert.equal(onlyReads("read", { path: "a" }), true);
    assert.equal(onlyReads("bash", { command: "git log" }), true);
    assert.equal(onlyReads("write", { path: "a", content: "" }), false);
    assert.equal(onlyReads("bash", { command: "npm install" }), false);
    assert.equal(onlyReads("schedule", {}), false, "tools it does not know do not pass");
    assert.equal(
        onlyReads("schedule", {}, true),
        true,
        "tools their extension marks read-only pass",
    );
});
