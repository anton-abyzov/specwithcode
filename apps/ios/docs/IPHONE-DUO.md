# SpecWithCode: iPhone Duo readiness

Target: Anton's physical phone acceptance on November 3, 2026. Simulator evidence is a prerequisite, not hardware acceptance.

## Research, October 25

A [linked post](https://x.com/theo/status/2114268788938145803) demonstrates accessing a remote Duo simulator from an iPhone. Its [quoted post](https://x.com/theo/status/2114267380818100402) describes Ubuntu controlling an iOS simulator on a connected Mac mini through another coding-agent app. These posts establish a remote development workflow, not layout requirements or proof that SpecWithCode works on Duo. Text was recovered from the FxTwitter public JSON mirror after X returned HTTP 403; the video interaction was not independently reproduced.

Apple's [preparation guide](https://developer.apple.com/iphone-duo/prepare/) requires current view/scene geometry, dynamic resizing and removal of device/orientation assumptions. iOS 26 SDK builds remain compatibility layouts. iOS 27 adds expanded resizing; iOS 27.1 adds full display use and vertical system bars. [Prepare your app](https://developer.apple.com/videos/play/tech-talks/111461/) covers size classes, navigation and safe areas. [Adaptive layouts](https://developer.apple.com/videos/play/tech-talks/111463/) covers reserved regions and hinge/camera-aware placement. Use the [design guidance](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo) for pose behavior.

## Implemented layout behavior

The existing drawer becomes a persistent navigation column when the scene has regular horizontal size class and at least 600 points of width. Narrower windows keep the modal drawer. The column uses 40% of the available width, capped at 320 points, leaving the remaining width for chat before system insets. The 669-point inner-display width is covered by the resize regression; no device identity check is used. The chat subtree stays mounted during a size-class change, preserving navigation and draft state. A resize clears an in-progress drawer gesture and modal coverage. Both landscape orientations are enabled. Each column consumes only the system insets that overlap it, including asymmetric vertical system bars; RTL layout mirrors once. Composer increment/checklist controls have 44-point tap targets. The SDK 27.1 build also fixes Swift 6.4 isolation diagnostics without raising the deployment minimum.

The existing implementation already reads local geometry, uses a lazy transcript and does not use UIScreen.main or phone/pad identity for layout. No new continuous animation or polling is introduced. The drawer remains custom: iOS 27.1 reserved-region and vertical-toolbar acceptance is still required before calling this fully optimized.

## Simulator commands

All runs use owned simulators booted with simctl; do not open Simulator.app. Browser checks, if added, must explicitly use headless Chrome with PWDEBUG=0 and PLAYWRIGHT_HTML_OPEN=never.

From apps/ios:

```sh
make sim-build SIM_NAME=SWC-1079-Compact
make sim-test SIM_NAME=SWC-1079-Compact ONLY=SpecWithCodeUITests/AdaptiveLayoutUITests
python3 Tools/test-duo-readiness.py
bash Tools/duo-readiness.sh check
# On M1, whose selected Xcode is 27.1:
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer bash Tools/duo-readiness.sh test
```

The prerequisite gate fails when SDK, device type or runtime is missing, or the owned simulator name identifies a different device/runtime; a phone or iPad viewport is never silently substituted. The automated XCTest suite checks rotation/draft behavior and chooses navigation expectations from the actual available layout. It does not automate Duo hinge poses. The test helper sends native coordinate taps to the visible target. On SDK 27.1 Duo, element activation can miss custom bars and `isHittable` can be false at the largest text size even when a physical coordinate tap succeeds. Menu checks therefore require an enabled, fully onscreen 44-point target and verify the resulting drawer and accessibility state. Assertions are retained. Save result bundles and screenshots under build/duo.

For an expanded-layout surrogate on Xcode 26.3, create an owned iPad Pro 11-inch simulator and build with TARGETED_DEVICE_FAMILY=1,2 as a command-line test override. Do not change the shipping iPhone device family. An iPad result verifies the adaptive branch, not fold behavior.

## Required Duo matrix — open

- Outer display: light/dark, Dynamic Type including accessibility sizes, pairing/sample welcome, projects, Aide, thread lists, long transcript/code, composer and attachments, menus and sheets.
- Inner display: same flows in both rotations; persistent navigation and useful chat width; narrow Split View returns to modal navigation.
- Fold/unfold with an unsent draft, keyboard open, pushed thread, scrolled history, streaming response, pending approval and presented sheet. Preserve selection, draft, scroll and approval state.
- Partially folded and tent poses: no controls or text under hinge, camera or reserved system regions; vertical bars and asymmetric safe areas remain usable.
- VoiceOver, Reduce Motion, right-to-left, hardware keyboard, background/reconnect and scene resize. Verify tap targets and focus as navigation changes modes.
- Performance: record Instruments hitches, main-thread work and memory for a long streaming transcript while resizing. Compare the same fixture/build before and after; do not infer device performance from host simulator timing.
- November 3 physical phone: repeat pose, keyboard, reconnect, long-stream and thermal/battery checks. Capture exact app build, SDK, OS and device versions. Manual acceptance is required before increment closure.

## Verified on October 26

M1 runs macOS 27.0.1 (26A434), Xcode 27.1 (27A9275), simulator SDK 27.1 and iOS 27.1 runtime (24A94425). Tests use the owned `SWC-1079-Duo` simulator; other devices and live app data remain untouched. Device Hub was used under Anton's explicit exception. No browser was opened for these checks.

| Check                                                                                                                                | Result                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| SWCKit core suite with coverage on M1                                                                                                | 94 passed, 18 suites                                                                                      |
| Native Duo regression (resize/draft identity, insets/RTL, wide compact traits, rotation, navigation, largest text and Reduce Motion) | 6 passed                                                                                                  |
| Compact native regression (adaptive layout, drawer, send, delete, native component tests)                                            | 15 passed                                                                                                 |
| Compact mobile readability/adaptive/drawer regression                                                                                | 14 passed                                                                                                 |
| Expanded iPad surrogate, earlier implementation                                                                                      | 3 passed; surrogate only                                                                                  |
| Duo outer navigation                                                                                                                 | Menu opens and closes through panel-aware native input; accessibility returns to composer                 |
| Duo draft and keyboard                                                                                                               | Exact unsent draft preserved from outer 466×678 to inner 951×669 and 669×951, then back to outer 678×466  |
| Duo inner interaction                                                                                                                | Additional text entered; increment sheet opened, survived folding closed, dismissed; exact draft retained |

The broader compact fixture run had 43 passes, two intentional live-server skips and one main-run-loop timeout. Its failed readability check passed in the focused 14-test rerun. This is not presented as a green full-suite run.

An isolated `agent-device@0.21.31` installation supplied the panel-aware interaction check. Its [release notes](https://github.com/callstack/agent-device/releases/tag/v0.21.31) include iOS gesture routing fixes. The app's shared device-tool pins were not changed. Pose requests were followed by fresh snapshots; refs and coordinates were never reused across panels. An initial inner fill failed readback; subsequent first-responder typing and sheet interaction succeeded and were read back. A dispatched half-open request retained draft/layout, but the angle is **unverified**: this Xcode's `devicectl device` has no `motion hinge-angle` subcommand expected by that tool.

The standard native Duo regression is now green: six tests passed with no failures or skips. A 678-point landscape outer display retains compact traits; UI checks follow the presented mode, while component tests independently enforce the regular-width/compact-width policy. The independent input diagnostic and exact results belong in increment 1079's evidence. The full native fixture run is recorded separately; a focused result does not imply every flow passed.

Full matrix acceptance, Instruments performance measurements and November 3 hardware acceptance remain open. Simulator host timing cannot establish phone thermals, battery use or rendering performance.
