/**
 * Pi's compaction settings for Pi Durable, with each model's own thresholds: Pi's `compaction.modelOverrides`, keyed
 * by `provider/modelId`, resolved by Pi itself (its checks, project over user settings).
 */
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CompactionPolicy, CompactionSettings } from "@earendil-works/pi-durable";
import { describe } from "./errors.ts";

/** The model names that Pi's settings (user and project, merged) give compaction values of their own. */
function overridden(settings: SettingsManager): string[] {
    return Object.keys(settings.getSettings().compaction?.modelOverrides ?? {});
}

/**
 * What Pi Durable compacts by, read afresh at each call: Pi's settings, and for each model with values of its own,
 * those. An override Pi refuses (not a whole number, or a name with no provider) is left out and reported once through
 * `warn`, so the others and the general values still count; general values that Pi refuses throw, as before.
 */
export function compactionReader(
    settings: SettingsManager,
    warn: (message: string) => void,
): () => CompactionSettings {
    const warned = new Set<string>();

    return () => {
        const general = settings.getCompactionSettings();
        const modelOverrides: Record<string, Partial<CompactionPolicy>> = {};

        for (const name of overridden(settings)) {
            const slash = name.indexOf("/");

            try {
                if (slash <= 0) {
                    throw new Error("the name must be provider/modelId");
                }

                const { reserveTokens, keepRecentTokens } = settings.getCompactionSettings({
                    provider: name.slice(0, slash),
                    id: name.slice(slash + 1),
                });

                modelOverrides[name] = { reserveTokens, keepRecentTokens };
            } catch (error) {
                const message = `Pi's compaction.modelOverrides[${JSON.stringify(name)}] is left out: ${describe(error)}`;

                if (!warned.has(message)) {
                    warned.add(message);
                    warn(message);
                }
            }
        }

        return Object.keys(modelOverrides).length === 0 ? general : { ...general, modelOverrides };
    };
}
