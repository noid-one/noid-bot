# Performance: noid against Pi Pocket, pi-web-desktop, and rakazo

All four apps were measured in one sitting on 2026-10-20 (WSL2, Node 22, headless Chromium 141 with software WebGL), and
the measurements were repeated in two more independent sittings that day (rakazo's whole stack set up anew each time,
noid and pi-web-desktop's start timed the same way in each): every figure reproduced within run-to-run noise, the third
sitting running 1–5% slower across all apps alike. The figures below are the first sitting's unless marked,
with the same data in each: 30 small conversations and one of 220 turns (440 entries). Figures are medians of 5 runs,
[min–max] where shown; each API figure is itself the median of 7 calls. noid was measured at the head of the review
branch, started directly (`node src/server/main.ts`), with and without Node's compile cache.

- **rakazo** ran as its compose file runs it in production: API and worker (`tsx src/index.ts`), web (`vite preview`
  of its build), `postgres:16` in Docker, Graphile jobs, Postgres realtime, and its `fake` sandbox (with `none`, its
  own fallback, its thread routes answer 500: a computer kind its contracts do not list). A local test account was made
  through its own sign-up route, and its data written with its own `createThreadMessage`.
- **pi-web-desktop** ran `next start` on a production build.
- **No model was called**, so streaming throughput is not compared here; see Streaming, after Pi Pocket 0.19, below.
- The shared computer's Docker tests run against a container of their own (`NOID_COMPUTER=noid-computer-test`) and
  pass, 12 of 12.

## The four apps

| median [min–max]                                                                      | noid                                                                                                                                                              | Pi Pocket 0.16                 | pi-web-desktop (Next 16)                    | rakazo                                                       |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------- | ------------------------------------------------------------ |
| Cold start: first byte / first useful answer                                          | 163 / 632 ms; 153 / 547 with the compile cache (the launcher's)                                                                                                   | 586 ms to first byte [583–909] | 369 / 756 ms (loads its agent on first use) | API 2587 ms [2565–2702], web 365, worker ready 2309          |
| Memory at idle                                                                        | 192 MB, one process                                                                                                                                               | 191 MB                         | 139 MB, 260 MB once pages are open          | API 576 + worker 549 + web 228 + Postgres ≈119: **≈1.47 GB** |
| Home, first visit: requests, sent (kB)                                                | 99, 752 kB (gzip)                                                                                                                                                 | 84, 1.99 MB                    | 36, 2.18 MB                                 | 67, 836 kB                                                   |
| Home, revisit (browser cache on): sent                                                | 32 KB (all 304)                                                                                                                                                   | 1.95 MB                        | 272 KB                                      | –                                                            |
| Home: first paint                                                                     | 40 ms [32–52] (180 before its boot screen stopped fading in)                                                                                                      | 596 ms                         | 56 ms                                       | 156 ms                                                       |
| Home: script during load                                                              | 321 ms [286–333] (faces; the session page: 109, Pi Pocket's 94)                                                                                                   | 29 ms                          | 987 ms                                      | 188 ms                                                       |
| Home: main thread at idle, headless software GL (this code; before the review 99–124) | 55 ms/s 5–15 s after load, 25 at 25–35 s, 0.1 after 2 min untouched                                                                                               | 0.2–2.6 ms/s                   | 6–21 ms/s                                   | 363–372 ms/s (CSS avatars)                                   |
| Home: main thread at idle, a real GPU                                                 | 4.3–6.5 ms/s resting (10 fps), 1.6–3.8 drowsy (4 fps), 0 after 2 min untouched (Chrome, Intel integrated, Direct3D 11; two browser sessions, 5 samples per stage) | –                              | –                                           | –                                                            |
| Session list / small conversation                                                     | 1.9 / 1.8 ms                                                                                                                                                      | 1.7 / 1.5 ms                   | 2.2 (378 the first call) / 2.7 ms           | 20.4 / 14.2 ms                                               |
| 220-turn conversation, first view                                                     | 7.1 ms; 15 KB gzipped (488 KB raw), all 440 entries                                                                                                               | 6.9 ms, 482 KB                 | 8.1 ms, 247 KB, its last 200 entries        | 15.1 ms, 112 KB, 100 messages a page                         |
| Install                                                                               | 246 packages, 247 MB, no build step                                                                                                                               | 269 packages, 230 MB           | 1,471 packages, 1.6 GB, a 304 MB build      | 1,379 packages, 1.6 GB, plus Postgres                        |
| Lines: server / web JS / CSS (no tests)                                               | 52.5k / 39.5k / 16.0k                                                                                                                                             | 45.3k / 36.2k / 15.4k          | ~41.7k / ~49k (client)                      | 19k API, 36k web, 106k in packages                           |

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
- **Payload**: noid now sends the least of the four on a first visit (752 kB, against rakazo's 836 kB; a `Vary`
  header on the fonts kept the browser from using their preload, so each came twice; fonts no longer carry it, and the
  app's are no longer preloaded, which paints sooner) and almost
  nothing on a revisit (32 kB); a 220-turn session's first view is 15 KB on the wire. That came from this review, not from the base, but the base made
  it a few lines: one process serves everything.
- **Start**: about even with Pi Pocket, faster with the compile cache; rakazo four to seven times slower.
- **Architecture**: durable SQLite with incremental streaming is a better base than re-parsing JSONL per request, or a
  database write per delta. Runs survive restarts, which the bots and routines rely on.
- **Start and first paint**: measured the same way for both, from spawn to the first byte and to the first `200` of
  the session list (`ttfu.mjs`, medians of 5): noid as its launcher runs it 153 / 547 ms, without the compile cache
  163 / 632, pi-web-desktop 369 / 756. noid takes its port at once and loads Pi's packages one at a time, answering
  between them: its page is served while it starts, and other requests wait to be answered as it opens, not refused.
  Most of its start is loading Pi's own package (`pi-coding-agent`, 272 of the app's 408 ms of imports), which Pi
  Pocket loads too; pi-web-desktop defers its agent to the first request instead. noid paints first sooner than any of
  them (40 ms): its boot screen, the page's own, no longer fades in from nothing.
- **Long transcripts**: both references page them on the server; noid sends a session's view
  whole, but that view is only what follows its last compaction, so it is bounded by the model's context, and earlier
  history comes a page at a time (`transcripts.history`). Measured, it is the smaller of the three anyway: the 220-turn
  session's page transfers about 2 KB more than the home page (753 against 751 KB; 15 KB for the gzipped stream alone),
  draws 1,588 elements (the browser shows its newest 60 rows), and runs 106 ms of script, against rakazo's 112 KB for its
  first 100 messages, 3,735 elements, and 373 ms, and pi-web-desktop's 247 KB for its last 200 entries and 8,090
  elements. Paging would save nothing here, and would make Find in session, jumps to pinned and older messages, and
  export fetch what they now have.
- **Where noid costs more than its base**: the WebGL bot faces. Headless, with software WebGL, they take about 300 ms
  of script while the home page loads and 25–55 ms/s at idle; in Chrome on an integrated Intel GPU, 2–7 ms/s while in use and 0 once untouched for 2 minutes
  and 1.3 ms to add a face. They are the product's look, and Appearance → Reduced motion stops them animating.

## What this review changed

- **Faces** (`web/faces/renderer.js`) draw 30 frames a second while something happens, 10 while every face in sight
  rests and the pointer is still, 4 once the pointer, keys, and taps have been still for 20 seconds, and none once nobody has touched the page for
  2 minutes (0 ms/s, as Pi Pocket), sleeping between frames. A change, a tap, a key, the wheel, or the pointer brings
  back 30 at once. Before: 99–124 ms/s at idle, headless.
- **App files** (`src/server/http/assets.ts`) are kept in memory while unchanged on disk (checked on every request, so
  live edits show at once), gzipped once, and answered `304` by ETag. Before: 2.08 MB on every load.
- **The event stream** (`src/server/http/events.ts`) is gzipped, each event flushed as it goes; so are long-poll
  answers over 2 KB. A 220-turn session's first view: 503 KB → 15 KB.
- **Start**: the launcher turns on Node's compile cache, kept in the data folder (`src/launcher/main.ts`), and the
  server lets the variable go so what Pi runs does not cache there: about 90 ms off each start or restart.

## Streaming, after Pi Pocket 0.19 (2026-10-21)

Pi Pocket 0.19 made streaming cheaper, and noid took the same changes (FORK.md, Upstream syncs). Before, every update
of a run (every 90 ms) sent each tab the whole message being written, so an answer cost its length squared; now a tab
that names protocol 3 gets only what changed (`liveMessageDelta`, `web/live.js`). Measured with the test model and two
tabs on one answer (`~/.cache/noid-perf/stream-bytes.ts`; protocol 2 is what every tab got before):

| A 14.8 KB answer of 40 Markdown parts | updates | sent to a tab, before | sent to a tab, now |
| ------------------------------------- | ------- | --------------------- | ------------------ |
| at 2,000 tokens a second (the tests)  | 20      | 128 KB                | 24.9 KB            |
| at 100 tokens a second (a real model) | 326     | 2.59 MB               | 193 KB (13× less)  |

The rest of the gain is in the browser: the session list and the rail are not drawn again when only the view changes
(`apartFromViews`; upstream measured 30 → 8 ms an update at 4× CPU on a phone), and a streaming answer's Markdown is
parsed block by block, the last block only. On the wire, every JSON answer of 1 KB or more now goes compressed (before,
only long polls and the `@` list), with brotli where the browser takes it (the app's files: 464 KB against 490 KB
gzipped, of 1.79 MB), and the app page lists its modules as `modulepreload` links, so a first load fetches them in
one round, not one per level of imports: what counts most over Tailscale from a phone.

Considered and left: loading noid-only modules on demand (about 40 KB gzipped, 5% of the first load, for more moving
parts); `content-visibility` on transcript rows (style and layout cost about 27 ms for 220 turns, and estimated row
heights would fight the transcript's follow-scrolling); diffing the per-tick work in `room.ts` (it walks a session's
entries in microseconds).

A note for anyone benchmarking with the test model: seeding past about 240 turns slows to 40 s a turn. That is the
scripted model, not the app: at its 128k window Pi Durable compacts, and the echo model's "summary" is the whole
conversation, streamed at 2,000 tokens a second, so every later turn compacts again.

Tools and raw results (`bench2.mjs`, `bench-pwd.mjs`, `bench-rk.mjs`, `load.mjs`, `idle2.mjs`, `seedbig.ts`, and
`results/run3/`) were kept outside the repository, in `~/.cache/noid-perf/`.

## The Pi Pocket 0.22 ports, before merging (2026-10-26)

Measured on Node 26 at main's head once branches `port/upstream-0.22` and `menu/working-subagents` were in (`41734b5`),
in one sitting with main before them (`a412a1e`) and upstream Pi Pocket 0.23.1 (`d08ccd4`), with the 220-turn data set
and no model called. Server figures are medians of 5 cold starts, each API figure the median of 7 calls
(`~/.cache/noid-perf/final26/bench.mjs`; its event streams are now read uncompressed, so the bytes are raw); typing is
the median of 20 calls into a plain field in real Chromium:

| median                               | before (`a412a1e`) | after (`41734b5`) | Pi Pocket 0.23.1 |
| ------------------------------------ | ------------------ | ----------------- | ---------------- |
| Start: first byte / first `200`      | 202 / 202 ms       | 204 / 204 ms      | 649 / 753 ms     |
| Memory at idle / after the API calls | 212 / 225 MB       | 210 / 223 MB      | 201 / 225 MB     |
| Session list / the 220-turn view     | 1.66 / 7.43 ms     | 1.76 / 7.45 ms    | 2.16 / 7.49 ms   |
| The 220-turn view, raw               | 488,400 B          | 488,400 B         | 482,491 B        |
| Typing into a plain field            | 50.0 ms            | 50.0 ms           | –                |

The full suite passes at `41734b5` (521, and the 12 Docker tests against their own container).

The review before merging changed three things that cost time:

- Typing first waited 30 ms after every click, in case a code widget moved focus on: a plain field took 83 ms. It
  now waits only when the click lands on a one-character box or on nothing one types in (the two reads it added, of
  the field before and of what it kept after, cost about a millisecond each).
- The fold dots: each folded row walked its whole group (upstream's code, but noid draws the whole list on every store
  change, where upstream draws it only when the list changes). One pass now, and the rows above the open session are
  worked out once per list. A draw, all sessions in one group, chains of four, a quarter folded:

    | sessions | main    | before the fix: folds / none | now: folds / none |
    | -------- | ------- | ---------------------------- | ----------------- |
    | 2,000    | 1.64 ms | 4.38 / 2.00 ms               | 2.05 / 1.69 ms    |
    | 10,000   | 8.22 ms | 35.6 / 11.7 ms               | 10.4 / 10.1 ms    |

- Spend by model adds up the usage the Spend sheet already reads: 0.9 ms for the live data's 47 usage records.
