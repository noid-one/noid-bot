# Phase 0 results (2026-10-18)

Verdict: **go**. Both spikes pass; neither fallback in PLAN.md section 8 is needed.

Environment: WSL2 Ubuntu 26.04, Node 22.23.3 (`.nvmrc`), Docker Desktop 29.8.2 reached from WSL through Windows `docker.exe` interop (the WSL integration is not enabled; `NOID_DOCKER` names the binary). Pi Durable, pi-coding-agent, pi-ai, chord, pi-codemode, pi-mcp, and pi-env at 1.3.0.

## Pi Durable 1.3 upgrade

- Breaking change that mattered: a tool result's `content` is now `output`. Results that also had `details` still type-checked with `content`, so a type check alone would have missed the ones in `artifacts`, `browser`, `memory`, `subagents`, `codemode`; every tool was changed by hand.
- `npm test`: 318 pass, 0 fail, 32 skipped (they need Chromium on the host). `npm run check`, lint, prettier clean.

## Spike A: Pi's tools in the shared computer (`spike-a.ts`, `env-conformance.ts`)

Every tool runs through pi-env's `RemoteExecutionEnv` (one id, `noid:computer`, for all bots) over `docker exec -i <container> /opt/pi-env/pi-env`.

| Check                                                               | Local daemon                                           | Docker container                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| A bash call is interrupted by SIGKILL of the server mid-`sleep 25`  | process alive before; **0 left 2 s after**             | process alive before; **0 sleeps, 0 daemons 3 s after** |
| Marker file                                                         | `started` only                                         | `started` only                                          |
| Resume: same `requestId` → same submission                          | yes (8)                                                | yes (8)                                                 |
| What the model is told                                              | "Tool bash was interrupted and may have partially run" | same                                                    |
| Two bots, `sleep 3` each, at once                                   | 3036 ms (parallel)                                     | 3035 ms (parallel)                                      |
| Each bot's cwd                                                      | `bots/a`, `bots/b`                                     | `/home/noid/bots/a`, `/home/noid/bots/b`                |
| Both edit `shared/x.md` at the same moment                          | both edits kept                                        | both edits kept                                         |
| Files after `docker restart`                                        | —                                                      | kept (named volume)                                     |
| Durable's `createEnvConformance` suite (29 cases, with `listFiles`) | —                                                      | **29/29 pass** in 3.0 s                                 |

Conclusion: the shared computer is one container plus a pi-env connection; Durable's crash semantics hold unchanged inside it, and the daemon's stdin-EOF rule means a dead server leaves no running commands behind.

## Spike B: one browser, a window per bot (`spike-b.ts`, `computer/`)

Chromium (155, Debian package) runs headful on one Xvfb display (3840×2160) in the container. It is launched through `docker exec -i … sh -c 'exec chromium --remote-debugging-pipe … 3<&0 4>&1'`, so the DevTools protocol travels over the exec's stdin/stdout: no published port, and pi-pocket's own pipe client (`src/server/browser/cdp.ts`) speaks it unchanged. Each bot gets a window (`Target.createTarget({ newWindow: true })`) in the default context; windows overlap on purpose.

| Windows              | Memory idle | Memory, all screencasting | Screencast frames per window in 4 s | Page frames per window in 4 s |
| -------------------- | ----------- | ------------------------- | ----------------------------------- | ----------------------------- |
| 0 (Xvfb + test site) | 61 MB       | —                         | —                                   | —                             |
| 1                    | 297 MB      | 312 MB                    | 240                                 | 241                           |
| 3                    | 405 MB      | 446 MB                    | 240, 240, 240                       | 240 each                      |
| 5                    | 484 MB      | 552 MB                    | 174–176                             | 175–178                       |

- Every window keeps rendering and casting while covered by others (`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`).
- Each extra bot window costs ~50 MB; a browser per bot would cost ~236 MB each (~1.2 GB for five vs ~0.5 GB shared). This confirms the shared-computer decision.
- After each run: 0 Chromium processes and 0 zombies (with `tini` as PID 1).

Logins (a cookie set in one window, `max-age` one day):

| Event                                                      | Kept?                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| The other window, same browser                             | yes, at once                                                              |
| Orderly browser close, new browser                         | yes                                                                       |
| Server crash (pipe closes; Chromium exits cleanly)         | yes                                                                       |
| `docker restart` (twice), new container on the same volume | yes                                                                       |
| Container SIGKILL 35 s after the login                     | yes                                                                       |
| Container SIGKILL 1 s after the login                      | **no**: the new login is lost (Chromium commits cookies about every 30 s) |

## Findings to carry into the next phases

1. **PID 1 must reap**: without `tini`, every Chromium run left zombie processes (`sleep infinity` as PID 1 never reaps). Phase 1 image: `tini` entrypoint.
2. **Stale locks after restart**: `/tmp` survives `docker restart`; Xvfb refused to start because of `/tmp/.X99-lock`. Start script clears X locks; launch clears Chromium's `Singleton*` locks (rakazo does the same).
3. **Chromium runs with `--no-sandbox`**: its sandbox needs user namespaces that Docker's default seccomp profile blocks. The container is the boundary (PLAN section 6); revisit with a custom seccomp profile if needed.
4. **Fresh logins and hard crashes**: when a takeover (a person logging in by hand) ends, Phase 3 should make the cookies durable before relying on them, for example by restarting the browser gracefully, or tell the user to wait ~30 s.
5. **Docker from WSL**: `docker.exe` through interop works for `run`, `exec -i` (binary pipes), `stats`, `build` (context as a tar on stdin). The computer module must take the docker binary from config (`NOID_DOCKER`) and not assume `docker` on PATH.
6. **Memory**: WSL still has 7 GB; `.wslconfig` now asks for 10 GB + 8 GB swap, which applies after `wsl --shutdown`. Not blocking: five bot windows used ~0.5 GB.
