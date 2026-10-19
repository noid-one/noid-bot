// Bot faces (web/faces/): each id gives its own steady face, palettes stay readable, the body shape stays in its box,
// the motion blinks, looks around and spins at work, celebrates finished work once, and sleeps, and the SVG fallback draws the same face.
import assert from "node:assert/strict";
import { test } from "node:test";

type Rgb = [number, number, number];
type Traits = {
    seed: number;
    skin: string;
    eyes: string;
    roundness: number;
    aspect: number;
    palette: { base: Rgb; light: Rgb; dark: Rgb; eye: Rgb; glow: Rgb };
};
type Pose = {
    open: number;
    smile: number;
    sad: number;
    dim: number;
    offset: number[];
    squash: number[];
    tilt: number;
    look: [number, number];
};
type Motion = {
    state: string;
    gesture: string | undefined;
    setState: (state: string, now?: number) => void;
    step: (now: number, dt: number, pointer?: [number, number]) => Pose;
};
type Params = {
    SKINS: string[];
    EYES: string[];
    STATES: string[];
    hashOf: (text: string) => number;
    traitsOf: (id: string, overrides?: Record<string, unknown>) => Traits;
    paletteOf: (color: string | undefined, seed?: number) => Traits["palette"];
    bodyRadius: (traits: Traits, theta: number, time?: number, ripple?: number) => number;
};
type MotionModule = {
    DONE_SECONDS: number;
    SPIN_SECONDS: number;
    createMotion: (traits: Traits, options?: { reducedMotion?: boolean }) => Motion;
};
type Svg = {
    faceSvg: (traits: Traits, state?: string) => string;
    bodyPath: (traits: Traits) => string;
};

const load = async <T>(path: string) => (await import(new URL(path, import.meta.url).href)) as T;
const params = await load<Params>("../web/faces/params.js");
const motion = await load<MotionModule>("../web/faces/motion.js");
const svg = await load<Svg>("../web/faces/svg.js");

/** Steps a motion for `seconds` at 30 frames a second, from `start`, returning every pose's eye openness. */
function run(face: Motion, start: number, seconds: number): number[] {
    const opens: number[] = [];

    for (let frame = 0; frame < seconds * 30; frame++) {
        opens.push(face.step(start + frame / 30, 1 / 30).open);
    }

    return opens;
}

test("the same id always gives the same face, and different ids give different faces", () => {
    assert.equal(params.hashOf("Noid"), params.hashOf("Noid"));
    assert.deepEqual(params.traitsOf("Noid"), params.traitsOf("Noid"));

    const looks = new Set(
        Array.from({ length: 60 }, (_, index) => {
            const traits = params.traitsOf(`bot-${index}`);

            return `${traits.skin}/${traits.eyes}/${traits.roundness.toFixed(1)}/${traits.aspect.toFixed(2)}`;
        }),
    );

    assert.ok(looks.size >= 50, `only ${String(looks.size)} distinct looks in 60 bots`);
});

test("the owner's picks win over the id's, and unknown picks are ignored", () => {
    const picked = params.traitsOf("Scout", { skin: "pixel", eyes: "visor" });

    assert.equal(picked.skin, "pixel");
    assert.equal(picked.eyes, "visor");
    assert.ok(picked.roundness > 3, "visors sit on squarer bodies");

    const odd = params.traitsOf("Scout", { skin: "plaid", eyes: "lasers" });

    assert.ok(params.SKINS.includes(odd.skin));
    assert.ok(params.EYES.includes(odd.eyes));
});

test("palettes stay in range and readable, whatever the color", () => {
    const luma = ([r, g, b]: Rgb) => 0.299 * r + 0.587 * g + 0.114 * b;

    for (const color of [
        "#000000",
        "#ffffff",
        "#ff0000",
        "#7aa2f7",
        "#abc",
        "not a color",
        undefined,
    ]) {
        const palette = params.paletteOf(color, 3);

        for (const tone of Object.values(palette)) {
            assert.equal(tone.length, 3);
            assert.ok(
                tone.every((channel) => channel >= 0 && channel <= 1),
                String(color),
            );
        }

        assert.ok(luma(palette.eye) < luma(palette.base) - 0.15, `eyes read on ${String(color)}`);
        assert.ok(luma(palette.light) > luma(palette.dark), `light over dark on ${String(color)}`);
    }
});

test("the body stays inside its box at every angle and moment", () => {
    for (let index = 0; index < 40; index++) {
        const traits = params.traitsOf(`shape-${index}`);

        for (let step = 0; step < 72; step++) {
            const theta = (step / 72) * Math.PI * 2;

            for (const time of [0, 3.7, 50]) {
                const radius = params.bodyRadius(traits, theta, time, 1.6);

                assert.ok(radius > 0.35 && radius < 0.8, `radius ${String(radius)}`);
            }
        }
    }
});

