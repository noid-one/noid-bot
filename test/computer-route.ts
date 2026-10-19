/**
 * The scripted model for the shared computer's tests: "run COMMAND" calls bash, and a tool result is answered with
 * its text, so the transcript shows what the tool saw. "prompt has WORD" says whether WORD is in the system prompt.
 */
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { lastText } from "./helpers.ts";

export const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
    }

    if (text.startsWith("prompt has ")) {
        const word = text.slice("prompt has ".length);
        // What the model was given before this message: its system prompt (as system entries) and earlier messages.
        const { messages, systemPrompt } = request as {
            messages: unknown[];
            systemPrompt?: string;
        };
        const given = JSON.stringify({ systemPrompt, messages: messages.slice(0, -1) });

        return fauxAssistantMessage([fauxText(`has ${word}: ${given.includes(word)}`)]);
    }

    if (text.startsWith("run ")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: text.slice(4) })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};
