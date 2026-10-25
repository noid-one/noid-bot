// noid: the owner's switch for auto review of bots' calls, and the models that check.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Sheet, Switch } from "../ui.js";

const keyOf = (model) => (model ? `${model.provider}/${model.modelId}` : "");

/** A model to check with, from the models signed in here; `none` names the choice of none. */
function ReviewModelPick({ label, value, none, onPick }) {
    const models = store.state.models ?? [];
    const chosen = keyOf(value);
    const known = models.some((model) => `${model.provider}/${model.id}` === chosen);

    return html`<label class="setting wrap">
        <div class="grow small">${label}</div>
        <select
            value=${chosen}
            aria-label=${label}
            onChange=${(event) => {
                const picked = models.find(
                    (model) => `${model.provider}/${model.id}` === event.currentTarget.value,
                );

                onPick(picked ? { provider: picked.provider, modelId: picked.id } : null);
            }}
        >
            <option value="">${none}</option>
            ${chosen !== "" && !known && html`<option value=${chosen}>${chosen} (not signed in)</option>`}
            ${models.map(
                (model) =>
                    html`<option value=${`${model.provider}/${model.id}`}>
                        ${model.name} (${model.provider})
                    </option>`,
            )}
        </select>
    </label>`;
}

/** Auto review: a quick model check of each bot call that would run unasked and change something. */
export function AutoReviewSheet() {
    const [state, setState] = useState(undefined);
    const on = state?.on;

    useEffect(() => {
        api("auto-review")
            .then(setState)
            .catch(() => setState({ on: false }));
    }, []);

    const change = (body) =>
        attempt(async () => {
            setState(await api("auto-review", body));
        });

    return html`<${Sheet} title="Auto review" onClose=${closeSheet}>
        <p class="muted small">
            Before a bot runs something that changes things without asking you (a command, a file,
            a click in the browser, a message to another bot), its model checks that it fits what
            the bot was asked. Anything that looks off asks you first. It never lets through what
            would ask anyway, and a check that fails asks too. Each check is a model request, paid
            like the bot's own.
        </p>
        <div class="sheet-list">
            <div class="extension">
                <div class="extension-main">Check bots' calls before they run</div>
                <${Switch}
                    on=${on === true}
                    disabled=${on === undefined}
                    label="Check bots' calls before they run"
                    onChange=${() => change({ on: !on })}
                />
            </div>
        </div>
        ${
            state !== undefined &&
            html`<p class="muted small">
                    A model of its own can check instead of each bot's, and a backup takes over when
                    the first is not signed in or fails.
                </p>
                <div class="sheet-list">
                    <${ReviewModelPick}
                        label="Model that checks"
                        value=${state.model}
                        none="The bot's own model"
                        onPick=${(model) => change({ model })}
                    />
                    <${ReviewModelPick}
                        label="Backup"
                        value=${state.backup}
                        none="No backup"
                        onPick=${(backup) => change({ backup })}
                    />
                </div>`
        }
    <//>`;
}
