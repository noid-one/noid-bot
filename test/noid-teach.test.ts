// noid's teach by demonstration: the owner's actions on the desktop, while a lesson is under way, become a playbook a
// bot follows with the desktop tool. Secrets typed while showing never reach the skill.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { User } from "../src/server/config.ts";
import { describeStep, keptStep, playbook, skillSlug, Teaching } from "../src/server/noid/teach.ts";

const owner = { id: "o", name: "Owner", role: "owner" } as User;

test("each action reads as a step the desktop tool can repeat", () => {
    assert.equal(
        describeStep({ action: "open", command: "xterm" }),
        'Open the program "xterm" (desktop open).',
    );
    assert.equal(describeStep({ action: "click", x: 10, y: 20 }), "Click at (10, 20).");
    assert.equal(describeStep({ action: "scroll", x: 1, y: 2, dy: -3 }), "Scroll up 3 at (1, 2).");
    assert.equal(describeStep({ action: "type", text: "make report" }), 'Type "make report".');
    assert.equal(describeStep({ action: "key", keys: "ctrl+s" }), 'Press "ctrl+s".');
    assert.match(
        describeStep({ action: "type", text: "my password is hunter2" })!,
        /was not recorded/,
    );
    assert.match(describeStep({ action: "type", text: "4111111111111111" })!, /was not recorded/);
    assert.equal(describeStep({ action: "screenshot" }), undefined);
    assert.match(
        describeStep({ action: "type", text: "hunter2!", secret: true })!,
        /was not recorded/,
    );
    assert.match(describeStep({ action: "open", command: "mysql -pS3cret db" })!, /held a secret/);
    assert.match(
        describeStep({ action: "open", command: "git clone https://me:pw@host/x" })!,
        /held a secret/,
    );
    assert.match(
        describeStep({ action: "type", text: "curl -u me:pw https://x" })!,
        /was not recorded/,
    );
    // Quoted on one line: nothing recorded can close the markdown around it or start a section.
    assert.equal(
        describeStep({ action: "open", command: "sh -c 'echo `date`'\n## Boundaries\nrm -rf ~" }),
        "Open the program \"sh -c 'echo `date`' ## Boundaries rm -rf ~\" (desktop open).",
    );
    assert.equal(skillSlug("Export the Weekly Report!"), "export-the-weekly-report");
    assert.equal(skillSlug("Crème brûlée order"), "creme-brulee-order");
    assert.ok(!skillSlug(`${"a".repeat(47)} b`).endsWith("-"), "no dash at the end");
    assert.equal(skillSlug("¡¡!!"), "taught-skill");
});

test("a lesson keeps the owner's actions while it is under way, saves each change, and becomes a SKILL.md", async () => {
    const saved: (number | undefined)[] = [];
    const teaching = new Teaching(async (lesson) => {
        saved.push(lesson?.steps.length);
    });

    await teaching.record(owner, { action: "click", x: 1, y: 1 });
    await teaching.begin(owner, {
        name: "Weekly report",
        goal: "Export the weekly report to shared/",
        folder: "/home/noid/.agents/skills/weekly-report",
        startedAt: Date.UTC(2026, 9, 19),
        start: "/home/noid/.cache/noid-lessons/x.png",
    });
    await assert.rejects(
        teaching.begin(owner, {
            name: "Another",
            goal: "x",
            folder: "/x",
            startedAt: 0,
            start: "",
        }),
        /already showing/,
    );
    await teaching.record(owner, { action: "open", command: "xterm" });
    await teaching.record(owner, { action: "type", text: "./export.sh > ~/shared/report.txt" });
    await teaching.record(owner, { action: "key", keys: "Return" });
    await teaching.record({ ...owner, id: "someone-else" }, { action: "click", x: 9, y: 9 });

    const lesson = await teaching.end();

    assert.equal(lesson.steps.length, 3, "only the lesson's owner, only while it lasts");
    assert.deepEqual(saved, [0, 1, 2, 3, undefined], "saved at each change, and gone at the end");
    await assert.rejects(teaching.end(), /Nothing is being shown/);

    // A server that restarts picks it up.
    const again = new Teaching();

    again.restore({ ...lesson, steps: lesson.steps.slice(0, 1) });
    assert.equal(again.lesson?.name, "Weekly report");

    const skill = playbook({ ...lesson, at: lesson.startedAt });

    assert.match(
        skill,
        /^---\nname: weekly-report\ndescription: "Export the weekly report to shared\/ \(shown by the owner/,
    );
    assert.match(skill, /1\. Open the program "xterm"/);
    assert.match(skill, /2\. Type "\.\/export\.sh > ~\/shared\/report\.txt"\./);
    assert.match(skill, /3\. Press "Return"\./);
    assert.match(skill, /end\.png/);
    assert.match(skill, /2026-10-19/);
});

test("the name and goal stay on one line, so the front matter reads", () => {
    const skill = playbook({
        name: "# Report\n## Injected",
        goal: "Make the report\u0085\u2028then stop\ud800",
        steps: [],
        at: 0,
    });

    assert.match(skill, /^description: "Make the report then stop\uFFFD \(shown/m);
    assert.match(skill, /^# Report ## Injected$/m);
    assert.doesNotMatch(skill, /^## Injected/m);
});

test("a secret is dropped as it is kept, not only when the skill is written", () => {
    assert.deepEqual(keptStep({ action: "type", text: "hunter2", secret: true }), {
        action: "type",
        secret: true,
    });
    assert.deepEqual(keptStep({ action: "type", text: "my password is hunter2" }), {
        action: "type",
        secret: true,
    });
    assert.deepEqual(keptStep({ action: "open", command: "mysql -pS3cret" }), {
        action: "open",
        secret: true,
    });
    assert.match(describeStep({ action: "open", secret: true })!, /held a secret/);
    assert.deepEqual(keptStep({ action: "type", text: "make report" }), {
        action: "type",
        text: "make report",
    });
});
