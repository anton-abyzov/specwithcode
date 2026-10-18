# SpecWithCode for iPhone: architecture

A native SwiftUI client that controls SpecWithCode on your machines: Aide, project
coordinators, threads and the essential settings. It talks to the servers machines
already run (orchestration protocol 2), so it needs no server change.

## Decisions

- Swift 6 with complete concurrency checking, SwiftUI, iOS 26 minimum, iPhone first.
- XcodeGen (`project.yml`) for the app shell; everything else is one local Swift package,
  `SWCKit`, so the protocol and sync layers test with `swift test` on macOS.
- No third-party dependencies. Markdown uses Foundation's `AttributedString` plus a small
  block parser.
- New bundle id `com.specwithcode.ios` (`.dev` in Debug), installable beside the Expo app.
- Weave design system: iris accent, Schibsted Grotesk, designed light and dark themes.

## Layout

```
apps/ios/
  project.yml                 XcodeGen spec (the .xcodeproj is generated, not committed)
  Makefile                    project, build, test-core, test-app, shots
  App/                        @main entry, scene phase and device name glue, assets,
                              PrivacyInfo.xcprivacy
  App/Tests/                  unit tests of the app shell (SpecWithCodeTests)
  UITests/
  SWCKit/
    Sources/SWCWire/          Codable wire types: envelopes, shell, thread projection, commands
    Sources/SWCTransport/     HTTP, pairing links, token exchange, Keychain, RpcSocket, supervisor
    Sources/SWCSync/          AppModel (UI contract), LiveEngine, reducers, FixtureEngine
    Sources/Weave/            tokens, fonts, reusable components
    Sources/SWCFeatures/      screens: drawer, chat, overview, settings, pairing
  Tools/                      fixture capture, screenshot scripts
```

Dependency direction: `SWCWire <- SWCTransport <- SWCSync <- SWCFeatures`; `Weave` depends on
nothing. Views read only `AppModel` and `ChatSession` (`SWCSync/AppModel.swift`). An `AppEngine`
fills them: `LiveEngine` for real machines, `FixtureEngine` for previews and screenshots
(launch argument `-SWCFixture`).

## Protocol

Per machine:

1. `GET /.well-known/studio/environment` (no auth). Require `orchestrationProtocolVersion == 2`
   (missing means 1). Check `environmentId` before spending a pairing code.
2. Pairing link: `http(s)://host[:port][/pair]#token=CODE` (also `?token=`, `?host=&token=`,
   `studio:…?pairingUrl=<url>`). Keep the origin only.
3. `POST /oauth/token`, form-encoded: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
   `subject_token=CODE`, `subject_token_type=urn:specweave-studio:params:oauth:token-type:environment-bootstrap`,
   `requested_token_type=urn:ietf:params:oauth:token-type:access_token`, `client_device_type=mobile`,
   `client_os=iOS`, `client_label=<device name>`: the `deviceLabel` user default when set, else
   `UIDevice.name`, which is only "iPhone" without the user-assigned-device-name entitlement. Response `{access_token, expires_in (30 days), scope}`.
   No refresh: warn before expiry, re-pair after.
4. `POST /api/auth/websocket-ticket` with `Authorization: Bearer` gives `{ticket, expiresAt}` (5 min).
5. `wss://host/ws?wsTicket=…&orchestrationProtocol=2&clientSurface=mobile&clientOs=iOS&clientDeviceType=phone&connectionMethod=direct`.
   Set `maximumMessageSize` to 32 MiB.

Frames are Effect RPC JSON, one value per text frame:

```
→ {"_tag":"Request","id":7,"tag":"orchestration.subscribeShell","payload":{"requestCompletionMarker":true},"headers":[]}
← {"_tag":"Chunk","requestId":7,"values":[…]}      → {"_tag":"Ack","requestId":7}   (ack every chunk, after applying it)
← {"_tag":"Exit","requestId":7,"exit":{"_tag":"Success","value":…}}
← {"_tag":"Exit","requestId":7,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{…}}]}}
→ {"_tag":"Interrupt","requestId":7}                 (unsubscribe / cancel)
→ {"_tag":"Ping"} every 5 s                          ← {"_tag":"Pong"}; reconnect after 3 missed
← {"_tag":"Defect","defect":…}                       socket-level, socket stays usable
```

