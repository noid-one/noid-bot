import {
    type App,
    cleanUp,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { SHOT_MAX } from "../src/server/browser/page.ts";
import { normalizeUrl } from "../src/server/browser/urls.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { onlyReads } from "../src/server/noid/read-only.ts";
import { uploadable } from "../src/server/extensions/browser.ts";

/** A JPEG's size in pixels, from its first frame header. */
function jpegSize(data: string): { width: number; height: number } {
    const bytes = Buffer.from(data, "base64");

    for (let at = 2; at + 9 < bytes.length; at += 2 + bytes.readUInt16BE(at + 2)) {
        const marker = bytes[at + 1]!;

        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
        }
    }

    throw new Error("no JPEG frame header");
}

test("addresses as people type them become URLs the browser may open", () => {
    assert.equal(normalizeUrl("localhost:5173"), "http://localhost:5173/");
    assert.equal(normalizeUrl("example.com/docs"), "https://example.com/docs");
    assert.equal(normalizeUrl("about:blank"), "about:blank");

    for (const refused of [
        "javascript:alert(1)",
        "chrome://settings",
        "view-source:https://example.com",
        "file:///etc/hosts",
        "/etc/hosts",
        "data:text/html,hi",
    ]) {
        assert.equal(normalizeUrl(refused), undefined, refused);
    }

    // Pi and the owner may open files on this machine.
    assert.equal(normalizeUrl("file:///etc/hosts", { trusted: true }), "file:///etc/hosts");
    assert.equal(
        normalizeUrl("./site/index.html", { trusted: true, cwd: "/work" }),
        "file:///work/site/index.html",
    );
    assert.equal(normalizeUrl("data:text/html,hi", { trusted: true }), "data:text/html,hi");
    assert.equal(normalizeUrl("javascript:alert(1)", { trusted: true }), undefined);
});

test("looking at pages only reads, and acting on them does not", () => {
    for (const action of ["navigate", "snapshot"]) {
        assert.equal(onlyReads("browser", { action }), true, action);
    }

    for (const action of ["click", "type", "press", "select", "evaluate"]) {
        assert.equal(onlyReads("browser", { action }), false, action);
    }

    // A data: page is one Pi writes, scripts and all.
    assert.equal(
        onlyReads("browser", {
            action: "navigate",
            url: "data:text/html,<script>fetch('/x')</script>",
        }),
        false,
    );
});

// ─── With a real browser ────────────────────────────────────────────────

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

const PAGE = `<!doctype html><html><head><title>Smoke test</title><meta name="viewport" content="width=device-width"></head><body>
<header><nav><a href="/two">Second page</a> <a href="/two" target="_blank">Popup</a></nav></header>
<main><h1>Hello</h1><p>Some intro text for the page.</p>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Sent ' + document.getElementById('email').value + ' ' + document.getElementById('pick').value">
<label for="email">Email</label><input id="email" type="email" placeholder="you@example.com" value="old@example.com">
<select id="pick"><option value="a">Apple</option><option value="b">Banana</option></select>
<button type="submit">Send</button></form>
<div id="out"></div>
<div id="fancy" style="cursor:pointer" onclick="this.textContent='clicked div'">Fancy div</div>
<button id="confirm" onclick="this.textContent = confirm('Sure?') ? 'yes' : 'no'">Ask</button>
<div style="height:3000px"></div><p id="bottom">The end</p>
</main><script>console.log("hello", {a: 1}); console.error("boom"); setTimeout(() => { throw new Error("late failure") }, 10);</script></body></html>`;

let site: Server;
let base = "";

before(async () => {
    site = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html" });

        response.end(request.url === "/two" ? "<title>Two</title><h1>Second</h1>" : PAGE);
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});

after(() => {
    site.close();
    cleanUp();
});

test(
    "the engine reads, clicks, types in, and streams a real page, and opens it again where it was",
    real,
    async () => {
        const saved = new Map<number, { url?: string }>();
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "engine-")),
            load: async (id) => saved.get(id),
            save: (id, value) => saved.set(id, value),
        });

        try {
            const page = await browsers.open(1);

            assert.deepEqual(await page.navigate(`${base}/`), { status: 200 });
            await until(() => page.title === "Smoke test", "the title");

            // A huge page comes back small enough for a model to take: too large an image breaks the conversation.
            await page.evaluate("document.body.style.cssText = 'width: 2600px; height: 6000px'; 1");
            const whole = await page.screenshot({ fullPage: true });
            const image = jpegSize(whole.data);

            assert.ok(
                whole.width >= 2600 && whole.height >= 6000,
                `${whole.width}×${whole.height}`,
            );
            assert.ok(Math.max(image.width, image.height) <= SHOT_MAX, JSON.stringify(image));
            await page.evaluate("document.body.style.cssText = ''; scrollTo(0, 0); 1");

            // A web page cannot use a new tab to open a file here, which it could not open itself.
            await page.evaluate("window.open('file:///etc/hosts'); 1");
            // Chromium refuses it by itself; the page's own rule refuses it too, should a tab open anyway.
            await until(
                () =>
                    page
                        .logs()
                        .some((entry) =>
                            /^(Not allowed to load local resource: |A new tab for )file:\/\/\/etc\/hosts/.test(
                                entry.text,
                            ),
                        ),
                "the refused tab",
            );
            await new Promise((done) => setTimeout(done, 500));
            assert.equal(page.url, `${base}/`);
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);

test(
    "upload attaches files to a hidden file input, listed in the snapshot, with no file chooser",
    real,
    async () => {
        const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "upload-")) });
        const folder = mkdtempSync(join(root, "upload-files-"));
        const file = join(folder, "resume.pdf");

        writeFileSync(file, "%PDF-1.4 a resume");

        try {
            const page = await browsers.open(1);

            await page.navigate(`${base}/`);
            await page.evaluate(
                `document.body.innerHTML = '<label class="button">Attach your resume<input type="file" accept=".pdf" style="display:none"></label>'; 1`,
            );
            const { lines } = await page.snapshot();
            const ref = /\[(e\d+)\] file upload[^\n]*accepts \.pdf/.exec(lines)?.[1];

            assert.ok(ref !== undefined, lines);
            assert.match(lines, /File uploads/);
            assert.equal(await page.upload({ ref }, [file]), "resume.pdf");
            assert.match(
                await page.evaluate("document.querySelector('input').files[0].name"),
                /resume\.pdf/,
            );
            // The label stands for its input too.
            assert.equal(await page.upload({ label: "Attach your resume" }, [file]), "resume.pdf");
            assert.match((await page.snapshot()).lines, /= "resume\.pdf"/);
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);

