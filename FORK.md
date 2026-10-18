# Fork notes

noid started as a copy of [Pi Pocket](https://github.com/TannerMidd/pi-pocket) (MIT, Tanner Middleton), copied on 2026-10-18.

- Upstream commit at copy time: `2c6faa45c10671c556d8886dd0b9d0c165257a56` (v0.16.0).
- History was not kept (fresh `git init`). To see what upstream changed since this copy, run `git diff 2c6faa45c10671c556d8886dd0b9d0c165257a56 main` in a separate clone of pi-pocket, then port changes by hand.
- The Pi Pocket license is kept in `LICENSE`. Files later adapted from [rakazo](https://github.com/elie222/rakazo) (Apache-2.0), such as the computer image, must keep its license and NOTICE next to them.

## Core files changed from upstream

Our own features go in `src/server/extensions/noid-*.ts`, with `x.noid.*` document, task and tool names. Changes to Pi Pocket's core files are listed here, one line each with the reason.

| File | Why |
|---|---|
| `src/server/memory.ts`, `src/server/extensions/memory.ts` | Memory auto-saves: Pi's lessons for the owner apply at once (guests' still wait). Tests and docs updated to match. |
| `web/style.css` | Styles for bot faces (`web/faces/`), appended at the end. |

## Node version

Use Node 22 (`.nvmrc`). On Node 26, 17 of upstream's tests fail at startup with `Cannot access 'PocketApp' before initialization`, which looks like a change in how Node 26 handles module cycles; on Node 22 everything passes.
