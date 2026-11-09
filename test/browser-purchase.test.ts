// A press that pays on a website asks first (rakazo ade7100b2): the page tells a click or key that completes a purchase
// from one that does not, and the browser tool asks the people in the session before it presses one, every time,
// with the page's own words for the button and the amount, and presses nothing once the page changed. Needs a
// Chromium-based browser on this machine, as browser.test.ts does; no Docker.
import {
    type App,
    cleanUp,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

const CHECKOUT = `<!doctype html><title>Checkout</title><body>
<header><nav><a href="/">Shop</a> <button id="menu">Menu</button></nav></header>
<main><h1>Checkout</h1>
<form id="card" onsubmit="event.preventDefault(); window.paid = (window.paid || 0) + 1">
<label for="number">Card number</label><input id="number" autocomplete="cc-number">
<label for="cvc">CVC</label><input id="cvc">
<p>Total: $12.00</p>
<button id="back" type="button">Back</button>
<button id="other" type="button">Continue</button>
<button id="pay" type="submit">Pay now</button></form>
</main></body>`;

const SHOP = `<!doctype html><title>Shop</title><body><main>
<button id="cart" onclick="window.carted = 1">Add to cart</button>
<button id="order" onclick="window.ordered = (window.ordered || 0) + 1">Place order · €40</button>
<a id="plain" href="/two">Our story</a>
<form id="find" onsubmit="event.preventDefault()"><input id="search"><button type="submit">Search</button></form>
</main></body>`;

// A plain "Continue" button and a field, with a "Place order" button drawn over both: a click on either lands on it.
const COVERED = `<!doctype html><title>Shop</title><body><main>
<button id="next" style="position:absolute;left:20px;top:20px;width:200px;height:60px">Continue</button>
<input id="code" style="position:absolute;left:20px;top:100px;width:200px">
<button id="cover" style="position:absolute;left:0;top:0;width:400px;height:200px;z-index:9"
 onclick="window.ordered = (window.ordered || 0) + 1">Place order · €40</button>
</main></body>`;

// A login's redirect: the page replaces its document again and again while checks run.
const BOUNCING = (to: string, ms: number) =>
    `<!doctype html><button id="go">Continue</button><script>setTimeout(() => location.replace("${to}"), ${ms})</script>`;

let site: Server;
let base = "";

before(async () => {
    site = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
            request.url === "/shop"
                ? SHOP
                : request.url === "/covered"
                  ? COVERED
                  : request.url === "/bounce-a"
                    ? BOUNCING("/bounce-b", 0)
                    : request.url === "/bounce-b"
                      ? BOUNCING("/bounce-a", 5)
                      : CHECKOUT,
        );
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});

after(() => {
    site.close();
    cleanUp();
});

test(
    "a check while the page replaces its document reads the new one, and asks for nothing",
    real,
    async () => {
        const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "purchase-")) });

        try {
            const page = await browsers.open(1);
            const asked: string[] = [];

            await page.navigate(`${base}/bounce-a`);

            for (let i = 0; i < 400; i++) {
                const found = await page.purchase({ selector: "#go" });

                if (found !== undefined) {
                    asked.push(found.reason);
                }
            }

            assert.deepEqual(asked, [], "no card for a payment that is not there");
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);