test("a password field's value is never part of what describes or finds it", real, async () => {
    const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "password-")) });

    try {
        const page = await browsers.open(1);

        await page.navigate(`${base}/`);
        await page.evaluate(
            `document.body.innerHTML = '<input id="secret" type="password"><input id="plain" value="visible words"><button id="under" style="position:absolute;left:0;top:200px;width:200px;height:40px">Under</button><input id="over" type="password" style="position:absolute;left:0;top:200px;width:200px;height:40px">'; 1`,
        );
        // An unlabelled field that holds a password: nothing about it says the password.
        await page.type({ selector: "#secret" }, "correct-horse");
        assert.equal(
            await page.evaluate("document.querySelector('#secret').value"),
            "correct-horse",
        );
        assert.equal((await page.locate({ selector: "#secret" })).label, "input#secret");
        await assert.rejects(page.locate({ label: "correct-horse" }), /Nothing on the page says/);
        // A password field lying over what Pi clicks is named without its value too.
        await page.evaluate("document.querySelector('#over').value = 'correct-horse'; 1");
        const found = await page.locate({ selector: "#under" });

        assert.equal(found.covered, "input#over");
        // Other fields are still found by what they hold.
        assert.equal(
            (await page.locate({ label: "visible words" })).label,
            'input#plain "visible words"',
        );
    } finally {
        await browsers.closeAll({ final: true });
    }
});

