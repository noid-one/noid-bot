# The cache keeper in noid: is it worth it?

Pi Pocket 0.26 added a cache keeper (`src/server/cache-keeper.ts`, upstream `53d6a31` … `04da353`): while a run waits on a tool call, it re-sends the last model request with a one-token output cap just before the provider's prompt cache entry expires, when the expected saving is larger than the warm's cost (`0.9 × prompt × (cache write − cache read) > prompt × cache read + one output token`). Pi's own CLI does the same by default (`cacheWarming: "streaming"`). This page is the evidence for taking it into noid, measured on 2026-10-28.

## What was ported

The keeper unchanged except for one line: noid has no limit gate, so a warm goes out with `maxRetries: 0` and no `noWait` (a warm that meets a provider limit fails and stops). The spend changes it needs (`recordModelUsage`, `countedChanged`, the startup re-read from `d6a03b8`), the app wiring (payload observer innermost, keeper outermost, `runEnded` on every run's end, Noid's and bots' included, `close` before spend), and upstream's tests. `PI_POCKET_CACHE_KEEPER=off` turns it off.

## Evidence

**1. Upstream's tests pass on noid** (33 in four files): the decision, timers, the 30-minute cap, late timers after sleep, stale lookups, shutdown, a payload that changed during the wait never reaching the wire (`cache-keeper-payload`, with the real Anthropic adapter and an intercepted `fetch`; noid has no request shapers, so a stand-in shapes the payload), warm usage counted in the session's and the captured payer's spend once, across a restart, and no warm past a spend limit. Plus upstream's startup spend-limit test.

**2. noid's own runs** (`test/cache-keeper-noid.test.ts`, through Pi Durable's real loop): a session whose model has a known cache lifetime is warmed about once a second (an 11 s lifetime) while `bash` sleeps, and not after the run ends; stopping a bot's run while its tool waits stops its warms; a model with no known lifetime is never warmed.

**3. Which of the owner's models it applies to: none today.** It warms only models whose `promptCache` lifetime Pi knows. In Pi 1.4's catalog that is Anthropic's 17 models (5 minutes, or 1 hour), and none of OpenAI's (43), ChatGPT's (`openai-codex`, 7) or any other provider's. The owner is signed in to OpenAI only, and the default model is `openai/gpt-6.1-sol`: for it the keeper returns before doing anything (no hashing, no timers), as the third test shows. It starts to matter if an Anthropic key is added, or when Pi gives OpenAI models a cache lifetime.

**4. What it would have done on the owner's real history** (`node test/cache-keeper-replay.ts <copy of pocket.sqlite>`: every tool wait in the live data, replayed through the real `CacheKeeper` with a fake clock, priced as Claude):

```
Tool waits: 797 (797 followed by a request, 0 not)
Models: openai/gpt-5.6-sol 789, openai/gpt-6.1-sol 8
Gap to the next request: median 0.5 s, p90 4.8 s, p99 25.9 s, max 162 s
Gaps past 300 s: 0 of 797 (0.0%), past 30 min: 0

anthropic/claude-opus-5-5 (5-minute cache): 0 warms costing $0.0000
  cache misses at the next request: 0 → 0; net $0.0000
anthropic/claude-sonnet-5-5 (5-minute cache): 0 warms costing $0.0000
  cache misses at the next request: 0 → 0; net $0.0000
```

No tool wait so far came near the five-minute lifetime, so even on Claude it would have sent nothing and saved nothing: the waits it helps are long ones (a long build or test run, the computer's first start or image rebuild, an approval the owner answers minutes later). The harness on made-up waits shows what it does then (Claude Opus prices, a 60k-token prompt):

```
4 min:            0 warms; miss $0.0000 → $0.0000, warms $0.0000, net  $0.0000
6 min:            1 warm at 270 s; miss $0.2880 → $0.0000, warms $0.0120, net +$0.2760
12 min:           2 warms; miss $0.2880 → $0.0000, warms $0.0240, net +$0.2640
40 min:           6 warms (to the 30-minute cap); miss stays, warms $0.0721, net −$0.0721
no next request:  6 warms (the worst case: in the app the run's end stops them sooner), net −$0.0721
```

So the trade is about +$0.22 to +$0.28 for each wait of 5 to 30 minutes (more warms toward 30 minutes), a cent lost on one that ends between 4.5 and 5 minutes (one warm, no miss to save), against at most −$0.07 for one past 30 minutes or one whose run is stopped mid-wait without the end reaching the keeper (the cap bounds it). A wait on an approval the owner answers after half an hour loses that −$0.07.

**5. Its cost on every request.** For a model with a known lifetime it hashes the request it sends, on the event loop, once per request and once per warm: about 2 ms for a 440 KB payload of large text blocks, up to about 15 ms for 600 KB of many small blocks, closer to a long transcript (measured by the review). For the others, nothing.

## Verdict

Good enough to take: it is upstream's code with its tests passing here, it follows Pi's own default, it never warms a request whose payload changed, it charges warms to whoever pays for the run and stops at their limit, and it is inert for every model the owner uses today. Its benefit is real only for Claude with tool waits longer than five minutes, which the owner's history does not have yet; if that changes, run the replay again on a copy of the data.
