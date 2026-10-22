# SpecWithCode for iPhone

A native SwiftUI app for controlling SpecWithCode on your own machines from your phone. You can talk to Aide, follow project coordinators and threads, answer approvals and change a few settings. It talks to the server each machine already runs (orchestration protocol 2). It reaches that server in one of two ways: through SpecWithCode Connect, where you sign in with the same account as on the Mac and it works from anywhere, or through a direct pairing with a link or QR code.

The design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short, `App/` contains only the `@main` entry point, its scene-phase and device-name glue, assets, the privacy manifest and the shell's unit tests (`App/Tests`). Everything else lives in the local Swift package `SWCKit`:

| Module         | Contents                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `SWCWire`      | Codable wire types                                                                                  |
| `SWCTransport` | HTTP, pairing, Connect (relay client, DPoP), Keychain, the RPC socket and the connection supervisor |
| `SWCSync`      | The UI model, `LiveEngine`, reducers and `FixtureEngine`                                            |
| `Weave`        | Design tokens and components                                                                        |
| `SWCFeatures`  | Screens                                                                                             |

## Requirements

- Xcode 26.3 or later, with the iOS 26 simulator runtime
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
- macOS 15 or later, which `swift test` needs

The `.xcodeproj` is generated from `project.yml` and is not committed.

## Build

Run these from `apps/ios`:

```sh
make project                    # xcodegen generate
make build                      # simulator build into build/DerivedData
make test-core                  # swift test for SWCKit (wire, transport, sync, features) on macOS
make test-app SIM_UDID=<udid>   # unit tests of the app shell (App/Tests) on that simulator
make shots SIM_UDID=<udid>      # fixture screenshots on that simulator (see Screenshots)
```

`test-app` and `shots` stop with a usage error when `SIM_UDID` is not set. List simulators and their UDIDs with `xcrun simctl list devices`.

The app target depends on the Clerk iOS SDK (`clerk-ios`, pinned in `project.yml`), which Xcode fetches with Swift Package Manager. If package resolution fails with `Git command '... config --get remote.origin.url' failed`, your global Git config probably sets `safe.bareRepository=explicit`, which breaks SwiftPM's bare clones. Allow them for one build without changing your config:

```sh
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all make build
```

`node Tools/verify-dpop-vectors.mjs` (from `apps/ios`, Node 22) checks the app's DPoP proofs with the relay's own TypeScript verifier (`packages/shared/src/dpop.ts`). It runs `swift test` to generate proofs, verifies each one, and confirms that tampered copies are rejected.

## Run in the simulator

1. Run `make project`, then open `SpecWithCode.xcodeproj`.
2. Choose the `SpecWithCode` scheme and an iPhone simulator, then run.

You can also run it from the command line once a simulator is booted:

```sh
xcrun simctl install booted build/DerivedData/Build/Products/Debug-iphonesimulator/SpecWithCode.app
xcrun simctl launch booted com.specwithcode.ios.dev
```

Debug builds use the bundle id `com.specwithcode.ios.dev` and appear as "SpecWithCode Dev". This means they can sit next to the release build and the Expo app.

Simulator builds need no signing. To build for a device, set `STUDIO_APPLE_TEAM_ID` to your team id before you run `make project`.

To put the current Release build on your own phone without waiting for TestFlight, run `DEVICE=<name> STUDIO_APPLE_TEAM_ID=… Tools/device.sh` (`Tools/device.sh list` shows device names). It builds, installs over any TestFlight copy and launches; the header of the script lists the optional settings.

`Tools/device.sh help` (also `--help` or `-h`) shows usage. Unsupported arguments stop before building or installing. Any launch failure, including a locked phone, returns the original nonzero exit status even when installation succeeded; the original `devicectl` diagnostic remains visible.

Run `bash Tools/test-device.sh` for the isolated shell regression checks; all build and device commands are stubbed.

## Simulator-first testing

Routine checks run on a simulator, never on a phone: nobody has to unlock an iPhone or watch a screen. `Tools/sim.sh` creates one dedicated simulator ("SWC Sim-First", iPhone 17 Pro on the newest iOS runtime), boots it with `simctl` without opening the Simulator app, and keeps every build and test on it. It also drops the `GIT_CONFIG_*` variables some agent harnesses inject, which break SwiftPM inside `xcodebuild`.

```sh
make sim-smoke                                   # boot, build for testing, run every fixture UI test
make sim-test ONLY=SpecWithCodeUITests/AideHistoryUITests
make sim-run FIXTURE=long                        # install, launch on fixture data, save a screenshot
bash Tools/sim.sh link 'specwithcode://thread/env-studio-mac/t-release'
bash Tools/sim.sh logs 10                        # the app's log from the last 10 minutes
make sim-stop
```

Each test run writes `build/sim-first/<time>/` with the result bundle, `summary.json`, the test log and every screenshot the tests attach. Set `SIM_NAME` to give a worktree its own simulator so parallel runs don't collide.

