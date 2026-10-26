# Embedded browser and live floating preview

October 23, 2026. Increment 1018. Current implementation snapshot: `252be2eb4`. Snapshot capture is owned separately by 1016; release dispatch by 1015.

## Recommendation

Keep the existing browser architecture. It already implements the useful T3 pattern: an interactive browser inside the app, a floating in-app mini-player, and a view-only always-on-top live window. Navigation and scrolling happen in the source tab; the floating window follows live frames. It is not a second independently navigable browser or a static screenshot.

Do not promise bug-free behavior. Validate individual paths, including failed loads, closed tabs, cancelled startup and replacement races. Fix verified lifecycle gaps rather than building a duplicate browser.

## Shipped T3 observations

REA reuses the official T3 Code `v0.1.2` macOS arm64 artifact from the earlier investigation. ASAR SHA-256: `0468a385f93ec672d554c301c6a12ad0014b08df8ab93def19a33082fac9d44d`.

Retained parent Evidence: `ev_bb0adcdc55b2aa4b89e93c9df6a6745c717371507e864997d9f2e3a08951b99e`.

Desktop module view: `ev_eb24dcca813b09ca1b2ee03aa43b18ab1d78985bfc14baf9b21851e7e1984a2e`, module SHA-256 `483ab1abef6c2b0f35a6dc1af56ca26ed4a1ec59fc2faca8c0daae2ef0c1b7cf`.

Web preview view: `ev_ffe9ab546452b007a60779a093f0896328b2926c78a704610e9373712572fc27`, module SHA-256 `ec0501d342d125fc6ed9d379ca66eeb740c984a0e00720b226c912f352a1a7d9`.

Shipped desktop bundle: `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/extracted/apps/desktop/dist-electron/main.cjs`.

| Location | Observed behavior |
| --- | --- |
| Lines 87240 onward | Desktop browser host shares a tab debugger with the server through a CDP relay. |
| Lines 110758 onward | Preview manager owns native tab registration, navigation status, background frame capture and the floating window. |
| Line 110812 | Floating-frame polling interval is approximately 83 ms, capped at 12 captures per second. |
| Lines 111600 onward | Load failures preserve Chromium error details; native input updates human control state. |
| Lines 112465–112487 | Frames are sent over a dedicated IPC channel; the manager retries failed background captures. |
| Lines 112595–112645 | Floating BrowserWindow is hidden until ready, always-on-top, a macOS panel, sandboxed, isolated and without Node integration; it can appear across workspaces. |
| Lines 112669–112724 | Native floating-window startup uses a ready signal, session identity checks, cancellation handling and cleanup. |
| Lines 147033 onward | Embedded preview uses sandboxed webviews without page Node integration. |

The view preload at `/Users/you/.specwithcode/m4/evidence/t3-connect-1014/extracted/apps/desktop/dist-electron/preview-pip-preload.cjs` exposes only the frame subscription used by the floating page.

## Inferences and limits

The embedded guest renders and scrolls normally, while agent navigation/click/scroll commands operate on that same page through CDP. The native floating window displays captured live frames, so source scrolling and animation become visible there. It does not itself contain the source website's DOM. These conclusions follow shipped code and the corresponding source paths; no T3 app was executed.

REA coverage is partial, including semantic result/heap/time limits and native unpacked ASAR integrity contradictions. Runtime reachability, OS z-order, native animation smoothness and current browser-profile behavior are not established by static evidence.

## Our corresponding paths

- `/Users/you/.specwithcode/m4/worktrees/browser-live-1018/apps/web/src/browser/HostedBrowserWebview.tsx` owns the embedded Electron guest and crash recovery.
- `/Users/you/.specwithcode/m4/worktrees/browser-live-1018/apps/desktop/src/preview/Manager.ts` already has the 12 fps native live frame loop and always-on-top panel. No edits here; annotation capture remains with 1016.
- `/Users/you/.specwithcode/m4/worktrees/browser-live-1018/apps/web/src/components/preview/ThreadPreviewMiniPlayer.tsx` provides the floating in-app surface.
- `/Users/you/.specwithcode/m4/worktrees/browser-live-1018/apps/web/src/browser/ServerBrowserSurface.tsx` displays remote frames, forwards scaled pointer/wheel input and enforces human/agent control ownership.
- `/Users/you/.specwithcode/m4/worktrees/browser-live-1018/apps/web/src/browser/serverPictureInPicture.ts` turns the server frame stream into canvas video for browser PiP. This fallback awaits playback and metadata without a bounded or cancellation-aware startup. It needs a regression before changing behavior.

