/**
 * noid's shared computer: one Docker container that every computer bot works in, each in its own folder under
 * `bots/`, sharing `shared/`, its installed tools, and one browser. Pi's tools reach it through pi-env's daemon inside
 * the container, over `docker exec -i` (spikes/RESULTS.md): the container is started when a tool first needs it and
 * stopped after a while with nothing to do. Its home is a named volume, so files and logins outlive the container, and
 * so is Homebrew's prefix (/home/linuxbrew, the only one its bottles install into), so formulae outlive it too.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    err,
    ExecutionError,
    type ExecutionEnv,
    FileError,
    toError,
} from "@earendil-works/pi-durable/env";
import { Connection, packagedDaemon, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";
import { APP_ROOT } from "../config.ts";

/** The computer's home inside the container. A session works on the computer when its folder is under it. */
export const COMPUTER_HOME = "/home/noid";

/** Homebrew's prefix on Linux, outside the home: a volume of its own. */
const BREW_HOME = "/home/linuxbrew";

export type ComputerOptions = {
    /** The docker command, for example Docker Desktop's `docker.exe` from WSL (`NOID_DOCKER`). */
    docker?: string;
    /**
     * The Docker engine that runs the computer, when it is not this machine's (`NOID_DOCKER_HOST`): `ssh://me@box` puts
     * the computer on another machine, which keeps working while this one sleeps. Every docker command gets `-H`.
     */
    dockerHost?: string;
    /** Names of the container, its home volume, and its image. */
    container?: string;
    volume?: string;
    image?: string;
    /** Stop the container after this long with no tool running and nothing asked of it. */
    idleMs?: number;
    /**
     * How long work left running in the background (a build, a coding agent CLI under nohup) keeps the computer up
     * after the last tool call: 4 hours unless given.
     */
    backgroundMs?: number;
    /** The clock and timers, for tests. */
    now?: () => number;
    /** Where the image is built from: the `computer/` folder. */
    buildContext?: string;
    log?: (message: string) => void;
};

export type ComputerState = "missing" | "stopped" | "running";

/** Runs a docker command, resolving with its output; a failure rejects with what docker said. */
/**
 * The CPU time, in clock ticks, of each process on the computer that is not the computer's own (its init, start.sh,
 * display, desktop, session bus, browser, and the bridges noid runs there): one `pid ticks` line each.
 */
const WORK_SCRIPT = `
import os
own = {"tini", "Xvfb", "fluxbox", "dbus-daemon", "dbus-launch", "sleep", "pi-env", "chrome_crashpad"}
for pid in os.listdir("/proc"):
    if not pid.isdigit() or pid == str(os.getpid()):
        continue
    try:
        stat = open("/proc/" + pid + "/stat").read()
        command = open("/proc/" + pid + "/cmdline", "rb").read().decode(errors="replace")
    except OSError:
        continue
    name = stat[stat.index("(") + 1 : stat.rindex(")")]
    fields = stat[stat.rindex(")") + 2 :].split()
    if name in own or name.startswith("chrom") or "cdp-bridge.py" in command or "/opt/noid/" in command:
        continue
    print(pid, int(fields[11]) + int(fields[12]))
`;
/** CPU time between two looks that says the background works: a second, at Linux's 100 ticks a second. */
const WORKING_TICKS = 100;

export type Docker = (args: readonly string[], input?: NodeJS.ReadableStream) => Promise<string>;

export function dockerCommand(binary: string): Docker {
    return (args, input) =>
        new Promise((resolve, reject) => {
            const child = spawn(binary, args, {
                stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
            });
            let output = "";
            let errors = "";

            child.stdout!.setEncoding("utf8");
            child.stdout!.on("data", (chunk: string) => (output += chunk));
            child.stderr!.setEncoding("utf8");
            child.stderr!.on("data", (chunk: string) => (errors = (errors + chunk).slice(-4000)));
            child.on("error", (error) =>
                reject(new Error(`Could not run ${binary}: ${error.message}`)),
            );
            child.on("close", (code) => {
                // Docker Desktop's Windows binary writes CRLF; nothing here wants the CR.
                const clean = (text: string) => text.replace(/\r/g, "").trim();

                if (code === 0) {
                    resolve(clean(output));
                } else {
                    reject(new Error(clean(errors) || `${binary} ${args[0]} failed (${code})`));
                }
            });

            if (input !== undefined && child.stdin !== null) {
                // Docker may stop reading (it failed, or never started): that is its error, reported on close, not a
                // broken pipe to throw from the stream.
                child.stdin.on("error", () => {});
                input.on("error", (error: Error) => {
                    child.kill();
                    reject(error);
                });
                input.pipe(child.stdin);
            }
        });
}

