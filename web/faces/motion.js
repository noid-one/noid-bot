// How a face moves: a small state machine per face that turns what the bot is doing (idle, working, waiting, done,
// error, asleep), the time, and where the pointer is into a pose the renderer draws. Pure: no DOM, no clock of its own,
// so the tests can step it.

import { randomFrom } from "./params.js";

/** How long the happy "done" moment lasts, in seconds, before the face goes back to idle. */
export const DONE_SECONDS = 1.8;

/** How long one blink takes, in seconds. */
const BLINK_SECONDS = 0.16;

/** How long a spin at work takes, in seconds. */
export const SPIN_SECONDS = 0.9;

/**
 * What a face does while its bot works, after Grok's: reads (its eyes scan a line), looks around (quick darts), thinks
 * (eyes up to one side, a little squint), or spins once. Each is held a while, then another follows: `weight` is how
 * often it is picked, `seconds` how long it lasts (a minimum and a spread).
 */
const WORK_GESTURES = {
    scan: { weight: 3, seconds: [2, 1.5] },
    look: { weight: 3, seconds: [1.6, 1.2] },
    think: { weight: 2, seconds: [1.4, 1] },
    spin: { weight: 1.5, seconds: [SPIN_SECONDS + 0.25, 0] },
};

/** Each state's resting pose: what the face eases toward. */
const TARGETS = {
    idle: { open: 1, smile: 0, sad: 0, glow: 0, dim: 0, ripple: 1, rippleSpeed: 1 },
    working: { open: 1, smile: 0, sad: 0, glow: 0.75, dim: 0, ripple: 1.6, rippleSpeed: 2.6 },
    waiting: { open: 1.12, smile: 0, sad: 0, glow: 0.6, dim: 0, ripple: 1.1, rippleSpeed: 1.4 },
    done: { open: 1, smile: 1, sad: 0, glow: 0.45, dim: 0, ripple: 1.3, rippleSpeed: 2 },
    error: { open: 0.55, smile: 0, sad: 1, glow: 0.35, dim: 0.15, ripple: 0.5, rippleSpeed: 0.6 },
    asleep: { open: 0.04, smile: 0, sad: 0, glow: 0, dim: 0.4, ripple: 0.4, rippleSpeed: 0.4 },
};

/** Which glow color a state uses: 0 the bot's own, 1 amber (wants you), 2 red (failed). */
const GLOW_TONE = { idle: 0, working: 0, waiting: 1, done: 0, error: 2, asleep: 0 };

/** Move `value` toward `target` at `rate` per second, independent of the frame rate. */
export function ease(value, target, rate, dt) {
    return target + (value - target) * Math.exp(-rate * dt);
}

