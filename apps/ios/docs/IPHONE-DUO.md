# SpecWithCode: iPhone Duo readiness

Target: Anton's physical phone acceptance on November 3, 2026. Simulator evidence is a prerequisite, not hardware acceptance.

## Research, October 25

Public posts demonstrate accessing a remote Duo simulator from an iPhone, with Ubuntu controlling an iOS simulator on a connected Mac mini through another coding-agent app. These posts establish a remote development workflow, not layout requirements or proof that SpecWithCode works on Duo. Text was recovered from the FxTwitter public JSON mirror after X returned HTTP 403; the video interaction was not independently reproduced.

Apple's [preparation guide](https://developer.apple.com/iphone-duo/prepare/) requires current view/scene geometry, dynamic resizing and removal of device/orientation assumptions. iOS 26 SDK builds remain compatibility layouts. iOS 27 adds expanded resizing; iOS 27.1 adds full display use and vertical system bars. [Prepare your app](https://developer.apple.com/videos/play/tech-talks/111461/) covers size classes, navigation and safe areas. [Adaptive layouts](https://developer.apple.com/videos/play/tech-talks/111463/) covers reserved regions and hinge/camera-aware placement. Use the [design guidance](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo) for pose behavior.

## Implemented layout behavior

The existing drawer becomes a persistent navigation column when the scene has regular horizontal size class and at least 600 points of width. Narrower windows keep the modal drawer. The column uses 40% of the available width, capped at 320 points, leaving the remaining width for chat before system insets. The 669-point inner-display width is covered by the resize regression; no device identity check is used. The chat subtree stays mounted during a size-class change, preserving navigation and draft state. A resize clears an in-progress drawer gesture and modal coverage. Both landscape orientations are enabled. Each column consumes only the system insets that overlap it, including asymmetric vertical system bars; RTL layout mirrors once. Composer increment/checklist controls have 44-point tap targets. The SDK 27.1 build also fixes Swift 6.4 isolation diagnostics without raising the deployment minimum.

Increment 1150 replaces the persistent column's content with a native sidebar list (`SidebarView`): large title, search in the toolbar, section headers for Projects, Recents by day and Machines, a tinted selection pill, Settings and New chat at the bottom. Rows select through `AppRouter.select`, and `AppRouter.sidebarSelection` derives the highlight, so the Router stays the single source of selection. Compact width still shows the unchanged phone drawer. `NavigationSplitView` was tried and rejected: at 669 points it chose `splitBehavior` overlay in two of three runs, covering the chat and ignoring the column width. The persistent column keeps one mounted detail subtree and deterministic widths. `AdaptiveSplitTests` resizes the real root view through 466×678 compact, 669×951, 951×669, 540-point regular and back, asserting the same composer instance, its draft, sidebar placement and accessibility.

Beside the sidebar, the chat header aligns its title leading and drops the menu control. `AdaptiveSplitTests` attaches a render of each geometry; the 669×951 render is the unfolded-portrait evidence.

Fold control on the M1 uses agent-device's fold-helper (`simctl spawn <udid> fold-helper open|closed`). Screenshot only the active panel (`--display=1` outer, `--display=3` inner); capturing the inner panel while folded hangs. In both fold-helper poses, `XCUIDevice` orientation changes leave the scene unrotated. `testBothLandscapeRotationsPreserveDraftAndSelectedChat` therefore fails with "App did not rotate into landscape", and origin/main `c13180084` fails identically on the same simulator. The assertion is unchanged; rotation acceptance remains on hardware.

The existing implementation already reads local geometry, uses a lazy transcript and does not use UIScreen.main or phone/pad identity for layout. No new continuous animation or polling is introduced. The drawer remains custom: iOS 27.1 reserved-region and vertical-toolbar acceptance is still required before calling this fully optimized.

## Wide layout, November 1

