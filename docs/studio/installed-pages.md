# Installed pages

A page from a chat can be installed as an app. It gets a launcher in the system's app folder and opens in its own window, with no chat around it.

## Where launchers go

| System                   | Launcher                                                                             | How it opens                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| macOS, packaged app      | `~/Applications/SpecWithCode Apps/<Name>.app`, built from Electron's app shim loader | The page runs as its own app: its own Dock icon, app switcher entry, menu bar and Command-Q |
| macOS, development build | the same folder, a shell script that opens `studio-dev://app/artifact-app/<id>`      | A window of SpecWithCode                                                                    |
| Windows                  | a Start menu shortcut                                                                | A window of SpecWithCode, grouped under the page's own taskbar id                           |
| Linux                    | a `.desktop` entry that runs `xdg-open studio://app/artifact-app/<id>`               | A window of SpecWithCode                                                                    |

## macOS: one app per page

The launcher's executable is a copy of `app_shim_loader` from SpecWithCode's Electron framework. Its `Info.plist` names the running SpecWithCode.app (`ElectronAppShimHostPath`), its bundle id, and the shim server's name (`<bundle id>.artifact-apps`).

When the page's app starts, the loader connects to SpecWithCode. If SpecWithCode is not running, the loader starts it first. SpecWithCode then creates the page's window inside the shim process, so macOS treats the page as an app of its own.

Every launcher is ad-hoc signed when it is written. Its code hash is kept in `artifact-app-shims.json` (mode 0600) in the desktop state folder, never in the install record the client sees. Any process of the same user can connect to the shim server, so SpecWithCode opens a window only when both of these hold:

- the shim's bundle path is the launcher of a recorded install, and the launcher on disk is exactly what SpecWithCode wrote;
- the running shim process meets the code requirement `cdhash H"<recorded hash>"`.

Anything else is turned away with `shim.quit()` and opens nothing. Checks wait until the main window exists, like every other launch.

When SpecWithCode itself starts a page's app (reopening it after a restart, or a second install of the same page), it first verifies the bundle against its signature with `codesign --verify --strict` and compares the hash with the recorded one. A bundle whose executable was changed is never started.

The checks defend against other processes connecting to the shim server or changing a launcher. They do not defend against a process that can rewrite SpecWithCode's own state folder: such a process can already change the install records, grants and settings kept there. A process that swaps a launcher in the moment between that check and Launch Services starting it gets only its own code started, which it could start itself; its window is still refused when it connects.

### What the page's app does

- **Menu bar:** the app menu is named after the page and has About, Show App in Finder, Uninstall, Hide, Hide Others, Show All and Quit. Edit, View (Reload, zoom, full screen) and Window menus follow.
- **Command-Q** quits the page's app only. SpecWithCode keeps running.
- **Closing the window** quits the page's app, so no Dock icon is left with no window.
- **Clicking its Dock icon,** or opening it again, brings its window forward or reopens it.
- **Pages that were open come back** when SpecWithCode restarts. Their install ids are kept in `artifact-apps-reopen.json` and removed once read.

SpecWithCode itself opens normally when a page's app starts it.

### Upgrades

At start, SpecWithCode rebuilds every recorded install's launcher as a shim. That covers older script launchers, and shims that point at a SpecWithCode.app path which is no longer the running one. A launcher that was changed by hand or is missing is left alone and logged. The new bundle is staged and signed, swapped in, and then its hash is recorded; the old one goes to the Trash. A failed swap or a failed record write puts the old launcher back. If SpecWithCode stops part way through, the next start puts a launcher left aside back in place, but only one that is exactly what the install's records describe, and rebuilds a new bundle that has no record yet rather than trusting it. Old copies an upgrade set aside are trashed on every start once the launcher is current, and first thing when the page is uninstalled; never through a linked folder. An empty launcher path beside a copy that an uninstall could not trash is left empty. A page's app that was already running the old bundle (it started SpecWithCode, for example after SpecWithCode was moved) is still accepted with the old hash until SpecWithCode quits.

If the shim server cannot start, new installs get script launchers that open windows of SpecWithCode.

If SpecWithCode was updated on disk while it was running, a page's app cannot load the new framework. SpecWithCode then shows "<Name> could not open because SpecWithCode was updated." once per page, and the fix is to quit and reopen SpecWithCode.

### Limits

- Electron's app shim API is experimental.
- In a shim window, SpecWithCode's own menu and its shortcuts do not apply; the page's menu does.
- A shim window has no parent or modal windows, no progress bar and no `flashFrame`.

## Other systems

Windows and Linux windows belong to SpecWithCode. On macOS, a window that is not in a shim (an old launcher, or a development build) catches Command-Q and closes only the page.

## Code

- `apps/desktop/src/artifactApps/ArtifactAppLaunchers.ts`: launcher file generators.
- `apps/desktop/src/artifactApps/ArtifactAppInstaller.ts`: install, ownership checks, signing, hash records, upgrade.
- `apps/desktop/src/artifactApps/ArtifactAppShims.ts`: shim server, verification, page menu, reopen and update message.
- `apps/desktop/src/artifactApps/ArtifactAppWindows.ts`: page windows, in a shim or not.
- `apps/desktop/src/artifactApps/ArtifactAppShimRecords.ts`: the private hash and reopen files.
