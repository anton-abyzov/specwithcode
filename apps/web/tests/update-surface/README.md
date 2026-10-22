# Update surface visual fixtures

This harness renders the production sidebar update controls, `SidebarRestartToUpdate` and
`SidebarServerUpdate`, in a sidebar-footer column as wide as the app sidebar before anyone
resizes it (256px, `resolveInitialThreadSidebarWidth` in `src/components/threadSidebarWidth.ts`),
with the real `ConfirmDialogHost` mounted. The desktop bridge, desktop and service update
state, server configs, session and `prepareServiceUpdate` command are explicit in-memory fakes
(`mocks.tsx`). Nothing installs, restarts or reaches a server; the fake bridge records install
calls so the receipt can prove that none were made. These receipts prove UI behaviour and
layout; the real desktop update path remains a separate gate.

Build the web application in this checkout first. The fixture reads its production
stylesheet from `apps/web/dist/assets` and does not overwrite a shared build. Install
Playwright in an isolated Python runtime, then run from the repository root:

```sh
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never /absolute/path/to/playwright/python \
  apps/web/tests/update-surface/verify.py --output /absolute/owned/evidence-directory
```

`--node` overrides the default isolated Node 24 path used for the Vite source fixture.
Vite serves the source module graph unbundled, so the first load can take minutes on a busy
machine; the runner allows each navigation 5 minutes.
`--chromium` overrides the default cached headless Chromium executable. The runner starts
one Node process on an ephemeral loopback port, blocks non-fixture HTTP and WebSocket
requests, and terminates only that owned process in `finally`. The fixture client reports
itself as 1.0.25 so the 1.0.20 fake servers are behind it; in `server-nightly` it reports
1.0.67-nightly.20261021.882 instead (`serve.mjs`).

Scenes (`?scene=`), each at 1440x900 in light and dark:

- `restart`: desktop update 1.0.25 downloaded with release notes. Captures the idle
  "Restart to update" button with the "What's new" sparkle button, the hover tooltip with
  release notes ("and 1 more" for the fifth item), the three-choice dialog "Restart to install
  SpecWithCode 1.0.25?" shown when `prepareServiceUpdate` reports 3 running jobs and 1 queued
  message in EasyChamp ("Restart when idle", "Restart now", "Cancel"), and the button reading
  "Restarts when idle, or in m:ss" (the forced-restart countdown) after that choice. The fake
  update feed answers that 1.0.25 is already the newest release. It asserts no install call
  was made.
- `server`: one remote server on 1.0.20 with `serverSelfUpdate: "boot-service"`. Asserts the
  row shows "Server" above "1.0.20 → 1.0.25" with its Update and × buttons ("Server" above
  "→ 1.0.25" at the 20px text size where the sidebar is narrowest), that screen readers hear it
  as "Server 1.0.20 to 1.0.25", and that hovering the row text and the Update button shows the
  same tooltip: "SpecWithCode on the server runs 1.0.20; this app runs 1.0.25. Update installs
  1.0.25 on the server and restarts it. Threads running there stop for the restart. Nothing
  else on the server changes: no settings, no other software." Only the Update button carries
  that text as its `aria-description`, so a screen reader reads it once per row. The runner
  then switches the row's update to running ("Updating server", "Downloading…", no buttons) and
  to failed ("Could not update server", Retry and ×) at each text size and width, and asserts
  the idle, running and failed rows are the same height.
- `server-desktop`: "ministorm" on 1.0.20 with `serverSelfUpdate: "desktop-managed"` and
  `desktopAppUpdate`, next to a second server already on 1.0.25 (no row), so the row is named
  by its machine, "ministorm", over the versions. Asserts the tooltip says Update installs the
  newest SpecWithCode release on ministorm and relaunches the app there, and that threads
  running there stop for the relaunch; clicking Update opens the confirm dialog naming "the
  ministorm server", and Cancel makes no update call.
- `server-continue`: "Office Mac mini build box" on 1.0.20 with `serverSelfUpdate: "respawn"`,
  `serverUpdateThreadContinuation` and "Continue threads after restarts" on, next to the same
  current server. Asserts the tooltip says threads running there continue after the restart,
  and that the long name ends in an ellipsis at every text size and width while "→ 1.0.25"
  stays whole. No current server advertises `serverUpdateThreadContinuation` (only the
  contract declares it), so this scene shows a state no released server produces yet; it keeps
  that client path covered.
- `server-nightly`: this app on 1.0.67-nightly.20261021.882 and "Build box" on 1.0.66 with
  `serverSelfUpdate: "boot-service"`, next to "ministorm" on 1.0.67 (no row: unless both sides
  are nightly builds, only x.y.z is compared). The target is too long for the column at every
  text size and width, so the current version gives way first and then
  "→ 1.0.67-nightly.20261021.882" ends in an ellipsis, keeping at least "→ 1.0.67".
- `server-none`: the `server` scene's server with `serverSelfUpdate: null`; asserts the row
  renders nothing.

Every server row is measured at two text sizes, the default (16px) and the largest that
Settings > Appearance offers (20px, set as the root font size the way the app does), each with
the column at the app sidebar's default width (256px) and at the narrowest the sidebar can be
dragged to at that size, by resizing the column in place. That minimum is 208px
(`THREAD_SIDEBAR_MIN_WIDTH`) at 16px; at 20px the brand needs more room and raises it (to
221px with the macOS system font). The fixture measures it with a copy of
`SidebarBrandWidthProbe` and a browser window's titlebar inset; the macOS desktop app's window
controls raise it further. Each receipt check keeps the four measurements under `layouts`. At
each of them:

- the row is two lines: the icon and the machine name, then the versions from under the icon;
  it is exactly as tall as its minimum, the height of the one-line running and failed rows;
- the machine name shows whole, or at least five characters before an ellipsis;
- a stable target ("→ 1.0.25") is never cut; a longer prerelease target keeps its x.y.z and
  ends in an ellipsis;
- the versions line clips its second line, so the current version is drawn whole or not at
  all, and it goes before the target is cut; whatever it draws starts at its left edge. Stable
  rows show both versions, except at 20px with the sidebar at its narrowest, where they show
  only the target ("→ 1.0.25");
- no glyph is sliced by a clip edge, and every cut part ends in an ellipsis;
- Update and × stay inside the row, and neither the row nor the column scrolls sideways;
- at the default text size, hovering the row text and hovering Update both show the whole
  description.

Screenshots (full viewport plus `-footer` crops of the bottom-left, `-row-<size>px-<width>`
crops of each server row, and `-state-<idle|running|failed>-<size>px-<width>` crops of the
`server` row), `server.log`, and `receipt.json` are saved only to the requested evidence
folder. Inspect the screenshots before treating a successful runner as visual acceptance.
