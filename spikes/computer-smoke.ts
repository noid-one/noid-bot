/**
 * The shared computer by hand: build its image when missing, start it, and run one command in a bot's folder.
 *
 *   NOID_DOCKER=docker node spikes/computer-smoke.ts
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Computer } from "../src/server/noid/computer.ts";

const computer = new Computer({ log: (message) => console.log(`[computer] ${message}`) });
const started = Date.now();
let output = "";

console.log("state before:", await computer.state());

const result = await computer
    .env("/home/noid")
    .exec(
        "mkdir -p /home/noid/bots/smoke && cd /home/noid/bots/smoke && pwd && whoami && uv --version && " +
            "gh --version | head -1 && chromium --version && git --version && ls /home/noid",
        { onOutput: (text) => void (output += text) },
        context,
    );

console.log(result.ok ? output.trim() : result.error, `\n(${Date.now() - started} ms)`);
console.log("state after:", await computer.state());
await computer.close();
