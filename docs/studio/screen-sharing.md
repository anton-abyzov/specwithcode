# Screen sharing

See the screen of one of your own machines from another of your own devices, through SpecWithCode
Connect. This first version is view-only and the machine being viewed must be a Mac. Control
(pointer, keys), Windows and Linux machines, and the phone viewer come in later versions.

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

"Always allow this device" lets that device in later without a prompt. Such a grant ends 30 days
after its last use, and you can remove it on the machine's card at any time. Removing it also makes
the next view a first time again, code included.

A session ends after 2 hours, when you press Stop or End, when the viewing device goes quiet for
2 minutes, when the device is removed from the approved list, when its sign-in ends, when sharing
is turned off, or when the app quits. One device views at a time.

While the Mac is locked the viewer shows "This Mac is locked" and no picture. Unlocking it is done
at the machine.

## What the viewer gets

A picture of one display at a time, up to 1920 pixels on the long edge, a few times a second and
only when the screen changed, with the pointer drawn on it. No sound, no clipboard, no files, no
typing and no clicks in this version.

The card of the machine being viewed keeps a list of recent sessions: which device, when, for how
long, and how it was allowed or why it was refused. Pictures are never kept.

## How it is protected

- **The app at the machine decides.** The switch, the list of devices always allowed, the
  machine's screen-sharing key and the session list live in the desktop app's main process, in a
  file sealed with AES-256-GCM under a key that macOS keeps. The server on that machine only checks
  who is calling and passes bytes on. There is no RPC method, no MCP tool and no other HTTP route
  for any of it; `apps/server/src/screenShare/noAgentPath.test.ts` fails if one is added.
- **Only a person's approved device may view.** The viewing socket is refused for agent threads,
  worker grants, outside MCP clients, management keys, pairing codes, the startup link and the
  local command line (`apps/server/src/auth/personDevice.ts`). The device signs each session with
  the key that was approved.
- **Only the machine's own app may host.** Its socket must come from the machine itself and prove
  itself on every connection, with a proof the app's own window never holds, renewed every few
  minutes and checked again when a viewer opens.
- **The picture is sealed end to end.** Each session has its own keys (X25519, HKDF-SHA256,
  AES-256-GCM). The relay in between, Cloudflare's edge and the server on the machine carry only
  sealed bytes. The machine signs the handshake with its screen-sharing key; a viewer that has
  saved that key refuses any other and says the key changed.
- **The server keeps its own limits** whatever the app does: a deadline for the handshake, a
  longest session, a limit on how often one device may ask, and a small size for anything a viewer
  sends.
- **Computer use on the viewing machine pauses** while the app shows another machine's screen, so
  that screen does not end up in a thread's screenshots.

## What it does not protect against

- **A program already running as you on the machine being viewed.** It can already take
  screenshots with the permissions the app holds, and it could run code as the app. The prompt,
  the banner and the session list tell you what remote devices and people did, not what local
  programs do.
- **A person who authenticates without reading.** A synthetic click can press Allow so that the
  system's dialog appears. The dialog names the device and the choice; approving it with Touch ID
  is the decision.
- **An older copy of the app's file put back by a local program.** A grant you removed could
  return that way. Sealing stops the file being edited by something that cannot run code as the
  app; it does not stop an earlier copy being put back.
- **What happens on the viewing device.** A viewer open in a browser tab cannot stop something
  else on that device from taking a screenshot of it.

## Not verified yet

- Capture on an installed, signed release. The capture path was measured with a development
  build; the first real check is turning the switch on at a Mac with a released build.
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
| The viewer and the settings               | `apps/web/src/components/screenShare/`                                                                |

Focused tests:
`node node_modules/vite-plus/bin/vp test run packages/shared/src/screenShareChannel.test.ts packages/shared/src/desktopBootstrapToken.test.ts apps/server/src/auth/personDevice.test.ts apps/server/src/screenShare/ apps/desktop/src/screenShare/ apps/web/src/components/screenShare/`.
The headless fixture is listed in `docs/operations/checks.md`.

Rules to keep when changing it:

- Nothing turns sharing on or adds a grant without the system's authentication at the machine.
- Agents get no path to it. A new RPC method, MCP tool or HTTP route for screen sharing is a
  product decision, not a refactor.
- The server stays unable to open a record: it is never given a key.
- No frame leaves before the banner is up.