## Independent behavior specification, before implementation

1. Preserve a single source page and its navigation/scroll state. Floating display follows it without acquiring control or stealing focus.
2. Opening a live display owns its own video element, stream tracks, frame painter, connection and listeners. Closing or replacement cancels pending initialization and cleans only those resources.
3. A cancelled or superseded startup must not enter PiP after playback/metadata resolves. A late native acknowledgment must not close the replacement's window.
4. Playback, metadata, PiP and initial access failures must settle within a bounded startup deadline and leave a retryable state. Intentional close should not raise an error toast.
5. Lost host/tab state must remain distinguishable from a successful live stream. Do not treat a frozen seed frame as an active connection.
6. Keep scope disjoint from capture/annotation work, preserve profile/sandbox settings and require explicit user action for OS pop-out.

## Validation

The receipts below distinguish real browser navigation/scroll/frame behavior from substituted OS-PiP control calls. Native always-on-top acceptance requires a separately authorized visible check and is not claimed here.

## Reproduced and fixed

Four baseline lifecycle tests failed on the original implementation: closing during playback still requested PiP; old playback completion replaced a newer native window; closing a never-resolving playback left the opening promise pending; missing metadata never timed out. Baseline receipt: `/Users/you/.specwithcode/m4/evidence/browser-live-1018/baseline-tests.log`.

The repair adds cancellation-aware startup, a ten-second deadline, metadata error handling, ordered native entry/exit, initial access failure propagation and retry/host-setup error messages. Intentional closing is quiet. Late native acknowledgments are cleaned before a replacement enters; streams, tracks, videos, listeners and timers belong to their own startup.

A fresh-context review found two additional medium issues before approval: the first late-ack regression did not model native ownership changes, and refresh errors silently closed the preview. Both were corrected. The revised test delays native exit and verifies that the new window waits; refresh/host setup failures now produce a reconnect/setup message. Final verdict: SHIP.

## Verified runtime boundaries

The product-native preview tools drove the authored local source page in a hidden, headless Chromium tab: followed a real link, confirmed `?page=two`, scrolled 960 CSS pixels, and captured the middle section. Navigating to an absent local server returned `Preview automation navigate failed: Navigation to http://127.0.0.1:4396/ failed: ERR_CONNECTION_REFUSED`; navigating back to the valid page recovered.

A second hidden tab loaded the production pop-out module and real browser canvas/video plus the production frame painter. The fixture substitutes stream delivery and the OS-PiP request, so it cannot open a visible native window. A captured source frame was delivered as JPEG bytes. The video changed to 1280×800 and its proof canvas returned pixel `[215,229,255,255]`, matching the source's blue middle section. Cancellation followed by replacement produced exactly one new native request, one live stream and one video. Host-setup failure reduced streams/videos to zero and reported `Live preview disconnected`; reopening recovered.

Runtime receipt: `/Users/you/.specwithcode/m4/evidence/browser-live-1018/browser-results.json`. This proves the scoped module's browser execution, frame-to-video path and lifecycle handling; it is not an end-to-end deployment, native Electron z-order check or proof of every site's behavior.

## Remaining limitations

- The floating window is view-only. Navigate, scroll or take control in the embedded source tab.
- Headless verification cannot prove native macOS z-order, Spaces behavior, desktop focus or sustained animation frame rate. No visible app was launched.
- A native PiP request that never resolves cannot be forcibly cancelled. It fences later native entry attempts; each caller still times out and frees its media resources. This deliberately prevents stale requests from taking over a newer preview.
- Transient network reconnection still uses the existing stream retry behavior. A paused frame alone is not proof of an active connection.
- No capture/annotation/Retina image path was changed. Snapshot work remains with 1016. No shared checkout, account, browser profile, service or release was changed.
