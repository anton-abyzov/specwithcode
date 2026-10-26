# SpecWithCode for iPhone: architecture

A native SwiftUI client that controls SpecWithCode on your machines: Aide, project
coordinators, threads and the essential settings. It talks to the servers machines
already run (orchestration protocol 2), reached through SpecWithCode Connect (sign in,
managed tunnel) or a direct pairing.

## Decisions

- Swift 6 with complete concurrency checking, SwiftUI, iOS 26 minimum, iPhone first.
- XcodeGen (`project.yml`) for the app shell; everything else is one local Swift package,
  `SWCKit`, so the protocol and sync layers test with `swift test` on macOS.
- One third-party dependency, the Clerk iOS SDK (`ClerkKit`), in the app target only, for
  Connect sign-in. `SWCKit` reaches it through the `ConnectAccount` protocol, so the package
  still has no third-party dependencies. Markdown uses Foundation's `AttributedString` plus a
  small block parser.
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
    Sources/SWCTransport/     HTTP, pairing links, token exchange, Keychain, RpcSocket, supervisor,
                              Connect: ConnectConfig, Dpop, RelayClient, ConnectAuthorizer
    Sources/SWCSync/          AppModel (UI contract), LiveEngine, reducers, FixtureEngine
    Sources/Weave/            tokens, fonts, reusable components
    Sources/SWCFeatures/      screens: drawer, chat, overview, settings, pairing, device viewer
  App/Generated/              device-stream.js, bundled by `make project` (not committed)
  Tools/                      fixture capture, screenshot scripts, device stream bundler
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

## Connect route

Settings come from `Info.plist` (`ConnectConfig.main()`); without them `AppModel.connect` is nil
and every Connect screen is hidden. The app target supplies a `ConnectAccount` backed by Clerk
(`App/ClerkConnectAccount.swift`); `LiveEngine+Connect.swift` does the rest.

- Sign-in: Clerk (Sign in with Apple first, App Store guideline 4.8). The account gives a JWT
  from the relay's JWT template; Clerk keeps its own session in the Keychain.
- DPoP: one P-256 key per phone, in the Secure Enclave (Keychain key on the simulator). Proofs
  are ES256 compact JWS with `htm`, `htu` (no query or fragment), `iat`, `jti` and, with a
  token, `ath`; `Tools/verify-dpop-vectors.mjs` checks them with `packages/shared/src/dpop.ts`.
- `RelayClient` (actor): token exchange at `/v1/client/dpop-token` with a cached token per scope
  set, then `/v1/environments`, `/status`, `/connect` and `/v1/mobile/devices`. A 401 refreshes
  the Clerk JWT and exchanges again once.
- Machines: each listed environment becomes a `MachineRecord` with a `connectRoute` (issuer
  `connect`, the tunnel's https and wss URLs), next to any direct routes. `ConnectAuthorizer`
  redeems a one-time bootstrap credential at `<tunnel>/oauth/token` and caches the resulting
  DPoP session in the credential store; `MachineConnection` signs requests with the same key.
  When the session expires or is rejected it bootstraps again, so Connect machines never need
  re-pairing. An offline Mac is listed with when the relay last checked it, not as an error.
- Sign-out unregisters push; account deletion calls `DELETE /v1/client/account`, which removes
  the account's links, devices and Clerk user on the relay (retried on `upstream_unavailable`).
  Both then drop Connect-only machines and strip the `connectRoute` from machines that also have
  a direct pairing.
- Push: in builds signed with `Config/Connect.entitlements`, the app registers its APNs token
  with the relay after sign-in (`LiveEngine+Push.swift`, `App/PushRegistration.swift`). The
  relay sends the notifications; the app shows them with the system defaults.

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

## Devices

- `subscribeDeviceState` (`{}`, scope `orchestration:read`) streams `DeviceServiceState`: hosts,
  open simulator and emulator sessions, and `hubPath`. `MachineDevices` groups sessions by
  `[hostId, deviceId]` (the Expo key) and merges their thread ids. An authorization error means the
  pairing lacks the scope; any other error before the first state means the server has no device
  support. Both show as a message, not a failure.
- Entry points: the thread toolbar (a picker when several devices belong to the thread) and the
  machine's Devices card. `LaunchRoute.device` opens the first one for screenshots.
- The viewer is a full-screen `WKWebView` that loads `App/Generated/device-stream.js`, the same
  transport the Expo app embeds (`apps/mobile/src/features/devices/device-stream.browser.ts`),
  with `baseURL` `file:///`. Each attempt mints a fresh ticket (`POST /api/auth/websocket-ticket`,
  bearer or DPoP) and connects to `<origin><hubPath>?wsTicket=…&hostId=…`. The page posts
  `unauthorized`, `retry`, `input` and `status` through the `stream` message handler; the first
  two mint a new ticket and reload. It stops on dismiss and in the background, allows landscape
  while open, and returns to portrait on close.

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

Live Activities, opening a thread from a notification, attachments, terminal and diffs,
iPad layout, SSH routes.
