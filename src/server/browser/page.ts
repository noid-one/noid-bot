/**
 * One conversation's page in the built-in browser: its events, screencast frames, console, and navigation, and what Pi
 * and people do to it.
 */
import { BrowserError, type Connection, type Json } from "./cdp.ts";
import { KEYS, keyEvents, parseKeys } from "./keys.ts";
import {
    DESCRIBE_FUNCTION,
    FILE_INPUT_SCRIPT,
    LOCATE_SCRIPT,
    KEPT_VALUE_SCRIPT,
    SELECT_ALL_SCRIPT,
    SELECT_OPTION_SCRIPT,
    SNAPSHOT_SCRIPT,
    TYPING_CLEAR_SCRIPT,
    TYPING_FIELD_SCRIPT,
    TYPING_FOCUS_BOX_SCRIPT,
    TYPING_STATE_SCRIPT,
} from "./page-scripts.ts";
import { clamp, presetOf, type Viewport, type ViewportPreset } from "./viewport.ts";
import { cutWhole } from "../cut.ts";

/** Where typing a code stands (`TYPING_STATE_SCRIPT`). */
type TypingState = {
    at: number;
    values: string[] | null;
    submitted: boolean;
    failed?: boolean;
    idle?: boolean;
};

/** What a field that may drop part of an insert kept (`KEPT_VALUE_SCRIPT`). */
type KeptValue = {
    value: string;
    number: boolean;
    limit?: number;
    password?: boolean;
    single?: boolean;
};

/** A row of code boxes (`TYPING_FIELD_SCRIPT`): what its boxes held before typing. */
type CodeRow = { box: false; field?: boolean } | { box: true; before: string[]; clicked: number };

/** A letter or digit: what codes are made of. */
const CODE_CHARACTER = /^[\p{L}\p{N}]$/u;

/**
 * How many letters and digits of `code` a row of boxes kept, -1 for all: box by box from the first box typing changed
 * (a widget may send focus back to the first empty box), else the box it began in (`from`). A row with fewer boxes,
 * boxes that kept an old code, or a box that took two does not hold it. Case aside; a box that shows a mask (•)
 * counts as kept when it changed, or when it was selected for the key (`replace`).
 */
function keptOf(
    code: readonly string[],
    values: readonly string[],
    before: readonly string[],
    from: number,
    replace: boolean,
): number {
    const changed = values.findIndex((each, index) => each !== before[index]);
    const start = changed === -1 ? from : Math.min(changed, from);

    return code.findIndex((each, index) => {
        const held = values[start + index];

        return (
            !holds(held, each) ||
            (!replace && !CODE_CHARACTER.test(held!) && held === before[start + index])
        );
    });
}

/** Whether a box holds one character of a code: that character (case aside), or a mask (•) in its place. */
function holds(held: string | undefined, character: string): boolean {
    if (held === undefined || [...held].length !== 1) {
        return false;
    }

    return !CODE_CHARACTER.test(held) || held.toLowerCase() === character.toLowerCase();
}

export type BrowserState = {
    /** A browser to run was found on this machine. */
    available: boolean;
    /** The conversation's page is open. */
    open: boolean;
    url: string;
    title: string;
    loading: boolean;
    viewport: Viewport;
    preset?: ViewportPreset;
    canGoBack: boolean;
    canGoForward: boolean;
    /** Console errors since the page last loaded. */
    errors: number;
    /** How many console lines there are, to know when to fetch them again. */
    logs: number;
    /** Why the page could not open, or that it crashed. */
    problem?: string;
};

export type LogEntry = { seq: number; at: number; level: string; text: string; source?: string };

export type Frame = { seq: number; data: Buffer; width: number; height: number };

/** Where Pi points: a ref from the last snapshot, a CSS selector, visible text, or a point. */
export type Target = { ref?: string; selector?: string; label?: string; x?: number; y?: number };

export type Saved = { url?: string; viewport?: Viewport };

const MAX_LOGS = 300;
/** Frame numbers, for every page: a page opened again goes on from where the last one was. */
let frameCount = 0;
/** At most one screencast frame per this many milliseconds. */
const FRAME_GAP_MS = 40;
/** Frames stop this long after the last viewer asked for one. */
const WATCH_MS = 15_000;
const FRAME_WAIT_MS = 25_000;
/**
 * Across sites, a navigation moves the page to a new process, and for a moment Chromium refuses commands without running
 * them. These ones are sent again then, for up to `SWAP_WAIT_MS` (the last try still gets the command's own timeout):
 * reloading and stopping act on whatever document is there. Others are not: a script, a selection, or a place to click
 * meant for the old document must not act on the new one, and a navigation sent again could overtake a newer one.
 */
const RETRY_WHILE_SWAPPING = new Set(["Page.reload", "Page.stopLoading"]);
const SWAP_WAIT_MS = 3000;

/**
 * The longest side of a screenshot's image, in pixels. Models refuse larger images once a conversation holds many of
 * them, and that refusal breaks every turn after it; they shrink anything past about 1600 pixels themselves anyway.
 */
export const SHOT_MAX = 2000;

/** The scale that brings an image of `width` × `height` pixels within `SHOT_MAX`. */
const fit = (width: number, height: number) => Math.min(1, SHOT_MAX / Math.max(width, height, 1));

/** A console argument as text: strings as they are, other values as DevTools would show them in one line. */
function formatArg(arg: Json): string {
    if (arg === undefined || arg === null) {
        return "";
    }

    if (arg.type === "string") {
        return String(arg.value);
    }

    if (arg.type === "undefined") {
        return "undefined";
    }

    if (arg.unserializableValue !== undefined) {
        return String(arg.unserializableValue);
    }

    if (Object.hasOwn(arg, "value")) {
        return JSON.stringify(arg.value);
    }

    const preview = arg.preview;

    if (preview !== undefined && Array.isArray(preview.properties)) {
        const items = preview.properties.map((property: Json) =>
            preview.subtype === "array" ? property.value : `${property.name}: ${property.value}`,
        );
        const body = `${items.join(", ")}${preview.overflow ? ", …" : ""}`;

        return preview.subtype === "array"
            ? `[${body}]`
            : `${arg.className && arg.className !== "Object" ? `${arg.className} ` : ""}{${body}}`;
    }

    return String(arg.description ?? arg.className ?? arg.type);
}

export const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function aborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new BrowserError("Stopped.");
    }
}

/** A page script's result, or its exception as an error. */
function evaluated(response: Json): Json {
    if (response.exceptionDetails !== undefined) {
        const details = response.exceptionDetails;
        const message =
            details.exception?.description ??
            details.exception?.value ??
            details.text ??
            "The script failed";

        throw new BrowserError(String(message).split("\n    at ")[0] ?? "The script failed");
    }

    return response.result?.value;
}

