# Isolated live-preview verification

Run from `/Users/you/.specwithcode/m4/worktrees/browser-live-1018` with Node 22.20.0:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/browser-live/vite.config.ts
cp apps/web/tests/browser-live/site.html .artifacts/browser-live/site/site.html
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never python3 -m http.server 4395 --bind 127.0.0.1 --directory /Users/you/.specwithcode/m4/worktrees/browser-live-1018/.artifacts/browser-live/site
```

Use product-native preview automation with `open: false`, `show: false`, `headless: true`. Open `/site.html` as the source tab and `/` as the viewer tab; preserve and pass their distinct tab IDs. Do not invoke native OS picture-in-picture during automation.

The fixture imports the production pop-out module and frame painter. It substitutes access, stream delivery, error-toast storage and native PiP calls. The canvas, video, canvas media stream and frame decode are real browser APIs. No account credentials or service database are used.

1. On the source tab, click Navigate to page two and verify the URL. Scroll 960 pixels and save a screenshot.
2. On the viewer tab, await `openLive()`; verify `liveSinkCount() === 1`.
3. Convert the source screenshot to JPEG, base64-encode it and call `feedLiveFrame(base64)` on the viewer. Verify the hidden video's size is 1280×800 and the displayed proof canvas's top-left pixel is blue `[215,229,255,255]` for the middle section. Save the viewer screenshot after decode.
4. Set `liveStats.delayNextPlay = true`, start `openLive('old')` without awaiting it, wait until `liveStats.gate` exists, call `closeLive()`, start `openLive('replacement')`, release `liveStats.gate()` and await both. Exactly one new native request and one live stream/video should remain.
5. Call `loseLiveHost()`; verify zero streams/videos and a `Live preview disconnected` message in `liveErrors`. Reopen and verify recovery.
6. Navigate the source to a refused local port, preserve the explicit failure, then return to `/site.html` and confirm recovery.

The native OS request is substituted. These checks do not prove macOS window z-order, Spaces behavior or native PiP performance. Unit tests cover unresolved playback/metadata, native entry/exit ordering, failures and cleanup. All automated browser launch settings must be explicitly headless; never open a visible browser or a personal profile.
