/**
 * noid's teach by demonstration (rakazo's teach recording and playbook, Apache-2.0): the owner shows a task on the
 * computer's desktop, and it becomes a skill. While teaching, each of the owner's own actions there (a program opened,
 * a click, typing, a key, a scroll) is kept; at the end they become a playbook, a SKILL.md with the steps, saved with
 * how the screen looked before and after, where the computer's skills are found: one bot's folder, or the folder every
 * bot shares. A bot finds it with its other skills and repeats it with the desktop tool; a routine can ask for it.
 */
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";
import { rebased } from "../docs.ts";
import type { User } from "../config.ts";
import { slug } from "./bots.ts";
import { HttpError } from "../errors.ts";

/** One of the owner's actions on the desktop, as it was asked for. */
export type TaughtStep = { [key: string]: JsonValue };

/**
 * Text that looks like a secret is never written into a skill: words that name one, long card-like numbers, a password
 * on a command line (`-pS3cret`, `--password=…`, `-u me:pw`, `https://me:pw@host`), or a bearer token. What the owner
 * marks secret as they type it is never written either: a word list cannot know a password.
 */
const SECRET =
    /password|passwd|secret|token|api[_-]?key|bearer\s|\b\d{12,19}\b|(^|\s)-p\S|--pass\w*=|(^|\s)-u\s+\S+:\S|:\/\/[^\s/@:]+:[^\s/@]+@/i;

/** A recorded value as plain words in a skill: one line, no control characters, quoted so nothing in it reads as markdown. */
const quoted = (value: unknown) => JSON.stringify(oneLine(String(value)));

/**
 * Typed text as a bot must type it again: every space, tab and line break kept (an indented line, a pasted paragraph),
 * escaped in its quotes so the step stays one line of markdown. Only invisible format characters go, which could make
 * the step read otherwise than it types.
 */
const typed = (text: string) =>
    JSON.stringify(
        text
            .toWellFormed()
            .replace(/[\p{Zl}\p{Zp}]/gu, "\n")
            .replace(/\p{Cf}/gu, ""),
    );

/** The most text one kept `type` step joins, as the desktop tool types (`MAX_TYPE` in desktop.ts). */
const JOIN_UP_TO = 1000;

/** One line of text without control characters or broken surrogates, which front matter and markdown cannot hold. */
const oneLine = (text: string) =>
    text
        .toWellFormed()
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

/**
 * A step as it is kept while the lesson goes on: a secret's text is dropped there and then, so it never reaches the
 * database (whose history keeps every version), not only the skill.
 */
export function keptStep(step: TaughtStep): TaughtStep {
    if (step.action === "type" && (step.secret === true || SECRET.test(String(step.text)))) {
        return { action: "type", secret: true };
    }

    if (step.action === "open" && SECRET.test(String(step.command))) {
        return { action: "open", secret: true };
    }

    return step;
}

/** A playbook step for one action, in words a bot follows with the desktop tool. */
export function describeStep(step: TaughtStep): string | undefined {
    const at = `(${String(step.x)}, ${String(step.y)})`;

    switch (step.action) {
        case "open":
            return step.secret === true || SECRET.test(String(step.command))
                ? "Open the program the task needs (its command held a secret, so it was not recorded; ask the owner)."
                : `Open the program ${quoted(step.command)} (desktop open).`;
        case "click":
            return `Click at ${at}.`;
        case "double_click":
            return `Double-click at ${at}.`;
        case "right_click":
            return `Right-click at ${at}.`;
        case "drag":
            return `Drag from ${at} to (${String(step.to_x)}, ${String(step.to_y)}).`;
        case "scroll":
            return `Scroll ${Number(step.dy) < 0 ? "up" : "down"} ${Math.abs(Number(step.dy))} at ${at}.`;

        case "type": {
            const text = String(step.text);

            return step.secret === true || SECRET.test(text)
                ? "Type the secret the task needs here (it was not recorded; ask the owner for it, never guess)."
                : `Type ${typed(text)}.`;
        }

        case "key":
            return `Press ${quoted(step.keys)}.`;
        default:
            return undefined;
    }
}

/** A skill's folder name: lowercase words joined by dashes. */
export function skillSlug(name: string): string {
    return slug(name, 48, "taught-skill");
}

