# Snapshot and preview-context quality

SpecWithCode preserves native macOS window pixels before attachment delivery. Preview annotation crops translate selected DOM rectangles from CSS pixels to Electron display coordinates using the guest's current zoom factor. The user comment, selected-element HTML and selector remain unchanged.

## Confirmed defects

A macOS window's bounds are measured in points, but `screencapture` produces Retina pixels. Passing the point dimensions into the native image resize discarded detail. A 3024 × 1964 capture became 1512 × 982. The native capture now uses an independent 8000 × 8000 pixel safety envelope, preserves the aspect ratio for oversized captures and never upscales. Within that envelope, its PNG bytes are unchanged.

The preview picker sends `getBoundingClientRect()` coordinates, measured in CSS pixels. `webContents.capturePage()` takes display coordinates. At 150% or 75% guest zoom, the old crop missed the selected heading and captured empty background. Scaling the rectangle by `getZoomFactor()`, with outward rounding, captures the intended content. The original CSS rectangle remains in annotation metadata.

## Preview, paste and provider boundaries

The user references are screenshots of another coding-agent app. Their cards alone do not establish the quality of that app's attached source or the bytes received by its provider. These fixes address independently reproduced defects in this app; they do not claim to diagnose the other app's runtime.

The composer generates a cached 256 × 256 center-cropped thumbnail for its small attachment cards. That is a display derivative. Expanded image previews and uploads use the attachment file, never that thumbnail. No screenshot-blur filter was found in these app card paths. Tiny card text is not a reliable source-quality test.

Normal clipboard paste reads the browser's `DataTransfer.files`. The app does not fetch a smaller native clipboard representation. It cannot restore pixels already missing from the clipboard source. Pasted and dropped images use the existing 2000-pixel edge and 3.75 MiB attachment preparation policy; this compatibility policy is unchanged. Native SnapShots take a separate route through `compressImageToByteLimit`: they retain their source bytes when within the provider byte cap. Larger native captures can still be reduced by the existing byte-budget encoder. Prompt stashes have a separate storage compression budget.

Annotation crops become PNG files alongside structured annotation records. `buildMessageContext` retains the comment and selected DOM context and links the screenshot by attachment id. Upload storage streams the received bytes to disk. The Claude adapter reads those bytes and sends base64 image content; the Codex adapter reads them into a base64 image URL. Neither adapter uses composer thumbnails. Providers can perform their own image processing.

Source paths, relative to this checkout:

- `/Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/desktop/src/snapShot/MacSnapShot.ts`
- `/Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/desktop/src/snapShot/DesktopSnapShot.ts`
- `/Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/desktop/src/preview/Manager.ts`
- `/Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/desktop/src/preview/AnnotationCapture.ts`
- `/Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/desktop/src/preview/PickPreload.ts`
- `/Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/web/src/components/desktop/SnapShotCoordinator.tsx`
- `/Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/web/src/lib/imageCompression.ts`
- `/Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/web/src/lib/previewAnnotation.ts`
- `/Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/web/src/lib/composerContextRecords.ts`
- `/Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/server/src/assets/AttachmentUpload.ts`
- `/Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`
- `/Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`

## Verification

Run `node apps/desktop/tests/snapshot-quality/check.mjs /absolute/evidence/folder` from the checkout root. It uses Electron with `--headless`, `show: false` and offscreen rendering, a private test home, and no live account or provider. It bundles the production picker and capture helpers. The test stubs only IPC transport and React component-source lookup, drives actual selection/comment/Attach, and saves old/new PNGs for 75%, 100% and 150% zoom. The selected DOM, comment and PNG base64 round trip are asserted. A generated Retina text source exercises the actual NativeImage transformation, including the oversized safety bound.

October 23, 2026 evidence: `/Users/you/.specwithcode/m4/evidence/snapshot-quality-1016/verified/receipt.json`. The fixed Retina source hash equals its output hash. At 150% zoom, the old blank crop was 480 bytes and the selected-content crop is 14188 bytes. At 75%, the old crop was 544 bytes and the corrected crop is 6966 bytes.

The desktop production bundle passes. Ten focused test files pass, 347 tests: native snapshot, annotation rectangle/manager, annotation conversion/context, snapshot delivery, image compression, legacy context transport and attachment upload storage.

The optional Claude adapter attachment suite did not execute because this checkout's installed dependencies lack `pptxgenjs`: `Error: Cannot find package 'pptxgenjs' imported from /Users/you/.specwithcode/m4/worktrees/snapshot-retina-quality/apps/server/src/design/export/pptx.ts`. Its source delivery path was inspected; this is not a provider-runtime pass.

These are source/build and private headless fixture proofs. The installed app, real OS capture shortcut, actual clipboard representations and a live provider turn have not been tested. No app restart, account change or independent release was performed. Release 1015 owns inclusion and dispatch.

## Settings and project destinations

The physical both-Shift shortcut was confirmed by the user on October 26, 2026. The resulting native PNGs are 4096 × 2420 and 4096 × 2368. This confirms real shortcut capture and retained native-sized attachments; live selected-element annotation at 150% remains pending.

Project-pane conversations use a thread and machine in URL search parameters. Snapshot delivery now resolves that exact pane, or the viewed project's coordinator, before acquisition. Settings retains the prior destination and full project URL. Delivery adds the image without changing existing prompt text. It leaves Settings only when the user has not navigated elsewhere since the capture began. A project whose destination is unavailable retains the pending capture instead of opening an unrelated Scratch chat.

Capturing the app itself skips native application activation and capture feedback overlays, preserving its existing window and macOS Space. Captures of other processes keep their existing behavior. This removes an app-driven focus/Space change path; the original reported desktop transition has not been independently reproduced on the installed patched build.

Source checks exercise the real snapshot coordinator through project → Settings → requested/ready delivery. The original implementation fails both regression cases; the corrected implementation preserves the image, prompt, machine and thread and respects newer navigation. Coordinator attachment acknowledgment requires its bytes to be present in the durable journal. These source checks do not substitute for installed acceptance of the new routing behavior.
