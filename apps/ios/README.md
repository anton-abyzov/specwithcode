# SpecWithCode for iPhone

A native SwiftUI app for controlling SpecWithCode on your own machines from your phone. You can talk to Aide, follow project coordinators and threads, answer approvals and change a few settings. It connects straight to the server each paired machine already runs (orchestration protocol 2), so the machines need no changes.

The design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short, `App/` contains only the `@main` entry point, its scene-phase and device-name glue, assets, the privacy manifest and the shell's unit tests (`App/Tests`). Everything else lives in the local Swift package `SWCKit`:

| Module         | Contents                                                              |
| -------------- | --------------------------------------------------------------------- |
| `SWCWire`      | Codable wire types                                                    |
| `SWCTransport` | HTTP, pairing, Keychain, the RPC socket and the connection supervisor |
| `SWCSync`      | The UI model, `LiveEngine`, reducers and `FixtureEngine`              |
| `Weave`        | Design tokens and components                                          |
| `SWCFeatures`  | Screens                                                               |

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

## Fixture mode

The app can run on sample data without a machine. To use it, add launch arguments in the scheme (Edit Scheme > Run > Arguments) or after `simctl launch`:

| Argument                 | Values                                                                                      | Effect                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `-SWCFixture [scenario]` | `default`, `empty`, `running`                                                               | Uses sample data instead of real machines. With no scenario it uses `default`. |
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

## Pair with a machine

1. On your computer, open SpecWithCode and go to Settings > Connections. Turn on Network access or Tailscale HTTPS so the phone has an address to reach, then choose Create link under Authorized clients. A pairing link works once and expires after 5 minutes.
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
