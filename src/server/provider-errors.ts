/**
 * What a provider's error says: whether the model or its account is the problem rather than the request
 * (`modelFailure`, for subagents), and when a quota it ran into comes back (`quotaReset`, for schedules: rakazo
 * 800edb462). One place for their words, so they agree.
 */

/** Words of a quota or rate limit: a provider's trouble, and what a reset is read from. */
const QUOTA = /\b429\b|quota|rate.?limit|usage limit|too many requests|limit (?:will )?reset/;

/**
 * What a provider says when the model or its account is the problem (a sign-in, a model that is gone or refused, a
 * quota or rate limit, an overload, a model that cannot call tools), not the request: a context that will not fit, say,
 * is Pi's to work around. Credential words on either side (rakazo 4185ee85d, 417cf2ecb).
 */
const PROVIDER_TROUBLE = new RegExp(
    `${QUOTA.source}|oauth|sign.?in|auth|api.?key|unauthori[sz]ed|forbidden|permission|\\b(401|402|403|404|503|529)\\b|not found|does not exist|no such model|not available|not configured|unsupported model|insufficient|billing|credit|overloaded|(?:expired|revoked) (?:api )?(?:key|credential|token)|(?:key|credential|token) (?:is |has been |was )?(?:expired|revoked)|tool calls'? (?:is |are )?not (?:currently )?supported`,
    "i",
);

/** Whether a run ended unanswered because of its model or provider: no model to use, or the provider's trouble. */
export function modelFailure(reason: string, detail: unknown): boolean {
    return (
        reason === "no_model" ||
        (reason === "model_error" && typeof detail === "string" && PROVIDER_TROUBLE.test(detail))
    );
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: HOUR, d: DAY };

/**
 * When the quota resets (the server's clock), for an error `message` written at `at`: an epoch it names
 * (`X-RateLimit-Reset`, `resets_at`), or a wait (`Retry-After`, `resets_in_seconds`, "try again in 3 hours"). Undefined
 * for a message that names none, or one within the hour, or one past a day (a wait that long is not one to keep).
 */
export function quotaReset(message: string, at: number): number | undefined {
    const text = message.toLowerCase();

    if (!QUOTA.test(text)) {
        return undefined;
    }

    let reset: number | undefined;
    const epoch = /(?:x-ratelimit-reset|resets?_at)["']?\s*[:=]\s*["']?(\d{10,13})\b/.exec(text);
    const seconds = /(?:retry-after|resets?_in_seconds)["']?\s*[:=]\s*["']?(\d+)\b/.exec(text);
    const words =
        /(?:try again|resets?|available again)\s+in\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/.exec(
            text,
        );

    if (epoch !== null) {
        const value = Number(epoch[1]);

        reset = value < 1e12 ? value * 1000 : value;
    } else if (seconds !== null) {
        reset = at + Number(seconds[1]) * 1000;
    } else if (words !== null) {
        reset = at + Number(words[1]) * UNITS[words[2]![0]!]!;
    }

    if (reset === undefined || reset - at <= HOUR || reset - at > DAY) {
        return undefined;
    }

    return reset;
}