The server blocks a stream until it receives the `Ack` for the previous chunk.

Methods the app uses: `server.getConfig`, `orchestration.subscribeShell`,
`orchestration.subscribeThread`, `orchestration.dispatchCommand` (`message.dispatch`,
`run.interrupt{holdQueue:true}`, `runtime-request.respond`, `thread.pin|unpin|settle|unsettle|archive|delete|visit|mark-unread|metadata.update`),
`orchestration.launchThread`, `projects.coordinatorSend`, `projects.coordinatorStart`,
`projects.workspaceRead`, `projects.mutate` (`project.update` with `workspaceSettings.expectedRevision`),
`projects.createNew` (Aide: `kind: "personal"`), `server.getSettings`, `server.updateSettings`.

## Routing

- Aide: the project whose `workspaceSettings.kind == "personal"`; lowest `environmentId` wins
  if several machines have one. Chat = its coordinator.
- Project: `projects.coordinatorSend{projectId, commandId, prompt}`. Transcript from
  `subscribeThread(coordinatorThreadId ?? "project-coordinator:<projectId>")`.
- Thread: `message.dispatch` on the thread's machine: `start_immediately` when idle,
  `queue_after_active` while a run is active.
- Other machines: the app keeps one socket per paired machine and scopes everything by
  `environmentId`. Aide and coordinators also reach machines through their own tools.

## State

- One `EnvironmentSync` per machine: `subscribeShell{afterSequence?, requestCompletionMarker:true}`
  into a shell reducer ported from `packages/client-runtime/src/state/shellReducer.ts`.
  A snapshot with `resolvedRepositoryIdentityRoots` is a metadata patch, never a replacement.
  Ignore items with `sequence <= snapshotSequence`.
- One thread subscription per open conversation. Render `visibleTurnItems`.
- Sends mint a UUID `commandId` (and `messageId`) and reuse them on retry; the server dedupes.
- Unread = `latestRunCompletedAt > lastVisitedAt` (null `lastVisitedAt` counts as read).
- Working = run status `preparing|queued|starting|running|waiting` or a pending runtime request.

## Lifecycle

- `.background` calls `AppEngine.setActive(false)`: each machine's supervisor closes its socket and
  stops reconnecting. `.active` calls `setActive(true)`: it reconnects at once, without backoff.
- `.inactive` changes nothing. It is transient (Control Center, the notification shade, the app
  switcher, call banners, Face ID and permission alerts), and closing sockets for it would drop
  every subscription, fail commands in flight and flash machines offline.
  `App/EngineActivity.swift` holds the mapping; `App/Tests` covers it.

## Design

Weave tokens (light / dark): canvas `#f8f7f9`/`#16131d`, panel `#ffffff`/`#201c29`, sunken
`#efedf2`/`#110e17`, ink `#241523`/`#f3eff9`, muted `#675d69`/`#a69fb2`, line `#dedae5`/`#322c3e`,
control `#8c8399`/`#776d8a`, iris `#6d4fb5`/`#a88cf6`, iris-strong `#4a3678`/`#cbbcff`, iris-tint
`#ece6f8`/`#2b2340`, on-iris `#ffffff`/`#1b1328`, pass/warn/fail from the Weave tokens.

Layout follows a simple chat-first phone pattern: a drawer (Aide, pinned projects, recents, machines,
settings), a project that opens as its coordinator chat, an overview with threads grouped as
Working and Idle, a thread view with a menu, a capsule composer with send, queue and stop, a
project settings sheet and a short global settings sheet. Every tap target is at least 44 pt;
text follows Dynamic Type.

## Not in v1

Push notifications and Live Activities (need a relay or an APNs sender), attachments,
terminal and diffs, iPad layout, relay and SSH routes.
