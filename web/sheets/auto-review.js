// noid: the owner's switch for auto review of bots' calls.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet } from "../store.js";
import { html, Sheet, Switch } from "../ui.js";

/** Auto review: a quick model check of each bot call that would run unasked and change something. */
export function AutoReviewSheet() {
    const [on, setOn] = useState(undefined);

    useEffect(() => {
        api("auto-review")
            .then((state) => setOn(state.on))
            .catch(() => setOn(false));
    }, []);

    const flip = () =>
        attempt(async () => {
            setOn((await api("auto-review", { on: !on })).on);
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
                    onChange=${flip}
                />
            </div>
        </div>
    <//>`;
}
