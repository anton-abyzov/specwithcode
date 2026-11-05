# SpecWithCode for Android

Native Android app, written in Kotlin with Jetpack Compose (Material 3). It replaces the Expo app in `apps/mobile` on Android: package `com.specwithcode.android`, versionCode 4, versionName 0.2.2, minSdk 26, target and compile SDK 36.

The protocol is described in [docs/PROTOCOL.md](docs/PROTOCOL.md). The module layout follows the iOS app in `apps/ios/SWCKit`.

## Requirements

- JDK 17 or newer. JDK 23 works.
- Android SDK with platform 36 and the matching build tools. Point `ANDROID_HOME` at it, or set `sdk.dir` in `local.properties`, which is not committed.
- The Gradle wrapper in this folder (Gradle 9.4.1). Nothing needs to be installed globally.

## Build and test

```sh
cd apps/android
export ANDROID_HOME=/path/to/android-sdk

./gradlew test :app:assembleDebug                   # the full check
./gradlew :wire:test                                 # protocol types only
./gradlew :sync:test                                 # reducers, transcript mapping, live and sample engines
./gradlew :app:testDebugUnitTest                     # view models, secure storage, Connect sign-in, pairing input
./gradlew :app:assembleDebug                         # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:installDebug                          # onto a connected device or emulator
ANDROID_SERIAL=emulator-5554 ./gradlew :app:connectedDebugAndroidTest   # sample-data smoke UI test
```

Test reports are written to `<module>/build/reports/tests/test/index.html` (`app/build/reports/tests/testDebugUnitTest` for the app).

Start the app on sample data, for screenshots and UI tests, without changing the saved choice:

```sh
adb shell am start -n com.specwithcode.android/.MainActivity --es fixture default   # or empty, running, long
```

People can also turn sample data on from the welcome screen or Settings. Without the extra, and without sample data chosen, the app runs the live engine against the person's own computers.

Connect settings come from build properties and default to the hosted service (`ConnectConfig.hosted`):

```sh
./gradlew :app:assembleDebug -PconnectPublishableKey=pk_test_... -PconnectRelayUrl=https://relay.staging.example
```

### Checking against a local server

Nothing in the build starts or stops a server. To try the live engine end to end by hand:

1. Start a development server from the repository root in its own terminal: `npm run dev:server` (or open the desktop app you already use). Leave any running desktop app alone; a second server needs its own port.
2. In the desktop or web app, open the phone pairing screen and copy the pairing link (`studio://...` or `studio-dev://...`), or show its QR code.
3. Install the app (`./gradlew :app:installDebug`) on an emulator or a phone on the same network. On the emulator the computer is `10.0.2.2`; a typed host and code also works.
4. Pair from the welcome screen. Projects and threads arrive from `GET /api/orchestration/shell`, then `orchestration.subscribeShell` resumes from that snapshot's sequence; an open chat does the same with `GET /api/orchestration/threads/{id}` and `orchestration.subscribeThread`.

`sync/src/test/.../LiveEngineTest.kt` runs the same flow against a fake machine (MockWebServer and a scripted WebSocket) on every `./gradlew test`.

### Release builds

```sh
./gradlew :app:bundleRelease                         # app/build/outputs/bundle/release/app-release.aab
./gradlew :app:bundleRelease -PswcVersionCode=5      # override versionCode (default 4)
```

Release builds are minified with R8 and shrink resources; the keep rules are in `app/proguard-rules.pro` and the mapping file lands in `app/build/outputs/mapping/release/mapping.txt`.

Signing reads a properties file outside the repo with the keys `storeFile`, `storePassword`, `keyAlias` and `keyPassword`. Its path comes from `-PSWC_ANDROID_SIGNING_PROPERTIES=...`, else the `SWC_ANDROID_SIGNING_PROPERTIES` environment variable, else `~/.config/specwithcode/specwithcode-android-upload.properties`. A relative `storeFile` is read from the properties file's folder. When the file or the keystore is missing, release builds are unsigned, which is what CI builds. Keystores, passwords and Play service-account files never go in the repo; `.gitignore` blocks the usual names.

Instrumented tests run through the AndroidX Test Orchestrator with `clearPackageData`, so each test starts from a fresh install. With a phone plugged in as well as an emulator, set `ANDROID_SERIAL` so the tests install only on the emulator. A headless local emulator: `emulator -avd <name> -no-window -no-audio -read-only -no-snapshot`.

### CI and Play listing

`.github/workflows/android.yml` runs `test`, `:app:lintDebug`, `:app:assembleDebug` and an unsigned `:app:bundleRelease` on Ubuntu with JDK 21, then the smoke UI test on API 34 and 35 x86_64 emulators. Play Store text lives in `play/listing/en-US/` (title, short and full description, release notes per version); paste it into Play Console.

## Layout

