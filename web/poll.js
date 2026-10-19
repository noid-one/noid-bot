// noid: refreshing what a sheet shows while it is open: again every so often, never while the tab is hidden, later after
// a failure, and not at all once the sheet closes or `load` says to stop (returns false).
import { useEffect } from "preact/hooks";

/** Call `load` now and every `every` ms (or `afterFailure` ms after it throws) while the component is mounted. */
export function usePoll(load, { every, afterFailure = every }, deps = []) {
    useEffect(() => {
        let gone = false;
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        void (async () => {
            while (!gone) {
                if (document.hidden) {
                    await wait(every);
                    continue;
                }

                let next = every;

                try {
                    if ((await load(() => gone)) === false) {
                        return;
                    }
                } catch {
                    next = afterFailure;
                }

                await wait(next);
            }
        })();

        return () => {
            gone = true;
        };
    }, deps);
}