test("the page tells a press that pays from one that does not", real, async () => {
    const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "purchase-")) });
    const host = base.replace("http://", "");

    try {
        const page = await browsers.open(1);

        await page.navigate(`${base}/checkout`);
        // The card form's submit: with its words and the page's total.
        assert.deepEqual(await page.purchase({ selector: "#pay" }), {
            site: host,
            reason: "card_form",
            label: "Pay now",
            amount: "$12.00",
            amountFrom: "page",
        });
        // Another button on a page with card fields may pay; one that never pays, or a site menu, does not.
        assert.equal((await page.purchase({ label: "Continue" }))?.reason, "payment_page");
        assert.equal(await page.purchase({ selector: "#back" }), undefined);
        assert.equal(await page.purchase({ selector: "#menu" }), undefined);
        // A click in a field types there; it presses nothing.
        assert.equal(await page.purchase({ selector: "#number" }), undefined);
        // Enter in a card field submits the card form; Space in a field types a space.
        assert.equal((await page.purchase({ selector: "#cvc" }, "enter"))?.reason, "card_form");
        assert.equal(await page.purchase({ selector: "#cvc" }, "space"), undefined);
        // A ref the page no longer has buys nothing: the click itself says so.
        assert.equal(await page.purchase({ ref: "e999" }), undefined);

        await page.navigate(`${base}/shop`);
        assert.deepEqual(await page.purchase({ selector: "#order" }), {
            site: host,
            reason: "final_step",
            label: "Place order · €40",
            amount: "€40",
            amountFrom: "button",
        });
        assert.equal(await page.purchase({ label: "Add to cart" }), undefined);
        assert.equal(await page.purchase({ selector: "#plain" }), undefined);
        // Enter in an ordinary field submits a form that buys nothing.
        assert.equal(await page.purchase({ selector: "#search" }, "enter"), undefined);
        // A point on the screen: what is there decides.
        const spot = await page.locate({ selector: "#order" });

        assert.equal((await page.purchase({ x: spot.x, y: spot.y }))?.reason, "final_step");
        // With the order button focused, Enter presses it.
        await page.evaluate("document.getElementById('order').focus(); 1");
        assert.equal((await page.purchase(undefined, "enter"))?.reason, "final_step");
        assert.equal(await page.evaluate("String(window.ordered)"), "undefined", "nothing pressed");
        // Where the click lands cannot be read (a page too busy to answer in time): the target itself is judged, so
        // the order button still asks.
        const locate = page.locate;

        page.locate = () => Promise.reject(new Error("The browser did not answer in time."));

        try {
            assert.equal((await page.purchase({ selector: "#order" }))?.reason, "final_step");
            assert.equal(await page.purchase({ selector: "#plain" }), undefined);
        } finally {
            page.locate = locate;
        }

        // A click lands on what is drawn over its target: the order button over "Continue" and a field.
        await page.navigate(`${base}/covered`);
        assert.equal((await page.purchase({ selector: "#next" }))?.label, "Place order · €40");
        assert.equal((await page.purchase({ selector: "#code" }))?.reason, "final_step");
        assert.equal(await page.evaluate("String(window.ordered)"), "undefined", "nothing pressed");
    } finally {
        await browsers.closeAll({ final: true });
    }
});

test(
    "the browser tool asks before a press that pays, every time, and presses nothing the page changed",
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

            const match = /^browser (.*)$/s.exec(text);

            return match === null
                ? fauxAssistantMessage([fauxText("ok")])
                : call(JSON.parse(match[1]!) as Parameters<typeof fauxToolCall>[1]);
        };

        const app: App = await openApp(scriptedModel(route), join(root, "purchase-app"));
        const id = await newSession(app);
        const send = (args: Record<string, unknown>) =>
            app.commands.submit(id, owner(app), {
                text: `browser ${JSON.stringify(args)}`,
                requestId: crypto.randomUUID(),
            });
        const card = () =>
            until(() => app.approvals.forConversation(id).length > 0, "the payment card").then(
                () => app.approvals.forConversation(id)[0]!,
            );
        const page = () => app.browsers.page(Number(id))!;
        const ordered = async () => await page().evaluate("String(window.ordered)");

        try {
            await loadTools(app, id, "browser");
            await send({ action: "navigate", url: `${base}/shop` });
            await until(() => results.length === 1, "the page");

            // A click that buys nothing asks nothing.
            await send({ action: "click", label: "Add to cart" });
            await until(() => results.length === 2, "the cart click");
            assert.equal(await page().evaluate("String(window.carted)"), "1");
            assert.equal(app.approvals.forConversation(id).length, 0);

            // The order: a card with the page's words, asked every time (no "Always allow"), and nothing pressed yet.
            await send({ action: "click", selector: "#order" });
            const asked = await card();

            assert.match(asked.id, /^noid:every:/);
            assert.match(asked.subject, /^Pay on 127\.0\.0\.1:\d+\?\nButton: "Place order · €40"/);
            assert.match(asked.subject, /Amount on the button: €40/);
            assert.match(asked.reason, /^Pi completes a payment on 127\.0\.0\.1/);
            assert.equal(await ordered(), "undefined");
            assert.ok(await app.answerApproval(asked.id, false, owner(app)));
            await until(() => results.length === 3, "the denied click");
            assert.match(results[2]!, /denied this payment on 127\.0\.0\.1:\d+/);
            assert.equal(await ordered(), "undefined");

            // Allowed: pressed once.
            await send({ action: "click", selector: "#order" });
            assert.ok(await app.answerApproval((await card()).id, true, owner(app)));
            await until(() => results.length === 4, "the allowed click");
            assert.equal(await ordered(), "1");

            // The page changes while the card waits: what was approved is not what is there, so nothing is pressed.
            await send({ action: "click", selector: "#order" });
            const waiting = await card();

            await page().evaluate(
                "document.getElementById('order').textContent = 'Place order · €400'; 1",
            );
            assert.ok(await app.answerApproval(waiting.id, true, owner(app)));
            await until(() => results.length === 5, "the changed click");
            assert.match(results[4]!, /The page changed since the payment was approved/);
            assert.equal(await ordered(), "1");

            // Enter on the focused order button asks too.
            await page().evaluate("document.getElementById('order').focus(); 1");
            await send({ action: "press", key: "Enter" });
            assert.ok(await app.answerApproval((await card()).id, false, owner(app)));
            await until(() => results.length === 6, "the denied key");
            assert.equal(await ordered(), "1");
        } finally {
            await app.close();
        }
    },
);