What the simulator covers: every screen on fixture data, long chats and scrolling (`long` fixture), links, deep links, background and foreground, drafts, machine outages (`m4-blip`, `minis-blip`), and pairing UI. SWCKit's wire, transport and sync logic runs in `make test-core` on macOS. Keep a physical iPhone for what a simulator can't prove: push notification delivery, Sign in with Apple and signing, the real network path from the phone (cellular, Tailscale or the Connect relay), the Secure Enclave key, and a final acceptance pass on a release build. Ask before such a run and say which of these it proves.

## Fixture mode

The app can run on sample data without a machine. To use it, add launch arguments in the scheme (Edit Scheme > Run > Arguments) or after `simctl launch`:

| Argument                 | Values                                                                                      | Effect                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `-SWCFixture [scenario]` | `default`, `empty`, `running`, `fleet`, `m4-blip`, `minis-blip`, `long`                     | Uses sample data instead of real machines. With no scenario it uses `default`. |
| `-SWCAppearance`         | `light`, `dark`, `system`                                                                   | Forces an appearance.                                                          |
| `-SWCRoute`              | `overview`, `settings`, `projectSettings`, `machines`, `pair`, `thread`, `drawer`, `search` | Opens that screen once the data has loaded.                                    |

For example:

```sh
xcrun simctl launch booted com.specwithcode.ios.dev -SWCFixture running -SWCAppearance dark -SWCRoute thread
```

Without `-SWCFixture` the app uses `LiveEngine` and connects to your paired machines.

## Screenshots

`make shots SIM_UDID=<udid>` runs `Tools/shots.sh`, which shoots every launch route in light and dark on fixture data and writes the PNGs to `build/shots`, plus a contact sheet per appearance when Pillow is installed. Boot the simulator first. The script installs the Debug build from `build/DerivedData` when there is one, relaunches the app many times and switches the simulator between light and dark, so it needs the UDID of a simulator you can spare: it refuses to run without one. It accepts `booted` only while exactly one simulator is booted. When it exits, even on failure or Ctrl-C, it puts the simulator's appearance and content size back as they were.

Environment variables: `ROUTES` (the routes to shoot), `WAIT` (seconds after each launch, default 3), `CONTENT_SIZE` (a content size category such as `accessibility-large`), `SHEET=0` (skip the contact sheets). Run `Tools/shots.sh` directly to pass a different derived data folder or output folder.

## Sign in with SpecWithCode Connect

With Connect configured, the welcome screen leads with sign-in: Sign in with Apple, plus Google and GitHub when the build offers them. After sign-in the app lists every Mac linked to that account, online or offline (with when it was last checked). Tap one to open it. There is nothing to pair, and it works on any network because each Mac is reached through its managed tunnel hostname. The relay is never in the traffic path.

How it connects (`SWCTransport/RelayClient.swift`, `ConnectAuthorizer.swift`):

1. The Clerk SDK signs the person in and keeps its session in the Keychain. The app asks it for a JWT from the relay's JWT template.
2. The app exchanges that JWT at `POST /v1/client/dpop-token` for a relay access token bound to the phone's DPoP key. The key is a P-256 key in the Secure Enclave; the simulator, which has no Secure Enclave, uses a Keychain key instead.
3. `GET /v1/environments` lists the account's Macs, and `GET /v1/environments/:id/status` says whether each is online.
4. To open a Mac, `POST /v1/environments/:id/connect` returns a one-time credential bound to the same key. The app redeems it with the Mac at `https://<tunnel>/oauth/token`, which returns a normal DPoP-bound session. All HTTP and WebSocket traffic then goes to the tunnel hostname.
5. When the session expires or the Mac rejects it, the app gets a new credential the same way. Nobody pairs again.

Settings > Account has Sign out and Delete account. Deleting calls the relay's `DELETE /v1/client/account` with the Clerk session token; the relay unlinks every Mac on the account, removes its devices and push registrations, and deletes the Clerk user (App Review 5.1.1(v)). The call is idempotent, so the app retries a `500` with reason `upstream_unavailable` up to three times before showing the error, and stays signed in until it succeeds. Signing out forgets the Macs that came from the account and keeps any you paired directly.

### Build settings

Connect is configured at build time from environment variables that `project.yml` copies into `Info.plist`. Only public values go here; there are no secrets. When `STUDIO_CLERK_PUBLISHABLE_KEY` or `STUDIO_RELAY_URL` is unset or invalid, the app hides Connect and works exactly as before: direct pairing only.

| Environment variable            | Info.plist key            | Value                                                                                                   |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `STUDIO_CLERK_PUBLISHABLE_KEY`  | `SWCClerkPublishableKey`  | Clerk publishable key (`pk_live_…` or `pk_test_…`)                                                      |
| `STUDIO_RELAY_URL`              | `SWCRelayURL`             | Relay base URL, `https://…` (`http://localhost` or `127.0.0.1` for a local relay)                       |
| `STUDIO_CLERK_JWT_TEMPLATE`     | `SWCClerkJWTTemplate`     | Clerk JWT template the relay accepts; defaults to `studio-relay`                                        |
| `STUDIO_CLERK_OAUTH_PROVIDERS`  | `SWCClerkOAuthProviders`  | Extra sign-in methods beside Apple, comma-separated: `google`, `github`                                 |
| `STUDIO_CODE_SIGN_ENTITLEMENTS` | `SWCCodeSignEntitlements` | `Config/Connect.entitlements` to sign with Sign in with Apple and push; leave unset for unsigned builds |

