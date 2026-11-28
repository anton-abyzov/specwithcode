# Screen sharing

See the screen of one of your own machines from another of your own devices, through SpecWithCode
Connect. The machine being viewed must be a Mac. A device that views it can also ask to control it
(pointer, scroll and keys), which a person at the Mac allows separately. Windows and Linux machines
and the phone viewer come in later versions.

Screen sharing is off on every machine until a person turns it on at that machine.

## Turn it on

1. At the Mac you want to view, open Settings > Machines and find this Mac's card.
2. Turn on "Screen sharing". macOS asks for Touch ID or your account password. That is the app
   checking that a person is at the machine; a click alone never turns it on.
3. The first time, macOS also asks for Screen Recording for SpecWithCode
   (System Settings > Privacy & Security > Screen & System Audio Recording). Without it there is
   nothing to show, and the card says so.

There is no way to turn it on from another machine, from a thread, or from a settings file.
Turning it off needs no authentication and ends a session that is running.

## View a machine

On another of your devices that is signed in to SpecWithCode Connect and on that machine's approved
list, open Settings > Machines and press "View screen" on the machine's card.

In the desktop app the screen opens in a window of its own, titled "Screen of <machine>". Each
machine gets one window, which remembers its size and place, so you can watch several machines side
by side. Pressing "View screen" again brings that machine's window forward. The arrow beside the
button offers "View in this window", which shows the screen over the app's window instead. A machine
already shown somewhere is brought forward rather than opened twice, because a machine shows its
screen to one viewer at a time. In a browser tab the screen shows over the page.

What happens at the machine being viewed:

- A prompt appears: "Work laptop (ID 7F3A) wants to view this Mac's screen", with Deny, Allow once
  and Always allow this device. The name is the one you approved that device under, not what the
  device calls itself now. Each Allow asks for Touch ID or your password, and the system's dialog
  says which of the two you are allowing and for which device. Read it. No answer in 60 seconds is
  Deny.
- The first time a device views this machine, the prompt also shows a 6-digit code. Type it on the
  viewing device. This tells the person at the viewing device that the machine on the other end is
  really this one. Nothing is shown until the code matches. Three wrong codes end the attempt.
- While the screen is being viewed, a banner stays on every display with the device's name, the
  time it has been viewing and a Stop button. If the banner cannot be shown, nothing is shown to
  anyone.

A device that is denied, left unanswered, gives up or sends a wrong code three times in 10 minutes,
after a person here was asked, is not asked about again for 10 minutes.

"Always allow this device" lets that device in later without a prompt. Such a grant ends 30 days
after its last use, and you can remove it on the machine's card at any time. Removing it also makes
the next view a first time again, code included.

A session ends after 2 hours, when you press Stop or End, when the viewing device goes quiet for
2 minutes, when the device is removed from the approved list, when its sign-in ends, when sharing
is turned off, or when the app quits. One device views at a time.

While the Mac is locked the viewer shows "This Mac is locked" and no picture. Unlocking it is done
at the machine.

## What the viewer gets

A picture of one display at a time, only when the screen changed, with the pointer drawn on it. No
sound, no clipboard, no files, no typing and no clicks in this version.

When both ends run a release newer than 1.0.460, the picture is sized to the viewer's window and its pixel ratio
(at least 640 and at most 2,880 pixels on the long edge, never more than the display has), and the
machine looks again every 100 ms while the screen changes, every 330 ms once it is still. One
picture is on its way at a time, so a slow link gets fewer pictures, never a backlog. "Low bandwidth"
in the viewer's header caps the picture at 1,280 pixels and encodes it rougher, for a phone hotspot
or a hotel network. The pulse button shows the frame rate, the size of the last picture and the
time from the start of its capture to the viewer's confirmation, measured on the machine's own
clock.

An older viewer or an older machine gets what 1.0.443 gave: up to 1920 pixels, at most one picture
every 330 ms. The machine says what it supports inside the sealed session, and neither end sends
the other anything it does not know.

The card of the machine being viewed keeps a list of recent sessions: which device, when, for how
long, and how it was allowed or why it was refused. Pictures are never kept.

## Control the machine

When the Mac offers control, a live view shows **Request control**. The Mac then shows "Work
laptop (ID 7F3A) wants to control this Mac" with **Deny** and **Always allow control**. Always
allow asks for Touch ID or the account password at the Mac. After that the device can control the
Mac with nobody there, until 30 days after it last did. Allowing a device to view never lets it
control, and a control grant never lets a device view without the view rules above. Removing a
device in Settings removes both.