test(
    "codes go into one-box-per-digit fields a key at a time, and other fields as before",
    real,
    async () => {
        const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "code-")) });
        // Boxes that move focus on input, boxes that take only key presses, a field that takes only key presses, and boxes
        // that send focus elsewhere after the second digit. The page counts key presses.
        const fixture = `
        <label>Name <input id="name" value="Ada"></label>
        <div id="otp"></div><div id="keyed"></div><div id="jump"></div>
        <div id="wrapped"><input type="hidden" name="code"></div>
        <form id="submit"><input type="submit" value="Verify"></form><label>Before <input aria-label="Before"></label><div id="four"></div><label>Gap <input aria-label="Gap"></label><div id="stale"></div><div id="swap"></div><div id="masked"></div>
        <form id="deep" onsubmit="event.preventDefault(); window.submits = (window.submits ?? 0) + 1"></form>
        <input type="checkbox" id="check" maxlength="1" aria-label="Check">
        <div id="autofill"><input autocomplete="one-time-code" tabindex="-1" style="position:absolute;opacity:0;width:1px;height:1px"></div>
        <div id="halves"><div><div class="half"></div></div><span>-</span><div><div class="half"></div></div></div>
        <label>Email <input type="email" aria-label="Email"></label><div id="slow"></div>
        <label>Phone <input type="tel" aria-label="Phone"></label><div id="gated"></div><div id="naive"></div>
        <label>Town <input aria-label="Town"></label><div id="lock"></div>
        <label>Street <input aria-label="Street"></label><div id="pin"></div>
        <label>Zip <input aria-label="Zip"></label><div id="first"></div>
        <form id="pinform" onsubmit="event.preventDefault(); window.pinSubmits = (window.pinSubmits ?? 0) + 1"></form>
        <label>City <input aria-label="City"></label><form id="scripted" onsubmit="event.preventDefault(); window.sent = (window.sent ?? 0) + 1"></form>
        <label>State <input aria-label="State"></label>
        <form id="later" onsubmit="event.preventDefault(); window.laterSent = (window.laterSent ?? 0) + 1"></form>
        <form id="full" onsubmit="event.preventDefault(); (window.fullSent ??= []).push([...this.querySelectorAll('input')].map((each) => each.value).join(''))"></form>
        <label>Area <input aria-label="Area"></label>
        <form id="held" onsubmit="event.preventDefault(); (window.heldSent ??= []).push([...this.querySelectorAll('input')].map((each) => each.value).join(''))"></form>
        <label>Floor <input aria-label="Floor"></label><div id="empty"></div>
        <label>Unit <input aria-label="Unit"></label><form id="locked" onsubmit="event.preventDefault(); (window.lockedSent ??= []).push([...this.querySelectorAll('input')].map((each) => each.value).join(''))"></form>
        <label>Suite <input aria-label="Suite"></label>
        <div id="mainCode"></div> Backup code <div id="backupCode"></div>
        <style>.or::before { content: "or use a backup code"; }</style>
        <label>Before or <input aria-label="Before or"></label><div id="orA"></div><div class="or"></div><div id="orB"></div><x-label></x-label><div id="orC"></div><label>After or <input aria-label="After or"></label>
        <label>Before tail <input aria-label="Before tail"></label><div id="tailA"></div><div><label>Backup code</label></div><div id="tailB"></div><label>After tail <input aria-label="After tail"></label>
        <label>Postcode <input aria-label="Postcode"></label><div id="redraw"></div>
        <label>Amount <input type="number" id="amount" aria-label="Amount"></label>
        <style>.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }</style>
        <div id="spoken">${[1, 2, 3, 4, 5, 6].map((i) => `<label class="sr" for="spoken${i}">Digit ${i}</label><input id="spoken${i}" maxlength="1" aria-label="spoken ${i}" oninput="this.value && document.getElementById('spoken${i + 1}')?.focus()">`).join("")}</div>
        <label>Day <input id="day" maxlength="2" aria-label="Day" oninput="if (this.value.length === 2) document.getElementById('month').focus()"></label>
        <label>Month <input id="month" type="number" aria-label="Month"></label>
        <div id="nested">${[1, 2, 3, 4, 5, 6].map((i) => `<label class="sr"><span>Digit ${i}</span></label><input id="nested${i}" maxlength="1" aria-label="nested ${i}" oninput="this.value && document.getElementById('nested${i + 1}')?.focus()">`).join("")}</div>
        <label>Notes <input aria-label="Notes field"></label>
        <div id="away">${[1, 2, 3, 4, 5, 6].map((i) => `<label style="position: absolute; left: -9999px">Digit ${i}</label><input id="away${i}" maxlength="1" aria-label="away ${i}" oninput="this.value && document.getElementById('away${i + 1}')?.focus()">`).join("")}</div>
        <div id="verify">${[1, 2, 3, 4, 5, 6].map((i) => `<input id="verify${i}" maxlength="1" aria-label="verify ${i}" oninput="this.value && document.getElementById('${i < 6 ? `verify${i + 1}` : "verifyButton"}').focus()">`).join("")}<button id="verifyButton" onclick="window.verified = (window.verified ?? 0) + 1">Verify</button></div>
        <div id="wrapA"></div><div style="display: contents"><p>Backup code</p></div><div id="wrapB"></div><label>Wrap <input aria-label="Wrap"></label>
        <div id="iconCode">${[1, 2, 3, 4, 5, 6].map((i) => `<input id="iconCode${i}" maxlength="1" aria-label="iconCode ${i}" oninput="this.value && document.getElementById('iconCode${i + 1}')?.focus()">${i === 3 ? '<span class="material-icons">remove</span>' : ""}`).join("")}</div>
        <label>Icon gap <input aria-label="Icon gap"></label><div id="kept"></div>
        <label>After kept <input aria-label="After kept"></label>
        <div id="rtl" dir="rtl">${[1, 2, 3, 4, 5, 6].map((i) => `<label style="position: absolute; right: -9999px">رقم ${i}</label><input id="rtl${i}" maxlength="1" aria-label="rtl ${i}" oninput="this.value && document.getElementById('rtl${i + 1}')?.focus()">`).join("")}</div>
        <label>Emoji gap <input aria-label="Emoji gap"></label>
        <div id="emoji">${[1, 2, 3, 4, 5, 6].map((i) => `<input id="emoji${i}" maxlength="1" aria-label="emoji ${i}" oninput="this.value && document.getElementById('emoji${i + 1}')?.focus()">${i === 3 ? "<span>🔒</span>" : ""}`).join("")}</div>
        <label>Short <input id="short" maxlength="4" aria-label="Short"></label>
        <label>Secret <input id="secretShort" type="password" maxlength="4" aria-label="Secret"></label>
        <label>Phone mask <input id="phoneMask" type="tel" maxlength="10" aria-label="Phone mask" onbeforeinput="if (event.inputType === 'insertText') { event.preventDefault(); this.value = (this.value + event.data).replace(/[^0-9]/g, '').slice(0, 10); }"></label>
        <form id="blurForm" onsubmit="event.preventDefault(); window.blurSent = (window.blurSent ?? 0) + 1">${[1, 2, 3, 4, 5, 6].map((i) => `<input id="blurBox${i}" maxlength="1" aria-label="blurBox ${i}" oninput="if (this.value) { ${i < 6 ? `document.getElementById('blurBox${i + 1}').focus()` : "this.blur(); setTimeout(() => this.form.requestSubmit(), 600)"} }">`).join("")}<button>Verify</button></form>
        <label>After blur <input aria-label="After blur"></label>
        <div id="spanA"></div><span style="display: contents">Backup code</span><div id="spanB"></div><label>After span <input aria-label="After span"></label>
        <label>Money <input id="money" maxlength="6" aria-label="Money" onbeforeinput="if (event.inputType === 'insertText') { event.preventDefault(); this.value = (this.value + event.data).replace(/[^0-9]/g, '').slice(0, 6); }"></label><form id="lastForm" onsubmit="event.preventDefault(); window.lastSent = (window.lastSent ?? 0) + 1"><div id="drawn"></div><button>Go</button></form>
        <label>Region <input aria-label="Region"></label><div id="go"></div><label>Country <input aria-label="Country"></label><div id="behind"><input id="real" maxlength="6" autocomplete="one-time-code" style="position:absolute;opacity:0;width:1px;height:1px"></div>
        <label>Note <input aria-label="Note"></label><div id="shadowed"></div><shadow-field></shadow-field>
        <div id="notes"><textarea aria-label="Notes"></textarea></div>
        <input id="strict" aria-label="Strict"><input id="tags" aria-label="Tags" oninput="window.tagInputs = (window.tagInputs || 0) + 1; this.value = ''">
        <script>
            window.keys = 0;
            addEventListener("keydown", () => window.keys++, true);
            for (const id of ["otp", "keyed", "jump", "wrapped", "submit", "four", "stale", "notes", "swap", "masked", "deep", "autofill", "halves", "slow", "gated", "naive", "lock", "pin", "first", "pinform", "behind", "go", "scripted", "later", "full", "held", "empty", "locked", "mainCode", "backupCode", "wrapA", "wrapB", "tailA", "tailB", "orA", "orB", "orC", "spanA", "spanB"]) {
                const boxes = Array.from({ length: id === "four" ? 4 : 6 }, (_, i) => {
                    const box = document.createElement("input");
                    box.maxLength = 1;
                    box.setAttribute("aria-label", id + " " + (i + 1));
                    // "stale": boxes that still hold an old code, and do not select it when focused.
                    if (["stale", "full", "held", "locked"].includes(id)) box.value = id === "stale" ? "8" : "9";
                    // "locked" keeps each box read-only until it is focused, against autofill.
                    if (id === "locked") {
                        box.readOnly = true;
                        box.addEventListener("focus", () => (box.readOnly = false));
                        box.addEventListener("blur", () => (box.readOnly = true));
                    }
                    // "held" keeps its digits as a controlled widget does: an emptied box gets its digit back, and only
                    // Backspace clears one.
                    if (id === "held") {
                        box.dataset.digit = "9";
                        box.addEventListener("keydown", (event) => {
                            if (event.key === "Backspace") {
                                event.preventDefault();
                                box.dataset.digit = "";
                                box.value = "";
                                if (i > 0) boxes[i - 1].focus();
                            }
                        });
                    }
                    // "gated": each box locked until the one before it is filled.
                    if (id === "gated" && i > 0) box.disabled = true;
                    // "wrapped": each box in a wrapper of its own, beside a hidden input that holds the code.
                    // "deep": each box in a wrapper inside a wrapper.
                    const wrapper = id === "wrapped" || id === "deep" ? document.createElement("div") : null;
                    const outer = id === "deep" ? document.createElement("div") : null;
                    wrapper?.append(box);
                    outer?.append(wrapper);
                    // "halves": a code split 3 + 3, each half in wrappers of its own.
                    const half = id === "halves" ? document.querySelectorAll("#halves .half")[i < 3 ? 0 : 1] : null;
                    (half ?? document.getElementById(id)).append(outer ?? wrapper ?? box);
                    return box;
                });
                boxes.forEach((box, i) => {
                    if (id !== "stale") box.addEventListener("focus", () => box.select());
                    // "behind" shows boxes, but sends focus to the field behind them, which fills them.
                    if (id === "behind") {
                        box.addEventListener("focus", () => setTimeout(() => document.getElementById("real").focus(), 0));
                    }
                    // "first" sends focus to its first empty box a moment after any box is focused.
                    if (id === "first") {
                        box.addEventListener("focus", () =>
                            setTimeout(() => boxes.find((each) => each.value === "")?.focus(), 0),
                        );
                    }
                    if (id === "keyed") {
                        box.addEventListener("beforeinput", (event) => event.preventDefault());
                        box.addEventListener("keydown", (event) => {
                            if (!/^[0-9]$/.test(event.key)) return;
                            event.preventDefault();
                            box.value = event.key;
                            boxes[Math.min(i + 1, 5)].focus();
                        });
                        return;
                    }
                    box.addEventListener("input", () => {
                        // As code widgets do: only letters and digits stay ("naive" keeps anything).
                        if (id !== "naive") box.value = box.value.replace(/[^0-9a-z]/gi, "");
                        if (id === "gated" && box.value && i < boxes.length - 1) boxes[i + 1].disabled = false;
                        // "pin" takes the code once complete and empties its boxes for the next one, as PIN pads do.
                        if (id === "held") {
                            if (box.value === "") {
                                box.value = box.dataset.digit;
                                return;
                            }
                            box.dataset.digit = box.value;
                        }
                        // "full" sends the code as soon as every box holds a digit, as many widgets do.
                        if (["full", "held", "locked"].includes(id) && box.value && boxes.every((each) => each.value)) {
                            document.getElementById(id).requestSubmit();
                            return;
                        }
                        // "scripted" sends the code itself on its last digit; "later" a moment after it.
                        if (id === "scripted" && i === boxes.length - 1 && box.value) {
                            document.getElementById("scripted").requestSubmit();
                            return;
                        }
                        if (id === "later" && i === boxes.length - 1 && box.value) {
                            setTimeout(() => document.getElementById("later").requestSubmit(), 60);
                            return;
                        }
                        // "go" leaves for the next page once the code is complete.
                        if (id === "go" && i === boxes.length - 1 && box.value) {
                            location.href = "/two";
                            return;
                        }
                        if ((id === "pin" || id === "pinform") && i === boxes.length - 1 && box.value) {
                            window.pin = boxes.map((each) => each.value).join("");
                            if (id === "pinform") document.getElementById("pinform").requestSubmit();
                            boxes.forEach((each) => (each.value = ""));
                            boxes[0].focus();
                            return;
                        }
                        // "lock" locks a full box, so no box has focus until it moves to the next one a while later.
                        if (id === "lock" && box.value) {
                            box.disabled = true;
                            if (i < boxes.length - 1) setTimeout(() => boxes[i + 1].focus(), 60);
                            return;
                        }
                        // "slow" moves focus well after the key, as some widgets do.
                        if (box.value && i < boxes.length - 1) setTimeout(() => boxes[i + 1].focus(), id === "slow" ? 80 : 0);
                        if (id === "jump" && i === 1) setTimeout(() => document.getElementById("name").focus(), 0);
                        if (id === "notes" && i === 1) setTimeout(() => document.querySelector("#notes textarea").focus(), 0);
                        // "masked" shows a dot for each digit; "swap" moves on, as an app does, once the code is in.
                        if (id === "masked" && box.value) box.value = "•";
                        if (id === "swap" && i === 5) setTimeout(() => (document.getElementById("swap").textContent = "Signed in"), 0);
                    });
                });
            }
            // A label inside a web component, between two codes.
            customElements.define("x-label", class extends HTMLElement {
                constructor() {
                    super();
                    this.attachShadow({ mode: "open" }).innerHTML = "<p>SMS code</p>";
                }
            });
            // A widget that draws all its boxes again, as new elements, on every input (as rakazo's fixture has).
            const redraw = document.getElementById("redraw");
            const draw = (values, focus) => {
                redraw.replaceChildren(...values.map((value, i) => {
                    const box = document.createElement("input");
                    box.maxLength = 1;
                    box.value = value;
                    box.setAttribute("aria-label", "redraw " + (i + 1));
                    box.addEventListener("input", () => {
                        const next = Array.from(redraw.children, (each) => each.value.replace(/[^0-9]/g, "").slice(-1));
                        draw(next, next[i] ? Math.min(i + 1, 5) : i);
                    });
                    return box;
                }));
                if (focus !== undefined) redraw.children[focus].focus();
            };
            draw(["", "", "", "", "", ""]);
            // The same, but leaving no box focused after the last digit.
            const drawn = document.getElementById("drawn");
            const drawAgain = (values) => {
                drawn.replaceChildren(...values.map((value, i) => {
                    const box = document.createElement("input");
                    box.maxLength = 1;
                    box.value = value;
                    box.setAttribute("aria-label", "drawn " + (i + 1));
                    box.addEventListener("input", () => {
                        const next = Array.from(drawn.children, (each) => each.value.slice(-1));
                        drawAgain(next);
                        if (i < 5) drawn.children[i + 1].focus();
                    });
                    return box;
                }));
            };
            drawAgain(["", "", "", "", "", ""]);
            // A widget that draws its boxes from its own state on every input, and empties a box only on Backspace.
            const keptRow = document.getElementById("kept");
            const state = ["1", "2", "3", "4", "5", "6"];
            const drawKept = (focus) => {
                keptRow.replaceChildren(...state.map((value, i) => {
                    const box = document.createElement("input");
                    box.maxLength = 1;
                    box.value = value;
                    box.setAttribute("aria-label", "kept " + (i + 1));
                    box.addEventListener("keydown", (event) => {
                        if (event.key !== "Backspace") return;
                        event.preventDefault();
                        state[i] = "";
                        drawKept(Math.max(0, i - 1));
                    });
                    box.addEventListener("input", () => {
                        const digit = box.value.replace(/[^0-9]/g, "").slice(-1);
                        if (digit) state[i] = digit;
                        drawKept(digit ? Math.min(i + 1, 5) : i);
                    });
                    return box;
                }));
                if (focus !== undefined) keptRow.children[focus].focus();
            };
            drawKept();
            // A row made of web components, a box in each one's shadow root, and a text field inside one.
            const shadowed = Array.from({ length: 6 }, (_, i) => {
                const host = document.createElement("span");
                const box = document.createElement("input");
                box.maxLength = 1;
                box.setAttribute("aria-label", "shadowed " + (i + 1));
                host.attachShadow({ mode: "open" }).append(box);
                document.getElementById("shadowed").append(host);
                return box;
            });
            shadowed.forEach((box, i) => box.addEventListener("input", () => box.value && i < 5 && shadowed[i + 1].focus()));
            const field = document.createElement("input");
            field.value = "old";
            document.querySelector("shadow-field").attachShadow({ mode: "open" }).append(field);
            window.shadowField = field;
            window.shadowBoxes = shadowed;
            const strict = document.getElementById("strict");
            strict.addEventListener("beforeinput", (event) => { if (event.inputType === "insertText" && event.data.length > 1) event.preventDefault(); });
        </script>`;
        const values = (id: string) =>
            page.evaluate(
                `[...document.querySelectorAll("#${id} input:not([type=submit])")].map((box) => box.value).join("")`,
            );
        const textOf = (selector: string) =>
            page.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
        let page!: Awaited<ReturnType<Browsers["open"]>>;

        try {
            page = await browsers.open(1);
            await page.navigate(`${base}/`);
            await page.evaluate(
                `document.open(); document.write(${JSON.stringify(fixture)}); document.close(); 1`,
            );

            // An ordinary field: replaced in one insert, with no key presses.
            await page.type({ selector: "#name" }, "Grace");
            assert.equal(await page.evaluate("document.getElementById('name').value"), "Grace");
            assert.equal(await page.evaluate("window.keys"), "0");

            await page.type({ label: "otp 1" }, "123456");
            assert.equal(await values("otp"), "123456");
            await page.type({ label: "keyed 1" }, "654321");
            assert.equal(await values("keyed"), "654321");
            await page.type({ label: "wrapped 1" }, "112233");
            assert.equal(await values("wrapped"), "112233");
            // Boxes beside the form's submit button are still one row.
            await page.type({ label: "submit 1" }, "445566");
            assert.equal(await values("submit"), "445566");
            // More characters than boxes: nothing is typed, and typing says so.
            await assert.rejects(
                page.type({ label: "four 1" }, "123456"),
                /the code has 6 letters and digits, and its row 4 boxes/,
            );
            // Any other field gets one insert and no keys, as before, even one that refuses it: no text typed twice
            // into an editor that takes it late, no Enter or Space pressed into a form or a checkbox.
            const keys = await page.evaluate("window.keys");

            await page.type({ selector: "#strict" }, "4242");
            assert.equal(await page.evaluate("document.getElementById('strict').value"), "");
            await page.type({ selector: "#check" }, "a b");
            // Ticked once by the click that type() makes first, as before; no Space toggled it back.
            assert.equal(await page.evaluate("document.getElementById('check').checked"), "true");
            assert.equal(await page.evaluate("window.keys"), keys);
            // Boxes wrapped two levels deep are still a row, and a line break in a code is no Enter.
            await page.type({ label: "deep 1" }, "121\n212");
            assert.equal(await values("deep"), "121212");
            assert.equal(await page.evaluate("window.submits ?? 0"), "0");

            // A code field with no name of its own is named for what it is (two on this page: behind the boxes, and
            // autofill's).
            assert.equal(
                (await page.snapshot()).lines.match(/textbox "One-time code"/g)?.length,
                2,
            );

            // A hidden autofill input under the boxes, a code split in wrapped halves, and a widget slow to move focus.
            for (const [id, code] of [
                ["autofill", "102938"],
                ["halves", "564738"],
                ["slow", "918273"],
            ] as const) {
                await page.type({ label: `${id} 1` }, code);
                assert.equal(await values(id), code, id);
            }

            // Boxes a widget unlocks in turn, and a space in a code into boxes that would keep it.
            await page.type({ label: "gated 1" }, "246813");
            assert.equal(await values("gated"), "246813");
            await page.type({ label: "naive 1" }, "135 791");
            assert.equal(await values("naive"), "135791");
            // A PIN pad that empties itself once the code is complete took it: no error, the code typed once.
            await page.type({ label: "pin 1" }, "246802");
            assert.equal(await page.evaluate("window.pin"), "246802");
            // A PIN form that submits itself once the code is complete is not submitted again, empty, by Enter.
            assert.deepEqual(await page.type({ label: "pinform 1" }, "135792", { submit: true }), {
                label: 'input "pinform 1"',
                pageSubmitted: true,
            });
            assert.equal(await page.evaluate("window.pin"), "135792");
            assert.equal(await page.evaluate("window.pinSubmits"), "1");

            // Codes the widget sends itself, at once or a moment later: sent once, Enter not pressed after them.
            for (const [id, counter] of [
                ["scripted", "sent"],
                ["later", "laterSent"],
            ] as const) {
                assert.equal(
                    (await page.type({ label: `${id} 1` }, "123456", { submit: true }))
                        .pageSubmitted,
                    true,
                );
                assert.equal(await page.evaluate(`window.${counter}`), "1", id);
            }

            // Boxes still holding an old code, in a widget that sends once every box is full: the old code goes
            // first, so the page sends only the new one.
            assert.equal((await page.type({ label: "full 1" }, "123456")).pageSubmitted, true);
            assert.equal(await page.evaluate("JSON.stringify(window.fullSent)"), '["123456"]');
            // A widget that puts back what a script empties: the old code goes with Backspace, and only the new one is
            // sent.
            assert.equal((await page.type({ label: "held 1" }, "123456")).pageSubmitted, true);
            assert.equal(await page.evaluate("JSON.stringify(window.heldSent)"), '["123456"]');
            // Boxes read-only until focused, holding an old code: it goes all the same, and only the new code is sent.
            assert.equal((await page.type({ label: "locked 1" }, "135790")).pageSubmitted, true);
            assert.equal(await page.evaluate("JSON.stringify(window.lockedSent)"), '["135790"]');
            // A shorter code over an old one clears the rest of the row too: the page never holds old digits with
            // new ones, so a widget that sends once every box is full sends nothing yet.
            await page.evaluate(
                "document.querySelectorAll('#full input').forEach((each) => (each.value = '9')); 1",
            );
            assert.equal((await page.type({ label: "full 1" }, "1234")).pageSubmitted, false);
            assert.equal(await values("full"), "1234");
            assert.equal(await page.evaluate("window.fullSent.length"), "1");
            // A code longer than the boxes from the one clicked on is not typed.
            await assert.rejects(
                page.type({ label: "empty 3" }, "12345"),
                /the code has 5 letters and digits, and its row 4 boxes from the one clicked on/,
            );
            // So does a divider whose words come from CSS, or sit in a web component: the boxes are laid out apart.
            await page.type({ label: "orB 1" }, "777777");
            await page.type({ label: "orC 1" }, "888888");
            await page.type({ label: "orA 1" }, "1234");
            assert.equal(await values("orB"), "777777");
            await page.type({ label: "orB 1" }, "2345");
            assert.equal(await values("orC"), "888888");
            // So they do on a site whose text font lists a symbol font as a fallback (Tailwind's and Bootstrap's do).
            await page.evaluate(
                `document.documentElement.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif, "Segoe UI Symbol"'; 1`,
            );
            await page.type({ label: "tailB 1" }, "333333");
            await page.type({ label: "tailA 1" }, "4444");
            assert.equal(await values("tailB"), "333333");
            await page.evaluate("document.documentElement.style.fontFamily = ''; 1");
            // Words between two rows part them: typing the backup code leaves the main code as it is.
            await page.type({ label: "mainCode 1" }, "111111");
            await page.type({ label: "backupCode 1" }, "222222");
            assert.equal(await values("mainCode"), "111111");
            assert.equal(await values("backupCode"), "222222");
            // A widget that draws its boxes again on every input gets every key, and a code typed again over it.
            await page.type({ label: "redraw 1" }, "482913");
            assert.equal(await values("redraw"), "482913");
            await page.type({ label: "redraw 4" }, "931");
            assert.equal(await values("redraw"), "482931");
            // Labels only a screen reader reads ("Digit 2") between the boxes part nothing.
            await page.type({ label: "spoken 1" }, "482913");
            assert.equal(await values("spoken"), "482913");
            // Labels hidden in a nested element, or moved off the page, part nothing either.
            await page.type({ label: "nested 1" }, "135791");
            assert.equal(await values("nested"), "135791");
            await page.type({ label: "away 1" }, "246802");
            assert.equal(await values("away"), "246802");
            // A redrawn row that leaves no box focused: found again, and Enter goes to its last box, once.
            assert.equal(
                (await page.type({ label: "drawn 1" }, "482913", { submit: true })).pageSubmitted,
                false,
            );
            assert.equal(await values("drawn"), "482913");
            assert.equal(await page.evaluate("window.lastSent"), "1");
            // A widget that hands focus to its Verify button after the last digit: Enter presses that button, once.
            await page.type({ label: "verify 1" }, "112358", { submit: true });
            assert.equal(await page.evaluate("window.verified"), "1");
            // A visible label in a wrapper that has no box of its own (display: contents) still parts two codes.
            await assert.rejects(
                page.type({ label: "wrapA 1" }, "48291357"),
                /the code has 8 letters and digits, and its row 6 boxes/,
            );
            // An icon drawn from a font's ligature ("remove" as a dash) between the boxes parts nothing.
            await page.type({ label: "iconCode 1" }, "482913");
            assert.equal(await values("iconCode"), "482913");
            // A widget that draws its boxes from its own state and puts values back: Backspace clears it, and the
            // new code replaces the old one.
            await page.type({ label: "kept 1" }, "482913");
            assert.equal(await values("kept"), "482913");
            // Labels moved off a right-to-left page, and an emoji between the halves, part nothing.
            await page.type({ label: "rtl 1" }, "482913");
            assert.equal(await values("rtl"), "482913");
            await page.type({ label: "emoji 1" }, "135791");
            assert.equal(await values("emoji"), "135791");
            // A field with a length limit that cuts the text says so, in a note: the text went in as before.
            assert.match(
                (await page.type({ selector: "#short" }, "123456")).note ?? "",
                /takes 4 characters: it kept "1234" of "123456"/,
            );
            // A line break or spaces past the limit are nothing kept or lost; an emoji past it is (it counts as two).
            assert.equal((await page.type({ selector: "#short" }, "1234\n")).note, undefined);
            assert.equal(await page.evaluate("document.getElementById('short').value"), "1234");
            assert.match(
                (await page.type({ selector: "#short" }, "abc😀")).note ?? "",
                /takes 4 characters: it kept "abc"/,
            );
            // Each line break is a space of its own in a one-line field: two of them leave less room.
            assert.match(
                (await page.type({ selector: "#short" }, "ab\n\nc")).note ?? "",
                /takes 4 characters/,
            );
            // A password's trailing space is part of it: cut, it says so.
            assert.match(
                (await page.type({ selector: "#secretShort" }, "abcd ")).note ?? "",
                /kept 4 of 5\./,
            );
            // A label right inside an element with display: contents still parts two codes.
            await assert.rejects(
                page.type({ label: "spanA 1" }, "48291357"),
                /the code has 8 letters and digits, and its row 6 boxes/,
            );
            // A mask that drops a currency sign and its commas cut nothing.
            await page.type({ selector: "#money" }, "$10,000");
            assert.equal(await page.evaluate("document.getElementById('money').value"), "10000");
            // A mask that keeps the digits and drops the dashes cut nothing.
            await page.type({ selector: "#phoneMask" }, "555-123-4567");
            assert.equal(
                await page.evaluate("document.getElementById('phoneMask').value"),
                "5551234567",
            );
            // A widget that lets go of focus on purpose, then submits the code itself a while later: Enter is pressed
            // nowhere it would submit it again.
            await page.type({ label: "blurBox 1" }, "482913", { submit: true });
            await new Promise((done) => setTimeout(done, 800));
            assert.equal(await page.evaluate("window.blurSent"), "1");
            // A password field's cut says how much went in, never what.
            const secretNote =
                (await page.type({ selector: "#secretShort" }, "hunter22")).note ?? "";

            assert.match(secretNote, /kept 4 of 8\./);
            assert.ok(!secretNote.includes("hunt"));
            // The number check reads the field typed into, not the next one the page moves focus to.
            await page.type({ selector: "#day" }, "12");
            assert.equal(await page.evaluate("document.getElementById('day').value"), "12");
            // A number field that keeps only part of the text says so.
            assert.match(
                (await page.type({ selector: "#amount" }, "12a")).note ?? "",
                /number field: it kept "12" of "12a"/,
            );
            // The same number written another way is what was typed.
            await page.type({ selector: "#amount" }, "+5");
            assert.equal(await page.evaluate("document.getElementById('amount').value"), "5");
            // Spaces aside: "1 000" is the number 1000.
            await page.type({ selector: "#amount" }, "1 000");
            assert.equal(await page.evaluate("document.getElementById('amount').value"), "1000");
            // A code as long as its row starts at the row's first box, whichever box was clicked.
            await page.type({ label: "empty 4" }, "123456");
            assert.equal(await values("empty"), "123456");
            // Without submit, a code the page sends itself is still said to be sent.
            assert.equal((await page.type({ label: "scripted 1" }, "654321")).pageSubmitted, true);
            // A code longer than the row: nothing is typed, so the page sends no part of it, and typing says so.
            await assert.rejects(
                page.type({ label: "scripted 1" }, "G-123456", { submit: true }),
                /the code has 7 letters and digits, and its row 6 boxes/,
            );
            assert.equal(await page.evaluate("window.sent"), "2");
            // Boxes that hand focus to the field behind them: that field gets the code in one insert.
            await page.type({ label: "behind 1" }, "864200");
            assert.equal(await page.evaluate("document.getElementById('real').value"), "864200");
            // A widget that sends focus to its first empty box a moment after the click gets every key there.
            await page.evaluate(
                "const f = document.querySelectorAll('#first input'); f[0].value = '1'; f[1].value = '2'; 1",
            );
            await page.type({ label: "first 1" }, "3456", { append: true });
            assert.equal(await values("first"), "123456");
            // Replacing its full row: the old code goes first from the box clicked, wherever the widget sends focus.
            await page.type({ label: "first 1" }, "654321");
            assert.equal(await values("first"), "654321");
            // A widget that locks each full box, with no box focused for a moment, gets the whole code.
            await page.type({ label: "lock 1" }, "975310");
            assert.equal(await values("lock"), "975310");
            // Text with no letters or digits types nothing into a code, and says so.
            await assert.rejects(page.type({ label: "naive 1" }, "--"), /Nothing was typed/);
            // Web components: a box in each one's shadow root, and a field whose text is replaced.
            await page.evaluate("window.shadowBoxes[0].focus(); 1");
            await page.type(undefined, "102030");
            assert.equal(
                await page.evaluate("window.shadowBoxes.map((box) => box.value).join('')"),
                "102030",
            );
            await page.evaluate("window.shadowField.focus(); 1");
            await page.type(undefined, "new");
            assert.equal(await page.evaluate("window.shadowField.value"), "new");
            // Codes as people write them, as a page that moves on, and as boxes that show dots: all went in.
            await page.type({ label: "otp 1" }, "135 791");
            assert.equal(await values("otp"), "135791");
            await page.type({ label: "swap 1" }, "112358");
            await page.type({ label: "masked 1" }, "314159");
            // A row still holding an old code, in boxes that do not select it on focus: the new code replaces it.
            await page.type({ label: "stale 1" }, "123456");
            assert.equal(await values("stale"), "123456");
            // Appending to full boxes keeps nothing, and typing says so.
            await assert.rejects(
                page.type({ label: "stale 1" }, "999999", { append: true }),
                /kept 0 of 6 characters/,
            );
            // A row beside a text area is still a row: focus going to the text area stops typing there.
            await assert.rejects(
                page.type({ label: "notes 1" }, "246802"),
                /Typed 2 of 6 characters/,
            );
            assert.equal(await textOf("#notes textarea"), "");
            // Stop ends typing key by key.
            const stop = new AbortController();

            setTimeout(() => stop.abort(), 50);
            await assert.rejects(
                page.type({ label: "keyed 1" }, "999999", { signal: stop.signal }),
                /Stopped/,
            );

            // A field that took the text and emptied itself, as a tag field does, gets it once.
            await page.type({ selector: "#tags" }, "alpha");
            assert.equal(await page.evaluate("window.tagInputs"), "1");
            // Focus leaves the code's boxes: typing stops there and says how far it got, typing nothing elsewhere.
            await assert.rejects(
                page.type({ label: "jump 1" }, "987654"),
                /Typed 2 of 6 characters/,
            );
            assert.equal(await values("jump"), "98");
            assert.equal(await page.evaluate("document.getElementById('name').value"), "Grace");

            // Last, as it leaves this page: a code that sends the page on is submitted by the page, and type() waits
            // for the next page, as Enter's would.
            assert.equal(
                (await page.type({ label: "go 1" }, "112233", { submit: true })).pageSubmitted,
                true,
            );
            assert.equal(page.title, "Two");
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);

