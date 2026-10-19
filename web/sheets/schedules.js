// Scheduled messages of this session; a bot's are its routines.
import { useEffect, useState } from "preact/hooks";
import { actions, attempt, canSteer, closeSheet, store } from "../store.js";
import { formatWhen, html, Icon, Sheet } from "../ui.js";

/** A run as one line: when, and what came of it. */
const runLine = (run) =>
    `${formatWhen(run.at)}${run.now ? " (run now)" : ""} · ${
        run.status === "failed"
            ? `failed: ${run.error}`
            : run.status === "running"
              ? "running"
              : "done"
    }`;

/** Messages that go to Pi later or on repeat: set one up, see what is coming and what came of it, run one now, cancel one. */
export function SchedulesSheet() {
    const { view, users, me, sessions } = store.state;
    const [when, setWhen] = useState("");
    // What came of each schedule's latest runs, newest first, by schedule id.
    const [runs, setRuns] = useState({});
    const steer = canSteer();
    const bot = sessions.find((session) => session.id === view.conversation?.id)?.bot;
    const setBy = (id) =>
        id === undefined
            ? "Pi"
            : id === me?.id
              ? "you"
              : (users.find((user) => user.id === id)?.name ?? "someone");
    const add = () =>
        attempt(async () => {
            await actions.schedule(when);
            setWhen("");
        });

    const refresh = async () =>
        setRuns((await actions.scheduleRuns().catch(() => ({ runs: {} }))).runs);

    const runNow = (id) =>
        attempt(async () => {
            await actions.runSchedule(id);
            await refresh();
        });

    // Again whenever one goes out or the list changes; a run still going is looked at again shortly.
    const shown = view.schedules.map((schedule) => `${schedule.id}:${schedule.runs}`).join();
    const going = Object.values(runs).some((list) => list[0]?.status === "running");

    useEffect(() => {
        void refresh();

        if (!going) {
            return undefined;
        }

        const timer = setInterval(() => void refresh(), 3000);

        return () => clearInterval(timer);
    }, [shown, going]);

    return html`<${Sheet}
        title=${bot === undefined ? "Scheduled messages" : `${bot.name}'s routines`}
        onClose=${closeSheet}
    >
        <p class="muted small">
            ${
                bot === undefined
                    ? "Pi gets these at their time, also when nobody is here, and the people in this session get a notification when it is done."
                    : `${bot.name} gets these at their time, also when nobody is here. You get a notification when one is done, and a louder one when one fails.`
            }
        </p>
        ${
            steer &&
            html`<div class="row">
                <input
                    placeholder=${bot === undefined ? "in 2h check the deploy" : "every weekday 8:00 summarize my inbox"}
                    value=${when}
                    onInput=${(event) => setWhen(event.currentTarget.value)}
                    onKeyDown=${(event) => event.key === "Enter" && add()}
                />
                <button class="button primary" disabled=${when.trim() === ""} onClick=${add}>
                    Add
                </button>
            </div>
            <p class="muted small">
                Start with when: in 30m, 7:00, tomorrow 9am, fri 17:30, every 2h, every weekday 8:00, or cron 0 8 * * 1-5. Then what ${bot?.name ?? "Pi"} gets.
            </p>`
        }
        ${view.schedules.length === 0 && html`<p class="muted">Nothing is scheduled.</p>`}
        ${
            view.schedules.length > 0 &&
            html`<div class="sheet-list">
                ${view.schedules.map((schedule) => {
                    const [last, ...earlier] = runs[schedule.id] ?? [];

                    return html`<div class="schedule" key=${schedule.id}>
                        <${Icon} name="clock" size=${15} />
                        <div class="grow">
                            <div>${schedule.text}</div>
                            <div class="muted small">
                                ${schedule.repeat ? `${schedule.repeat} · next ${formatWhen(schedule.next)}` : formatWhen(schedule.next)} · set by ${setBy(schedule.by)}
                            </div>
                            ${
                                last !== undefined &&
                                html`<div class=${`small schedule-run ${last.status}`}>
                                    Last run ${runLine(last)}
                                </div>`
                            }
                            ${
                                earlier.length > 0 &&
                                html`<details class="schedule-history small muted">
                                    <summary>${earlier.length} earlier</summary>
                                    ${earlier.map(
                                        (run) =>
                                            html`<div class=${`schedule-run ${run.status}`}>
                                                ${runLine(run)}
                                            </div>`,
                                    )}
                                </details>`
                            }
                        </div>
                        ${
                            steer &&
                            html`<button
                                    class="button small ghost"
                                    onClick=${() => runNow(schedule.id)}
                                >
                                    Run now
                                </button>
                                <button
                                    class="button small ghost"
                                    onClick=${() =>
                                        attempt(() => actions.cancelSchedule(schedule.id))}
                                >
                                    Cancel
                                </button>`
                        }
                    </div>`;
                })}
            </div>`
        }
    <//>`;
}
