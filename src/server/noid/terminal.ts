/**
 * noid's terminal: a shell on the shared computer, for the owner, in the app. Each terminal is a program in a
 * pseudo-terminal of the computer's pi-env daemon (`openTerminal`). Its output is kept in order, the last part of it
 * at least, and read by long polling from an offset: a tab that loses its connection, or comes back to the shell after
 * a reload, reads on from where it was, and one that falls far behind gets what is still kept. The shell's own request
 * to the daemon keeps the computer awake while it runs; one nobody reads for a while is closed.
 */
import { randomUUID } from "node:crypto";
import { openTerminal, type RemoteTerminal, type TerminalOptions } from "@earendil-works/pi-env";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import { requireOwner } from "./owner.ts";
import { type Computer, COMPUTER_HOME, normalFolder, onComputer } from "./computer.ts";

/** How much of a terminal's output is kept for reading again. */
const KEEP_BYTES = 256 * 1024;
/** Output comes a few bytes at a time (each key's echo): small pieces are joined up to this, so few are kept. */
const PIECE_BYTES = 8 * 1024;
/** How long a read waits for output before it answers empty. */
const READ_HOLD_MS = 25_000;
/** How long a terminal nobody reads stays open. */
const UNREAD_MS = 10 * 60_000;
const MAX_TERMINALS = 4;

/** The most input one request may carry; the app sends a long paste in pieces. */
export const MAX_INPUT = 64 * 1024;

type Opener = (options: TerminalOptions) => Promise<RemoteTerminal>;

type Terminal = {
    id: string;
    cwd: string;
    remote: RemoteTerminal;
    /** Output kept, in order: the bytes from `start` to `end` of everything it wrote. */
    pieces: Buffer[];
    start: number;
    end: number;
    /** How it ended: its exit code, or why it was lost. Undefined while it runs. */
    ended: string | undefined;
    /** Reads waiting for output. */
    waiters: Set<() => void>;
    readAt: number;
};

/** What a read finds: the output from `from` (base64) and the offset to read from next. */
export type TerminalRead = { from: number; next: number; data: string; ended?: string };

export class Terminals {
    readonly #computer: Computer;
    readonly #open: Opener;
    readonly #now: () => number;
    readonly #terminals = new Map<string, Terminal>();
    /** Opens on their way: they count toward the limit already. */
    #opening = 0;
    #closed = false;
    readonly #sweep: NodeJS.Timeout;

    constructor(computer: Computer, open?: Opener, now: () => number = Date.now) {
        this.#computer = computer;
        this.#open = open ?? ((options) => openTerminal(computer.connection, options));
        this.#now = now;
        this.#sweep = setInterval(() => this.#closeUnread(), 60_000);
        this.#sweep.unref();
    }

