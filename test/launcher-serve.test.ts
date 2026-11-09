// Publishing Pi Pocket on the tailnet: the version gate, what `tailscale status --json` must say before anything is
// served, who already holds 443, and the address to open. The mount itself is exercised against a fake tailscale that a
// test writes into a temp dir: no real tailscale is run and nothing here touches the network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import {
    parseTailscaleVersion,
    portState,
    preflightProblem,
    removeStaleServe,
    sameLocalTarget,
    serveSupported,
    TailscaleServe,
} from "../src/launcher/serve.ts";
import type { ServeEvents } from "../src/launcher/serve.ts";

const VERSION = `1.58.2
  tailscale commit: 4f2d1a2b9c7e8d3f0a1b2c3d4e5f60718293a4b5
  other commit: 0f9e8d7c6b5a4938271605f4e3d2c1b0a9988776
  go version: go1.22.5
`;

const NAME = "host.tail1.ts.net";
const LOCAL_PORT = 8787;
const PROXY = `http://127.0.0.1:${LOCAL_PORT}`;
const SKIP_WINDOWS = "an executable file needs the execute bit, which this platform does not have";

test("the installed version is read from what `tailscale version` prints", () => {
    assert.deepEqual(parseTailscaleVersion(VERSION), [1, 58, 2]);
    assert.deepEqual(parseTailscaleVersion("1.52.0\n"), [1, 52, 0]);
    assert.deepEqual(parseTailscaleVersion("  tailscale version 1.64.0\n"), undefined);
    assert.equal(parseTailscaleVersion("bash: tailscale: command not found"), undefined);
    assert.equal(parseTailscaleVersion(""), undefined);
});

test("serve needs 1.52 or newer, and an unknown version is not good enough", () => {
    assert.equal(serveSupported([1, 58, 2]), true);
    assert.equal(serveSupported([1, 52, 0]), true);
    assert.equal(serveSupported([1, 52, 1]), true);
    assert.equal(serveSupported([2, 0, 0]), true);
    assert.equal(serveSupported([1, 51, 9]), false);
    assert.equal(serveSupported([1, 51]), false);
    assert.equal(serveSupported([]), false);
    assert.equal(serveSupported(undefined), false);
});

/** The address a `/` mount of ours at `port` gives: what the launcher opens, and nothing for any other state. */
function urlOf(config: unknown, dnsName: string, port: number): string | undefined {
    const state = portState(config, dnsName, port, LOCAL_PORT);

    return state.kind === "ours" ? state.url : undefined;
}

test("the address is https on the node's own name, with no port on 443", () => {
    const served = {
        Web: {
            "host.tail1.ts.net:443": {
                Handlers: { "/": { Proxy: PROXY } },
            },
        },
    };

    // No trailing slash: the panel appends the sign-in path to this, and `https://host//login` is a link nobody can use.
    assert.equal(urlOf(served, "host.tail1.ts.net", 443), "https://host.tail1.ts.net");

    // Self.DNSName keeps the trailing dot the DNS name has.
    assert.equal(urlOf(served, "host.tail1.ts.net.", 443), "https://host.tail1.ts.net");

    // The config spells the name its own way, which is the control plane's, not necessarily the DNSName's.
    assert.equal(urlOf(served, "Host.Tail1.ts.net.", 443), "https://Host.Tail1.ts.net");

    const other = {
        Web: { "host.tail1.ts.net:8443": { Handlers: { "/": { Proxy: PROXY } } } },
    };

    assert.equal(urlOf(other, "host.tail1.ts.net.", 8443), "https://host.tail1.ts.net:8443");
    assert.equal(urlOf(other, "host.tail1.ts.net.", 443), undefined);
    assert.equal(urlOf({}, "host.tail1.ts.net.", 443), undefined);
    assert.equal(urlOf(null, "host.tail1.ts.net.", 443), undefined);
    assert.equal(urlOf(served, "", 443), undefined);

    // Another path on the port is not a mount for us, and it must not be reported as one: only a `/` handler is ours.
    const otherPath = {
        Web: { "host.tail1.ts.net:443": { Handlers: { "/api": { Proxy: PROXY } } } },
    };

    assert.equal(urlOf(otherPath, "host.tail1.ts.net.", 443), undefined);
});

