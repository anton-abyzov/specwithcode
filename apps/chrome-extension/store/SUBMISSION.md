# Chrome Web Store submission: SpecWithCode Browser 1.0.4

Every field the developer dashboard asks for, in the order it asks, with paste-ready values. Images are in `screenshots/`; the privacy policy text is in `privacy-policy.md`.

## 0. Before you start

- **Publisher account:** anton.abyzov@gmail.com (registration fee of USD 5 already paid). Per the JobWeave notes of October 6, 2026, the account still has **no verified contact email**. Add one and click the verification link (Dashboard → Account → Contact email) before submitting; publishing is blocked without it.
- **Privacy policy page:** publish `privacy-policy.md` at <https://spec-weave.com/specwithcode/chrome-extension-privacy>. The page does not exist yet and review checks that it loads.
- **Package:** `apps/chrome-extension/dist/specwithcode-browser-1.0.4.zip`. Build it with `node apps/chrome-extension/scripts/build.mjs` (or `pnpm --filter @specweave-studio/chrome-extension build`). The build refuses a manifest with a `key`, host permissions, an unreviewed permission or a description over 132 characters.
- **Screenshots:** regenerate with `PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never node apps/chrome-extension/store/screenshots/src/render.mjs` (headless Chromium).

## 1. Package

| Field  | Value                                                       |
| ------ | ----------------------------------------------------------- |
| Upload | `apps/chrome-extension/dist/specwithcode-browser-1.0.4.zip` |

The summary shown on the listing comes from the manifest `description` (121 of 132 characters):

```
Let the coding agents you run in SpecWithCode use this Chrome profile, in a visible tab group, on this computer only.
```

## 2. Store listing tab

| Field                         | Value                                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                          | `SpecWithCode Browser` (from the manifest)                                                                                                                                   |
| Summary                       | From the manifest, above (121 characters)                                                                                                                                    |
| Category                      | Developer Tools                                                                                                                                                              |
| Language                      | English                                                                                                                                                                      |
| Store icon (128×128)          | `apps/chrome-extension/icons/icon-128.png`                                                                                                                                   |
| Screenshots (1280×800)        | `screenshots/screenshot-1-overview.png`, `screenshot-2-pair.png`, `screenshot-3-tab-group.png`, `screenshot-4-agents.png`, `screenshot-5-control.png` (upload in this order) |
| Small promo tile (440×280)    | `screenshots/promo-small-440x280.png`                                                                                                                                        |
| Marquee promo tile (1400×560) | `screenshots/promo-marquee-1400x560.png`                                                                                                                                     |
| Official URL                  | Leave unset unless spec-weave.com is verified in Google Search Console for this account                                                                                      |
| Homepage URL                  | `https://spec-weave.com`                                                                                                                                                     |
| Support URL                   | `https://spec-weave.com`                                                                                                                                                     |
| Mature content                | No                                                                                                                                                                           |

### Detailed description (paste as is)

```
SpecWithCode Browser lets the agents you run in the SpecWithCode desktop app use this Chrome profile: your tabs, your logins and your cookies, on this computer only.

Pair once with a code from SpecWithCode (Settings › Chrome), give the profile a name such as "Personal" or "Work", and your agents can open tabs, read pages, click, type and take screenshots, signed in as you. It works with any coding agent you run in SpecWithCode, whichever AI provider it uses.

WHAT YOU SEE
• Every tab an agent opens or works in sits in a blue "SpecWithCode · <profile name>" tab group, so you always know which tabs agents are using.
• Drag a tab out of the group and it is yours again: the agent detaches from it.
• The toolbar badge shows ON while agents can use this profile.
• Pause stops all agent access at once. Unpair forgets the pairing.

HOW IT CONNECTS
The extension talks only to the SpecWithCode app on the same computer, over a loopback WebSocket (127.0.0.1). A pairing code that points anywhere else is refused, so a pasted code can never connect your browser to another machine. The app can ask only for a fixed list of browser actions (attach to a tab, send it browser commands, and open, list, switch to or close tabs). Chrome's own pages (chrome://, extension pages, DevTools) cannot be controlled.

PRIVACY
• No servers of its own: nothing is sent to the developer or any third party.
• No analytics, no ads, no tracking, no remote code.
• The pairing token and profile name are kept in Chrome's local extension storage and deleted when you unpair.
• Page content goes only to SpecWithCode on your computer. What happens next is up to you: an agent you run there may send it to the AI provider you chose for that agent.
Full policy: https://spec-weave.com/specwithcode/chrome-extension-privacy

REQUIREMENTS
The SpecWithCode desktop app running on the same computer (https://spec-weave.com). Chrome 120 or later.

OPEN SOURCE
SpecWithCode Browser is open source under the Apache License 2.0. It is derived from Microsoft's Playwright MCP Bridge extension (Playwright, Copyright Microsoft Corporation, Apache-2.0); the NOTICE file in the package lists the derived files and the changes.
```

## 3. Privacy practices tab

### Single purpose

```
Connects this Chrome profile to the SpecWithCode desktop app on the same computer so the user's own coding agents can open, read and operate browser tabs for the user, in a visible tab group the user can pause, take back or unpair at any time.
```

### Permission justifications (one box each)

**debugger**