    /** Only the owner gets a shell: it reaches everything on the computer. */
    #require(user: User): void {
        requireOwner(user, "Only the owner can open a terminal on the computer.");
    }

    #get(user: User, id: string): Terminal {
        this.#require(user);
        const terminal = this.#terminals.get(id);

        if (terminal === undefined) {
            throw new HttpError(404, "No such terminal");
        }

        return terminal;
    }

    /** Open a shell in a folder on the computer (its home when the folder is elsewhere). */
    async open(
        user: User,
        request: { cwd?: unknown; cols?: unknown; rows?: unknown },
    ): Promise<{ id: string; cwd: string }> {
        this.#require(user);

        if (this.#closed) {
            throw new HttpError(503, "The server is stopping.");
        }

        if (this.#terminals.size + this.#opening >= MAX_TERMINALS) {
            throw new HttpError(409, `At most ${MAX_TERMINALS} terminals can be open.`);
        }

        const cwd =
            typeof request.cwd === "string" && onComputer(request.cwd)
                ? normalFolder(request.cwd)
                : COMPUTER_HOME;
        const id = randomUUID();
        const terminal: Terminal = {
            id,
            cwd,
            remote: undefined as unknown as RemoteTerminal,
            pieces: [],
            start: 0,
            end: 0,
            ended: undefined,
            waiters: new Set(),
            readAt: this.#now(),
        };

        this.#opening += 1;

        try {
            await this.#computer.prepare(cwd);
            terminal.remote = await this.#open({
                cwd,
                cols: size(request.cols, 80),
                rows: size(request.rows, 24),
                // The computer's daemon runs without a SHELL: bash, as a login shell, as the noid user has.
                argv: ["/bin/bash", "-l"],
                env: { TERM: "xterm-256color", SHELL: "/bin/bash" },
                onData: (bytes) => this.#append(terminal, Buffer.from(bytes)),
            });
        } finally {
            this.#opening -= 1;
        }

        // The server stopped while it opened: nothing would ever close it.
        if (this.#closed) {
            terminal.remote.exited.catch(() => {});
            terminal.remote.close();

            throw new HttpError(503, "The server is stopping.");
        }

        this.#terminals.set(id, terminal);
        terminal.remote.exited.then(
            (code) => this.#end(terminal, `exited with code ${code}`),
            (error: unknown) =>
                this.#end(
                    terminal,
                    error instanceof Error && "code" in error && error.code === "aborted"
                        ? "closed"
                        : `lost: ${error instanceof Error ? error.message : String(error)}`,
                ),
        );

        return { id, cwd };
    }

    #append(terminal: Terminal, bytes: Buffer): void {
        const last = terminal.pieces.at(-1);

        if (last !== undefined && last.length + bytes.length <= PIECE_BYTES) {
            terminal.pieces[terminal.pieces.length - 1] = Buffer.concat([last, bytes]);
        } else {
            terminal.pieces.push(bytes);
        }

        terminal.end += bytes.length;

        // Forget the oldest output past what is kept, a whole piece at a time.
        while (terminal.end - terminal.start - terminal.pieces[0]!.length >= KEEP_BYTES) {
            terminal.start += terminal.pieces.shift()!.length;
        }

        this.#wake(terminal);
    }

    #wake(terminal: Terminal): void {
        for (const wake of terminal.waiters) {
            wake();
        }

        terminal.waiters.clear();
    }

    #end(terminal: Terminal, how: string): void {
        if (terminal.ended === undefined) {
            terminal.ended = how;
            this.#wake(terminal);
        }
    }

    /**
     * Output from `from` on, waiting a while for some when there is none yet. A terminal that ended is forgotten once
     * its last output was read.
     */
    async read(user: User, id: string, from: number, signal?: AbortSignal): Promise<TerminalRead> {
        const terminal = this.#get(user, id);

        terminal.readAt = this.#now();

        if (terminal.end <= from && terminal.ended === undefined) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(done, READ_HOLD_MS);

                function done() {
                    clearTimeout(timer);
                    terminal.waiters.delete(done);
                    signal?.removeEventListener("abort", done);
                    resolve();
                }

                terminal.waiters.add(done);
                signal?.addEventListener("abort", done);
            });
        }

        terminal.readAt = this.#now();
        // What is no longer kept is skipped; an offset past the end (a terminal this tab knew before) starts over.
        const start = from > terminal.end ? terminal.start : Math.max(from, terminal.start);
        // Only the pieces from `start` on: from the newest back, most reads want the last few bytes.
        const wanted: Buffer[] = [];
        let at = terminal.end;

        for (let index = terminal.pieces.length - 1; index >= 0 && at > start; index--) {
            const piece = terminal.pieces[index]!;

            at -= piece.length;
            wanted.unshift(at >= start ? piece : piece.subarray(start - at));
        }

        if (terminal.ended !== undefined) {
            this.#terminals.delete(id);
        }

        return {
            from: start,
            next: terminal.end,
            data: Buffer.concat(wanted).toString("base64"),
            ...(terminal.ended === undefined ? {} : { ended: terminal.ended }),
        };
    }

    write(user: User, id: string, data: unknown): void {
        if (typeof data !== "string" || data.length > MAX_INPUT) {
            throw new HttpError(
                400,
                `Input must be text, up to ${MAX_INPUT} characters at a time.`,
            );
        }

        this.#get(user, id).remote.write(data);
    }

    resize(user: User, id: string, cols: unknown, rows: unknown): void {
        this.#get(user, id).remote.resize(size(cols, 80), size(rows, 24));
    }

    close(user: User, id: string): void {
        const terminal = this.#get(user, id);

        this.#terminals.delete(id);
        terminal.remote.close();
        this.#end(terminal, "closed");
    }

    /** The owner's open terminals: a tab coming back reads on in one of them. */
    list(user: User): { id: string; cwd: string }[] {
        this.#require(user);

        return [...this.#terminals.values()].map(({ id, cwd }) => ({ id, cwd }));
    }

    #closeUnread(): void {
        for (const terminal of this.#terminals.values()) {
            if (terminal.waiters.size === 0 && this.#now() - terminal.readAt > UNREAD_MS) {
                this.#terminals.delete(terminal.id);
                terminal.remote.close();
                this.#end(terminal, "closed: nobody read it");
            }
        }
    }

    /** Close every terminal, and any still opening, as the server stops. */
    closeAll(): void {
        this.#closed = true;
        clearInterval(this.#sweep);

        for (const terminal of this.#terminals.values()) {
            terminal.remote.close();
            this.#end(terminal, "closed");
        }

        this.#terminals.clear();
    }
}

/** A terminal's columns or rows, kept from 2 to 500; `fallback` when it is not a number. */
function size(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.min(500, Math.max(2, Math.round(value)))
        : fallback;
}