Set them, then run `make project`:

```sh
export STUDIO_CLERK_PUBLISHABLE_KEY=pk_live_… STUDIO_RELAY_URL=https://relay.example.com STUDIO_CLERK_OAUTH_PROVIDERS=google,github
export STUDIO_CODE_SIGN_ENTITLEMENTS=Config/Connect.entitlements STUDIO_APPLE_TEAM_ID=…
make project build
```

`Config/Connect.entitlements` adds Sign in with Apple and `aps-environment` (`development` in Debug, `production` in Release). It is opt-in because automatic signing fails until the App ID and its provisioning profile have both capabilities. Without it, Sign in with Apple cannot complete on a device, and the app never asks for notification permission.

What the owner sets up in Clerk and Apple (not in this repo):

- Clerk: the Apple, Google and GitHub social connections; a native application for bundle ids `com.specwithcode.ios` and `com.specwithcode.ios.dev` with the Apple team id; and the JWT template the relay verifies (`STUDIO_CLERK_JWT_TEMPLATE`, audience as in `docs/operations/connect-setup.md`).
- Apple: Sign in with Apple and Push Notifications on the App ID; an APNs key for the relay.

### Notifications

In a build signed with `Config/Connect.entitlements`, the app asks for notification permission after sign-in and registers its APNs token with the relay at `POST /v1/mobile/devices` (scope `mobile:registration`), with `apsEnvironment` `sandbox` in Debug and `production` in Release. Signing out removes the registration (`DELETE /v1/mobile/devices/:id`) first; deleting the account leaves that to the relay. The device id is a random UUID kept in `UserDefaults` (`SWCConnectDeviceId`).

## Pair with a link or QR code (advanced)

Direct pairing works without an account and without Connect. On the welcome screen it is "Pair with a link or QR code"; once you are signed in it is under Machines.

1. On your computer, open SpecWithCode, go to Settings > Connections and choose Pair a phone. It shows a QR code for the address the phone can reach: the machine's Tailscale HTTPS name (the phone needs the Tailscale app) or, with Network access on, its address on your Wi-Fi. If no address is offered, turn on Tailscale HTTPS or Network access first. A pairing link works once and expires after 5 minutes.
2. On the phone, tap Pair a machine. Then either scan the QR code, or paste the pairing link (it looks like `https://host:port/pair#token=…`) and tap Connect.

The phone must be able to reach the machine on your local network, over Tailscale or at a public address. Before it uses the pairing code, the app checks that the machine speaks orchestration protocol 2. It then exchanges the code for a 30-day token and stores the token in the Keychain. There is no refresh: when the token expires, pair again. Removing a machine in the app deletes its token from the phone but does not tell the machine; revoke the phone under Settings > Connections > Authorized clients on the computer to end its access sooner.

The computer lists each paired phone by the name the phone sends when it pairs. The app sends the name stored under the `deviceLabel` user default when one is set (for example by a field bound to `@AppStorage("deviceLabel")`; the app reads it at launch), and otherwise the system device name. iOS only gives apps the name the user gave the phone when they hold the `com.apple.developer.device-information.user-assigned-device-name` entitlement; without it the system name is just "iPhone". The app does not request that entitlement yet, because automatic signing fails while the provisioning profile lacks it. Once Apple grants it, add `App/SpecWithCode.entitlements` with that key set to `true` and set `CODE_SIGN_ENTITLEMENTS: App/SpecWithCode.entitlements` under `targets.SpecWithCode.settings.base` in `project.yml`. A new name only applies to pairings made after it; the server cannot rename an existing pairing.

A link can also start pairing: `specwithcode://pair?link=<URL-encoded pairing link>` opens the pair screen with the link already filled in. `specwithcode://thread/<environmentId>/<threadId>` opens a thread.

## App Store

`App/PrivacyInfo.xcprivacy` declares no tracking and no collected data: the app talks only to the user's own machines. It declares one required-reason API, `UserDefaults` (reason `CA92.1`, data the app itself reads and writes), used for the appearance preference and the device name. Add an entry there before using any other required-reason API, such as file timestamps, system boot time or disk space.

## Fonts

Weave uses Schibsted Grotesk. The font files are not checked in. To add them:

1. Download Schibsted Grotesk from Google Fonts.
2. Put the `.ttf` files in `SWCKit/Sources/Weave/Resources/Fonts`, along with the `OFL.txt` licence.

The fonts are registered the first time they are used. No `project.yml` change is needed. Until the files are there, the app uses the system font at the same sizes and weights.
