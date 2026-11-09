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

let site: Server;
let base = "";

before(async () => {
    site = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(request.url === "/shop" ? SHOP : CHECKOUT);
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});

after(() => {
    site.close();
    cleanUp();
});

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