While a device controls the Mac:

- The banner reads "Work laptop (ID 7F3A) is controlling this screen", and **Stop** ends control
  and the view.
- The viewer's picture area has an amber edge. Pointer, scroll and keys go to the Mac while that
  area has focus. **Stop control** goes back to viewing.
- Computer use on the Mac pauses, so an agent and a person never move the same pointer.
- Nothing is typed on the Mac while a password field has focus there (macOS secure input), while a
  system prompt is open (SecurityAgent, the Touch ID dialog), while a browser is the front app, or
  while the Mac is locked. Clicks stop too while a system prompt is open or the Mac is locked. The
  viewer says why typing is off. Clicks and scrolling still work in a browser.
- Every key and button held is let go when control ends, the view ends, the viewer leaves or goes
  quiet for 5 seconds, the picture moves to another display, or the window loses focus.

Control needs the Mac's Accessibility permission for SpecWithCode (System Settings > Privacy &
Security > Accessibility). Without it the Mac does not offer control. Keys are sent as physical
keys and typed with the Mac's own keyboard layout.

Browsers in front of which nothing is typed, by bundle identifier: Safari and Safari Technology
Preview, Chrome (stable, beta, dev, canary), Chromium, Firefox (stable, developer, nightly), Edge
(stable, beta, dev), Brave (stable, beta), Arc, Dia, Opera, Vivaldi, Zen, Tor Browser, Orion, Comet,
ChatGPT Atlas, DuckDuckGo, Waterfox and LibreWolf (`CONTROL_BROWSER_BUNDLE_IDS` in `apps/desktop/src/screenShare/screenControl.logic.ts`).
A password field on a web page does not turn macOS secure input on, so a browser cannot be told
apart from one.

## How it is protected

- **The app at the machine decides.** The switch, the list of devices always allowed, the
  machine's screen-sharing key and the session list live in the desktop app's main process, in a
  file sealed with AES-256-GCM under a key that macOS keeps. The server on that machine only checks
  who is calling and passes bytes on. There is no RPC method, no MCP tool and no other HTTP route
  for any of it. `apps/server/src/screenShare/noAgentPath.test.ts` checks the MCP tools, the RPC
  methods and the routes for screen sharing's names and paths; a path added under another name
  would pass it, so adding one is a review matter too.
- **Only a person's approved device may view.** The viewing socket is refused for agent threads,
  worker grants, outside MCP clients, management keys, pairing codes, the startup link and the
  local command line (`apps/server/src/auth/personDevice.ts`). The device signs each session with
  the key that was approved, and before that it has to answer a number from the server with that
  key. A copy of the device's sign-in ticket without the key opens nothing, uses up none of the
  device's tries and is never told to the app.
- **Only the machine's own app may host.** Its socket must come from the machine itself and prove
  itself on every connection, with a proof the app's own window never holds, renewed every few
  minutes and checked again when a viewer opens and every minute while one is viewing.
- **The picture is sealed end to end.** Each session has its own keys (X25519, HKDF-SHA256,
  AES-256-GCM). The relay in between, Cloudflare's edge and the server on the machine carry only
  sealed bytes. The machine signs the handshake with its screen-sharing key; a viewer that has
  saved that key refuses any other and says the key changed. For a viewer open in a browser tab
  this holds as long as the page's own code arrived unchanged (see below).
- **The server keeps its own limits** whatever the app does: a deadline for the handshake, a
  longest session, a limit on how often one device may ask, and a small size for anything a viewer
  sends. One WebSocket message is still read whole before its size is known, up to the server's
  general limit of 100 MB; a message over screen sharing's own limits then ends the session.
- **Control is a second permission.** It is asked for inside a live, sealed view, only from a
  machine that offers it, with its own prompt and its own grant. The banner says "is controlling"
  and the session list records it before the first event is posted. The input helper
  (`native/screen-control/main.swift`) runs only during control, takes commands only over the pipe
  the app started it with, checks secure input, system prompts and the front app before each key,
  click, scroll and drag, and blocks when it cannot read them. Input that waited more than a second
  is dropped, except what lets go of a key or button, and at most 256 lines wait at once. It exits
  when the pipe closes or after 2 minutes without a command, and the app kills it 2 seconds after
  the session ends at the latest.
