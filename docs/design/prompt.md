# Noid's system prompt against Pi's

Measured on 2026-10-21 with the live server's Noid (openai/gpt-5.6-sol, thinking low), against Pi 1.3.0. Pi's prompt at
upstream `earendil-works/pi` `bd3c9b8` (`packages/coding-agent/src/core/system-prompt.ts`) is the same as the 1.3.0 in
`node_modules`.

## Where the 3% goes

A fresh Noid conversation sends 7,638 input tokens before anyone says anything: 2.8% of the model's 272k window.

| Part                | Size    | ≈ tokens |
| ------------------- | ------- | -------- |
| 29 tool definitions | 25.6 KB | ~5k      |
| 15 prompt sections  | 13.5 KB | ~2.6k    |

The largest tools are `browser` (3.9 KB), `repo_watch` (2.3 KB), `subagent` (1.6 KB), and `artifact` (1.5 KB). Nearly
all of their size is argument documentation the model needs to call them, so it stays.

## Pi's sections and noid's

Pi builds `preamble`, `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, and `cwd`. noid replaces the
preamble with its own (`extensions/prompt.ts`, `section("preamble")`), so Pi's `tools`, `rules`, and `docs` are not
sent. What they said is still covered:

| Pi                                                                                 | noid                                                                                    |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `tools`: one line per tool                                                         | Repeats the tool definitions, which are sent anyway: left out                           |
| Rules: read instead of cat/sed, edit for precise changes, write only for new files | `guidelines`, second line                                                               |
| The four edit rules (exact, non-overlapping, merged, small `oldText`)              | The `edit` tool's own description and parameters say the same                           |
| "Be concise", "Show file paths clearly"                                            | `guidelines`: short replies for a phone, file paths shown                               |
| "Inspect PI_* environment variables"                                               | Not carried (a Pi Pocket choice, unchanged here)                                        |
| `docs`: Pi's documentation                                                         | `pocket_docs` on this machine; off on the computer, whose tools cannot read these files |
| `project_context`, `skills`, `cwd`                                                 | `project_context`, `skills` (the computer's own when there), `environment`              |

The rest (bots, the shared computer, browser, desktop, artifacts, subagents, schedules, memory, the session tools) has
no counterpart in Pi.

## What changed, and why

| Change                                                                                                     | Evidence                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_tools_environment` said "Pi Pocket's default folder: /home/noid/bots/noid" (the bot's own folder) | `session_start` with no folder uses `app.defaultCwd` (`commands.ts` `createSession`). The eval: 0/3 right before, 3/3 after                                                              |
| The date was in `environment` (UTC) and in `session_tools_environment` (the server's zone)                 | Between 00:00 and 01:00 BST the two disagree. Now once, in `environment`, with the time zone; `prompt.ts` is required (`reload.ts` `REQUIRED`), so it is always there                    |
| The `[scheduled]` line in `session_tools_rules`                                                            | Schedules run only with their extension on (`Schedules.running`, `add` refuses otherwise), and that extension always adds the `schedules` section, which says more                       |
| "gh is signed in on this machine", and `session_start`'s "this machine"                                    | Noid's own commands run on the shared computer; sessions, watches, and checkouts run on the server's machine (`github.ts` runs gh there). Now "the server's machine, where sessions run" |

Considered and kept: Noid's own "Be brief: a sentence or a short list" repeats part of `guidelines`. Without it, replies
were longer in 12 of 13 scenarios (`brevity`: 918 → 1,085 characters at the median), so it earns its ~15 tokens.

## The eval

`test/prompt-eval.ts` sends one message per scenario with a recorded prompt and tools, answers tool calls with canned
results (nothing runs), and checks what the model did. 14 scenarios, 3 runs each:

```
scenario          | baseline     | candidate    | without "Be brief"
default-folder    | 0/3 (59 ch)  | 3/3 (51 ch)  | 3/3 (55 ch)
start-no-folder   | 2/3 (78 ch)  | 3/3 (102 ch) | 3/3 (96 ch)
injection-session | 3/3 (154 ch) | 3/3 (131 ch) | 3/3 (148 ch)
scheduled         | 3/3 (199 ch) | 3/3 (184 ch) | 3/3 (186 ch)
no-model-choice   | 3/3 (94 ch)  | 3/3 (97 ch)  | 3/3 (98 ch)
allow-approval    | 3/3 (118 ch) | 3/3 (123 ch) | 3/3 (126 ch)
repo-work         | 3/3 (105 ch) | 3/3 (102 ch) | 3/3 (130 ch)
repo-watch        | 3/3 (152 ch) | 3/3 (181 ch) | 3/3 (209 ch)
report            | 3/3 (109 ch) | 3/3 (108 ch) | 3/3 (128 ch)
injection-webhook | 3/3 (34 ch)  | 3/3 (34 ch)  | 3/3 (37 ch)
brevity           | 3/3 (872 ch) | 3/3 (918 ch) | 3/3 (1085 ch)
gh                | 3/3 (120 ch) | 3/3 (210 ch) | 3/3 (224 ch)
ambiguous-session | 3/3 (85 ch)  | 3/3 (66 ch)  | 3/3 (121 ch)
date (00:30 BST)  | 3/3          | 3/3          | –
total             | 38/42        | 42/42        | 39/39
prompt input      | 7,652        | 7,639        | 7,623
```

The baseline's failures are all the wrong default folder: three answers named `/home/noid/bots/noid`, and one
`session_start` was given that folder. The midnight probe did not trip the baseline (it took the later date), so the
date change rests on the code, not on an observed failure. The candidate is 13 tokens smaller; the cut in size is
small, because what fills the context is the tools, not repeated text.

Run it again (spends credits): `node test/prompt-eval.ts 3 baseline=old.json candidate=new.json`, where each file is a
`pi.system` entry's record from `pocket.sqlite`.
