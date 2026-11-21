# Code health

Agents pay for every line they read. Keep files small and obvious so a task needs one or two files, not ten.

## Conventions

- One concern per file; aim for under ~800 lines. Split before adding to a file over 1,500.
- Start each file with a 1-3 line comment saying what it owns and what it must not do.
- Name files after what they hold (`push-rules.ts`, not `utils2.ts`); no barrel files that hide where code lives.
- Tests sit beside the code (`x.test.ts`); a split moves the tests with the code.
- When behaviour changes, update the matching `docs/agents/*.md` in the same commit. Keep agent docs as plain bullets: no
  markdown tables (prettier pads them to the widest cell; one table here once cost 134 KB per session).
- A split is a pure move: no behaviour change in the same commit, `npm run ci` green before and after.

## Backlog: largest source files (non-test, line counts on 2026-11-21)

Split along the suggested seam, one file per PR, tests moved alongside.

- `src/remote/remote-bridge.ts` (6,147) — one module per phone command kind (`handleCommand` dispatches), the phone view
  builder, publishing/presence
- `src/flotilla/service.ts` (4,491) — publish/invite, members, threads, timeline sync as separate services
- `ios/SqueakCore/Sources/SqueakUI/AppModel.swift` (3,497) — extensions per feature (sessions, channel, settings,
  ponds) in their own files
- `src/squeak/app.ts` (2,940) — Telegram command and callback handlers out of the app wiring
- `src/fleet/hook-ingress.ts` (2,569) — a route table with one file per route group (`/hook`, `/state`, `/control/*`)
- `ios/SqueakCore/Sources/SqueakCore/Models.swift` (2,552) — one file per model family (session, view, commands, ponds)
- `ios/SqueakCore/Sources/SqueakUI/SessionView.swift` (2,461) — subviews (header, feed rows, composer) in own files
- `macos/Sources/SqueakMac/AppModel.swift` (2,337) — extensions per feature, as on iPhone
- `src/native/host.ts` (1,994), `store.ts` (1,577), `server.ts` (1,558) — routes, turn runner, persistence
- `src/voice/memo-inbox.ts` (1,839) — transcription, storage, routing
- `addons/conductor/registry.ts` (1,499) — reads vs writes vs migrations
- Also over 1,000: `NativeHostClient.swift` (1,360), `VoiceSettingsView.swift` (1,291), `Channel.swift` (1,254),
  `natural-voice.ts` (1,246), `inbound-flow.ts` (1,237), `ChannelsModel.swift` (1,214), `WorkbenchSidebar.swift` (1,062)
