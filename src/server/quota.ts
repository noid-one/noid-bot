/**
 * When a provider's quota that a failed request ran into comes back, read from its error message: a reset it names
 * more than an hour away is a quota, not a short rate limit that Pi's own retries wait out (rakazo 800edb462).
 */

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

    if (
        !/\b429\b|quota|rate.?limit|usage limit|too many requests|limit (?:will )?reset/.test(text)
    ) {
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
