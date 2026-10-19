// noid: how a step on the timeline reads (web/steps.js), after pi-web-desktop's process view: a verb and what it acts
// on, shell commands by what they do, and calls of a kind one after another as one line.
import assert from "node:assert/strict";
import { test } from "node:test";

type View = {
    icon: string;
    verb: string;
    target: string;
    detail: string;
    path?: string;
    mono: boolean;
    kind: string;
};
type Steps = {
    classifyShell: (command: string) => { kind: string; binary: string; argument: string };
    stepView: (call: { name: string; args?: Record<string, unknown> }) => View;
    runLabel: (views: View[]) => { verb: string; target: string; more: string };
    runsOf: <T>(steps: T[], kindOf: (step: T) => string, joins: (step: T) => boolean) => T[][];
};

// A plain ES module of the web app's: a path the type checker does not follow, as it has no types of its own.
const steps = (await import(new URL("../web/steps.js", import.meta.url).href)) as Steps;

test("shell commands read by what they do, past cd, variables, and sudo", () => {
    const cases: [string, string, string][] = [
        ["ls -la web", "list", "web"],
        ["cd /repo && rg -n 'mainBot' web", "search", "mainBot"],
        ["grep -rn -e foo src", "search", "foo"],
        ["git grep isNoid", "search", "isNoid"],
        ['find . -name "*.ts"', "find", "*.ts"],
        ["sed -n 1,80p web/transcript.js", "read", "web/transcript.js"],
        ["head -50 README.md | tail -5", "read", "README.md"],
        ["curl -s https://example.com/x", "fetch", "https://example.com/x"],
        ["rm -rf build", "delete", "build"],
        ["mv a.txt b.txt", "move", "a.txt → b.txt"],
        ["NODE_ENV=test sudo npm test", "run", "test"],
        ["node --test test/steps.test.ts", "run", "test/steps.test.ts"],
    ];

    for (const [command, kind, argument] of cases) {
        const shell = steps.classifyShell(command);

        assert.equal(shell.kind, kind, command);
        assert.equal(shell.argument, argument, command);
    }

    assert.equal(steps.classifyShell("for i in 1 2; do echo $i; done").kind, "run");
});

test("a call says a verb and what it acts on, a file by its name", () => {
    const read = steps.stepView({ name: "read", args: { path: "web/transcript.js", offset: 10 } });

    assert.deepEqual(
        [read.verb, read.target, read.path],
        ["Read", "transcript.js:10", "web/transcript.js"],
    );

    const run = steps.stepView({ name: "bash", args: { command: "npm run lint" } });

    assert.deepEqual([run.icon, run.verb, run.target], ["terminal", "Run", "npm run lint"]);

    const cat = steps.stepView({ name: "bash", args: { command: "cat src/a.ts" } });

    assert.deepEqual([cat.verb, cat.target, cat.path], ["Read", "a.ts", "src/a.ts"]);
    assert.equal(cat.kind, read.kind, "a read in the shell shares a line with the read tool's");

    const mail = steps.stepView({
        name: "bot_message",
        args: { to: "Researcher", message: "Write three facts" },
    });

    assert.deepEqual(
        [mail.verb, mail.target, mail.detail],
        ["Message", "Researcher", "Write three facts"],
    );
    assert.equal(steps.stepView({ name: "bots", args: {} }).target, "", "no `{}` for no arguments");
    assert.equal(steps.stepView({ name: "session_read", args: { session: 7 } }).target, "#7");
    assert.equal(steps.stepView({ name: "mystery", args: { what: "it" } }).target, "it");
});

test("calls of a kind one after another share a line, and say what they acted on", () => {
    const view = (path: string) => steps.stepView({ name: "read", args: { path } });

    assert.deepEqual(steps.runLabel([view("a/x.js"), view("b/y.js")]), {
        verb: "Read",
        target: "x.js, y.js",
        more: "",
    });
    assert.deepEqual(steps.runLabel([view("x.js"), view("y.js"), view("z.js")]), {
        verb: "Read",
        target: "x.js",
        more: "+2",
    });
    assert.deepEqual(steps.runLabel([view("x.js"), view("x.js")]), {
        verb: "Read",
        target: "x.js",
        more: "×2",
    });

    const runs = steps.runsOf(
        ["read", "read", "edit", "read", "fail", "fail"],
        (step) => step,
        (step) => step !== "fail",
    );

    assert.deepEqual(runs, [["read", "read"], ["edit"], ["read"], ["fail"], ["fail"]]);
});
