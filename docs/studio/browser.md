# Browser

SpecWithCode has its own browser beside every thread. You and your agents
share it: you watch and steer, the agent clicks and types. This page covers
what it can do, how agents use it, and how to work with several accounts
(for example two Google Ads logins) without mixing them up.

## What the in-app browser does

- Tabs with back, forward, reload and hard reload, an address bar, and
  per-tab zoom and light/dark emulation.
- DevTools, screenshots, and screen recordings (frame rate and key/mouse
  press overlays are set under Settings > Integrations > Browser).
- Element picking: point at something on the page and send it to the chat as
  context.
- A device toolbar for fixed viewports, a floating mini player, and a
  separate always-on-top window.
- Browser profiles: each profile keeps its own cookies and storage. The
  built-in profiles are Default and Incognito; you can add your own.
- Local servers: the empty tab lists every web server running on this
  machine, whichever app started it. Each row is named by the page's own
  title (for example "Ads Dashboard"), or by what is running it
  ("Node server", "SSH tunnel") when the page has no title, else
  "Local server". The second line shows `localhost:PORT · <process>`; hover a
  row to read both lines in full. The
  SpecWithCode instance you are using is left out; other SpecWithCode
  instances (another machine's service reached over an SSH tunnel, say) are
  labelled "SpecWithCode" and listed last.

## How agents use it

When agent browser access is on (Settings > Integrations > Agent browser
access, per project), agents get the `preview_*` tools from the SpecWithCode
MCP server: `preview_open`, `preview_navigate`, `preview_snapshot`,
`preview_click`, `preview_type`, `preview_press`, `preview_scroll`,
`preview_wait_for`, `preview_evaluate`, `preview_upload`,
`preview_recording_start` / `preview_recording_stop` and more. The tab an
agent opens shows up beside its thread, so you can watch it work and take
over at any time.

Agent tabs use isolated storage unless you pick a browser profile for agents
(Settings > Integrations > Browser profiles > a profile's menu > Use for
agents). Agents then share that profile's saved logins.

## Working with several accounts

There are two ways to keep accounts apart, and they combine well.

### 1. Signed-in profiles inside SpecWithCode (agents can use these)

1. Settings > Integrations > Browser profiles > Import from, then pick the
   browser and its profile (for example Chrome, "Work"). SpecWithCode copies
   that profile's cookies into a new in-app profile, so you are signed in
   there without typing a password. Only cookies are copied, never saved
   passwords.
2. Open the new profile's menu and choose Use for agents if agents should
   act as that account.
3. Repeat for each account, one in-app profile per account.

Cookie import works for Chrome, Edge, Brave, Vivaldi, Opera, Arc, Helium,
Firefox and Safari on macOS, and for the ones that exist on Linux. On
Windows, most Chromium browsers encrypt cookies to the browser itself
(App-Bound Encryption), so only Firefox and Helium can be imported there.

### 2. Sending pages to a profile in your own browser

The desktop app finds the Chrome, Edge, Brave, Vivaldi and Helium profiles
installed on the machine (with the account each one is signed in to, when
the browser records it). Helium is found on macOS and Linux only. Opera and
Arc are left out: they do not take Chrome's `--profile-directory` flag, so a
page could not be sent to a chosen profile; their cookies can still be
imported as above.

- Settings > Integrations > Browser > Open links in: choose
  "Your default browser", "SpecWithCode", or a specific profile such as
  "Chrome — Work". Links in the chat and terminal then open there.
- In the in-app browser, the more menu (three dots) > Open in sends the
  current page to your default browser or to any detected profile. The list
  is read again each time the menu opens, so a profile you just created shows
  up. The address bar's open-in-browser button follows the "Open links in"
  choice, and its tooltip says where it goes (for example
  "Open in Chrome — Work").
- Some links always use your default browser: a link's right-click
  "Open in default browser" item, and sign-in pages for providers and
  accounts.

On macOS the page opens with
`open -na <browser app> --args --profile-directory=<profile> <url>`; on
Windows and Linux the browser executable is started with the same flag. If
the browser or profile is gone, the link opens in your default browser
instead. The web version of SpecWithCode cannot see or launch other browsers,
so these choices only appear in the desktop app.

## Why agents cannot drive your real Chrome profile

Agents control a browser through the Chrome DevTools Protocol. Since Chrome
136, Chrome refuses `--remote-debugging-port` and `--remote-debugging-pipe`
when they point at its default user-data directory, which is where your
everyday signed-in profiles live. Google made this change because malware
used remote debugging to steal cookies from real profiles. Getting around it
would mean copying your whole profile somewhere else or weakening that
protection, so SpecWithCode does not do it.

What works instead: import the cookies of the profile you need into an in-app
profile (agents can drive that), and send pages to your real Chrome profile
when you want to look at them yourself.