/** One conversation's page. Everything it knows comes from the browser's events; nothing here is stored. */
export class BrowserPage {
    readonly conversationId: number;
    readonly #connection: Connection;
    readonly #session: string;
    readonly #target: string;
    readonly #context: string;
    readonly #shared: boolean;
    readonly #baseAgent: string;
    readonly #ownAgent: boolean;
    readonly #native: boolean;
    readonly #changed: () => void;
    readonly #saved: (saved: Saved) => void;
    #frameId = "";
    #url = "about:blank";
    #title = "";
    #loading = false;
    #starts = 0;
    #stops = 0;
    readonly #stopWaiters = new Set<() => void>();
    #viewport: Viewport;
    #canGoBack = false;
    #canGoForward = false;
    #logs: LogEntry[] = [];
    #logSeq = 0;
    #errors = 0;
    #crashed = false;
    #closed = false;
    #frame: Frame | undefined;
    readonly #frameWaiters = new Set<() => void>();
    #watchers = 0;
    #watchedAt = 0;
    #casting = false;
    #castTimer: NodeJS.Timeout | undefined;
    #historyTimer: NodeJS.Timeout | undefined;
    #saveTimer: NodeJS.Timeout | undefined;
    /** Last time Pi or a person used this page; idle pages close. */
    usedAt = Date.now();
    readonly #popups = new Map<string, NodeJS.Timeout>();
    /** Tabs already sent here or closed, until the browser says they are gone: their later updates change nothing. */
    readonly #handled = new Set<string>();

    constructor(options: {
        conversationId: number;
        connection: Connection;
        session: string;
        target: string;
        context: string;
        userAgent: string;
        /** `userAgent` is the browser's own, so a desktop page needs no override (one would empty its client hints). */
        ownAgent?: boolean;
        /**
         * noid: a tab in a window people see (the computer's desktop browser): at desktop size it is the window's own,
         * as a size set here would leave the page cut off or shrunk in that window.
         */
        native?: boolean;
        viewport: Viewport;
        changed: () => void;
        saved: (saved: Saved) => void;
        /**
         * noid: the page is a window in a browser context other conversations' windows share (the shared computer's
         * one browser, logins and all), so only windows it opened itself are its popups.
         */
        shared?: boolean;
    }) {
        this.conversationId = options.conversationId;
        this.#connection = options.connection;
        this.#session = options.session;
        this.#target = options.target;
        this.#context = options.context;
        this.#shared = options.shared === true;
        this.#baseAgent = options.userAgent;
        this.#ownAgent = options.ownAgent === true;
        this.#native = options.native === true;
        this.#viewport = options.viewport;
        this.#changed = options.changed;
        this.#saved = options.saved;
        this.#connection.listen(this.#session, (method, params) => this.#event(method, params));
    }

    get targetId(): string {
        return this.#target;
    }

    /** noid: whether the page is a window in a shared browser context (closed by itself, not with its context). */
    get shared(): boolean {
        return this.#shared;
    }

    get contextId(): string {
        return this.#context;
    }

    get closed(): boolean {
        return this.#closed || this.#connection.closed;
    }

    get url(): string {
        return this.#url;
    }

    get title(): string {
        return this.#title;
    }

    get viewport(): Viewport {
        return { ...this.#viewport };
    }

    /** Send a command to the page; a reload or stop again while a navigation swaps its document (`RETRY_WHILE_SWAPPING`). */
    async #send(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number,
    ): Promise<Json> {
        const started = Date.now();

        for (;;) {
            if (this.#closed) {
                throw new BrowserError("This page is closed.");
            }

            try {
                return await this.#connection.send(method, params, this.#session, timeoutMs);
            } catch (error) {
                if (
                    !(error instanceof BrowserError) ||
                    error.message !== "Not attached to an active page" ||
                    !RETRY_WHILE_SWAPPING.has(method) ||
                    Date.now() - started > SWAP_WAIT_MS
                ) {
                    throw error;
                }

                await wait(25);
            }
        }
    }

    async init(): Promise<void> {
        await Promise.all([
            this.#send("Page.enable"),
            this.#send("Runtime.enable"),
            this.#send("Log.enable"),
        ]);
        const tree = await this.#send("Page.getFrameTree");

        this.#frameId = String(tree.frameTree?.frame?.id ?? "");
        await this.#applyViewport();
    }

    state(available: boolean): BrowserState {
        return {
            available,
            open: !this.closed,
            url: this.#url,
            title: this.#title,
            loading: this.#loading,
            viewport: { ...this.#viewport },
            ...(presetOf(this.#viewport) === undefined ? {} : { preset: presetOf(this.#viewport) }),
            canGoBack: this.#canGoBack,
            canGoForward: this.#canGoForward,
            errors: this.#errors,
            logs: this.#logSeq,
            ...(this.#crashed ? { problem: "The page crashed. Reload it." } : {}),
        };
    }

    // ─── Events ─────────────────────────────────────────────────────────────

    #event(method: string, params: Json): void {
        switch (method) {
            case "Page.frameNavigated": {
                const frame = params.frame;

                if (frame === undefined || frame.parentId !== undefined) {
                    return;
                }

                this.#frameId = frame.id;
                // A page that failed to load shows Chromium's error page; the address is still the one asked for.
                this.#url = String(
                    frame.unreachableUrl ?? `${frame.url}${frame.urlFragment ?? ""}`,
                );
                this.#errors = 0;
                this.#crashed = false;
                this.#log("nav", this.#url);
                this.#navigated();

                return;
            }

            case "Page.navigatedWithinDocument":
                if (params.frameId !== this.#frameId) {
                    return;
                }

                this.#url = String(params.url);
                this.#navigated();

                return;
            case "Page.frameStartedLoading":
                if (params.frameId !== this.#frameId) {
                    return;
                }

                this.#starts++;

                if (this.#loading) {
                    return;
                }

                this.#loading = true;
                this.#changed();

                return;
            case "Page.frameStoppedLoading":
                if (params.frameId !== this.#frameId) {
                    return;
                }

                this.#loading = false;
                this.#stops++;

                for (const wake of this.#stopWaiters) {
                    wake();
                }

                this.#stopWaiters.clear();
                this.#changed();

                return;

            case "Page.javascriptDialogOpening": {
                // Nobody can answer a dialog in a headless page, and it would stop the page: accept it, and say so.
                this.#log("dialog", `${params.type}: ${params.message}`);
                void this.#send("Page.handleJavaScriptDialog", {
                    accept: true,
                    ...(params.type === "prompt"
                        ? { promptText: String(params.defaultPrompt ?? "") }
                        : {}),
                }).catch(() => {});

                return;
            }

            case "Page.screencastFrame":
                this.#onFrame(params);

                return;

            case "Runtime.consoleAPICalled": {
                const level =
                    params.type === "warning"
                        ? "warn"
                        : params.type === "assert"
                          ? "error"
                          : String(params.type);

                if (level === "clear") {
                    return;
                }

                const frame = params.stackTrace?.callFrames?.[0];

                this.#log(
                    level,
                    (params.args ?? []).map(formatArg).join(" "),
                    frame === undefined ? undefined : `${frame.url}:${frame.lineNumber + 1}`,
                );

                return;
            }

            case "Runtime.exceptionThrown": {
                const details = params.exceptionDetails ?? {};
                const text =
                    String(
                        details.exception?.description ?? details.text ?? "Uncaught error",
                    ).split("\n    at ")[0] ?? "";

                this.#log(
                    "error",
                    text.startsWith("Uncaught") ? text : `Uncaught ${text}`,
                    details.url ? `${details.url}:${(details.lineNumber ?? 0) + 1}` : undefined,
                );

                return;
            }

