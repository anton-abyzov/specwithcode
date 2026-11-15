# Installing from the disk image on macOS

When someone opens SpecWithCode straight from the downloaded disk image, or macOS runs it from an
App Translocation copy, the app shows one native "Install SpecWithCode" alert before it starts
anything else: before the backend, the bundle rename and the update check. Code:
`apps/desktop/src/install/macSelfInstall.ts`, strings in nine languages in
`apps/desktop/src/install/macSelfInstallCopy.ts`, called from `apps/desktop/src/app/DesktopApp.ts`
right after Electron is ready.

## What each answer does

- **Install** copies the running bundle to `<Applications>/.SpecWithCode.app-<version>-install`
  without the disk image's quarantine flag, checks it with `codesign --verify --deep --strict` and
  compares its bundle id and version with the running app. Only then does it rename an installed
  copy to `SpecWithCode.app.install-old`, rename the new one in and move the old one to the Trash,
  the order of "Swapping the desktop app" in `docs/studio/releasing.md`. A failed copy or check
  leaves Applications as it was and the app keeps running from the disk image.
- **Not now** starts the app as before. Updates stay off while it runs from the disk image
  (`apps/desktop/src/updates/macSwapInstall.ts`, `assertReplaceable`). The alert comes back on the
  next launch from the disk image.

Before relaunching, the step unregisters the disk-image path from Launch Services, registers the
installed app, and rewrites any `~/Library/LaunchAgents/com.specweave.studio*.plist` that names the
old path. A job whose program ran from the disk image is reloaded; one that only had it in `PATH`
picks the change up on its next load. A detached script then waits for the app to exit, opens the
installed copy with `open -n` and runs `hdiutil detach` on the disk image, only when `hdiutil info`
lists that volume as a disk image.

## Copies already installed

Copies named `SpecWithCode.app` or an earlier name from `LEGACY_BUNDLE_SUCCESSORS`, in
`/Applications` and `~/Applications`, are checked by bundle id, version and whether they run:

| Found                           | The alert offers                                            |
| ------------------------------- | ----------------------------------------------------------- |
| Nothing                         | Install                                                     |
| Older, not running              | Install, replacing it; earlier-named copies go to the Trash |
| Same or newer, not running      | Open it                                                     |
| Same or newer, running          | Switch to it                                                |
| Older, running                  | Quit it first, then Install checks again                    |
| Another app under the same name | Nothing; asks to move that app away                         |

## Without administrator rights

When `/Applications` is not writable, the app installs into `~/Applications` for that user only
and says so, including that a Dock item for the disk-image copy has to be replaced. An older copy
in `/Applications` that this user cannot remove stays where it is.

## Why not `app.moveToApplicationsFolder()`

In Electron 44 (`shell/browser/ui/cocoa/electron_bundle_mover.mm`) it moves the installed app to
the Trash before copying the new one, always targets `/Applications` and asks for an administrator
password instead of using `~/Applications`, quits before the app can re-register anything, and does
not know the earlier bundle names. The pinned Electron 44.4.2 does include the fix for its
AppleScript injection (CVE-2026-34779, GHSA-5rqw-r77c-jp79, fixed in 38.8.6, 39.8.1, 40.8.0 and
41.0.0-beta.8 by electron/electron#50044), but the app does not call it. It does call
`app.isInApplicationsFolder()`.

## Turning it off

`STUDIO_SELF_INSTALL=off` skips the step, for automation that runs the app from a disk image.