test("upload takes regular files only, and on the computer only from the session's folder and shared", async () => {
    const home = mkdtempSync(join(root, "upload-home-"));
    const mine = join(home, "bots", "scout");
    const shared = join(home, "shared");
    const other = join(home, "bots", "other");

    for (const folder of [mine, shared, other]) {
        mkdirSync(folder, { recursive: true });
    }

    writeFileSync(join(mine, "a.txt"), "a");
    writeFileSync(join(shared, "b.txt"), "b");
    writeFileSync(join(other, "secret.txt"), "s");
    symlinkSync(join(other, "secret.txt"), join(mine, "link.txt"));

    // An environment as pi-durable's: results, not throws.
    const { realpathSync, statSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    const result = <T>(make: () => T) => {
        try {
            return { ok: true as const, value: make() };
        } catch (error) {
            return { ok: false as const, error: error as Error };
        }
    };

    const env = {
        absolutePath: async (path: string) => result(() => resolve(mine, path)),
        canonicalPath: async (path: string) => result(() => realpathSync(path)),
        fileInfo: async (path: string) =>
            result(() => {
                const info = statSync(path);

                return { kind: info.isDirectory() ? "directory" : "file", size: info.size };
            }),
    } as never;
    const within = [mine, shared];

    assert.deepEqual(
        await uploadable(env, ["a.txt", join(shared, "b.txt")], within, BACKGROUND_CONTEXT),
        [realpathSync(join(mine, "a.txt")), realpathSync(join(shared, "b.txt"))],
    );
    await assert.rejects(
        uploadable(env, [join(other, "secret.txt")], within, BACKGROUND_CONTEXT),
        /outside your folder/,
    );
    await assert.rejects(
        uploadable(env, ["link.txt"], within, BACKGROUND_CONTEXT),
        /outside your folder/,
        "a link is followed",
    );
    await assert.rejects(uploadable(env, ["."], within, BACKGROUND_CONTEXT), /is not a file/);
    await assert.rejects(
        uploadable(env, ["nope.txt"], within, BACKGROUND_CONTEXT),
        /is not a file/,
    );
    // On this machine (a host session): any regular file, as Pi reads any.
    assert.equal(
        (await uploadable(env, [join(other, "secret.txt")], undefined, BACKGROUND_CONTEXT)).length,
        1,
    );
});

test("pages do not see an automated browser, on a phone or after one", real, async () => {
    const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "agent-")) });

    try {
        const page = await browsers.open(1);

        await page.navigate(`${base}/`);
        assert.match(await page.evaluate("String(navigator.webdriver)"), /false/);
        const desktop = await page.evaluate("navigator.userAgent");

        assert.doesNotMatch(desktop, /HeadlessChrome/);
        await page.setViewport({ ...VIEWPORTS.mobile });
        assert.match(await page.evaluate("navigator.userAgent"), /Android/);
        await page.setViewport({ ...VIEWPORTS.desktop });
        assert.equal(await page.evaluate("navigator.userAgent"), desktop);
    } finally {
        await browsers.closeAll({ final: true });
    }
});