| Module | iOS counterpart | What it holds |
|---|---|---|
| `:wire` | `SWCWire` | Plain Kotlin (JVM). The serializable protocol types: RPC frames, shell and thread streams, domain events, turn items, commands, project links and settings. Unknown enum values and unknown union cases decode to an `Unknown` case and encode back unchanged. |
| `:transport` | `SWCTransport` | Plain Kotlin (JVM). OkHttp HTTP and WebSocket clients: Effect RPC (`RpcSocket`), `MachineConnection` (route probing, tickets, reconnect ladder), pairing, the machine registry, the `CredentialStore` seam, DPoP, and the Connect relay client and authorizer. |
| `:sync` | `SWCSync` | Plain Kotlin (JVM). The UI contract: `AppModel` (a `StateFlow<AppState>`), `ChatSession` (a `StateFlow<ChatState>`), the `AppEngine` interface. `LiveEngine` (with `LiveSessions.kt` and `LiveConnect.kt`) talks to real machines through `:transport`; `ShellReducer`, `ThreadReducer`, `StreamSync`, `TranscriptMapper`, `ShellSummaries` and `ThreadAttention` are its pure parts. `FixtureEngine` fills the model with sample data and never touches the network. |
| `:app` | `Weave` and `SWCFeatures` | The Android app. `ui/theme` holds the Weave tokens (`WeavePalette`, `WeaveTheme`), `ui/components` the shared pieces and the Markdown renderer, and `ui/<screen>` each screen with its view model. `app/` holds the session holder (sample or live engine), settings, deep links, pairing input and the network watcher; `app/secure` the Keystore-backed credential store and DPoP key; `app/connect` the Connect sign-in. `AppGraph` in `MainActivity.kt` wires them; `AppNavHost` is the navigation graph. |

Tests:

- `wire/src/test` decodes the shared JSON fixtures in `wire/src/test/resources/fixtures` and checks that commands encode correctly and that unknown or malformed input is tolerated.
- `sync/src/test` ports the iOS reducer and transcript tests (`ShellReducerTest`, `ThreadReducerTest`, `TranscriptMapperTest`) over the recorded fixtures, runs `LiveEngine` against a fake machine (snapshot then resume by sequence, thread stream, send with a stable command id, reconnect with a fresh snapshot), and runs `FixtureEngine` under `kotlinx-coroutines-test`.
- `app/src/test` runs the view models against `FixtureEngine` on the JVM (chat send, stop and queue, approvals, offline sending, pairing, new thread, overview counts, sample-data switching, sign-in), the sealed credential store, the Connect sign-in against a fake account service, the DPoP key's raw signatures, plus pairing input and deep links, the Markdown parser and the Weave contrast checks.
- `app/src/androidTest` is a smoke UI test on sample data: it opens a thread and sends a message, and reaches the manual pairing fields.

## App notes

- The launcher icon is adaptive. The foreground is `apps/mobile/assets/android-icon-foreground.png`, the background is `#5B6CFF`, and the monochrome layer (for themed icons) is `android-icon-mark.png`.
- `res/xml/network_security_config.xml` allows plain `http`, because manual pairing reaches machines on the local network by IP address. Connect links use `https`.
- Credentials and the Connect session are sealed with an AES-GCM key that lives in the Android Keystore and kept in `files/datastore/credentials.preferences_pb`. The DPoP key for Connect is an EC P-256 Keystore key; its DER signatures are converted to raw `r || s`. `res/xml/backup_rules.xml` (Android 11 and older) and `res/xml/data_extraction_rules.xml` (Android 12 and newer) keep that file, `machines.json` and the install's Connect device id out of cloud backup and device transfer.
- Connect sign-in uses the account service's frontend API: OAuth (Google by default) opens in a Custom Tab and returns to `clerk://com.specwithcode.android.callback`, the redirect the Expo app used. The vendor's Android SDK is not used because its current release needs Kotlin 2.4 and OkHttp 5. Sign-in against the hosted service has not been tried from this build; it needs a person at the sign-in page.
- The engine reconnects when the app comes to the foreground and when the network changes (`ConnectivityWatcher`, `ACCESS_NETWORK_STATE`).
- Screens: welcome (Connect sign-in, pairing, sample data), pairing (QR scan with CameraX and ML Kit, pasted link, typed host and code, `studio://`, `studio-dev://` and `specwithcode://` deep links), home with a drawer of projects and threads and their pending-approval badges, machines, chat (Markdown with code blocks, reasoning, plans, commands and file changes, approval, question and access cards, composer with send and stop), new thread (project, model, runtime mode) and settings (appearance, wallpaper colors, sample data, computers, version, privacy policy, open-source licenses, sign out).
- Colors follow Weave with an iris accent around `#5B6CFF`. Light and dark are designed; wallpaper (dynamic) color is off unless turned on in Settings, and then only Material roles follow it.
- Key elements carry stable test tags, for example `pairing.manual.host`, `pairing.manual.code`, `thread.list`, `thread.row.<id>`, `chat.transcript`, `composer.input`, `composer.send`, `composer.stop`, `approval.approve`, `newThread.start` and `settings.signOut`.
- `PendingLiveEngine` and `ConnectSignInUnavailable` remain for tests and builds without the live engine.

## Not done yet

- Live engine gaps: sending pictures, project settings, Aide setup, older history paging for bounded thread snapshots, a cached shell for offline start, the fleet roster and linked-machine discovery (all machines are listed), push registration, and the Connect phones list.
- Thread info and the iOS sidebar layout for wide screens.
- Features not ported to `AppEngine` yet: handoff, increment progress, attachments, thread links and device hub access.
