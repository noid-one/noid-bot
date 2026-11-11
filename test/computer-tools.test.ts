// What the bot preamble says the shared computer has must be what computer/Dockerfile installs (rakazo 20e9e989f).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMPUTER_TOOLS } from "../src/server/extensions/prompt.ts";

const dockerfile = readFileSync(new URL("../computer/Dockerfile", import.meta.url), "utf8");

test("every tool the preamble names is in the computer image", () => {
    // name in the preamble → what the Dockerfile installs it as
    const packages: Record<string, string> = {
        git: "git",
        ssh: "openssh-client",
        curl: "curl",
        jq: "jq",
        unzip: "unzip",
        file: "file",
        "build-essential": "build-essential",
        ffmpeg: "ffmpeg",
        pandoc: "pandoc",
        poppler: "poppler-utils",
        openpyxl: "python3-openpyxl",
        python3: "python3",
        Chromium: "chromium",
    };
    for (const [named, pkg] of Object.entries(packages)) {
        assert.ok(COMPUTER_TOOLS.includes(named), `preamble names ${named}`);
        assert.match(dockerfile, new RegExp(`^\\s+${pkg} \\\\$`, "m"), `Dockerfile installs ${pkg}`);
    }
    assert.match(dockerfile, /uv-\$\{uv_arch\}/, "uv is installed");
    assert.match(dockerfile, /gh_/, "gh is installed");
    assert.match(dockerfile, /^USER 1000:1000$/m, "runs unprivileged");
    assert.doesNotMatch(dockerfile, /^\s+(sudo|python3-pip) \\$/m, "no sudo, no pip");
});