test("a command sent while a navigation swaps the page waits for it", real, async () => {
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "swap-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        const page = await browsers.open(1, { restore: false });

        // Across sites (to the test site and back to about:blank), Chromium moves the page to a new process and for a
        // moment refuses commands. A reload or stop sent right then used to fail: "Not attached to an active page".
        for (let round = 0; round < 3; round++) {
            await page.navigate("about:blank");
            await page.navigate(`${base}/`);
            await page.go(-1, { wait: false });
            await page.reload({ wait: false });
            await page.navigate(`${base}/two`, { wait: false });
            await page.stop();
        }
    } finally {
        await browsers.closeAll({ final: true });
    }
});

test(
    "Pi uses the browser tool, and people watch and use the same page in the panel",
    real,
    async () => {
        const results: string[] = [];

        const route: FauxResponseStep = (context) => {
            const { role, text } = lastText(context as never);
            const call = (args: Parameters<typeof fauxToolCall>[1]) =>
                fauxAssistantMessage([fauxToolCall("browser", args)], { stopReason: "toolUse" });

            if (role === "toolResult") {
                results.push(text);

                return fauxAssistantMessage([fauxText("done")]);
            }

            if (text.includes("open the test page")) {
                return call({
                    action: "navigate",
                    url: base.replace("http://", ""),
                    snapshot: true,
                });
            }

            if (text.includes("take a screenshot")) {
                return call({ action: "screenshot" });
            }

            return fauxAssistantMessage([fauxText("ok")]);
        };

        const app: App = await openApp(scriptedModel(route), join(root, "app"));
        const { createHandler } = await import("../src/server/http.ts");
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
        const viewer = app.config.addUser("Vee", "viewer");
        const guest = app.config.addUser("Gus", "guest");
        const request = (token: string, path: string, body?: unknown) =>
            fetch(
                `${api}/${path}`,
                body === undefined
                    ? { headers: { authorization: `Bearer ${token}` } }
                    : {
                          method: "POST",
                          headers: {
                              authorization: `Bearer ${token}`,
                              "x-pocket": "1",
                              "content-type": "application/json",
                          },
                          body: JSON.stringify(body),
                      },
            );

        try {
            const id = await newSession(app);

            // A model that takes images keeps the screenshot in the transcript.
            await app.commands.configure(id, owner(app), {
                model: { provider: "faux", modelId: "faux-vision" },
            });
            const tab = fakeTab(id, owner(app));

            await app.attach(tab.client);
            assert.equal(tab.last("browser")?.open, false);

            await say(app, id, "open the test page");
            await until(() => results.length === 1, "the navigate result");
            assert.match(results[0]!, /\[e\d+\] button "Send"/);
            await until(() => tab.last("browser")?.url === `${base}/`, "the page reaching the tab");

            await say(app, id, "take a screenshot");
            await until(() => results.length === 2, "the screenshot result");
            const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
            const entries = await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT);
            const shot = entries.items.find(
                (entry) =>
                    entry.kind === "pi.tool-result" &&
                    JSON.stringify(entry.model).includes("Screenshot of the viewport"),
            )!;

            assert.equal(
                (await app.transcripts.entryImage(id, shot.id as unknown as number, 0))?.mimeType,
                "image/jpeg",
                "Pi sees the screenshot",
            );

            // Everyone who sees the session watches; only people who can steer use the page, and files are the owner's.
            await request(app.config.ownerToken, `c/${id}/browser/navigate`, { url: `${base}/` });
            const state = (await (await request(viewer.token, `c/${id}/browser`)).json()) as {
                open: boolean;
            };

            assert.equal(state.open, true);
            const frame = await request(viewer.token, `c/${id}/browser/frame?after=0`);

            assert.equal(frame.status, 200);
            assert.equal(frame.headers.get("content-type"), "image/jpeg");
            assert.equal(
                (await request(viewer.token, `c/${id}/browser/navigate`, { url: "example.com" }))
                    .status,
                403,
            );
            assert.equal(
                (await request(viewer.token, `c/${id}/browser/input`, { events: [] })).status,
                403,
            );
            const file = await request(guest.token, `c/${id}/browser/navigate`, {
                url: "file:///etc/hosts",
            });

            assert.equal(file.status, 400);
            assert.equal(
                (
                    await request(guest.token, `c/${id}/browser/navigate`, {
                        url: `${base.replace("http://", "")}/two`,
                    })
                ).status,
                200,
            );
            await until(
                () => app.browsers.page(Number(id))?.url === `${base}/two`,
                "the guest's address",
            );
            assert.deepEqual(await (await request(guest.token, `c/${id}/browser/servers`)).json(), {
                servers: [],
            });
            assert.equal((await request(guest.token, `c/${id}/browser/teleport`, {})).status, 404);
            app.detach(tab.client);
        } finally {
            server.closeAllConnections();
            server.close();
            await app.close();
        }
    },
);

test(
    "in a browser people use, a bot's page is a tab of the window's own size that keeps painting",
    real,
    async () => {
        const dataDir = mkdtempSync(join(root, "tabs-"));
        const browsers = new Browsers({
            dataDir,
            remote: {
                claims: () => true,
                // Headless, its window is 800×600: a desktop page there is that wide at most, not the 1280×800 preset.
                launch: () => Chromium.launch(chromium!, join(dataDir, "people"), []),
                tabs: true,
            },
        });

        try {
            const page = await browsers.open(1);

            await page.navigate(`${base}/`);
            const [visibility, width] = (
                await page.evaluate("document.visibilityState + ' ' + innerWidth")
            ).split(" ");

            assert.equal(visibility, "visible");
            assert.ok(Number(width) <= 800, `the window's ${width}, not the preset's 1280`);
            assert.ok((await page.frame(0)) !== undefined, "frames for the panel");
            // A phone's size is still the phone's.
            await page.setViewport({ ...VIEWPORTS.mobile });
            assert.equal(await page.evaluate("String(innerWidth)"), String(VIEWPORTS.mobile.width));
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);