/** A face's motion, from its traits. `reducedMotion` keeps it still: poses change only with its state. */
export function createMotion(traits, { reducedMotion = false } = {}) {
    const random = randomFrom(traits.seed ^ 0x5eed);
    const between = (min, spread) => min + random() * spread;
    const pose = {
        offset: [0, 0],
        squash: [1, 1],
        tilt: 0,
        look: [0, 0],
        ...TARGETS.idle,
        glowTone: 0,
        time: random() * 100,
    };
    let state = "idle";
    let stateSince = 0;
    // How open the eyes are before a blink closes them: blinks multiply this, they never feed back into it.
    let openLevel = 1;
    let clock = 0;
    let nextBlink = between(traits.blinkMin * 0.3, traits.blinkSpread);
    let blinkAt = -1;
    let nextGlance = between(1, 3);
    let glance = [0, 0];
    // A spring for hops and boops: its displacement adds to the squash and the height.
    let spring = 0;
    let springSpeed = 0;
    let nextHop = 0;
    // At work: the gesture, when it began and ends, its side (-1 or 1), and where a darting look is aimed.
    let gesture = "look";
    let gestureSince = 0;
    let gestureEnds = 0;
    let side = 1;
    let dart = [0, 0];
    let nextDart = 0;
    let spin = 0;
    let leaning = 0;

    /** The next gesture at work, never the one just done: a face does not spin twice running. */
    function nextGesture(now) {
        const choices = Object.entries(WORK_GESTURES).filter(([name]) => name !== gesture);
        let pick = random() * choices.reduce((sum, [, each]) => sum + each.weight, 0);
        const [name, { seconds }] =
            choices.find(([, each]) => (pick -= each.weight) < 0) ?? choices[0];

        gesture = name;
        gestureSince = now;
        gestureEnds = now + between(seconds[0], seconds[1]);
        side = random() < 0.5 ? -1 : 1;
        nextDart = now;

        if (name === "spin") {
            boop(0.45);
        }
    }

    function setState(next, now = clock) {
        const known = next in TARGETS ? next : "idle";

        // Work that ends well is celebrated once: done, then idle.
        const celebrated = state === "working" && known === "idle" ? "done" : known;

        if (celebrated === state) {
            return;
        }

        state = celebrated;
        stateSince = now;
        nextHop = now;

        // Work begins with a look around.
        if (state === "working") {
            gesture = "look";
            gestureSince = now;
            gestureEnds = now + between(1.2, 0.8);
            nextDart = now;
        }

        if (state === "done") {
            boop(0.9);
        }
    }

    /** A squash-and-stretch kick: a hover, a click, a hop. */
    function boop(strength = 0.6) {
        springSpeed -= 5 * strength;
    }

    function blinkAmount(now) {
        if (state === "asleep") {
            return 0;
        }

        if (now >= nextBlink && blinkAt < 0) {
            blinkAt = now;
        }

        if (blinkAt < 0) {
            return 0;
        }

        const progress = (now - blinkAt) / BLINK_SECONDS;

        if (progress >= 1) {
            blinkAt = -1;
            // Now and then a double blink, as people do.
            nextBlink =
                random() < 0.15 ? now + 0.12 : now + between(traits.blinkMin, traits.blinkSpread);

            return 0;
        }

        return Math.sin(progress * Math.PI);
    }

    /**
     * The pose at `now` (seconds), `dt` after the last step. `pointer` is where the pointer is, relative to the face's
     * center in face widths, or undefined when it is far away or unknown.
     */
    function step(now, dt, pointer) {
        clock = now;

        if (state === "done" && now - stateSince >= DONE_SECONDS) {
            state = "idle";
            stateSince = now;
        }

        const target = TARGETS[state];
        const since = now - stateSince;

        if (reducedMotion) {
            Object.assign(pose, target, {
                offset: [0, state === "error" ? -0.03 : 0],
                squash: [1, 1],
                tilt: 0,
                look: [0, state === "waiting" ? 0.2 : 0],
                glowTone: GLOW_TONE[state],
            });

            return pose;
        }

        const rate = 8;

        for (const key of ["smile", "sad", "glow", "dim", "ripple", "rippleSpeed"]) {
            pose[key] = ease(pose[key], target[key], rate, dt);
        }

        pose.glowTone = GLOW_TONE[state];
        pose.time += dt * pose.rippleSpeed;

        // Breathing, the base of every state; slower asleep, quicker at work.
        const breathPeriod =
            state === "asleep"
                ? traits.breathPeriod * 1.6
                : state === "working"
                  ? 1.1
                  : traits.breathPeriod;
        const breath = Math.sin(((now % 1000) / breathPeriod) * Math.PI * 2);
        let height = 0;
        let tilt = 0;
        let lookTarget = [0, 0];

        let open = target.open;

        if (state === "working") {
            if (now >= gestureEnds) {
                nextGesture(now);
            }

            const into = now - gestureSince;

            // A busy bob under every gesture.
            height = 0.03 * Math.abs(Math.sin(now * 3.4));

            if (gesture === "scan") {
                // Reading: eyes along a line and back, a little low.
                tilt = 0.035 * Math.sin(now * 1.7);
                lookTarget = [Math.sin(now * 1.9) * 0.85, -0.25 + 0.1 * Math.sin(now * 3.8)];
            } else if (gesture === "look") {
                // Looking around: quick darts, each held a moment.
                if (now >= nextDart) {
                    dart = [between(-0.95, 1.9), between(-0.6, 1.2)];
                    nextDart = now + between(0.3, 0.35);
                }

                tilt = dart[0] * 0.05;
                lookTarget = dart;
            } else if (gesture === "think") {
                // Thinking: eyes up to one side, head tipped, a little squint.
                height = 0.012 * Math.sin(now * 2);
                tilt = side * 0.09;
                lookTarget = [side * 0.75, 0.8];
                open *= 0.8;
            } else {
                // A spin: once around, eased in and out, with a hop at its top.
                const progress = Math.min(1, into / SPIN_SECONDS);
                const eased = progress * progress * (3 - 2 * progress);

                spin = side * Math.PI * 2 * eased;
                height = 0.08 * Math.sin(Math.PI * progress);
                lookTarget = [side * 0.6, 0.1];
            }
        } else if (state === "waiting") {
            // Looking at you, with a small hop every so often.
            lookTarget = [0, 0.25];

            if (now >= nextHop) {
                boop(0.55);
                nextHop = now + 1.6;
            }
        } else if (state === "done") {
            height = 0.06 * Math.max(0, Math.sin(Math.min(1, since / 0.5) * Math.PI));
            lookTarget = [0, 0.15];
        } else if (state === "error") {
            height = -0.03;
            tilt = -0.05;
            lookTarget = [0.15, -0.55];
        } else if (state === "asleep") {
            height = -0.02;
            tilt = 0.06;
        } else {
            // Idle: glance around now and then.
            if (now >= nextGlance) {
                glance = random() < 0.35 ? [0, 0] : [between(-0.8, 1.6), between(-0.5, 0.9)];
                nextGlance = now + between(1.4, 3.2);
            }

            lookTarget = glance;
        }

        // The pointer wins over glances: eyes follow it when it is near, unless the bot is busy, upset, or asleep.
        if (
            pointer !== undefined &&
            (state === "idle" || state === "waiting" || state === "done")
        ) {
            const distance = Math.hypot(pointer[0], pointer[1]);
            const reach = Math.min(1, distance * 1.5);

            if (distance > 0) {
                lookTarget = [(pointer[0] / distance) * reach, (-pointer[1] / distance) * reach];
            }
        }

        // Darting eyes move fast; the rest drift.
        const lookRate = state === "working" && gesture === "look" ? 24 : 10;

        pose.look = [
            ease(pose.look[0], lookTarget[0], lookRate, dt),
            ease(pose.look[1], lookTarget[1], lookRate, dt),
        ];
        openLevel = ease(openLevel, open, 14, dt);

        // The spring: hops and boops settle with a little overshoot.
        springSpeed += (-60 * spring - 7 * springSpeed) * dt;
        spring += springSpeed * dt;

        const squeeze = spring * 0.5;
        const breathe = 0.022 * breath * (state === "working" ? 0.6 : 1);

        pose.offset = [0, height + Math.max(0, -spring) * 0.12 + breathe * 0.4];
        pose.squash = [1 + squeeze - breathe * 0.6, 1 - squeeze + breathe];

        // A whole turn is no turn: a spin done ends where it began, and one cut short turns on to the nearest whole.
        if (state !== "working" || gesture !== "spin") {
            const whole = Math.round(spin / (Math.PI * 2)) * Math.PI * 2;

            spin = Math.abs(spin - whole) < 0.01 ? 0 : ease(spin, whole, 8, dt);
        }

        leaning = ease(leaning, tilt, 6, dt);
        pose.tilt = leaning + spin;

        const blink = blinkAmount(now);

        pose.open = Math.max(0, openLevel * (1 - blink));

        return pose;
    }

    return {
        get state() {
            return state;
        },
        /** What it does at work (scan, look, think, spin), while it works. */
        get gesture() {
            return state === "working" ? gesture : undefined;
        },
        setState,
        boop,
        step,
        pose,
    };
}