test("a node that is not running or not signed in has nothing to serve", () => {
    const notRunning = preflightProblem({});

    assert.match(notRunning ?? "", /not running or not signed in/);
    assert.equal(preflightProblem({}), notRunning);
    assert.equal(preflightProblem(null), notRunning);
    assert.equal(preflightProblem(undefined), notRunning);

    for (const backend of ["NeedsLogin", "Stopped", "NoState"]) {
        assert.equal(
            preflightProblem({
                BackendState: backend,
                Self: { DNSName: "host.tail1.ts.net." },
                CertDomains: ["host.tail1.ts.net"],
            }),
            notRunning,
            backend,
        );
    }

    assert.equal(
        preflightProblem({ BackendState: "Running", Self: null, CertDomains: [] }),
        notRunning,
    );
});

test("a node the tailnet has not admitted yet waits on the admin console, not on tailscale up", () => {
    assert.equal(
        preflightProblem({
            BackendState: "NeedsMachineAuth",
            Self: { DNSName: "host.tail1.ts.net." },
            CertDomains: ["host.tail1.ts.net"],
        }),
        "This machine is waiting for approval in the tailnet's admin console.",
    );
});

test("serve needs HTTPS certificates, which the control plane reports as CertDomains", () => {
    const noCertificates = preflightProblem({
        BackendState: "Running",
        Self: { DNSName: "host.tail1.ts.net." },
        CertDomains: [],
    });

    assert.match(noCertificates ?? "", /HTTPS certificates are off/);

    assert.equal(
        preflightProblem({
            BackendState: "Running",
            Self: { DNSName: "host.tail1.ts.net." },
            CertDomains: ["host.tail1.ts.net"],
        }),
        undefined,
    );
});

test("a node with an empty name has nothing to serve at, whatever the rest of the status says", () => {
    // tailscaled can report an empty DNSName, which is not a name to mount under: the mount would fail after the fact.
    assert.equal(
        preflightProblem({
            BackendState: "Running",
            Self: { DNSName: "" },
            CertDomains: ["host.tail1.ts.net"],
        }),
        'Tailscale has not given this machine a name in the tailnet yet. Check "tailscale status", then try again.',
    );
});