- **Computer use on the viewing machine pauses** while the app shows another machine's screen, so
  that screen does not end up in a thread's screenshots. Every view is counted on its own, and a
  screen's own window counts from the moment it opens until it closes, so closing one of two views
  does not resume computer use while the other is still on screen.

## What it does not protect against

- **A program already running as you on the machine being viewed.** It can already take
  screenshots with the permissions the app holds, and it could run code as the app. The prompt,
  the banner and the session list tell you what remote devices and people did, not what local
  programs do.
- **A person who authenticates without reading.** A synthetic click can press Allow so that the
  system's dialog appears. The dialog names the device and the choice; approving it with Touch ID
  is the decision.
- **Typing into a web page's password field while a non-browser app is in front.** An app that
  draws its own web content (an Electron app, for example) is not on the browser list, and its
  password fields do not turn secure input on.
- **An older copy of the app's file put back by a local program.** A grant you removed could
  return that way. Sealing stops the file being edited by something that cannot run code as the
  app; it does not stop an earlier copy being put back.
- **What happens on the viewing device.** A viewer open in a browser tab cannot stop something
  else on that device from taking a screenshot of it.
- **A browser-tab viewer whose code was changed on the way.** In a browser the viewer's code
  comes through the same network edge as the picture. An edge that rewrote that code could make
  the tab accept another machine's key or skip the code check. The installed app carries its own
  code and has no such limit.
- **Someone on the network path making it fail.** The relay and the edge can drop or delay a
  session, as they can any connection. They cannot see or change one. Copies of a sign-in ticket
  without the device's key leave nothing behind. A session they break while a person is being
  asked does count as that device giving up, since the person was asked; three of those in 10
  minutes rest the device for 10.

## Not verified yet

- Capture on an installed, signed release. The capture path was measured with a development
  build; the first real check is turning the switch on at a Mac with a released build.
- The banner's Stop on an installed build. It depends on a small file packaged beside the app's
  main code; the app checks the file is there and shows nothing without it, but that the packaged
  one loads is first seen on a released build.
- A Mac with no Touch ID sensor in reach (Mac mini, Mac Studio, a laptop with its lid closed).
  macOS should fall back to the account password there. If it does not, screen sharing cannot be
  turned on at that Mac until a password path is added.

## For developers

| Part                                      | Where                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Messages, limits and end reasons          | `packages/contracts/src/screenShare.ts`                                                               |
| The sealed session and the first-use code | `packages/shared/src/screenShareChannel.ts`                                                           |
| Who may open the two sockets              | `apps/server/src/auth/personDevice.ts`, `apps/server/src/screenShare/ScreenShareHttp.ts`              |
| The relay between them                    | `apps/server/src/screenShare/ScreenShareRelay.ts`                                                     |
| The session's rules at the machine        | `apps/desktop/src/screenShare/screenShareSession.logic.ts`                                            |
| The sealed file                           | `apps/desktop/src/screenShare/ScreenShareStore.ts`, `apps/desktop/src/screenShare/screenShareSeal.ts` |
| Capture, prompt and banner                | `apps/desktop/src/screenShare/ScreenCapture.ts`, `apps/desktop/src/screenShare/ScreenShareWindows.ts` |
| Control rules and the input helper        | `apps/desktop/src/screenShare/screenControl.logic.ts`, `native/screen-control/main.swift`             |
| The viewer and the settings               | `apps/web/src/components/screenShare/`                                                                |

Focused tests:
`node node_modules/vite-plus/bin/vp test run packages/shared/src/screenShareChannel.test.ts packages/shared/src/desktopBootstrapToken.test.ts apps/server/src/auth/personDevice.test.ts apps/server/src/screenShare/ apps/desktop/src/screenShare/`,
and from `apps/web`: `node ../../node_modules/vite-plus/bin/vp test run src/components/screenShare/`.
The headless fixture is listed in `docs/operations/checks.md`.

Rules to keep when changing it:

- Nothing turns sharing on or adds a grant without the system's authentication at the machine.
- The server opens, counts and tells the app nothing for a viewer socket until it has shown the
  device's key. A limit keyed on the device that a copied ticket could use up is a way to lock
  that device out.
- Agents get no path to it. A new RPC method, MCP tool or HTTP route for screen sharing is a
  product decision, not a refactor.
- The server stays unable to open a record: it is never given a key.
- No frame leaves before the banner is up.
- No input is posted before the banner says "is controlling" and the session list has it. Every end
  of control lets go of every key and button.
