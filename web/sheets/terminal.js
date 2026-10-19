// noid: a shell on the shared computer, for the owner. Output is read by long polling from an offset; input goes out in
// order, one request at a time. Closing the sheet leaves the shell running: opening it again (or reloading) reads on
// in the same shell, with what it showed. End shell stops it; one nobody reads for 10 minutes stops by itself.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, closeSheet } from "../store.js";
import { html, Sheet } from "../ui.js";

const HOME = "/home/noid";
/** The most input sent in one request: a long paste goes in pieces (the server takes up to 64K characters). */
const INPUT_PIECE = 16_000;

/** Whether a folder is on the shared computer: its home, or under it. */
export const onComputer = (cwd) => cwd === HOME || (cwd ?? "").startsWith(`${HOME}/`);

/** xterm and its stylesheet, loaded the first time a terminal opens; tried again after a failure. */
let loading;

function loadXterm() {
    if (loading === undefined) {
        if (!document.querySelector('link[href="/vendor/xterm.css"]')) {
            const link = document.createElement("link");

            link.rel = "stylesheet";
            link.href = "/vendor/xterm.css";
            document.head.append(link);
        }

        loading = Promise.all([import("/vendor/xterm.mjs"), import("/vendor/addon-fit.mjs")]);
        loading.catch(() => {
            loading = undefined;
        });
    }

    return loading;
}

const bytes = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
const folderOf = (cwd) => (onComputer(cwd) ? cwd.replace(/\/+$/, "") : HOME);

/** `cwd`: the folder on the computer to start in; the computer's home when it is elsewhere. */
export function TerminalSheet({ cwd }) {
    const host = useRef(null);
    const shell = useRef(undefined);
    const [status, setStatus] = useState("Starting the computer…");
    const [folder, setFolder] = useState(folderOf(cwd));

    useEffect(() => {
        let gone = false;
        let term;
        let observer;

        void (async () => {
            try {
                const [{ Terminal }, { FitAddon }] = await loadXterm();

                if (gone) {
                    return;
                }

                const style = getComputedStyle(document.body);

                term = new Terminal({
                    cursorBlink: true,
                    fontFamily: style.getPropertyValue("--mono") || "monospace",
                    fontSize: 13,
                    theme: {
                        background: style.getPropertyValue("--bg").trim() || "#16161e",
                        foreground: style.getPropertyValue("--body").trim() || "#c0caf5",
                    },
                });
                const fit = new FitAddon();

                term.loadAddon(fit);
                term.open(host.current);
                fit.fit();

                // A shell in this folder that is still running (the sheet was closed, the page reloaded) is read on.
                const { terminals } = await api("terminals");
                const running = terminals.find((each) => each.cwd === folderOf(cwd));
                const opened =
                    running ?? (await api("terminals", { cwd, cols: term.cols, rows: term.rows }));

                shell.current = opened.id;
                setFolder(opened.cwd);

                if (gone) {
                    return;
                }

                const id = opened.id;
                const resize = () =>
                    api(`terminals/${id}/resize`, { cols: term.cols, rows: term.rows }).catch(
                        () => {},
                    );

                if (running !== undefined) {
                    void resize();
                }

                setStatus("");
                term.focus();

                // Input in order: what is typed while a send is out goes in the next one, a long paste in pieces.
                let queued = "";
                let sending = false;

                const send = async () => {
                    if (sending || queued === "" || gone) {
                        return;
                    }

                    sending = true;
                    const data = queued.slice(0, INPUT_PIECE);

                    queued = queued.slice(data.length);

                    try {
                        await api(`terminals/${id}/input`, { data });
                    } catch (error) {
                        setStatus(`Input was not sent: ${error.message}`);
                    }

                    sending = false;
                    void send();
                };

                term.onData((data) => {
                    queued += data;
                    void send();
                });
                observer = new ResizeObserver(() => {
                    fit.fit();
                    void resize();
                });
                observer.observe(host.current);

                let next = 0;

                while (!gone) {
                    try {
                        const read = await api(`terminals/${id}/read?from=${next}`);

                        if (gone) {
                            return;
                        }

                        term.write(bytes(read.data));
                        next = read.next;

                        if (read.ended !== undefined) {
                            shell.current = undefined;
                            setStatus(`The shell ${read.ended}.`);

                            return;
                        }
                    } catch (error) {
                        if (error.status === 404) {
                            shell.current = undefined;
                            setStatus("The shell is gone.");

                            return;
                        }

                        await new Promise((resolve) => setTimeout(resolve, 1000));
                    }
                }
            } catch (error) {
                if (!gone) {
                    setStatus(`Could not open a terminal: ${error.message}`);
                }
            }
        })();

        return () => {
            gone = true;
            observer?.disconnect();
            term?.dispose();
        };
    }, [cwd]);

    const end = () => {
        const id = shell.current;

        shell.current = undefined;

        if (id !== undefined) {
            void api(`terminals/${id}/close`, {}).catch(() => {});
        }

        closeSheet();
    };

    return html`<${Sheet} title="Computer terminal" onClose=${closeSheet} wide>
        <p class="muted small">
            A shell on the shared computer, in ${folder}. Bots work here too: what you change, they
            see. Closing this keeps it running for a while; End shell stops it.
        </p>
        ${status && html`<p class="muted small" role="status">${status}</p>`}
        <div class="terminal-host" ref=${host}></div>
        <div class="sheet-actions">
            <button class="button" onClick=${end}>End shell</button>
        </div>
    <//>`;
}
