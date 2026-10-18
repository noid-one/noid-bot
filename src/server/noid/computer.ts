/**
 * noid's shared computer: one Docker container that every computer bot works in, each in its own folder under
 * `bots/`, sharing `shared/`, its installed tools, and one browser. Pi's tools reach it through pi-env's daemon inside
 * the container, over `docker exec -i` (spikes/RESULTS.md): the container is started when a tool first needs it and
 * stopped after a while with nothing to do. Its home is a named volume, so files and logins outlive the container.
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
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { APP_ROOT } from "../config.ts";

/** The computer's home inside the container. A session works on the computer when its folder is under it. */
export const COMPUTER_HOME = "/home/noid";

export type ComputerOptions = {
    /** The docker command, for example Docker Desktop's `docker.exe` from WSL (`NOID_DOCKER`). */
    docker?: string;
    /** Names of the container, its home volume, and its image. */
    container?: string;
    volume?: string;
    image?: string;
    /** Stop the container after this long with no tool running and nothing asked of it. */
    idleMs?: number;
    /** The clock and timers, for tests. */
    now?: () => number;
    /** Where the image is built from: the `computer/` folder. */
    buildContext?: string;
    log?: (message: string) => void;
};

export type ComputerState = "missing" | "stopped" | "running";

/** Runs a docker command, resolving with its output; a failure rejects with what docker said. */
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
    readonly image: string;
    readonly #docker: Docker;
    readonly #binary: string;
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
    #idleTimer: NodeJS.Timeout | undefined;
    /** False once a stop (or a look) found it not running, until something asks for it again: no idle polling meanwhile. */
    #mayBeRunning = true;

    constructor(options: ComputerOptions = {}, docker?: Docker) {
        this.#binary = options.docker ?? process.env.NOID_DOCKER ?? "docker";
        this.#docker = docker ?? dockerCommand(this.#binary);
        this.container = options.container ?? "noid-computer";
        this.volume = options.volume ?? "noid-computer-home";
        this.image = options.image ?? "noid-computer:1";
        this.#idleMs = options.idleMs ?? 15 * 60_000;
        this.#now = options.now ?? Date.now;
        this.#buildContext = options.buildContext ?? join(APP_ROOT, "computer");
        this.#log = options.log ?? (() => {});
        this.#lastActive = this.#now();
        this.connection = new Connection({
            command: async () => {
                await this.start();

                return [this.#binary, "exec", "-i", this.container, "/opt/pi-env/pi-env"];
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

            if (state === "stopped") {
                this.#log(`starting ${this.container}`);
                await this.#docker(["start", this.container]);

                return;
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
                "--volume",
                `${this.volume}:${COMPUTER_HOME}`,
                this.image,
            ]);
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

            // An idle stop checks again last thing: a request may have begun while docker answered.
            if (running && (!ifIdle || this.idle())) {
                this.#log(`stopping ${this.container}`);
                await this.#docker(["stop", "--time", "10", this.container]);
            }

            this.#mayBeRunning = !running ? false : ifIdle && !this.idle();
        })().finally(() => {
            this.#stopping = undefined;
        });

        return this.#stopping;
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
            await Promise.all([
                packed,
                this.#docker(["build", "--quiet", "--tag", this.image, "-"], tar.stdout!),
            ]);
        } finally {
            rmSync(context, { recursive: true, force: true });
        }
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
                this.#touch();
            }
        };
    }
}
