# Fork notes

noid started as a copy of [Pi Pocket](https://github.com/TannerMidd/pi-pocket) (MIT, Tanner Middleton), copied on 2026-10-18.

- Upstream commit at copy time: `2c6faa45c10671c556d8886dd0b9d0c165257a56` (v0.16.0).
- History was not kept (fresh `git init`). To see what upstream changed since this copy, run `git diff 2c6faa45c10671c556d8886dd0b9d0c165257a56 main` in a separate clone of pi-pocket, then port changes by hand.
- The Pi Pocket license is kept in `LICENSE`. Files later adapted from [rakazo](https://github.com/elie222/rakazo) (Apache-2.0), such as the computer image, must keep its license and NOTICE next to them.

## Core files changed from upstream

Our own features go in `src/server/extensions/noid-*.ts`, with `x.noid.*` document, task and tool names. Changes to Pi Pocket's core files are listed here, one line each with the reason.

| File                                                                                             | Why                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/memory.ts`, `src/server/extensions/memory.ts`                                        | Memory auto-saves: Pi's lessons for the owner apply at once (guests' still wait). Tests and docs updated to match.                                                  |
| `web/style.css`                                                                                  | Styles for bot faces (`web/faces/`), appended at the end.                                                                                                           |
| `src/server/app.ts`, `src/server/host.ts`                                                        | The shared computer is part of the app (`app.computer`, claims `/home/noid/…` always, fails closed); environment providers (`envFor`, `envAt`, `claims`, `onHost`). |
| `src/server/workspace.ts`, `src/server/http/conversation-routes.ts`, `src/server/http/assets.ts` | Viewer, `@` list, and images of a computer session through its environment; git features refuse it; folders made there.                                             |
| `src/server/commands.ts`                                                                         | Computer sessions: folders made there, no worktrees, `@` mentions read there, attachments copied there.                                                             |
| `src/server/extensions/prompt.ts`                                                                | Computer sessions: AGENTS.md read there; no host skills or Pi Pocket docs; platform says so.                                                                        |
| `src/server/http/api.ts`, `src/server/watches.ts`                                                | Folder picker skips computer folders; PR watches refuse computer sessions (they use host git/gh).                                                                   |
| `test/public-types.ts`                                                                           | `onHost` is an internal host member.                                                                                                                                |
| `src/server/extensions/codemode.ts`                                                              | Its overflow file goes through the call's environment, so a computer session can read it.                                                                           |
| `src/server/docs.ts`, `src/server/commands.ts`                                                   | Bots: `SessionMeta.bot`; `createSession` takes a bot profile and instructions; Noid cannot be archived; `MAX_INSTRUCTIONS` exported.                                |
| `src/server/app.ts`, `src/server/http/api.ts`                                                    | `app.bots`, Noid on open (`mainBot` option), the approvals extension installed as part of the app, "always allow" rules; `/api/bots` routes.                        |
| `src/server/extensions/prompt.ts`                                                                | A bot's own preamble.                                                                                                                                               |
| `web/sessions.js`, `web/app.js`, `web/sheets.js`, `web/store.js`, `web/transcript.js`            | Bots list with faces, the bot sheet, the face in the top bar, "Always allow" on approval cards.                                                                     |
| `test/helpers.ts`, `test/serve.ts`                                                               | `openApp` takes `mainBot` (off in tests, on for the throwaway server).                                                                                              |
| Built-in extensions and tests (`content` → `output`)                                             | Pi Durable 1.2+ tool results.                                                                                                                                       |

## Node version

Use Node 22 (`.nvmrc`). On Node 26, 17 of upstream's tests fail at startup with `Cannot access 'PocketApp' before initialization`, which looks like a change in how Node 26 handles module cycles; on Node 22 everything passes.
