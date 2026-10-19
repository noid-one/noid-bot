// noid: a shell on the shared computer, for the owner, as a page in the conversation's place. Output is read by long
// polling from an offset; input goes out in order, one request at a time. Closing the page leaves the shell running:
// opening it again (or reloading) reads on in the same shell, with what it showed. End shell stops it; one nobody
// reads for 10 minutes stops by itself.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, closeTool, store } from "../store.js";
import { ToolFrame } from "../tool-page.js";
import { html, shortPath } from "../ui.js";

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
export function TerminalPage({ cwd }) {
    const host = useRef(null);
    const shell = useRef(undefined);
    const [status, setStatus] = useState("Starting the computer…");
    const [folder, setFolder] = useState(folderOf(cwd));

    useEffect(() => {
        let gone = false;
        let term;
        let observer;
        let resizing;
        // The read waiting on the server (up to 25 seconds) ends with the page: held open, each would take one of the
        // browser's few connections to the server.
        const reads = new AbortController();

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
                // The size the shell has: a new one was made at this size, a running one may have another.
                let size = running === undefined ? `${term.cols}x${term.rows}` : "";

                const resize = () => {
                    const now = `${term.cols}x${term.rows}`;

                    if (now === size) {
                        return;
                    }

                    size = now;
                    void api(`terminals/${id}/resize`, { cols: term.cols, rows: term.rows }).catch(
                        () => {},
                    );
                };

                resize();

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
                // Once the size settles: dragging a splitter would send dozens.
                observer = new ResizeObserver(() => {
                    fit.fit();
                    clearTimeout(resizing);
                    resizing = setTimeout(resize, 150);
                });
                observer.observe(host.current);

                let next = 0;
                let failing = false;

                while (!gone) {
                    try {
                        const read = await api(`terminals/${id}/read?from=${next}`, undefined, {
                            signal: reads.signal,
                        });

                        if (gone) {
                            return;
                        }

                        if (failing) {
                            failing = false;
                            setStatus("");
                        }

                        term.write(bytes(read.data));
                        next = read.next;

                        if (read.ended !== undefined) {
                            shell.current = undefined;
                            setStatus(`The shell ${read.ended}.`);

                            return;
                        }
                    } catch (error) {
                        if (gone) {
                            return;
                        }

                        if (error.status === 404) {
                            shell.current = undefined;
                            setStatus("The shell is gone.");

                            return;
                        }

                        // Signed out, or no longer allowed: trying again would not change that.
                        if (error.status === 401 || error.status === 403) {
                            setStatus(`The shell cannot be read: ${error.message}`);

                            return;
                        }

                        failing = true;
                        setStatus(`Reconnecting to the shell… (${error.message})`);
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
            reads.abort();
            clearTimeout(resizing);
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

        closeTool();
    };

    return html`<${ToolFrame}
        kind="terminal"
        title="Terminal"
        sub=${`${shortPath(folder, store.state.server?.home)} on the shared computer · bots see what you change`}
        actions=${html`<button
            class="button ghost small"
            title="Stop this shell. Closing the page keeps it running for a while."
            onClick=${end}
        >
            End shell
        </button>`}
    >
        ${status && html`<p class="tool-status muted small" role="status">${status}</p>`}
        <div class="terminal-host" ref=${host}></div>
    <//>`;
}