test("a mount of ours at / is ours however its loopback target is spelled", () => {
    const ours = (proxy: string) => ({
        Web: { "host.tail1.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } },
    });
    const address = { kind: "ours", url: "https://host.tail1.ts.net" };

    assert.deepEqual(portState(ours(PROXY), NAME, 443, LOCAL_PORT), address);
    assert.deepEqual(portState(ours("http://localhost:8787"), NAME, 443, LOCAL_PORT), address);
    assert.deepEqual(portState(ours("localhost:8787"), NAME, 443, LOCAL_PORT), address);
    assert.deepEqual(portState(ours("127.0.0.1:8787"), NAME, 443, LOCAL_PORT), address);
    assert.deepEqual(portState(ours("http://[::1]:8787"), NAME, 443, LOCAL_PORT), address);

    // A target on another port or another host is not ours to take; a stale one like that is what removeStaleServe
    // clears when the server moves to a new --port.
    assert.deepEqual(portState(ours("http://127.0.0.1:9999"), NAME, 443, LOCAL_PORT), {
        kind: "taken",
        detail: "http://127.0.0.1:9999",
    });
    assert.deepEqual(portState(ours("http://10.0.0.5:8787"), NAME, 443, LOCAL_PORT), {
        kind: "taken",
        detail: "http://10.0.0.5:8787",
    });
});

test("only a loopback target on our own port counts as this server", () => {
    assert.equal(sameLocalTarget("http://127.0.0.1:8787", LOCAL_PORT), true);
    assert.equal(sameLocalTarget("http://127.0.0.1:8787/", LOCAL_PORT), true);
    assert.equal(sameLocalTarget("http://localhost:8787", LOCAL_PORT), true);
    assert.equal(sameLocalTarget("localhost:8787", LOCAL_PORT), true);
    assert.equal(sameLocalTarget("127.0.0.1:8787", LOCAL_PORT), true);
    assert.equal(sameLocalTarget("http://[::1]:8787", LOCAL_PORT), true);
    assert.equal(sameLocalTarget("::1:8787", LOCAL_PORT), false);
    assert.equal(sameLocalTarget("http://127.0.0.1:9999", LOCAL_PORT), false);
    assert.equal(sameLocalTarget("http://localhost:9999", LOCAL_PORT), false);
    assert.equal(sameLocalTarget("http://10.0.0.5:8787", LOCAL_PORT), false);
    assert.equal(sameLocalTarget("http://127.0.0.1", LOCAL_PORT), false);
    // Only the root of the port over plain http is this server: a path of its own, or TLS at a server that speaks http,
    // is a different mount, and adopting it would half work.
    assert.equal(sameLocalTarget("http://127.0.0.1:8787/path", LOCAL_PORT), false);
    assert.equal(sameLocalTarget("https://127.0.0.1:8787", LOCAL_PORT), false);
    assert.equal(sameLocalTarget("", LOCAL_PORT), false);
    assert.equal(sameLocalTarget("   ", LOCAL_PORT), false);
    assert.equal(sameLocalTarget("http://", LOCAL_PORT), false);
    assert.equal(sameLocalTarget("not a url", LOCAL_PORT), false);
    assert.equal(sameLocalTarget(undefined, LOCAL_PORT), false);
    assert.equal(sameLocalTarget(LOCAL_PORT, LOCAL_PORT), false);
    assert.equal(sameLocalTarget({ Proxy: PROXY }, LOCAL_PORT), false);
});

test("a mount someone else put on 443 is left alone", () => {
    const served = {
        Web: { "host.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
    };

    assert.deepEqual(portState(served, "host.tail1.ts.net.", 443, LOCAL_PORT), {
        kind: "taken",
        detail: "http://127.0.0.1:9999",
    });
});

test("another path on 443 does not hold the port, so / can still be mounted", () => {
    const served = {
        Web: {
            "host.tail1.ts.net:443": {
                Handlers: { "/elsewhere": { Proxy: "http://127.0.0.1:9999" } },
            },
        },
        TCP: { "443": { HTTPS: true } },
    };

    assert.deepEqual(portState(served, "host.tail1.ts.net.", 443, LOCAL_PORT), { kind: "free" });
});

test("HTTPS on the port is how tailscaled terminates TLS, so it does not hold 443", () => {
    const served = { TCP: { "443": { HTTPS: true } } };

    assert.deepEqual(portState(served, "host.tail1.ts.net.", 443, LOCAL_PORT), { kind: "free" });
});

test("a TCP forward holds 443", () => {
    const served = { TCP: { "443": { TCPForward: "localhost:22" } } };

    assert.deepEqual(portState(served, "host.tail1.ts.net.", 443, LOCAL_PORT), {
        kind: "taken",
        detail: "a TCP forward to localhost:22",
    });
});

test("a mount on another port leaves 443 free", () => {
    const served = {
        Web: { "host.tail1.ts.net:8443": { Handlers: { "/": { Proxy: PROXY } } } },
        TCP: { "8443": { HTTPS: true } },
    };

    assert.deepEqual(portState(served, "host.tail1.ts.net.", 443, LOCAL_PORT), { kind: "free" });
});

test("a Funnel on this name and port is reported before anything else holds it", () => {
    const ours = { Web: { "host.tail1.ts.net:443": { Handlers: { "/": { Proxy: PROXY } } } } };
    const funnel = { kind: "funnel", detail: "host.tail1.ts.net:443" };

    // Funnel would put the port on the internet, so it is worse news than our own mount, and mounting / under it would
    // publish Pi Pocket far outside the tailnet the menu promises.
    assert.deepEqual(
        portState(
            { ...ours, AllowFunnel: { "host.tail1.ts.net:443": true } },
            NAME,
            443,
            LOCAL_PORT,
        ),
        funnel,
    );

    // Older and simple configs key AllowFunnel by the port alone, and the name is spelled the config's own way.
    assert.deepEqual(portState({ AllowFunnel: { "443": true } }, NAME, 443, LOCAL_PORT), funnel);
    assert.deepEqual(
        portState({ AllowFunnel: { "HOST.Tail1.ts.net:443": true } }, NAME, 443, LOCAL_PORT),
        funnel,
    );

    // Off, absent, and another name's Funnel change nothing.
    assert.deepEqual(
        portState(
            { ...ours, AllowFunnel: { "host.tail1.ts.net:443": false } },
            NAME,
            443,
            LOCAL_PORT,
        ),
        { kind: "ours", url: "https://host.tail1.ts.net" },
    );
    assert.deepEqual(portState({ ...ours }, NAME, 443, LOCAL_PORT), {
        kind: "ours",
        url: "https://host.tail1.ts.net",
    });
    assert.deepEqual(
        portState({ AllowFunnel: { "other.tail1.ts.net:443": true } }, NAME, 443, LOCAL_PORT),
        { kind: "free" },
    );
    assert.deepEqual(portState({ AllowFunnel: { "8443": true } }, NAME, 443, LOCAL_PORT), {
        kind: "free",
    });
});

// ─── The mount, against a fake tailscale ────────────────────────────────

const STATUS = {
    BackendState: "Running",
    Self: { DNSName: "host.tail1.ts.net." },
    CertDomains: ["host.tail1.ts.net"],
};

function mounted(proxy: string = PROXY): unknown {
    return {
        Web: { "host.tail1.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } },
    };
}

/**
 * A fake tailscale: it appends its argv to `calls`, then answers from the files beside it, and a mount writes
 * `mounted.json` into `serve.json` the way tailscaled would.
 */
function fakeScript(dir: string): string {
    return `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls"
case "$1" in
version)
    printf '1.60.0\\n'
    ;;
status)
    cat "${dir}/status.json"
    ;;
serve)
    case " $* " in
    *" status "*)
        cat "${dir}/serve.json"
        ;;
    *" off "*)
        if [ -f "${dir}/off-error" ]; then
            cat "${dir}/off-error" >&2
            exit "$(cat "${dir}/off-status")"
        fi
        printf '{"Web":{}}\\n' > "${dir}/serve.json"
        ;;
    *)
        cat "${dir}/mounted.json" > "${dir}/serve.json"
        ;;
    esac
    ;;
esac
`;
}

interface FakeOptions {
    status?: unknown;
    serve?: unknown;
    mounted?: unknown;
    /** Makes `off` fail with this, the way tailscaled complains about a mount that is not there. */
    offFailure?: { status: number; error: string };
}

interface Fake {
    binary: string;
    calls(): string[];
    restore(): void;
}

/** A tailscale on PATH that answers from files, so a test can see exactly which commands ran. */
function fakeTailscale(options: FakeOptions = {}): Fake {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-serve-"));
    const binary = join(dir, "tailscale");
    const previous = process.env.PATH;

    writeFileSync(binary, fakeScript(dir), { mode: 0o755 });
    writeFileSync(join(dir, "status.json"), JSON.stringify(options.status ?? STATUS));
    writeFileSync(join(dir, "serve.json"), JSON.stringify(options.serve ?? {}));
    writeFileSync(join(dir, "mounted.json"), JSON.stringify(options.mounted ?? mounted()));

    if (options.offFailure !== undefined) {
        writeFileSync(join(dir, "off-error"), `${options.offFailure.error}\n`);
        writeFileSync(join(dir, "off-status"), `${options.offFailure.status}`);
    }

    // The binary is run by its own path, and its directory is on PATH too, the way the real one would be found.
    process.env.PATH = `${dir}${delimiter}${previous ?? ""}`;

    return {
        binary,
        calls() {
            let text: string;

            try {
                text = readFileSync(join(dir, "calls"), "utf8");
            } catch {
                return [];
            }

            return text.split("\n").filter((line) => line !== "");
        },
        restore() {
            if (previous === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = previous;
            }

            rmSync(dir, { recursive: true, force: true });
        },
    };
}

function heard(): { problems: string[]; events: ServeEvents } {
    const problems: string[] = [];

    return {
        problems,
        events: {
            problem(line) {
                problems.push(line);
            },
        },
    };
}

test("a fresh mount is published on the node's own name", async (t) => {
    if (process.platform === "win32") {
        t.skip(SKIP_WINDOWS);

        return;
    }

    const fake = fakeTailscale();
    const said = heard();

    try {
        const serve = new TailscaleServe(fake.binary, LOCAL_PORT, said.events);

        assert.deepEqual(serve.start(), {
            ok: true,
            url: "https://host.tail1.ts.net",
            adopted: false,
        });
        assert.deepEqual(fake.calls(), [
            "version",
            "status --json",
            "serve status --json",
            "serve --bg --https=443 --set-path=/ http://127.0.0.1:8787",
            "serve status --json",
        ]);
    } finally {
        fake.restore();
    }
});

test("a mount of ours that points at this server is adopted, not mounted again", async (t) => {
    if (process.platform === "win32") {
        t.skip(SKIP_WINDOWS);

        return;
    }

    const fake = fakeTailscale({ serve: mounted("http://localhost:8787") });
    const said = heard();

    try {
        const serve = new TailscaleServe(fake.binary, LOCAL_PORT, said.events);

        assert.deepEqual(serve.start(), {
            ok: true,
            url: "https://host.tail1.ts.net",
            adopted: true,
        });
        assert.deepEqual(fake.calls(), [
            "version",
            "status --json",
            "serve status --json",
            "serve status --json",
        ]);
    } finally {
        fake.restore();
    }
});

test("stop removes the mount it made, and only that path", async (t) => {
    if (process.platform === "win32") {
        t.skip(SKIP_WINDOWS);

        return;
    }

    const fake = fakeTailscale();
    const said = heard();

    try {
        const serve = new TailscaleServe(fake.binary, LOCAL_PORT, said.events);

        serve.start();
        serve.stop();
        assert.equal(fake.calls().at(-1), "serve --https=443 --set-path=/ off");
        assert.deepEqual(said.problems, []);
    } finally {
        fake.restore();
    }
});

test("stop with nothing mounted runs nothing", async (t) => {
    if (process.platform === "win32") {
        t.skip(SKIP_WINDOWS);

        return;
    }

    const fake = fakeTailscale();
    const said = heard();

    try {
        const serve = new TailscaleServe(fake.binary, LOCAL_PORT, said.events);

        serve.stop();
        assert.deepEqual(fake.calls(), []);
        assert.deepEqual(said.problems, []);
    } finally {
        fake.restore();
    }
});

test("a Funnel already on 443 stops the start before anything is mounted", async (t) => {
    if (process.platform === "win32") {
        t.skip(SKIP_WINDOWS);

        return;
    }

    const fake = fakeTailscale({ serve: { AllowFunnel: { "host.tail1.ts.net:443": true } } });
    const said = heard();

    try {
        const serve = new TailscaleServe(fake.binary, LOCAL_PORT, said.events);

        assert.deepEqual(serve.start(), {
            ok: false,
            message:
                'Tailscale Funnel is on for host.tail1.ts.net:443, which would publish Pi Pocket to the internet. Turn it off with "tailscale funnel --https=443 off", which takes every handler on 443 with it, then try again.',
        });
        assert.equal(
            fake.calls().some((line) => line.startsWith("serve --bg")),
            false,
        );
    } finally {
        fake.restore();
    }
});

test("a mount that leaves no entry under our key is not reported as served", async (t) => {
    if (process.platform === "win32") {
        t.skip(SKIP_WINDOWS);

        return;
    }

    // The fake applies the mount and keeps a config with nothing in it, as a tailscaled that lost the mount would: the
    // node's own DNS name would name an address nothing serves, so the start fails instead.
    const fake = fakeTailscale({ mounted: {} });
    const said = heard();

    try {
        const serve = new TailscaleServe(fake.binary, LOCAL_PORT, said.events);

        assert.deepEqual(serve.start(), {
            ok: false,
            message:
                'Tailscale Serve reports no mount at "/" for host.tail1.ts.net:443. Check "tailscale serve status".',
        });

        // main removes the mount after a failed start, and the attempted mount is what makes that an `off` at all.
        serve.stop();
        assert.equal(fake.calls().at(-1), "serve --https=443 --set-path=/ off");
    } finally {
        fake.restore();
    }
});

test("stop leaves a mount at / that someone pointed at another service", async (t) => {
    if (process.platform === "win32") {
        t.skip(SKIP_WINDOWS);

        return;
    }

    const fake = fakeTailscale();
    const said = heard();

    try {
        const serve = new TailscaleServe(fake.binary, LOCAL_PORT, said.events);

        assert.equal(serve.start().ok, true);
        writeFileSync(
            join(dirname(fake.binary), "serve.json"),
            JSON.stringify(mounted("http://127.0.0.1:9999")),
        );
        serve.stop();
        assert.equal(fake.calls().at(-1), "serve status --json");
    } finally {
        fake.restore();
    }
});

test("stop says nothing about a handler Tailscale does not have", async (t) => {
    if (process.platform === "win32") {
        t.skip(SKIP_WINDOWS);

        return;
    }

    const fake = fakeTailscale({
        offFailure: { status: 1, error: "error: handler does not exist" },
    });
    const said = heard();

    try {
        const serve = new TailscaleServe(fake.binary, LOCAL_PORT, said.events);

        serve.start();
        serve.stop();
        assert.deepEqual(said.problems, []);
    } finally {
        fake.restore();
    }
});

test("stop reports an off that failed for any other reason", async (t) => {
    if (process.platform === "win32") {
        t.skip(SKIP_WINDOWS);

        return;
    }

    const fake = fakeTailscale({ offFailure: { status: 1, error: "serve config denied" } });
    const said = heard();

    try {
        const serve = new TailscaleServe(fake.binary, LOCAL_PORT, said.events);

        serve.start();
        serve.stop();
        assert.deepEqual(said.problems, [
            'Run "sudo tailscale set --operator=$USER" once, so Pi Pocket may configure serve.',
        ]);
    } finally {
        fake.restore();
    }
});

test("a mount a crashed launcher left behind is removed before anything is mounted", async (t) => {
    if (process.platform === "win32") {
        t.skip(SKIP_WINDOWS);

        return;
    }

    const fake = fakeTailscale({ serve: mounted("http://localhost:8787") });
    const said = heard();

    try {
        assert.equal(removeStaleServe(fake.binary, LOCAL_PORT, said.events), true);
        assert.deepEqual(fake.calls(), [
            "status --json",
            "serve status --json",
            "serve --https=443 --set-path=/ off",
        ]);
        assert.deepEqual(said.problems, []);
    } finally {
        fake.restore();
    }
});

test("a mount that points somewhere else is not ours to remove", async (t) => {
    if (process.platform === "win32") {
        t.skip(SKIP_WINDOWS);

        return;
    }

    const fake = fakeTailscale({ serve: mounted("http://127.0.0.1:9999") });
    const said = heard();

    try {
        assert.equal(removeStaleServe(fake.binary, LOCAL_PORT, said.events), false);
        assert.equal(
            fake.calls().some((line) => line.endsWith(" off")),
            false,
        );
    } finally {
        fake.restore();
    }
});

test("nothing mounted means nothing for removeStaleServe to remove", async (t) => {
    if (process.platform === "win32") {
        t.skip(SKIP_WINDOWS);

        return;
    }

    const fake = fakeTailscale();

    try {
        assert.equal(removeStaleServe(fake.binary, LOCAL_PORT), false);
        assert.deepEqual(fake.calls(), ["status --json", "serve status --json"]);
    } finally {
        fake.restore();
    }
});