test("an idle face blinks now and then, and keeps its eyes open in between", () => {
    const face = motion.createMotion(params.traitsOf("Blinker"));
    const opens = run(face, 0, 30);
    const closed = opens.filter((open) => open < 0.3).length;

    assert.ok(closed > 0, "it blinked");
    assert.ok(closed < opens.length * 0.1, "but mostly its eyes are open");
    assert.ok(opens.every((open) => Number.isFinite(open) && open >= 0 && open <= 1.2));
});

test("finished work is celebrated once, then the face is idle again", () => {
    const face = motion.createMotion(params.traitsOf("Worker"));

    face.setState("working", 0);
    run(face, 0, 2);
    face.setState("idle", 2);
    assert.equal(face.state, "done");

    const smiles = Array.from(
        { length: 20 },
        (_, frame) => face.step(2 + frame / 30, 1 / 30).smile,
    );

    assert.ok(smiles.at(-1)! > 0.5, "it smiles");
    run(face, 3, motion.DONE_SECONDS + 1);
    assert.equal(face.state, "idle");

    // Idle after idle, or after an error, is not a celebration.
    face.setState("error", 10);
    face.setState("idle", 11);
    assert.equal(face.state, "idle");
});

test("at work a face reads, looks around, thinks, and spins, and a spin ends where it began", () => {
    const face = motion.createMotion(params.traitsOf("Worker"));
    const gestures = new Set<string>();
    // Read through a call: an assertion on the getter would narrow it for the rest of the test.
    const gesture = () => face.gesture;
    let turned = 0;

    face.setState("working", 0);
    assert.equal(gesture(), "look", "work begins with a look around");

    for (let frame = 0; frame < 120 * 30; frame++) {
        const pose = face.step(frame / 30, 1 / 30);

        gestures.add(gesture()!);
        turned = Math.max(turned, Math.abs(pose.tilt));
        assert.ok(Math.abs(pose.look[0]) <= 1 && Math.abs(pose.look[1]) <= 1, "eyes stay in");

        if (gesture() !== "spin") {
            assert.ok(Math.abs(pose.tilt) < 0.3, "only a spin turns it far");
        }
    }

    assert.deepEqual([...gestures].sort(), ["look", "scan", "spin", "think"]);
    assert.ok(turned > Math.PI, "it spun");

    // Cut short mid-spin, it turns on to a whole turn and stands upright.
    let now = 120;

    while (gesture() !== "spin") {
        now += 1 / 30;
        face.step(now, 1 / 30);
    }

    for (const end = now + motion.SPIN_SECONDS / 2; now < end; now += 1 / 30) {
        face.step(now, 1 / 30);
    }

    assert.ok(Math.abs(face.step(now, 1 / 30).tilt) > 1, "mid-spin");
    face.setState("waiting", now);

    let pose = face.step(now, 1 / 30);

    for (let frame = 0; frame < 60; frame++) {
        pose = face.step(now + frame / 30, 1 / 30);
    }

    assert.equal(gesture(), undefined);
    assert.ok(Math.abs(pose.tilt) < 0.05, `upright again (${String(pose.tilt)})`);
});

test("asleep, the eyes close and the face dims; upset, the eyes droop", () => {
    const sleeper = motion.createMotion(params.traitsOf("Sleeper"));

    sleeper.setState("asleep", 0);
    const opens = run(sleeper, 0, 6);
    const pose = sleeper.step(6, 1 / 30);

    assert.ok(Math.max(...opens.slice(60)) < 0.1, "eyes stay shut");
    assert.ok(pose.dim > 0.3);

    const upset = motion.createMotion(params.traitsOf("Upset"));

    upset.setState("error", 0);
    run(upset, 0, 3);
    assert.ok(upset.step(3, 1 / 30).sad > 0.9);
});

test("with reduced motion, a pose changes only with its state", () => {
    const face = motion.createMotion(params.traitsOf("Still"), { reducedMotion: true });
    const first = { ...face.step(0, 1 / 30) };
    const later = { ...face.step(7.3, 1 / 30) };

    assert.deepEqual(later.offset, first.offset);
    assert.deepEqual(later.squash, first.squash);
    assert.equal(later.open, 1);
    face.setState("asleep", 8);
    assert.ok(face.step(8, 1 / 30).open < 0.1);
});

test("the SVG fallback draws the body and two eyes, and arches them when happy", () => {
    const traits = params.traitsOf("Fallback");
    const idle = svg.faceSvg(traits, "idle");

    assert.match(idle, /^<svg /);
    assert.match(idle, /data-state="idle"/);
    assert.equal((idle.match(/class="noid-face-eye"/g) ?? []).length, 2);
    assert.match(svg.bodyPath(traits), /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+){47}Z$/);

    const happy = svg.faceSvg(traits, "done");

    assert.equal((happy.match(/class="noid-face-eye"/g) ?? []).length, 0);
    assert.equal((happy.match(/q5 -8 10 0/g) ?? []).length, 2);
});
