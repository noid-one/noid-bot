/**
 * The answers on an ask's card (Pi's `ask` tool, `extensions/ask.ts`), checked where they come in: the answer route
 * (`PocketApp.answerApproval`) takes only what the card offered. Ported from Pi Pocket's `host.ask` (0.27.0), with its
 * question fields alone: noid has no extension API for asking.
 */
import type { AskField } from "./host.ts";

/** The longest answer one question takes. */
export const MAX_ASK_VALUE = 4096;

/** A choice field's value as labels: one, or with `multiple` one per line; undefined when it is not only labels. */
export function pickedLabels(field: AskField, value: string): string[] | undefined {
    const labels = field.choices.map((choice) => choice.label);
    const picked = field.multiple === true ? value.split("\n") : [value];

    return picked.every((label) => labels.includes(label)) && new Set(picked).size === picked.length
        ? picked
        : undefined;
}

/**
 * What a person sent on an ask's card, checked against its fields: each one there, as text of up to `MAX_ASK_VALUE`
 * characters, and nothing else. A field takes one of its labels, or with `multiple` one or more, one per line; with
 * `other`, any text too. An error says what is wrong, never a value.
 */
export function checkValues(fields: readonly AskField[], values: unknown): Record<string, string> {
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
        throw new Error("Answer the questions.");
    }

    const out: Record<string, string> = {};

    for (const field of fields) {
        const value = (values as Record<string, unknown>)[field.name];

        if (typeof value !== "string" || value === "") {
            throw new Error(`Answer ${field.label}`);
        }

        if (value.length > MAX_ASK_VALUE) {
            throw new Error(`The answer to ${field.label} is too long.`);
        }

        if (
            pickedLabels(field, value) === undefined &&
            (field.other !== true || value.trim() === "")
        ) {
            throw new Error(`Choose an answer to ${field.label}`);
        }

        out[field.name] = value;
    }

    if (Object.keys(values).some((key) => !fields.some((field) => field.name === key))) {
        throw new Error("That is not a question on this card.");
    }

    return out;
}