/** The one browser's profile on the computer (noid-browser's): the owner's and every bot's tabs share it, logins too. */
export const BROWSER_PROFILE = `${COMPUTER_HOME}/.browser-profile`;

/** A short hash of what the image is built from: the files of `computer/`, and pi-env's daemon (which goes in). */
export function imageTag(buildContext: string): string {
    const hash = createHash("sha256");

    const add = (folder: string) => {
        for (const name of readdirSync(folder).sort()) {
            const path = join(folder, name);

            if (statSync(path).isDirectory()) {
                add(path);
            } else {
                hash.update(`${relative(buildContext, path)}\0`).update(readFileSync(path));
            }
        }
    };

    try {
        add(buildContext);
    } catch {
        // No build folder (a test's): the tag says only which daemon.
    }

    try {
        hash.update(
            `pi-env ${statSync(packagedDaemon({ platform: "linux", arch: process.arch === "arm64" ? "arm64" : "x64" })).size}`,
        );
    } catch {
        // No daemon for this machine: the build would say so.
    }

    return hash.digest("hex").slice(0, 12);
}

/** A folder as noid keeps it: absolute, `..` and `.` resolved, no slash at the end. */
export function normalFolder(cwd: string): string {
    const normal = posix.normalize(cwd.trim());

    return normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal;
}

/** Whether a folder is on the shared computer: under its home once `..` is resolved, never by its spelling alone. */
export function onComputer(cwd: string): boolean {
    const folder = normalFolder(cwd);

    return (
        cwd.trim().startsWith("/") &&
        (folder === COMPUTER_HOME || folder.startsWith(`${COMPUTER_HOME}/`))
    );
}

export class Computer {
    readonly container: string;
    readonly volume: string;
    /** The volume Homebrew installs into. */
    readonly brewVolume: string;
    readonly image: string;
    readonly #docker: Docker;
    readonly #binary: string;
    /** `-H <engine>` before every docker command, when the computer is on another machine. */
    readonly #hostArgs: string[];
    readonly #idleMs: number;
    readonly #now: () => number;
    readonly #buildContext: string;
    readonly #log: (message: string) => void;
    readonly #envs = new Map<string, ExecutionEnv>();
    /** Folders made on the computer (or being made) since this server started: each is made once, on first use. */
    readonly #made = new Map<string, Promise<void>>();
    readonly connection: Connection;
    #starting: Promise<void> | undefined;
    #stopping: Promise<void> | undefined;
    /** Requests to the daemon now running, and when the last one ended (or the computer was last asked for). */
    #inFlight = 0;
    #lastActive: number;
    #holds = 0;
    /** When the last request to the daemon ended; never, since this server started, at 0. */
    #lastRequest = 0;
    #idleTimer: NodeJS.Timeout | undefined;
    readonly #backgroundMs: number;
    /** When this server started: work in the background counts from here when no request ran since. */
    readonly #since: number;
    /** The CPU time of the computer's work processes at the last look before an idle stop, and when that was. */
    #lastLook: { at: number; ticks: Map<string, number> } | undefined;
    /** False once a stop (or a look) found it not running, until something asks for it again: no idle polling meanwhile. */
    #mayBeRunning = true;