Width alone decides the layout now: from `WeaveSize.sidebarBreakpoint` (760 points) the navigation is a column beside the chat, even when the Duo reports a compact class at full width; below it (folded, unfolded upright at 669 points, Split View) the chat keeps the whole width and navigation is the modal drawer. 760 sits between Claude's 700-point and Codex's 768-point overlay breakpoints. The column is 32% of the scene, clamped to 288-340 points, and `AppRouter.isSidebarCollapsed` (remembered) hides it with a 0.3-second, 0.1-bounce spring. Transcript and composer are capped at `WeaveSize.readableColumn` (720 points) and centered. Projects in the sidebar unfold their open threads in place.

A phone build made with an iOS 26 SDK runs on Duo as a compatibility layout, scaled and letterboxed, and rotation rescales it. The copy installed on October 31 was such a build (DTSDKName iphoneos26.2), which explains "not using the full width". `Tools/device.sh` refuses an SDK older than 27.1; build device copies with `DEVELOPER_DIR=/Applications/Xcode-27.2.app`.

## Coordinator beside a thread, November 2

From `WeaveSize.sidebarBreakpoint`, with a project or Aide thread open, the column holds that thread's coordinator and the thread stays on the right. It opens at half the scene, on the hinge, and resizes up to 62% while leaving the thread 340 points; its width is stored apart from the list's (`swc.chatColumnWidth`). The column follows the project's active coordinator or else the thread's own machine, and its switcher changes only the column. "Show projects" in its header shows the list until the screen changes, and Settings > "Coordinator beside threads" turns it off (`swc.coordinatorBeside`). With no thread open the column is the list. A thread opened from a coordinator link lands on the right because the column chat uses the main stack's navigator. Upright at 669 points and folded, navigation stays the modal drawer.

## List beside a thread, November 3

The wide list's header holds the sidebar toggle, a way to change list level and one capsule with search and New chat; machine chips sit under it when there are two or more machines. With a project in view the list holds its threads on single lines; the header's back button returns to all projects. Its resting width is 42% of the scene, up to 420 points.

Beside the list, a thread's title is plain text, its controls sit in the status rail when the scene reports one, and its composer names the machine ("Work on Office Mac"). A pill above the composer counts working agents: a coordinator's threads, or a thread's subagents. Hosted renders at 951x669 come from `DuoWideLayoutTests`.

## Top edge, rail and project level, November 3

An unfolded Duo reports no top inset and a status bar 2 points tall, yet the system takes touches along the top edge. On the Duo simulator the header's first control, at 4 points, did not fire when tapped above about 15 points. Headers now start 20 points down when the scene has a one-sided status rail (`EdgeInsets.hasStatusRail`). On that simulator's system status items, the clock and Wi-Fi centre sits 48 points from the edge and ends at about 98 points, so rail controls share that centre and start at 112 points.

Projects no longer unfold in the wide list, which pushed every row below and took width from titles. A project row goes down a level in the same column; the header's back button returns. That level replaces the project picker menu. A hidden column can come back from a pushed thread.

## One project in both columns, November 3

The left column and the screen beside it are always about the same project: going into a project opens its coordinator on the right unless one of its chats is already there, and opening any chat ends the all-projects level. With a thread open, the column header's Coordinator and Threads switch chooses what the column holds, and the choice persists. The Threads label counts what needs you.

Every thread row leads with its status in a fixed column, in the desktop's language from `ModStatGlyph`: speech bubble needs you, barred circle failed, spinner working, check finished, hollow dot idle or offline. A finished thread used to map to idle and idle drew nothing, so most rows had no status. Rows sort by `activityAt`, never `updatedAt`, so a status change or streamed update does not move them; All, Needs you, Working and Offline chips filter instead of grouping, hidden when empty. When a project spans machines each row names its machine, because the same check launched on two machines reads as a duplicate without it.

Status words follow the desktop's: groups are Needs you, Working, Offline, Idle and Resolved. Waiting on subagents, CI, a review or a merge counts as Working, and "Waiting" survives only as a row's reason, such as "Waiting for CI". A count reads "1 needs you" or "2 need you". An ask found only in a thread's last message reads "Reply needed" and clears on reply; "Answer needed" stays for native question requests. `ThreadAttention` holds these rules, ported from `reportWaitReason` and `threadDependencyWait`.

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