            case "Log.entryAdded": {
                const entry = params.entry ?? {};

                // The browser asks every site for an icon by itself; most dev servers have none. Not the page's error.
                if (
                    entry.source === "network" &&
                    /\/favicon\.ico([?#]|$)/.test(String(entry.url ?? ""))
                ) {
                    return;
                }

                const level =
                    entry.level === "warning"
                        ? "warn"
                        : entry.level === "verbose"
                          ? "debug"
                          : String(entry.level ?? "info");

                this.#log(
                    level,
                    String(entry.text ?? ""),
                    entry.url ? String(entry.url) : undefined,
                );

                return;
            }

            case "Inspector.targetCrashed":
                this.#crashed = true;
                this.#loading = false;
                this.#changed();

                return;
        }
    }

    /** The browser's own events about this page's target, and popups it opened. */
    targetEvent(method: string, info: Json): void {
        if (info?.targetId === this.#target) {
            if (method === "Target.targetInfoChanged") {
                const title = String(info.title ?? "");
                // Until a page has a title, Chromium reports its address as one.
                const next =
                    title === info.url || title === this.#url.replace(/^https?:\/\//, "")
                        ? ""
                        : title;

                if (next !== this.#title) {
                    this.#title = next;
                    this.#changed();
                }
            }

            return;
        }

        const id = String(info?.targetId);

        // The browser says only which tab is gone.
        if (method === "Target.targetDestroyed") {
            clearTimeout(this.#popups.get(id));
            this.#popups.delete(id);
            this.#handled.delete(id);

            return;
        }

        if (info?.type !== "page" || info.browserContextId !== this.#context) {
            return;
        }

        // Pages the browser prerenders on a site's hint are its guesses, not tabs; and only this page's tabs come here.
        // In a shared context another conversation's new window has no opener either: only this page's own count.
        if (
            (info.subtype ?? "") !== "" ||
            (info.openerId !== undefined && info.openerId !== this.#target) ||
            (this.#shared && info.openerId !== this.#target) ||
            this.#handled.has(id)
        ) {
            return;
        }

        // One page per conversation: a popup or new tab opens here instead, once it has an address.
        const url = String(info.url ?? "");

        if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
            if (!this.#popups.has(id)) {
                const timer = setTimeout(() => this.#closePopup(id), 5000);

                timer.unref();
                this.#popups.set(id, timer);
            }

            if (url !== "" && url !== "about:blank") {
                this.#closePopup(id);
                // Opened from here, the address would skip the browser's own rules (a web page may not open a file): only
                // web addresses follow, and files from a page that is a file itself.
                const web =
                    /^https?:/i.test(url) || (/^file:/i.test(url) && /^file:/i.test(this.#url));

                if (web) {
                    void this.navigate(url, { wait: false }).catch(() => {});
                } else {
                    this.#log("warn", `A new tab for ${url} was not opened.`);
                }
            }
        }
    }

    #closePopup(targetId: string): void {
        clearTimeout(this.#popups.get(targetId));
        this.#popups.delete(targetId);
        this.#handled.add(targetId);
        void this.#connection.send("Target.closeTarget", { targetId }).catch(() => {});
    }

    #log(level: string, text: string, source?: string): void {
        const entry: LogEntry = {
            seq: ++this.#logSeq,
            at: Date.now(),
            level,
            text: text.length > 2000 ? `${cutWhole(text, 1999)}…` : text,
            ...(source === undefined || source === "" ? {} : { source }),
        };

        this.#logs.push(entry);

        if (this.#logs.length > MAX_LOGS) {
            this.#logs.splice(0, this.#logs.length - MAX_LOGS);
        }

        if (level === "error") {
            this.#errors++;
        }

        this.#changed();
    }

    #navigated(): void {
        this.#changed();
        clearTimeout(this.#historyTimer);
        this.#historyTimer = setTimeout(() => void this.#refreshHistory(), 50);
        this.#historyTimer.unref();
        clearTimeout(this.#saveTimer);
        this.#saveTimer = setTimeout(() => this.#save(), 1000);
        this.#saveTimer.unref();
    }

    #save(): void {
        if (this.#closed) {
            return;
        }

        const url = this.#url;

        this.#saved({
            ...(url === "about:blank" || url.startsWith("chrome-error:") ? {} : { url }),
            viewport: { ...this.#viewport },
        });
    }

    async #refreshHistory(): Promise<void> {
        try {
            const history = await this.#send("Page.getNavigationHistory");
            const back = history.currentIndex > 0;
            const forward = history.currentIndex < history.entries.length - 1;
            const entry = history.entries[history.currentIndex];
            // A page without a title has its address as one.
            const title =
                entry === undefined || entry.title === entry.url ? "" : String(entry.title ?? "");

            if (
                back !== this.#canGoBack ||
                forward !== this.#canGoForward ||
                title !== this.#title
            ) {
                this.#canGoBack = back;
                this.#canGoForward = forward;
                this.#title = title;
                this.#changed();
            }
        } catch {
            // Closed meanwhile.
        }
    }

    // ─── Frames for the Browser panel ─────────────────────────────────────

    #onFrame(params: Json): void {
        const meta = params.metadata ?? {};

        this.#frame = {
            seq: ++frameCount,
            data: Buffer.from(String(params.data ?? ""), "base64"),
            width: Math.round(meta.deviceWidth ?? this.#viewport.width),
            height: Math.round(meta.deviceHeight ?? this.#viewport.height),
        };

        for (const wake of this.#frameWaiters) {
            wake();
        }

        this.#frameWaiters.clear();
        // The next frame comes after this one is acknowledged: acknowledging a little later caps the frame rate.
        const timer = setTimeout(() => {
            if (this.#casting) {
                void this.#send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(
                    () => {},
                );
            }
        }, FRAME_GAP_MS);

        timer.unref();
    }

    async #startCast(): Promise<void> {
        if (this.#casting || this.closed) {
            return;
        }

        this.#casting = true;
        const scale = Math.min(this.#viewport.scale, 2);

        try {
            await this.#send("Page.startScreencast", {
                format: "jpeg",
                quality: 65,
                maxWidth: Math.round(this.#viewport.width * scale),
                maxHeight: Math.round(this.#viewport.height * scale),
            });
        } catch {
            this.#casting = false;

            return;
        }

        clearInterval(this.#castTimer);
        this.#castTimer = setInterval(() => {
            if (this.#watchers === 0 && Date.now() - this.#watchedAt > WATCH_MS) {
                void this.#stopCast();
            }
        }, 5000);
        this.#castTimer.unref();
    }

    async #stopCast(): Promise<void> {
        clearInterval(this.#castTimer);
        this.#castTimer = undefined;

        if (!this.#casting) {
            return;
        }

        this.#casting = false;
        await this.#send("Page.stopScreencast").catch(() => {});
    }

    /** The newest frame after `after`, waiting for one up to 25 seconds; undefined if none came. */
    async frame(after: number, signal?: AbortSignal): Promise<Frame | undefined> {
        // A number from before a restart: this tab has none of these frames.
        if (after > frameCount) {
            after = 0;
        }

        this.#watchedAt = Date.now();
        this.usedAt = Date.now();
        this.#watchers++;

        try {
            await this.#startCast();

            if (this.#frame !== undefined && this.#frame.seq > after) {
                return this.#frame;
            }

            if (this.closed) {
                return undefined;
            }

            await new Promise<void>((done) => {
                const finish = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", finish);
                    this.#frameWaiters.delete(finish);
                    done();
                };

                const timer = setTimeout(finish, FRAME_WAIT_MS);

                signal?.addEventListener("abort", finish, { once: true });
                this.#frameWaiters.add(finish);
            });

            return this.#frame !== undefined && this.#frame.seq > after ? this.#frame : undefined;
        } finally {
            this.#watchers--;
            this.#watchedAt = Date.now();
        }
    }

    /**
     * Taps, drags, scrolls, and keys from the Browser panel, in order: `click`, `mouse` (down, up, or move), `wheel`, `key`,
     * and `text`, at CSS pixels of the viewport. They come from browsers, so each is checked as it is read.
     */
    async input(events: readonly unknown[]): Promise<void> {
        this.usedAt = Date.now();
        const { width, height } = this.#viewport;
        const point = (raw: Record<string, unknown>) => ({
            x: clamp(Number(raw.x) || 0, 0, width),
            y: clamp(Number(raw.y) || 0, 0, height),
        });
        const button = (raw: unknown) => (raw === "right" || raw === "middle" ? raw : "left");

        for (const item of events) {
            if (typeof item !== "object" || item === null) {
                continue;
            }

            const event = item as Record<string, unknown>;

            switch (event.type) {
                case "click":
                    await this.#click(
                        point(event),
                        button(event.button),
                        clamp(Number(event.count) || 1, 1, 3),
                    );
                    break;

                case "mouse": {
                    const at = point(event);
                    const pressed = button(event.button);
                    const type =
                        event.action === "down"
                            ? "mousePressed"
                            : event.action === "up"
                              ? "mouseReleased"
                              : "mouseMoved";
                    const count = clamp(Number(event.count) || 1, 1, 3);

                    await this.#send("Input.dispatchMouseEvent", {
                        type,
                        ...at,
                        button: type === "mouseMoved" && event.pressed !== true ? "none" : pressed,
                        buttons: event.pressed === true || type === "mousePressed" ? 1 : 0,
                        clickCount: type === "mouseMoved" ? 0 : count,
                    });
                    break;
                }

                case "wheel":
                    await this.#send("Input.dispatchMouseEvent", {
                        type: "mouseWheel",
                        ...point(event),
                        deltaX: clamp(Number(event.dx) || 0, -5000, 5000),
                        deltaY: clamp(Number(event.dy) || 0, -5000, 5000),
                    });
                    break;

                case "key": {
                    const key = String(event.key ?? "");

                    if (
                        key === "" ||
                        key === "Unidentified" ||
                        key === "Dead" ||
                        key === "Process"
                    ) {
                        break;
                    }

                    if (key.length !== 1 && KEYS[key] === undefined) {
                        break;
                    }

                    await this.#key(key, clamp(Number(event.modifiers) || 0, 0, 15));
                    break;
                }

                case "text": {
                    const text = String(event.text ?? "").slice(0, 10_000);

                    if (text !== "") {
                        await this.#send("Input.insertText", { text });
                    }

                    break;
                }
            }
        }
    }

    async #click(at: { x: number; y: number }, button: string, count: number): Promise<void> {
        await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, button: "none" });

        for (let index = 1; index <= count; index++) {
            await this.#send("Input.dispatchMouseEvent", {
                type: "mousePressed",
                ...at,
                button,
                buttons: 1,
                clickCount: index,
            });
            await this.#send("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                ...at,
                button,
                buttons: 0,
                clickCount: index,
            });
        }
    }

    async #key(key: string, modifiers: number): Promise<void> {
        const { down, up } = keyEvents(key, modifiers);

        await this.#send("Input.dispatchKeyEvent", down);
        await this.#send("Input.dispatchKeyEvent", up);
    }

    // ─── Navigation ───────────────────────────────────────────────────────────

    /** Where loading stands before an action, to tell the loads it started from those already going on. */
    #mark(): { starts: number; stops: number } {
        return { starts: this.#starts, stops: this.#stops };
    }

    /**
     * Wait for the load an action started, until it stops; false when that took longer than `timeoutMs`. A load that was
     * going on before (a request that never ends) does not count. With `started`, the action surely started one.
     */
    async #settle(
        mark: { starts: number; stops: number },
        timeoutMs: number,
        signal?: AbortSignal,
        started = false,
    ): Promise<boolean> {
        if (!started) {
            // A navigation a click starts begins a moment later.
            await wait(150);

            if (this.#starts === mark.starts) {
                return true;
            }
        }

        if (this.#stops > mark.stops && !this.#loading) {
            return true;
        }

        return new Promise((done) => {
            const finish = (ok: boolean) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", stop);
                this.#stopWaiters.delete(wake);
                done(ok);
            };

            const wake = () => finish(true);
            const stop = () => finish(false);
            const timer = setTimeout(stop, timeoutMs);

            signal?.addEventListener("abort", stop, { once: true });
            this.#stopWaiters.add(wake);
        });
    }

    /**
     * Open an address. With `wait`, until it has loaded (or `timeoutMs` passed); without, only as long as it takes to
     * hear whether it failed at once (nothing answers there), at most a few seconds. The result says how it went.
     */
    async navigate(
        url: string,
        options: { wait?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<{ error?: string; status?: number; slow?: boolean }> {
        this.usedAt = Date.now();
        const mark = this.#mark();
        const budget = options.wait === false ? 3000 : (options.timeoutMs ?? 30_000);
        // The browser answers once the page starts to arrive: a server that never responds keeps it waiting, while the
        // navigation goes on.
        const answer = this.#send("Page.navigate", { url }, 120_000);

        answer.catch(() => {});
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<undefined>((done) => {
            timer = setTimeout(() => done(undefined), budget);
        });
        const result = await Promise.race([answer, late]).finally(() => clearTimeout(timer));

        if (result === undefined) {
            return options.wait === false ? {} : { slow: true };
        }

        if (result.errorText) {
            return { error: String(result.errorText) };
        }

        if (options.wait === false || result.loaderId === undefined) {
            return {};
        }

        const loaded = await this.#settle(mark, options.timeoutMs ?? 30_000, options.signal, true);

        aborted(options.signal);
        // Apps fetch their data after the load event; give them a moment.
        await wait(300);
        const status = await this.#send("Runtime.evaluate", {
            expression: `performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0`,
            returnByValue: true,
        }).then(evaluated, () => 0);

        return {
            ...(typeof status === "number" && status > 0 ? { status } : {}),
            ...(loaded ? {} : { slow: true }),
        };
    }

    async go(
        delta: -1 | 1,
        options: { wait?: boolean; signal?: AbortSignal } = {},
    ): Promise<boolean> {
        this.usedAt = Date.now();
        const history = await this.#send("Page.getNavigationHistory");
        const entry = history.entries?.[history.currentIndex + delta];

        if (entry === undefined) {
            return false;
        }

        const mark = this.#mark();

        await this.#send("Page.navigateToHistoryEntry", { entryId: entry.id });

        if (options.wait !== false) {
            await this.#settle(mark, 30_000, options.signal);
        }

        return true;
    }

    async reload(options: { wait?: boolean; signal?: AbortSignal } = {}): Promise<void> {
        this.usedAt = Date.now();
        this.#crashed = false;
        const mark = this.#mark();

        await this.#send("Page.reload", { ignoreCache: false });

        if (options.wait !== false) {
            await this.#settle(mark, 30_000, options.signal, true);
        }
    }

    async stop(): Promise<void> {
        await this.#send("Page.stopLoading");
    }

    async #applyViewport(): Promise<void> {
        const viewport = this.#viewport;
        const agent = viewport.mobile
            ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${/Chrome\/([\d.]+)/.exec(this.#baseAgent)?.[1] ?? "130.0.0.0"} Mobile Safari/537.36`
            : this.#ownAgent
              ? ""
              : this.#baseAgent;

        await Promise.all([
            this.#native && !viewport.mobile
                ? this.#send("Emulation.clearDeviceMetricsOverride")
                : this.#send("Emulation.setDeviceMetricsOverride", {
                      width: viewport.width,
                      height: viewport.height,
                      deviceScaleFactor: viewport.scale,
                      mobile: viewport.mobile,
                  }),
            this.#send("Emulation.setTouchEmulationEnabled", {
                enabled: viewport.mobile,
                maxTouchPoints: viewport.mobile ? 5 : 1,
            }),
            // An empty agent clears an earlier (mobile) override; any override without metadata empties
            // navigator.userAgentData and the Sec-CH-UA headers, which sites such as X read as a bot.
            this.#baseAgent === ""
                ? Promise.resolve()
                : this.#send("Emulation.setUserAgentOverride", { userAgent: agent }),
        ]);
    }

    async setViewport(viewport: Viewport): Promise<void> {
        this.usedAt = Date.now();
        this.#viewport = { ...viewport };
        await this.#applyViewport();

        if (this.#casting) {
            await this.#stopCast();
            await this.#startCast();
        }

        this.#changed();
        this.#save();
    }

    // ─── What Pi does ─────────────────────────────────────────────────────────

    async #evaluate(expression: string, timeoutMs = 15_000): Promise<Json> {
        return evaluated(
            await this.#send(
                "Runtime.evaluate",
                { expression, returnByValue: true, awaitPromise: true, userGesture: true },
                timeoutMs,
            ),
        );
    }

    /** Where a target is on screen, scrolled into view. */
    async locate(
        target: Target,
    ): Promise<{ x: number; y: number; label: string; covered?: string; editable?: boolean }> {
        if (typeof target.x === "number" && typeof target.y === "number") {
            return {
                x: target.x,
                y: target.y,
                label: `the point ${Math.round(target.x)},${Math.round(target.y)}`,
            };
        }

        if (
            target.ref === undefined &&
            target.selector === undefined &&
            target.label === undefined
        ) {
            throw new BrowserError(
                "Say what to act on: a ref from the snapshot, a selector, a label, or x and y.",
            );
        }

        return await this.#evaluate(`(${LOCATE_SCRIPT})(${JSON.stringify(target)})`);
    }

    async click(
        target: Target,
        options: { count?: number; signal?: AbortSignal } = {},
    ): Promise<{ label: string; covered?: string; navigated: boolean }> {
        this.usedAt = Date.now();
        const found = await this.locate(target);
        const url = this.#url;
        const mark = this.#mark();

        await this.#click({ x: found.x, y: found.y }, "left", options.count ?? 1);
        await this.#settle(mark, 10_000, options.signal);

        return {
            label: found.label,
            ...(found.covered === undefined ? {} : { covered: found.covered }),
            navigated: this.#url !== url,
        };
    }

    async hover(target: Target): Promise<string> {
        this.usedAt = Date.now();
        const found = await this.locate(target);

        await this.#send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: found.x,
            y: found.y,
            button: "none",
        });
        await wait(150);

        return found.label;
    }

    /**
     * Type into a target (clicking it first), or into what has focus. Replaces what the field holds unless `append`.
     * Returns what it typed into, and with `submit`, whether the page submitted a code itself (Enter is then not
     * pressed, but its load is waited for as Enter's would be).
     */
    async type(
        target: Target | undefined,
        text: string,
        options: { append?: boolean; submit?: boolean; signal?: AbortSignal } = {},
    ): Promise<{ label: string; pageSubmitted: boolean; note?: string }> {
        this.usedAt = Date.now();
        let label = "the focused element";
        let note: string | undefined;
        let clicked = false;

        if (
            target !== undefined &&
            (target.ref ?? target.selector ?? target.label ?? target.x) !== undefined
        ) {
            const found = await this.locate(target);

            await this.#click({ x: found.x, y: found.y }, "left", 1);
            label = found.label;
            clicked = true;
        }

        // Only a code of more than one character can need keys. A page that is going away (the click started a
        // navigation) types as before: one insert.
        const field = async () =>
            (await this.#evaluate(TYPING_FIELD_SCRIPT).catch(() => ({ box: false }))) as CodeRow;
        let row: CodeRow = text.length > 1 ? await field() : { box: false };

        // A code's widget may send focus on after the click (to its first empty box, or to a hidden field behind the
        // boxes) on a timer: it gets a moment first, unless the click landed in a plain field (most typing).
        if (clicked && text.length > 1 && !(row.box === false && row.field === true)) {
            await wait(30);
            row = await field();
        }

        // A code's row is selected box by box as it is typed (`#typeCode`).
        if (options.append !== true && !row.box) {
            const field = await this.#evaluate(SELECT_ALL_SCRIPT);

            // Some fields (email, number) cannot be selected by script: the editor's select-all works on them.
            if (field === "keys") {
                await this.#key("a", 2);
            }

            if ((field === "selected" || field === "keys") && text === "") {
                await this.#key("Backspace", 0);
            }
        }

        // Code fields with a box per character take keys one at a time, as focus moves along; every other field takes
        // the text in one insert. A code the page took itself (a form submitted, a load started, or the row emptied or
        // gone) was submitted by the page: Enter would send it again.
        let submitted = false;
        // Where loading stood before typing: a code whose page submits it starts a load that Enter's wait would see.
        const mark = this.#mark();

        if (row.box) {
            submitted = await this.#typeCode(
                text,
                label,
                row,
                options.append !== true,
                mark,
                options.submit === true,
                options.signal,
            );
        } else if (text !== "") {
            await this.#send("Input.insertText", { text });

            // A field that drops part of the text says so rather than keep it silently: a number field what is not a
            // number ("12a" leaves "12"; spaces aside, and the same number written another way is what was typed), a
            // field with a length limit what goes past it. The field was noted as select-all ran. It is a note, not an
            // error: the text went in as before, and Enter still follows with submit (neither upstream checks plain
            // fields; a page may clamp or cut on purpose).
            if (options.append !== true) {
                const kept = (await this.#evaluate(KEPT_VALUE_SCRIPT).catch(
                    () => null,
                )) as KeptValue | null;

                if (kept !== null) {
                    // A field may format what it keeps: only text cut at the limit counts, as the field takes it (a
                    // one-line field makes each line break a space; spaces at the end are nothing to keep, but in a
                    // password, where they are part of it), in the units its limit counts (an emoji is two). A mask
                    // that keeps all but punctuation and spaces (a phone number without its dashes) cut nothing.
                    const lines = kept.single === true ? text.replace(/\r\n|[\r\n]/g, " ") : text;
                    const taken = kept.password === true ? lines : lines.trimEnd();
                    // What is left once punctuation, spaces, and currency and math signs ($, +), which masks add or drop, are
                    // taken out (an emoji stays); all of a password.
                    const code = (value: string) =>
                        kept.password === true
                            ? value
                            : value.replace(/[\p{P}\p{Z}\p{Sc}\p{Sm}\s]/gu, "");
                    const cut =
                        !kept.number &&
                        kept.limit !== undefined &&
                        taken.length > kept.limit &&
                        kept.value.length < taken.length &&
                        code(kept.value) !== code(taken);
                    // A field with no limit that kept one letter or digit of several, the first or the last: a box per
                    // character with no maxlength (a chip, or a mask that drops a country code, keeps more than one).
                    const letters = (value: string) =>
                        value.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
                    const lost =
                        !kept.number &&
                        kept.limit === undefined &&
                        [...letters(kept.value)].length === 1 &&
                        [...letters(taken)].length > 1 &&
                        (letters(taken).startsWith(letters(kept.value)) ||
                            letters(taken).endsWith(letters(kept.value)));
                    const typed = text.replace(/\s+/g, "");
                    const dropped =
                        kept.number &&
                        kept.value !== typed &&
                        !(kept.value !== "" && Number(kept.value) === Number(typed));

                    if (lost) {
                        note = `${label} kept ${
                            kept.password === true
                                ? `${String(kept.value.length)} of ${String(taken.length)} characters`
                                : `"${kept.value}" of "${text}"`
                        }: a field per character may need a key at a time (press each).`;
                    } else if (cut || dropped) {
                        note = kept.number
                            ? `${label} is a number field: it kept "${kept.value}" of "${text}".`
                            : `${label} takes ${String(kept.limit)} ${kept.limit === 1 ? "character" : "characters"}: it kept ${
                                  // A password is not repeated: only how much of it went in.
                                  kept.password === true
                                      ? `${String(kept.value.length)} of ${String(taken.length)}`
                                      : `"${kept.value}" of "${text}"`
                              }.`;
                    }
                }
            }
        }

        // A code the page submitted itself: Enter would send it again. Its load is waited for as Enter's would be.
        if (submitted) {
            await this.#settle(mark, 10_000, options.signal);
        } else if (options.submit === true) {
            const before = this.#mark();

            // A code's widget may leave no box focused after the last digit (it drew them again): Enter goes to the
            // last box, as it would from a person who typed the code there.
            if (row.box && (await this.#typingState(false)).idle === true) {
                await this.#evaluate(
                    `(${TYPING_FOCUS_BOX_SCRIPT})(${String(row.before.length - 1)})`,
                ).catch(() => false);
            }

            await this.#key("Enter", 0);
            await this.#settle(before, 10_000, options.signal);
        }

        return { label, pageSubmitted: submitted, ...(note === undefined ? {} : { note }) };
    }

    /**
     * Where typing a code stands (`TYPING_STATE_SCRIPT`), selecting the focused box's text first with `select`. A page
     * that could not be read comes back `failed`, with focus gone (`#typeCode` decides what that means).
     */
    async #typingState(select: boolean): Promise<TypingState> {
        const state = await this.#evaluate(`(${TYPING_STATE_SCRIPT})(${String(select)})`).catch(
            () => undefined,
        );

        return (
            (state as TypingState | undefined) ?? {
                at: -1,
                values: null,
                submitted: false,
                failed: true,
            }
        );
    }

    /**
     * Types a code into a row of one-character boxes, a key per letter or digit (a code written "123 456" fills six
     * boxes; a space or dash pressed would take a box, or a line break submit the form), stopping if focus leaves the
     * row's boxes or the run stops. With `replace`, each box's text is selected as focus reaches it, so the code
     * replaces an old one. `before` is what the boxes held, `clicked` the box clicked; `mark`, where loading stood before. True when the page took
     * the code itself: a form was submitted, a load started, or the row emptied after the last key or left the page.
     * With `enter` (Enter follows), it waits up to 300 ms for that first. A read that fails with no load started, or a
     * page that submits before the code's end, is an error.
     */
    async #typeCode(
        text: string,
        label: string,
        { before, clicked }: { before: string[]; clicked: number },
        replace: boolean,
        mark: { starts: number; stops: number },
        enter: boolean,
        signal?: AbortSignal,
    ): Promise<boolean> {
        const code = [...text].filter((each) => CODE_CHARACTER.test(each));

        if (code.length === 0) {
            throw new BrowserError(
                `Nothing was typed into ${label}: its boxes take letters and digits, and "${text}" has none.`,
            );
        }

        // Whether the page took the code: a form submitted, a load started, or the row gone. A page that could not be
        // read is that only when a load started; otherwise the read failed, and nothing can be said.
        const movedOn = (now: TypingState) => {
            if (now.failed === true && this.#starts === mark.starts) {
                throw new BrowserError(`Could not read the page while typing into ${label}.`);
            }

            return now.submitted || now.values === null || this.#starts !== mark.starts;
        };

        // A code longer than its row: the boxes would keep the wrong part of it, or the page send that. Nothing is typed.
        // The boxes the code takes: from the one clicked, or from the row's first for a code as long as the row
        // (wherever the widget sent focus since).
        const from = code.length >= before.length ? 0 : Math.max(0, clicked);

        // A code longer than the boxes from there on: they would keep the wrong part of it, or the page send that.
        if (code.length > before.length - from) {
            throw new BrowserError(
                `Nothing was typed into ${label}: the code has ${String(code.length)} letters and digits, and its row ${String(before.length - from)} boxes${from > 0 ? ` from the one clicked on` : ""}.`,
            );
        }

        // Replacing clears the row from there to its end: a shorter code would otherwise leave old digits after it,
        // which a widget that sends once every box is full would send with it. Boxes before it are left (a code typed
        // in two parts).
        const taken = (values: string[] | null) => values?.slice(from) ?? [];

        // Replacing a code: the old one goes first, so the page never holds old digits with new ones (a widget that
        // sends once every box is full would send them). As edits, then, for a widget that puts values back, with
        // Backspace from the last of them; a code that still cannot be cleared is not typed over.
        if (replace && taken(before).some((each) => each !== "")) {
            await this.#evaluate(
                `(${TYPING_CLEAR_SCRIPT})(${String(from)}, ${String(before.length - from)})`,
            ).catch(() => false);
            await wait(30);

            if (taken((await this.#typingState(false)).values).some((each) => each !== "")) {
                const last = before.length - 1;

                await this.#evaluate(`(${TYPING_FOCUS_BOX_SCRIPT})(${String(last)})`).catch(
                    () => false,
                );

                for (let presses = 0; presses < 2 * (before.length - from); presses++) {
                    aborted(signal);
                    await this.#key("Backspace", 0);
                    await wait(30);

                    if (
                        !taken((await this.#typingState(false)).values).some((each) => each !== "")
                    ) {
                        break;
                    }
                }

                if (taken((await this.#typingState(false)).values).some((each) => each !== "")) {
                    throw new BrowserError(
                        `Nothing was typed into ${label}: its boxes hold an old code that could not be cleared.`,
                    );
                }
            }
        }

        if (from !== clicked || (replace && taken(before).some((each) => each !== ""))) {
            await this.#evaluate(`(${TYPING_FOCUS_BOX_SCRIPT})(${String(from)})`).catch(
                () => false,
            );
            await wait(30);
        }

        let state = await this.#typingState(replace);
        // What changed from here on is the code's doing: boxes this cleared are where it goes.
        const baseline = state.values ?? before;
        // The code starts in the box that has focus (the widget may have moved it from the one clicked).
        const start = state.at;
        // What each box a key went to held once the widget moved on: a row that empties itself after the last key
        // (a PIN pad that submits and resets) is judged by these.
        const landed: string[] = [];

        for (const [index, character] of code.entries()) {
            aborted(signal);

            // The page took the code before its end (more characters than the row has boxes): the rest is not typed,
            // which would go into the next step, or be sent again.
            if (index > 0 && movedOn(state)) {
                throw new BrowserError(
                    `The page submitted ${label} after ${index} of ${code.length} characters, so the rest was not typed: it sent what its boxes held then, before the code was complete.`,
                );
            }

            if (state.at < 0) {
                throw new BrowserError(
                    `Typed ${index} of ${code.length} characters into ${label}: ${this.#starts === mark.starts ? "focus left the field" : "the page changed while typing"}, so the rest was not typed.`,
                );
            }

            const at = state.at;

            await this.#key(character, 0);

            // Widgets move focus to the next box when they take a key, some a while after it, some through a moment
            // with no box focused (they lock the full box first): wait for another box to have focus, up to 300 ms, so
            // the next key does not land in a full box. The last key waits for the row to hold the code instead.
            for (let waited = 0; waited < 300 && !movedOn(state); waited += 30) {
                await wait(30);
                state = await this.#typingState(replace);

                const done =
                    movedOn(state) ||
                    (index === code.length - 1
                        ? keptOf(code, state.values!, baseline, start, replace) === -1
                        : state.at >= 0 && state.at !== at);

                if (done) {
                    break;
                }
            }

            landed.push(state.values?.[at] ?? "");
        }

        if (movedOn(state)) {
            return true;
        }

        const values = state.values!;
        // The row was emptied once the code was complete, after every key but the last went in (a PIN pad that
        // submits and resets).
        const reset =
            values.every((each) => each === "") &&
            code.slice(0, -1).every((each, index) => holds(landed[index], each));

        if (reset) {
            return true;
        }

        const kept = keptOf(code, values, baseline, start, replace);

        if (kept !== -1) {
            throw new BrowserError(
                `Typed ${code.length} characters into ${label}, but the page kept ${kept} of ${code.length} characters.`,
            );
        }

        // Some widgets submit the code a moment after its last digit: when Enter is to follow, a while for that, as
        // Enter would send it again.
        for (let waited = 0; enter && waited < 300; waited += 30) {
            await wait(30);

            if (movedOn(await this.#typingState(false))) {
                return true;
            }
        }

        return false;
    }

    async press(combo: string, options: { signal?: AbortSignal } = {}): Promise<void> {
        this.usedAt = Date.now();
        const { key, modifiers } = parseKeys(combo);
        const mark = this.#mark();

        await this.#key(key, modifiers);
        await this.#settle(mark, 10_000, options.signal);
    }

    async select(target: Target, value: string): Promise<string> {
        this.usedAt = Date.now();

        return String(
            await this.#evaluate(
                `(${SELECT_OPTION_SCRIPT})(${JSON.stringify(target)}, ${JSON.stringify(value)})`,
            ),
        );
    }

    /**
     * Attach files to a file upload, as the browser does with files a person chose: no file chooser opens (on the shared
     * desktop one would block the window for everyone). `paths` are as this browser's machine sees them, checked by the
     * caller. Returns the names the field now holds.
     */
    async upload(target: Target, paths: readonly string[]): Promise<string> {
        this.usedAt = Date.now();
        const found = await this.#send(
            "Runtime.evaluate",
            { expression: `(${FILE_INPUT_SCRIPT})(${JSON.stringify(target)})`, userGesture: true },
            15_000,
        );

        evaluated(found);
        const objectId = found.result?.objectId as string | undefined;

        if (objectId === undefined) {
            throw new BrowserError("No file upload there: take a new snapshot.");
        }

        try {
            await this.#send("DOM.setFileInputFiles", { files: [...paths], objectId });
            const names = await this.#send("Runtime.callFunctionOn", {
                objectId,
                functionDeclaration:
                    "function () { return [...(this.files ?? [])].map((file) => file.name).join(', '); }",
                returnByValue: true,
            });

            return String(evaluated(names) ?? "");
        } finally {
            void this.#send("Runtime.releaseObject", { objectId }).catch(() => {});
        }
    }

    /** Scroll a target into view, or the page by `dy` pixels (a screen down by default). */
    async scroll(target: Target | undefined, dy?: number): Promise<string> {
        this.usedAt = Date.now();

        if (target !== undefined && (target.ref ?? target.selector ?? target.label) !== undefined) {
            return (await this.locate(target)).label;
        }

        const amount = dy ?? Math.round(this.#viewport.height * 0.8);

        await this.#send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: this.#viewport.width / 2,
            y: this.#viewport.height / 2,
            deltaX: 0,
            deltaY: amount,
        });
        await wait(250);

        return `${amount >= 0 ? "down" : "up"} ${Math.abs(amount)}px`;
    }

    async snapshot(): Promise<{
        lines: string;
        truncated: boolean;
        controls: number;
        scrollY: number;
        scrollHeight: number;
        innerHeight: number;
    }> {
        this.usedAt = Date.now();

        return await this.#evaluate(SNAPSHOT_SCRIPT, 20_000);
    }

    /**
     * A JPEG of the viewport, or of the whole page (up to 8000 CSS pixels tall). The size it reports is in CSS pixels;
     * the image itself is at most `SHOT_MAX` pixels on its longer side, `scale` image pixels to a CSS pixel (1 unless
     * that made it smaller).
     */
    async screenshot(
        options: { fullPage?: boolean } = {},
    ): Promise<{ data: string; width: number; height: number; scale: number }> {
        this.usedAt = Date.now();
        const scale = 1 / this.#viewport.scale;

        if (options.fullPage === true) {
            const metrics = await this.#send("Page.getLayoutMetrics");
            const size = metrics.cssContentSize ?? metrics.contentSize;
            const width = Math.ceil(size.width);
            const height = Math.min(Math.ceil(size.height), 8000);
            const shot = await this.#send(
                "Page.captureScreenshot",
                {
                    format: "jpeg",
                    quality: 80,
                    captureBeyondViewport: true,
                    clip: { x: 0, y: 0, width, height, scale: scale * fit(width, height) },
                },
                60_000,
            );

            return { data: String(shot.data), width, height, scale: fit(width, height) };
        }

        const metrics = await this.#send("Page.getLayoutMetrics");
        const view = metrics.cssVisualViewport ?? {
            pageX: 0,
            pageY: 0,
            clientWidth: this.#viewport.width,
            clientHeight: this.#viewport.height,
            scale: 1,
        };
        const zoom = view.scale ?? 1;
        const shot = await this.#send(
            "Page.captureScreenshot",
            {
                format: "jpeg",
                quality: 80,
                clip: {
                    x: view.pageX,
                    y: view.pageY,
                    width: view.clientWidth,
                    height: view.clientHeight,
                    scale: scale * zoom * fit(view.clientWidth, view.clientHeight),
                },
            },
            60_000,
        );

        return {
            data: String(shot.data),
            width: this.#viewport.width,
            height: this.#viewport.height,
            scale: fit(view.clientWidth, view.clientHeight),
        };
    }

    /** Run JavaScript in the page: an expression or statements (top-level await works), or a body that uses `return`. */
    async evaluate(script: string, options: { timeoutMs?: number } = {}): Promise<string> {
        this.usedAt = Date.now();
        const run = (expression: string, replMode: boolean) =>
            this.#send(
                "Runtime.evaluate",
                {
                    expression,
                    replMode,
                    awaitPromise: true,
                    userGesture: true,
                    objectGroup: "pi-pocket",
                    generatePreview: false,
                    timeout: options.timeoutMs ?? 30_000,
                },
                (options.timeoutMs ?? 30_000) + 5000,
            );
        // REPL mode, as in DevTools' console: top-level await works and names can be declared again. A body that returns
        // its result is not a script there; it runs as a function, outside REPL mode, which would not await its promise.
        let response = await run(script, true);

        if (
            /Illegal return statement/.test(
                String(response.exceptionDetails?.exception?.description ?? ""),
            )
        ) {
            response = await run(`(async () => {\n${script}\n})()`, false);
        }

        try {
            if (response.exceptionDetails !== undefined) {
                evaluated(response);
            }

            const result = response.result ?? {};

            if (result.type === "undefined") {
                return "undefined";
            }

            if (result.objectId === undefined) {
                if (result.unserializableValue !== undefined) {
                    return String(result.unserializableValue);
                }

                return typeof result.value === "string"
                    ? result.value
                    : JSON.stringify(result.value);
            }

            const described = await this.#send("Runtime.callFunctionOn", {
                objectId: result.objectId,
                functionDeclaration: DESCRIBE_FUNCTION,
                returnByValue: true,
            });

            return String(described.result?.value ?? result.description ?? "");
        } finally {
            void this.#send("Runtime.releaseObjectGroup", { objectGroup: "pi-pocket" }).catch(
                () => {},
            );
        }
    }

    /** Wait for text or an element to show up, or a number of milliseconds. */
    async waitFor(options: {
        text?: string;
        selector?: string;
        ms?: number;
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<boolean> {
        this.usedAt = Date.now();

        if (options.text === undefined && options.selector === undefined) {
            await wait(clamp(options.ms ?? 1000, 0, 30_000));

            return true;
        }

        const check =
            options.selector !== undefined
                ? `(() => { const el = document.querySelector(${JSON.stringify(options.selector)}); return !!el && el.getClientRects().length > 0; })()`
                : `(document.body?.innerText ?? "").toLowerCase().includes(${JSON.stringify(options.text!.toLowerCase())})`;
        const until = Date.now() + clamp(options.timeoutMs ?? 10_000, 0, 60_000);

        while (true) {
            aborted(options.signal);

            if ((await this.#evaluate(check).catch(() => false)) === true) {
                return true;
            }

            if (Date.now() >= until) {
                return false;
            }

            await wait(200);
        }
    }

    /** Console lines after `after` (all of them by default). */
    logs(after = 0): LogEntry[] {
        return this.#logs.filter((entry) => entry.seq > after);
    }

    get logSeq(): number {
        return this.#logSeq;
    }

    clearLogs(): void {
        this.#logs = [];
        this.#errors = 0;
        // Counted as a change, so the panel fetches the (empty) console again.
        this.#logSeq++;
        this.#changed();
    }

    close(): void {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        this.#casting = false;
        clearInterval(this.#castTimer);
        clearTimeout(this.#historyTimer);
        clearTimeout(this.#saveTimer);

        for (const timer of this.#popups.values()) {
            clearTimeout(timer);
        }

        for (const wake of this.#frameWaiters) {
            wake();
        }

        for (const wake of this.#stopWaiters) {
            wake();
        }

        this.#connection.unlisten(this.#session);
        this.#changed();
    }
}