    constructor(options: ComputerOptions = {}, docker?: Docker) {
        this.#binary = options.docker ?? process.env.NOID_DOCKER ?? "docker";
        const host = options.dockerHost ?? process.env.NOID_DOCKER_HOST;

        this.#hostArgs = host === undefined || host === "" ? [] : ["-H", host];
        const run = docker ?? dockerCommand(this.#binary);

        this.#docker = (args, input) => run([...this.#hostArgs, ...args], input);
        // NOID_COMPUTER names another computer (its container, and `<name>-home` its volume): the Docker tests use one
        // of their own, and never stop or restart the owner's.
        const named = process.env.NOID_COMPUTER?.trim() || "noid-computer";

        this.container = options.container ?? named;
        this.volume = options.volume ?? `${named}-home`;
        this.brewVolume = `${named}-linuxbrew`;
        this.#buildContext = options.buildContext ?? join(APP_ROOT, "computer");
        // Tagged by what it is built from: a change to computer/ (or to pi-env's daemon) is a new image, and a container
        // made from an older one is made again at its next start.
        this.image = options.image ?? `noid-computer:${imageTag(this.#buildContext)}`;
        this.#idleMs = options.idleMs ?? 15 * 60_000;
        this.#now = options.now ?? Date.now;
        this.#log = options.log ?? (() => {});
        this.#lastActive = this.#now();
        this.#backgroundMs = options.backgroundMs ?? 4 * 60 * 60_000;
        this.#since = this.#now();
        this.connection = new Connection({
            command: async () => {
                await this.start();

                return [
                    this.#binary,
                    ...this.#hostArgs,
                    "exec",
                    "-i",
                    this.container,
                    "/opt/pi-env/pi-env",
                ];
            },
            onLog: (text) => this.#log(`pi-env: ${text.trim()}`),
        });
        this.#countRequests();
    }

    /**
     * The environment for a folder on the computer. Every folder shares one id: one computer, one set of files. The
     * folder is made on its first use, so a new bot wakes nothing until it works.
     */
    env(cwd: string): ExecutionEnv {
        const folder = normalFolder(cwd);
        let env = this.#envs.get(folder);

        if (env === undefined) {
            const remote = new RemoteExecutionEnv({
                connection: this.connection,
                id: "noid:computer",
                cwd: folder,
            });

            env = new Proxy(remote, {
                get: (target, key) => {
                    const value = Reflect.get(target, key, target) as unknown;

                    if (typeof value !== "function") {
                        return value;
                    }

                    // Bound to the real environment: its private fields are not the proxy's.
                    if (key === "cleanup") {
                        return value.bind(target);
                    }

                    return async (...args: unknown[]) => {
                        try {
                            await this.#make(folder);
                        } catch (error) {
                            // As every ExecutionEnv method: an expected failure is a result, not a throw.
                            const message = `Could not make ${folder} on the shared computer: ${toError(error).message}`;

                            return err(
                                key === "exec"
                                    ? new ExecutionError("spawn_error", message)
                                    : new FileError("unknown", message, folder),
                            );
                        }

                        return (value as (...a: unknown[]) => unknown).apply(target, args);
                    };
                },
            });
            this.#envs.set(folder, env);
        }

        return env;
    }

    #make(folder: string): Promise<void> {
        let made = this.#made.get(folder);

        if (made === undefined) {
            made = (async () => {
                const home = new RemoteExecutionEnv({
                    connection: this.connection,
                    id: "noid:computer",
                    cwd: COMPUTER_HOME,
                });
                const result = await home.createDir(
                    folder,
                    { recursive: true },
                    BACKGROUND_CONTEXT,
                );

                if (!result.ok) {
                    throw result.error;
                }
            })();
            // A failure (the computer could not start) is tried again on the next use.
            made.catch(() => this.#made.delete(folder));
            this.#made.set(folder, made);
        }

        return made;
    }

    /** The image the container was made from. */
    async #containerImage(): Promise<string> {
        return (
            await this.#docker([
                "inspect",
                "--type",
                "container",
                "--format",
                "{{.Config.Image}}",
                this.container,
            ])
        ).trim();
    }

    async state(): Promise<ComputerState> {
        try {
            const running = await this.#docker([
                "inspect",
                "--type",
                "container",
                "--format",
                "{{.State.Running}}",
                this.container,
            ]);

            return running === "true" ? "running" : "stopped";
        } catch {
            return "missing";
        }
    }

    /** Make sure the container runs: start it, or create it (building the image first if needed). One at a time. */
    start(): Promise<void> {
        this.#touch();
        this.#starting ??= (async () => {
            await this.#stopping;

            const state = await this.state();

            if (state === "running") {
                return;
            }

            let replaced: string | undefined;

            if (state === "stopped") {
                // Made from an older image: made again from this one (its home is a volume, and stays). One still
                // running moves to the new image the next time it stops, rather than cut off work under way.
                const old = await this.#containerImage();

                if (old === this.image) {
                    this.#log(`starting ${this.container}`);
                    await this.#docker(["start", this.container]);

                    return;
                }

                // What was installed outside its home goes with the old container: bots install into ~/.local.
                this.#log(
                    `replacing ${this.container}: it was made from ${old}, not ${this.image}`,
                );
                await this.#docker(["rm", this.container]);
                this.#stopped();
                replaced = old;
            }

            if (!(await this.#imageExists())) {
                await this.build();
            }

            this.#log(`creating ${this.container}`);
            await this.#docker([
                "run",
                "--detach",
                "--name",
                this.container,
                "--label",
                "noid.computer=1",
                "--shm-size",
                "1g",
                // The owner's time zone, not UTC: the desktop's clock, and what sites see in its browser.
                "--env",
                `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
                "--volume",
                `${this.volume}:${COMPUTER_HOME}`,
                "--volume",
                `${this.brewVolume}:${BREW_HOME}`,
                this.image,
            ]);

            // The old image takes gigabytes and nothing uses it now (one still in use stays, and says so).
            if (replaced !== undefined) {
                await this.#docker(["image", "rm", replaced]).catch((error: unknown) =>
                    this.#log(`kept ${replaced}: ${toError(error).message}`),
                );
            }
        })().finally(() => {
            this.#starting = undefined;
        });

        return this.#starting;
    }

    /**
     * Stop the container (its home stays). The daemon dies with it, which the connection takes as lost: the next
     * request starts the container and a new daemon again. (Closing the connection instead would end it for good.)
     */
    stop({ ifIdle = false }: { ifIdle?: boolean } = {}): Promise<void> {
        this.#stopping ??= (async () => {
            await this.#starting?.catch(() => {});

            const running = (await this.state()) === "running";
            // Work left running in the background (a build, a coding agent CLI) is activity too (rakazo 8d90ea634).
            const working =
                running && ifIdle && this.idle() && (await this.#background()) !== "idle";

            // An idle stop checks again last thing: a request may have begun while docker answered.
            if (running && !working && (!ifIdle || this.idle())) {
                this.#log(`stopping ${this.container}`);
                await this.#docker(["stop", "--time", "10", this.container]);
                this.#stopped();
            }

            this.#mayBeRunning = !running ? false : working || (ifIdle && !this.idle());
        })().finally(() => {
            this.#stopping = undefined;
        });

        return this.#stopping;
    }

    /**
     * A connection to the computer's one browser, an ordinary Chromium on its desktop (`noid-browser`, started if it
     * is not running): the `docker exec` process whose stdin and stdout are its DevTools pipe (pi-pocket's
     * `Chromium.over` speaks it), joined there to the browser's DevTools socket by `cdp-bridge.py`. Stopping it lets go
     * of the browser, which keeps running for the people using it.
     */
    async connectBrowser(): Promise<ChildProcess> {
        await this.start();

        return spawn(
            this.#binary,
            [...this.#hostArgs, "exec", "-i", this.container, "python3", "/opt/noid/cdp-bridge.py"],
            { stdio: ["pipe", "pipe", "ignore"] },
        );
    }

    /** Build the image from `computer/`, with pi-env's daemon for Linux put in beside the Dockerfile. */
    async build(): Promise<void> {
        const context = mkdtempSync(join(tmpdir(), "noid-computer-"));

        try {
            cpSync(this.#buildContext, context, { recursive: true });
            // The container runs this machine's architecture (Docker Desktop on Apple silicon runs arm64).
            cpSync(
                packagedDaemon({
                    platform: "linux",
                    arch: process.arch === "arm64" ? "arm64" : "x64",
                }),
                join(context, "pi-env"),
            );
            this.#log(`building ${this.image}`);

            const tar = spawn("tar", ["-C", context, "-cf", "-", "."], {
                stdio: ["ignore", "pipe", "inherit"],
            });
            const packed = new Promise<void>((resolve, reject) => {
                tar.on("error", (error) =>
                    reject(new Error(`Could not run tar: ${error.message}`)),
                );
                tar.on("close", (code) =>
                    code === 0
                        ? resolve()
                        : reject(new Error(`tar failed (${code}): the image was not built`)),
                );
            });

            // Both must succeed: a context cut short would build a broken image, or fail with a confusing error.
            try {
                await Promise.all([
                    packed,
                    this.#docker(["build", "--quiet", "--tag", this.image, "-"], tar.stdout!),
                ]);
            } catch (error) {
                // A docker that stopped reading leaves tar blocked on a full pipe, forever: stop it too.
                tar.kill();
                packed.catch(() => {});

                throw error;
            }
        } finally {
            rmSync(context, { recursive: true, force: true });
        }
    }

    /**
     * Make a folder on the computer before something outside its environments (a terminal) works there. Made again
     * each time, unlike the environments' once: someone may have removed it since.
     */
    prepare(cwd: string): Promise<void> {
        const folder = normalFolder(cwd);

        this.#made.delete(folder);

        return this.#make(folder);
    }

    /** Told each time what ran on the computer is gone (it stopped, or was made again): its process ids mean nothing now. */
    readonly #onStop = new Set<() => void>();

    onStop(listener: () => void): () => void {
        this.#onStop.add(listener);

        return () => this.#onStop.delete(listener);
    }

    #stopped(): void {
        for (const listener of this.#onStop) {
            try {
                listener();
            } catch (error) {
                this.#log(`a stop listener failed: ${toError(error).message}`);
            }
        }
    }

    /** Stop the computer and start it again: what it runs stops, and an older image is replaced. */
    async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    /** Keep the computer from stopping while something outside a tool call uses it (a browser window being watched). */
    hold(): () => void {
        this.#holds += 1;
        this.#touch();

        let released = false;

        return () => {
            if (!released) {
                released = true;
                this.#holds -= 1;
                this.#touch();
            }
        };
    }

    /**
     * Whether processes outside any tool call still work: "working" when their CPU time grew by a second since the
     * last look (which counts as activity), "unsure" at a first look (look again at the next check), "idle" when none
     * runs, none works, or the computer cannot be asked. Never past `backgroundMs` after the last tool call.
     */
    async #background(): Promise<"idle" | "working" | "unsure"> {
        if (this.#now() - Math.max(this.#lastRequest, this.#since) >= this.#backgroundMs) {
            return "idle";
        }

        let ticks: Map<string, number>;

        try {
            const out = await this.#docker(["exec", this.container, "python3", "-c", WORK_SCRIPT]);

            ticks = new Map(
                out
                    .split("\n")
                    .map((line) => line.trim().split(/\s+/))
                    .filter(([pid, used]) => /^\d+$/.test(pid ?? "") && /^\d+$/.test(used ?? ""))
                    .map(([pid, used]) => [pid!, Number(used)]),
            );
        } catch {
            return "idle";
        }

        const last = this.#lastLook;

        this.#lastLook = { at: this.#now(), ticks };

        if (ticks.size === 0) {
            return "idle";
        }

        // A look long ago says nothing of the last minute: look again.
        if (last === undefined || this.#now() - last.at > 5 * 60_000) {
            return "unsure";
        }

        let used = 0;

        for (const [pid, now] of ticks) {
            used += now - (last.ticks.get(pid) ?? 0);
        }

        if (used < WORKING_TICKS) {
            return "idle";
        }

        this.#log(`kept running: work in the background used ${String(used / 100)} s of CPU`);
        this.#touch();

        return "working";
    }

    /** Whether the computer has had nothing to do for its idle time. */
    idle(): boolean {
        return (
            this.#inFlight === 0 &&
            this.#holds === 0 &&
            this.#now() - this.#lastActive >= this.#idleMs
        );
    }

    /** Check now and then, and stop the container once it is idle. Returns how to stop checking. */
    watchIdle(every = 60_000): () => void {
        this.#idleTimer = setInterval(() => {
            if (this.#mayBeRunning && this.#stopping === undefined && this.idle()) {
                this.stop({ ifIdle: true }).catch((error: unknown) =>
                    this.#log(`could not stop: ${String(error)}`),
                );
            }
        }, every);
        this.#idleTimer.unref();

        return () => clearInterval(this.#idleTimer);
    }

    /** Close the connection and stop checking; the container keeps running (a restarted server finds it). */
    async close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
        clearInterval(this.#idleTimer);

        for (const env of this.#envs.values()) {
            await env.cleanup(context);
        }

        this.connection.close();
    }

    #touch(): void {
        this.#lastActive = this.#now();
        this.#mayBeRunning = true;
    }

    async #imageExists(): Promise<boolean> {
        try {
            await this.#docker(["image", "inspect", "--format", "{{.Id}}", this.image]);

            return true;
        } catch {
            return false;
        }
    }

    /** Every request to the daemon (each file operation and command) is activity, from its start to its end. */
    #countRequests(): void {
        const request = this.connection.request.bind(this.connection);

        this.connection.request = async (...args) => {
            this.#inFlight += 1;
            this.#touch();

            try {
                return await request(...args);
            } finally {
                this.#inFlight -= 1;
                this.#lastRequest = this.#now();
                this.#touch();
            }
        };
    }

    /**
     * Whether the computer is known to be up: a request is running, or one ended in the last minute. Something that
     * only shows a detail (a session's branch) asks it only then, rather than start the computer for that.
     */
    get awake(): boolean {
        return this.#inFlight > 0 || this.#now() - this.#lastRequest < 60_000;
    }
}
