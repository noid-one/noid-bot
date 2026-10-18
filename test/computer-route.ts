/**
 * The scripted model for the shared computer's tests: "run COMMAND" calls bash, and a tool result is answered with
 * its text, so the transcript shows what the tool saw.
 */
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { lastText } from "./helpers.ts";

export const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
    }

    if (text.startsWith("run ")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: text.slice(4) })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};
