# Performance: noid against Pi Pocket, pi-web-desktop, and rakazo

All four apps were measured in one sitting on 2026-10-20 (WSL2, Node 22, headless Chromium 141 with software WebGL),
with the same data in each: 30 small conversations and one of 220 turns (440 entries). Figures are medians of 5 runs,
[min–max] where shown; each API figure is itself the median of 7 calls. noid was measured at the head of the review
branch, started directly (`node src/server/main.ts`), with and without Node's compile cache.

- **rakazo** ran as its compose file runs it in production: API and worker (`tsx src/index.ts`), web (`vite preview`
  of its build), `postgres:16` in Docker, Graphile jobs, Postgres realtime, and its `fake` sandbox (with `none`, its
  own fallback, its thread routes answer 500: a computer kind its contracts do not list). A local test account was made
  through its own sign-up route, and its data written with its own `createThreadMessage`.
- **pi-web-desktop** ran `next start` on a production build.
- **No model was called**, so streaming throughput is not compared.
- The shared computer's Docker tests run against a container of their own (`NOID_COMPUTER=noid-computer-test`) and
  pass, 12 of 12.

## The four apps

| median [min–max]                        | noid                                                                     | Pi Pocket 0.16        | pi-web-desktop (Next 16)                  | rakazo                                                       |
| --------------------------------------- | ------------------------------------------------------------------------ | --------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| Cold start to first HTTP 200            | 632 ms [623–1067]; 540 [538–543] with the compile cache (the launcher's) | 586 ms [583–909]      | 360 ms [357–381] (loads its agent lazily) | API 2587 ms [2565–2702], web 365, worker ready 2309          |
| Memory at idle                          | 192 MB, one process                                                      | 191 MB                | 139 MB, 260 MB once pages are open        | API 576 + worker 549 + web 228 + Postgres ≈119: **≈1.47 GB** |
| Home, first visit: requests, sent       | 99, 749 KB (gzip)                                                        | 84, 1.99 MB           | 36, 2.13 MB                               | 67, 817 KB                                                   |
| Home, revisit: sent                     | 32 KB (all 304)                                                          | 2.1 MB again          | –                                         | –                                                            |
| Home: first paint                       | 40 ms [32–52] (180 before its boot screen stopped fading in)             | 596 ms                | 56 ms                                     | 156 ms                                                       |
| Home: script during load                | 321 ms [286–333] (faces; the session page: 109, Pi Pocket's 94)          | 29 ms                 | 987 ms                                    | 188 ms                                                       |
| Home: main thread at idle, software GL  | 53 ms/s, 23 after 20 s still                                             | 0.2–2.6 ms/s          | 6–21 ms/s                                 | 363–372 ms/s (CSS avatars)                                   |
| Home: main thread at idle, a real GPU   | 6–8 ms/s at rest (Chrome, Intel integrated, Direct3D 11)                 | –                     | –                                         | –                                                            |
| Session list / small conversation       | 1.9 / 1.8 ms                                                             | 1.7 / 1.5 ms          | 2.2 (378 the first call) / 2.7 ms         | 20.4 / 14.2 ms                                               |
| 220-turn conversation, first view       | 7.1 ms; 15 KB gzipped (488 KB raw), all 440 entries                      | 6.9 ms, 482 KB        | 8.1 ms, 247 KB, its last 200 entries      | 15.1 ms, 112 KB, 100 messages a page                         |
| Install                                 | 246 packages, 247 MB, no build step                                      | 269 packages, 230 MB  | 1,471 packages, 1.6 GB, a 304 MB build    | 1,379 packages, 1.6 GB, plus Postgres                        |
| Lines: server / web JS / CSS (no tests) | 52.5k / 39.5k / 16.0k                                                    | 45.3k / 36.2k / 15.4k | ~41.7k / ~49k (client)                    | 19k API, 36k web, 106k in packages                           |

How each works where it matters for speed:

- **noid and Pi Pocket**: Pi Durable keeps sessions in SQLite; output streams over server-sent events (long polling
  through tunnels that hold streams back), coalesced every 90 ms, sending only entries a tab has not seen. No build
  step: the browser loads the app's modules as they are.
- **pi-web-desktop**: pi's JSONL files, parsed whole on every transcript request; an event stream that re-sends the
  whole message on every update; the agent in the server's process; a 2.3 MB chunk with every Prism language.
- **rakazo**: Postgres for everything, a write per streamed delta (batched every 250 ms), LISTEN/NOTIFY to the API,
  separate API and worker processes, an RPC layer and a web proxy in front of each call.

## Was building on Pi Pocket the right call?

Yes. By dimension:

- **Running weight**: noid is one process of about 192 MB; rakazo is four, about 1.47 GB, and a 1.6 GB install with a
  database server. pi-web-desktop starts smaller but passes noid once used, and installs 1.6 GB with a build.
- **Speed of what people wait for**: noid answers its API in 2–7 ms like Pi Pocket and pi-web-desktop; rakazo takes
  9–22 ms through Postgres, its RPC layer, and its proxy.
- **Payload**: noid now sends the least of the four on a first visit (749 KB) and almost nothing on a revisit; a
  220-turn session's first view is 15 KB on the wire. That came from this review, not from the base, but the base made
  it a few lines: one process serves everything.
- **Start**: about even with Pi Pocket, faster with the compile cache; rakazo four to seven times slower.
- **Architecture**: durable SQLite with incremental streaming is a better base than re-parsing JSONL per request, or a
  database write per delta. Runs survive restarts, which the bots and routines rely on.
- **Start and first paint**: pi-web-desktop answers its first request sooner (360 ms against 540), because it loads its
  agent only when first needed: its first session-list call then takes 378 ms, so its first useful answer comes at
  about 740 ms, and noid's (its list in 2 ms once up) at about 542. noid now paints first sooner than any of them
  (40 ms): its boot screen, the page's own, no longer fades in from nothing.
- **Long transcripts**: both references page them on the server; noid sends a session's view
  whole, but that view is only what follows its last compaction, so it is bounded by the model's context, and earlier
  history comes a page at a time (`transcripts.history`). Measured, it is the smaller of the three anyway: the 220-turn
  session's page transfers about 2 KB more than the home page (753 against 751 KB; 15 KB for the gzipped stream alone),
  draws 1,588 elements (the browser shows its newest 60 rows), and runs 106 ms of script, against rakazo's 112 KB for its
  first 100 messages, 3,735 elements, and 373 ms, and pi-web-desktop's 247 KB for its last 200 entries and 8,090
  elements. Paging would save nothing here, and would make Find in session, jumps to pinned and older messages, and
  export fetch what they now have.
- **Where noid costs more than its base**: the WebGL bot faces. Headless, with software WebGL, they take about 300 ms
  of script while the home page loads and 23–53 ms/s at idle; in Chrome on an integrated Intel GPU, 6–8 ms/s at rest
  and 1.3 ms to add a face. They are the product's look, and Appearance → Reduced motion stops them animating.

## What this review changed

- **Faces** (`web/faces/renderer.js`) draw 30 frames a second while something happens, 10 while every face in sight
  rests and the pointer is still, and 4 once nothing has moved for 20 seconds, sleeping between frames. A change, a
  tap, or the pointer brings back 30 at once. Before: 99–124 ms/s at idle, headless.
- **App files** (`src/server/http/assets.ts`) are kept in memory while unchanged on disk (checked on every request, so
  live edits show at once), gzipped once, and answered `304` by ETag. Before: 2.08 MB on every load.
- **The event stream** (`src/server/http/events.ts`) is gzipped, each event flushed as it goes; so are long-poll
  answers over 2 KB. A 220-turn session's first view: 503 KB → 15 KB.
- **Start**: the launcher turns on Node's compile cache, kept in the data folder (`src/launcher/main.ts`), and the
  server lets the variable go so what Pi runs does not cache there: about 90 ms off each start or restart.

Considered and left: loading noid-only modules on demand (about 40 KB gzipped, 5% of the first load, for more moving
parts); `content-visibility` on transcript rows (style and layout cost about 27 ms for 220 turns, and estimated row
heights would fight the transcript's follow-scrolling); diffing the per-tick work in `room.ts` (it walks a session's
entries in microseconds).

A note for anyone benchmarking with the test model: seeding past about 240 turns slows to 40 s a turn. That is the
scripted model, not the app: at its 128k window Pi Durable compacts, and the echo model's "summary" is the whole
conversation, streamed at 2,000 tokens a second, so every later turn compacts again.

Tools and raw results (`bench2.mjs`, `bench-pwd.mjs`, `bench-rk.mjs`, `load.mjs`, `idle2.mjs`, `seedbig.ts`, and
`results/run3/`) were kept outside the repository, in `~/.cache/noid-perf/`.
