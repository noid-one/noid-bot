# Performance: noid against Pi Pocket, pi-web-desktop, and rakazo

Measured on 2026-10-19/20 (WSL2, Node 22, headless Chromium 141 with software WebGL), with the same seeds for each app:
30 small sessions of 6 turns, and one of 220 turns (440 entries). Medians of 5 runs; [min–max] where shown. No real
model was called, so streaming throughput is not measured. rakazo needs Postgres, a worker, and an account: only its
signed-out web shell was loaded.

## The four apps

|                                         | noid (before → after this review)           | Pi Pocket 0.16        | pi-web-desktop (Next 16, prod)          | rakazo                       |
| --------------------------------------- | ------------------------------------------- | --------------------- | --------------------------------------- | ---------------------------- |
| Cold start to first HTTP 200            | 661 ms [649–717] → ~465 ms (compile cache)  | 643 ms                | 409 ms (loads its agent lazily)         | not run                      |
| RSS idle / after a session opened       | 191 / 199 MB                                | 190 / 195 MB          | 139 / 244–257 MB                        | –                            |
| First load: requests                    | 101                                         | 84                    | 36                                      | 26 (sign-in shell)           |
| First load: bytes sent                  | 2.08 MB → 751 KB (gzip, 304 on reload)      | 1.94 MB               | 2.13 MB (gzip)                          | 567 KB (gzip, shell only)    |
| Home page: first contentful paint       | 228–248 ms → ~165 ms                        | 600 ms                | 64 ms                                   | 148 ms                       |
| Home page: script during load           | 314–322 ms → ~230 ms                        | 31 ms                 | 954 ms                                  | 80 ms                        |
| Home page: main thread while idle       | 99–124 ms/s → ~43 ms/s (2 WebGL faces)      | 0.1 ms/s              | 1–19 ms/s                               | –                            |
| Session list / small transcript         | 2.0 / 1.9 ms                                | 2.1 / 1.9 ms          | 2.6 ms (384 ms first call) / 2.7 ms     | –                            |
| 220-turn transcript (first view)        | 8.1 ms, 488 KB (polling: 15 KB gzipped now) | 8.0 ms, 482 KB        | 9.2 ms for its last 200 entries, 247 KB | pages 100 messages at a time |
| Installed packages / `node_modules`     | 246 / 247 MB, no build step                 | 269 / 230 MB          | 1,471 / 1.6 GB, plus a 304 MB build     | ~2,000 packages, Postgres    |
| Lines: server / web JS / CSS (no tests) | 52.5k / 39.5k / 16.0k                       | 45.3k / 36.2k / 15.4k | ~41.7k / ~49k (client)                  | 19k API, 36k web, 106k pkgs  |

How each works where it matters for speed:

- **noid and Pi Pocket**: Pi Durable keeps sessions in SQLite. Output streams over SSE (long polling through tunnels
  that hold streams back), coalesced every 90 ms, sending only entries a tab has not seen. No build step: the browser
  loads the app's modules as they are.
- **pi-web-desktop**: pi's JSONL files, parsed whole on every transcript request; SSE that re-sends the whole message
  on every update; the agent in the server's process; a 2.3 MB chunk with every Prism language.
- **rakazo**: Postgres for everything, a write per streamed delta (batched every 250 ms), LISTEN/NOTIFY to the API,
  separate API and worker processes.

## Was building on Pi Pocket the right call?

Yes, on the evidence:

- **Weight.** A sixth of pi-web-desktop's packages and no build; no database server or worker, unlike rakazo.
  Installing, upgrading, and running noid on one machine stays simple, which a personal server needs.
- **Architecture.** Durable SQLite with incremental streaming is a better base than re-parsing JSONL per request, or a
  database write per delta. Runs survive restarts, which the bots and routines rely on.
- **Payload.** Gzipped, noid's first load is about a third of pi-web-desktop's, and its script during load a quarter.
- **Even.** API latency is 2–9 ms in all three that ran.
- **Where the references are better.** pi-web-desktop starts sooner (its agent loads on first use) and pages long
  transcripts (the last 200 entries, older ones on scroll, rows with `content-visibility`); rakazo pages too. noid sends
  a session's whole transcript when it opens: 488 KB for 220 turns, which is fine on a local network and now gzipped
  on the polling path tunnels use. Paging it is the next step if sessions grow longer.
- **Where noid was worse than its own base.** The WebGL faces made the home page about a thousand times busier at idle
  than Pi Pocket's; this review cut that by about 60% (below), and a real GPU costs much less than this test's software
  WebGL. Faces remain noid's one standing cost over Pi Pocket, and the feature is the product's look.

## What this review changed (commit d6dd498)

- Faces draw 10 frames a second while every face in sight rests (idle or asleep) and the pointer is still, and sleep
  between frames; work, a change, or the pointer brings back 30 at once (`web/faces/renderer.js`).
- App files are kept in memory while unchanged on disk (checked on every request, so live edits show at once), gzipped
  once, and answered `304` by ETag (`src/server/http/assets.ts`).
- The launcher turns on Node's compile cache, kept in the data folder (`src/launcher/main.ts`): about 90 ms off each
  start or restart.
- Long-poll answers over 2 KB go gzipped (`src/server/http/events.ts`).

Considered and left: loading noid-only modules on demand (about 40 KB gzipped, 5% of the first load, for more
moving parts); `content-visibility` on transcript rows (style and layout cost about 27 ms for 220 turns, and estimated
row heights would fight the transcript's follow-scrolling); diffing the per-tick work in `room.ts` (it walks a session's
entries in microseconds).

A note for anyone benchmarking with the test model: seeding past about 240 turns slows to 40 s a turn. That is the
scripted model, not the app: at its 128k window Pi Durable compacts, and the echo model's "summary" is the whole
conversation, streamed at 2,000 tokens a second, so every later turn compacts again.

Tools and raw results: the benchmark scripts (`bench2.mjs`, `load.mjs`, `idle.mjs`, `seedbig.ts`) were kept outside
the repository, in `~/.cache/noid-perf/`.