test(
    "the browser tool asks however a press reaches a pay button: a covered target, typing, a line break, Space",
    real,
    async () => {
        const results: string[] = [];

        const route: FauxResponseStep = (context) => {
            const { role, text } = lastText(context as never);

            if (role === "toolResult") {
                results.push(text);

                return fauxAssistantMessage([fauxText("done")]);
            }

            const match = /^browser (.*)$/s.exec(text);

            return match === null
                ? fauxAssistantMessage([fauxText("ok")])
                : fauxAssistantMessage(
                      [
                          fauxToolCall(
                              "browser",
                              JSON.parse(match[1]!) as Parameters<typeof fauxToolCall>[1],
                          ),
                      ],
                      { stopReason: "toolUse" },
                  );
        };

        const app: App = await openApp(scriptedModel(route), join(root, "purchase-ways"));
        const id = await newSession(app);
        const page = () => app.browsers.page(Number(id))!;

        // Each press, denied on its card: the page shows whether anything was pressed.
        const denied = async (args: Record<string, unknown>, what: string) => {
            const count = results.length;

            await app.commands.submit(id, owner(app), {
                text: `browser ${JSON.stringify(args)}`,
                requestId: crypto.randomUUID(),
            });
            await until(() => app.approvals.forConversation(id).length > 0, `the card for ${what}`);
            const card = app.approvals.forConversation(id)[0]!;

            assert.match(card.subject, /^Pay on 127\.0\.0\.1:\d+\?/, what);
            assert.ok(await app.answerApproval(card.id, false, owner(app)));
            await until(() => results.length === count + 1, what);
            assert.match(results.at(-1)!, /denied this payment/, what);
        };

        const go = async (path: string) => {
            const count = results.length;

            await app.commands.submit(id, owner(app), {
                text: `browser ${JSON.stringify({ action: "navigate", url: `${base}${path}` })}`,
                requestId: crypto.randomUUID(),
            });
            await until(() => results.length === count + 1, path);
        };

        try {
            await loadTools(app, id, "browser");

            // A click, or the click typing makes first, on a control the order button is drawn over.
            await go("/covered");
            await denied({ action: "click", selector: "#next" }, "a covered click");
            await denied({ action: "type", selector: "#code", text: "SAVE10" }, "a covered field");
            assert.equal(await page().evaluate("String(window.ordered)"), "undefined");

            // Space, and a line break sent as a key, on the focused order button.
            await go("/shop");
            await page().evaluate("document.getElementById('order').focus(); 1");
            await denied({ action: "press", key: " " }, "Space");
            await denied({ action: "press", key: "\r" }, "a carriage return");
            assert.equal(await page().evaluate("String(window.ordered)"), "undefined");

            // Typing with Enter, or a line break pressed, in a card field submits the card form.
            await go("/checkout");
            await denied({ action: "type", selector: "#cvc", text: "123", submit: true }, "submit");
            await page().evaluate("document.getElementById('cvc').focus(); 1");
            await denied({ action: "press", key: "\n" }, "a line feed");
            assert.equal(await page().evaluate("String(window.paid)"), "undefined");
        } finally {
            await app.close();
        }
    },
);