```
Agents act on a page through the Chrome DevTools Protocol: reading the page, clicking, typing and taking screenshots. The extension attaches the debugger only to tabs SpecWithCode asks for, moves each attached tab into the visible SpecWithCode tab group, and detaches when the user drags the tab out of the group, pauses, unpairs or the connection closes. Chrome's internal pages are refused.
```

**tabs**

```
Lets agents open a new tab, find a tab by URL or title, switch to it, navigate it and close it, and lets the extension notice when an agent's tab is closed. Tab URLs and titles go only to the SpecWithCode app on the same computer.
```

**tabGroups**

```
Keeps every tab an agent controls in one blue tab group titled "SpecWithCode · <profile name>", so the user always sees which tabs agents use. Dragging a tab out of the group hands it back to the user. Leftover groups from a previous session are cleaned up on start.
```

**storage**

```
Stores the pairing (the local app address, a random token and the computer's name), the profile name the user chose and the paused setting in chrome.storage.local, so the extension reconnects after Chrome restarts. Nothing is synced or sent elsewhere; Unpair deletes the pairing.
```

**alarms**

```
A 30-second watchdog alarm reconnects to the SpecWithCode app on this computer after Chrome suspends the service worker or the app restarts, so the user does not have to re-open the popup.
```

**Host permissions:** none requested.

### Remote code

`No, I am not using remote code.` (All JavaScript ships in the package; nothing is fetched or evaluated at run time.)

### Data usage

Tick these categories:

| Category                            | Tick | What it covers                                                                                                         |
| ----------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------- |
| Authentication information          | Yes  | The pairing token, stored locally and sent only to SpecWithCode on the same computer                                   |
| Web history                         | Yes  | URLs and titles of open tabs, listed so agents can find or reuse a tab; sent only to SpecWithCode on the same computer |
| Website content                     | Yes  | Text, page structure and screenshots of tabs an agent works in; sent only to SpecWithCode on the same computer         |
| Personally identifiable information | No   |                                                                                                                        |
| Health information                  | No   |                                                                                                                        |
| Financial and payment information   | No   |                                                                                                                        |
| Personal communications             | No   |                                                                                                                        |
| Location                            | No   |                                                                                                                        |
| User activity                       | No   | (Agents perform clicks and typing; the extension does not monitor the user's own input)                                |

### Certifications (tick all three)

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Privacy policy URL

`https://spec-weave.com/specwithcode/chrome-extension-privacy` (must be live before you submit; text in `privacy-policy.md`).

## 4. Test instructions (for the reviewer)

```
SpecWithCode Browser needs the SpecWithCode desktop app on the same computer (download: https://spec-weave.com). It has no account or server.
1. Install and open SpecWithCode. Go to Settings › Chrome and copy the pairing code.
2. Click the SpecWithCode Browser toolbar icon, paste the code, enter a profile name (e.g. "Review") and click "Pair this profile". The popup shows "Connected" and the badge shows ON.
3. In SpecWithCode, ask any agent to open https://example.com and take a screenshot. A tab opens inside a blue "SpecWithCode · Review" tab group.
4. Drag that tab out of the group: the agent lets go of it. Click Pause or Unpair in the popup to stop all access.
Without the desktop app the extension stays "Not paired" and does nothing.
```

## 5. Distribution

- **Visibility:** start **Unlisted**. The extension only works with the SpecWithCode app, and Unlisted lets you link it from the app and spec-weave.com while the first review and real-world pairing are confirmed. Switch to **Public** once the listing is approved and the in-app "Add to Chrome" link works.
- **Regions:** all regions.
- **Pricing:** free.

The `debugger` permission usually triggers an in-depth review, so expect more than a few days.

## 6. Dashboard checklist

1. Sign in to <https://chrome.google.com/webstore/devconsole> as anton.abyzov@gmail.com.
2. Account: add a contact email and verify it from the link Google sends.
3. Confirm <https://spec-weave.com/specwithcode/chrome-extension-privacy> loads with the text of `privacy-policy.md`.
4. Items → New item → upload `apps/chrome-extension/dist/specwithcode-browser-1.0.4.zip`.
5. Store listing: paste the detailed description; set category Developer Tools and language English.
6. Store listing: upload the store icon, the five screenshots in order and both promo tiles.
7. Store listing: set homepage and support URLs to `https://spec-weave.com`.
8. Privacy practices: paste the single purpose statement.
9. Privacy practices: paste the five permission justifications (debugger, tabs, tabGroups, storage, alarms).
10. Privacy practices: remote code → No.
11. Privacy practices: tick Authentication information, Web history and Website content; leave the rest unticked.
12. Privacy practices: tick the three certifications and enter the privacy policy URL.
13. Test instructions: paste the reviewer steps from section 4.
14. Distribution: visibility Unlisted (or Public), all regions, free.
15. Click **Submit for review**.

## After approval

Copy the item id (32 letters a–p) from the dashboard URL; the listing is `https://chromewebstore.google.com/detail/<item-id>`. Link it from SpecWithCode Settings › Chrome and spec-weave.com. A store install pairs with a fresh code, like any new profile.

## Updating

Bump `version` in `apps/chrome-extension/manifest.json` and `package.json`, rebuild, upload the new zip on the item's **Package** tab, submit for review. Update the privacy practices tab first if the extension handles any new data.
