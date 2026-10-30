// A quota's reset, read from a provider's error: hours away is a quota to wait out; seconds away is Pi's to retry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaReset } from "../src/server/provider-errors.ts";

const at = Date.UTC(2026, 9, 30, 12);
const HOUR = 60 * 60_000;

test("a quota names its reset as a wait or an epoch; a short rate limit or none is no quota", () => {
    assert.equal(quotaReset("429 Usage limit reached. Try again in 3 hours.", at), at + 3 * HOUR);
    assert.equal(quotaReset('429 {"resets_in_seconds": 7200}', at), at + 2 * HOUR);
    assert.equal(
        quotaReset(`quota exceeded; x-ratelimit-reset: ${String((at + 5 * HOUR) / 1000)}`, at),
        at + 5 * HOUR,
    );
    assert.equal(quotaReset("429 rate limit, retry-after: 20", at), undefined, "seconds away");
    assert.equal(quotaReset("quota exceeded, try again in 2 days", at), undefined, "past a day");
    assert.equal(quotaReset("Try again in 3 hours.", at), undefined, "not a limit");
    assert.equal(quotaReset("prompt is too long", at), undefined);
});