/** The SKILL.md for what was shown. */
export function playbook(input: {
    name: string;
    goal: string;
    steps: TaughtStep[];
    at: number;
}): string {
    const lines = input.steps.flatMap((step) => {
        const line = describeStep(step);

        return line === undefined ? [] : [line];
    });
    const steps =
        lines.length === 0
            ? [
                  "Nothing was recorded: look at start.png and end.png, and ask the owner how to get from one to the other.",
              ]
            : lines;
    const description = `${oneLine(input.goal)} (shown by the owner on the computer's desktop)`;

    return [
        "---",
        `name: ${skillSlug(input.name)}`,
        `description: ${JSON.stringify(description)}`,
        "---",
        `# ${oneLine(input.name).replace(/^#+\s*/, "")}`,
        "",
        `The owner showed this on the shared computer's desktop (1280×800) on ${new Date(input.at).toISOString().slice(0, 10)}. Repeat it with the desktop tool: take a screenshot first, and after each step.`,
        "",
        "## When to use",
        "",
        oneLine(input.goal),
        "",
        "## Steps",
        "",
        ...steps.map((step, index) => `${index + 1}. ${step}`),
        "",
        "Positions are where things were when it was shown: if a window or button moved, find the same thing in your screenshot and use where it is now.",
        "",
        "## How to check",
        "",
        "start.png in this folder is how the screen looked before, end.png how it looked after. Compare your last screenshot with end.png, and say the task is done only when it matches the goal.",
        "",
        "## Boundaries",
        "",
        "- Do not send messages, spend money, publish, or delete anything the owner did not show here without asking first.",
        "- If a step fails or the screen does not look as expected, stop and say what you see; do not guess.",
        "",
    ].join("\n");
}

/** A demonstration under way: its goal, where it goes, the screen before (a file on the computer), and the steps so far. */
export type Lesson = {
    name: string;
    goal: string;
    /** The folder its skill goes in, on the computer. */
    folder: string;
    by: string;
    startedAt: number;
    /** Where the screenshot from before is kept on the computer until the skill is saved. */
    start: string;
    steps: TaughtStep[];
};

/** The lesson under way, kept so a restart of the server does not lose it. */
export const LessonDoc = defineDoc<{ lesson?: Lesson }>({
    kind: "x.noid.lesson",
    version: 1,
    ...rebased,
    scope: "session",
    initial: () => ({}),
});

const MAX_STEPS = 200;

/** The one lesson under way (one desktop, one owner), saved with each change by `save`. */
export class Teaching {
    #lesson: Lesson | undefined;
    readonly #save: (lesson: Lesson | undefined) => Promise<void>;

    constructor(save: (lesson: Lesson | undefined) => Promise<void> = async () => {}) {
        this.#save = save;
    }

    get lesson(): Lesson | undefined {
        return this.#lesson;
    }

    /** The lesson a server stopped in the middle of: it goes on. */
    restore(lesson: Lesson | undefined): void {
        this.#lesson = lesson;
    }

    async begin(user: User, lesson: Omit<Lesson, "by" | "steps">): Promise<void> {
        if (this.#lesson !== undefined) {
            throw new HttpError(
                409,
                `You are already showing “${this.#lesson.name}”: finish it or stop it first.`,
            );
        }

        this.#lesson = { ...lesson, by: user.id, steps: [] };
        await this.#save(this.#lesson);
    }

    /** Keep one of the owner's actions, while a lesson is under way. */
    async record(user: User, step: TaughtStep): Promise<void> {
        if (
            this.#lesson?.by === user.id &&
            step.action !== "release" &&
            this.#lesson.steps.length < MAX_STEPS
        ) {
            const steps = this.#lesson.steps;
            const last = steps.at(-1);

            // Typing reaches the server in pieces (a pause between words, a long paste): one step again, with the
            // spaces between them, and judged secret or not as a whole.
            if (
                step.action === "type" &&
                step.secret !== true &&
                last?.action === "type" &&
                last.secret !== true &&
                String(last.text).length + String(step.text).length <= JOIN_UP_TO
            ) {
                steps[steps.length - 1] = keptStep({
                    action: "type",
                    text: `${String(last.text)}${String(step.text)}`,
                });
            } else {
                steps.push(keptStep(step));
            }

            await this.#save(this.#lesson);
        }
    }

    async end(): Promise<Lesson> {
        const lesson = this.#lesson;

        if (lesson === undefined) {
            throw new HttpError(409, "Nothing is being shown.");
        }

        this.#lesson = undefined;
        await this.#save(undefined);

        return lesson;
    }
}
