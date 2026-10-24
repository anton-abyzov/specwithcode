# Installed desktop tests without visible windows

Set `STUDIO_DESKTOP_TEST_OFFSCREEN=1` in the packaged executable's environment
**before launching it**. Only the exact value `1` enables the mode. It is off by
default; `CI`, `PWDEBUG`, Xvfb and Playwright reporter settings do not enable it.

The main process selects Electron's software offscreen output before readiness.
Every app-created BrowserWindow, including splash, project, preview popup and PiP
windows, gets `webPreferences.offscreen: true`, `show: false`, `focusable: false`
and `skipTaskbar: true`. Native show, focus, restore, maximize and fullscreen
requests are suppressed on those real windows. Detached DevTools are disabled,
native dialogs fail the process, and the native-only snapshot flash is omitted.
Backend startup/attachment, the tray, renderer/preload, IPC and window lifecycles
remain real. This mode does not mock backend ownership or service installation.

Construction and readiness checks read Electron's actual
`webContents.isOffscreen()`, `isVisible()` and `isFocused()` methods. Those getters
are never replaced. Every guarded window logs one stderr record:

```text
[desktop-test-offscreen] {"event":"window-created","id":1,"offscreen":true,"visible":false,"focused":false}
```

A failed check or any native `show`/`focus` event logs
`[desktop-test-offscreen] failure: ...` and exits with code 1. Retain these records
to cover early splash windows which close before the automation client attaches.
Installed harnesses must also assert that a nonempty set of created windows has
`webContents.isOffscreen() === true`, `isVisible() === false` and
`isFocused() === false`, repeat the checks after ready/activation/close scenarios,
and reject failure records or unexpected process exits. Use the real Electron
queries via the existing main-process evaluation seam; do not mock their answers.

Web UI testing still launches Chromium separately with `headless: true`,
`PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`. Offscreen Electron rendering is not
a claim that Electron's native process and real tray work without an operating
system display backend. A Linux runner may still require Xvfb for that backend;
Xvfb alone is not evidence that windows stayed offscreen and invisible.

Electron documents the rendering mechanism at
https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering and the native
query at https://www.electronjs.org/docs/latest/api/web-contents#contentsisoffscreen.
