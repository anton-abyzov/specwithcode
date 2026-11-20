# Chrome for agents

Agents can work in your own Chrome, signed in as you: open a site, read a
page, fill a form, check an account. They do it through the **SpecWithCode
Browser** extension, and only in a Chrome profile you pair with this
computer.

You set it up in one of three places, and they show the same steps:

- **First-run setup**, in the **Your browser** row of the Access step. This
  row appears only in the desktop app, for the computer it runs on.
- **Settings > Chrome**, at any time, from the desktop app or a browser tab.
- The **Connect Chrome** card in a thread, when an agent needs Chrome and no
  profile is paired yet.

## Why a paired profile

Agents use only the Chrome profiles you pair, and only while they are paired.

They work in the live browser, in a blue tab group you can pull a tab out
of. Drag a tab out of the group and agents stop using it. They never read
Chrome's files on disk. The other way to give agents your Chrome data is
[Full Disk Access](./full-disk-access.md), which opens those files, and
your mail and messages, to every agent on the Mac. Pairing a profile is the
narrower choice.

## One profile or several

Pick the profile where the accounts agents need are signed in. One profile
is enough when everything agents need is signed in there. Pair a second one
for a work account or another brand's accounts. The browser tools never
reach a profile you did not pair.

Pairing another profile on this computer never disconnects the first. With
several paired, agents use the profile you name in your request ("use the
Work profile"), so give each one a name you can tell apart.

## Pair a profile

1. Press **Set up** in the **Your browser** row, or open **Settings >
   Chrome**. To add a profile when one is already paired, press **Pair
   another profile**.
2. In first-run setup in the desktop app, pick the Chrome profile from the
   list. SpecWithCode reads Chrome's profile names to show this list, and none
   starts picked: **Add to Chrome** waits until you pick one. With one profile
   there is no list. Press **Add to Chrome**: the Chrome Web Store page opens
   in that profile. In Settings > Chrome, in a browser tab, or when the list
   cannot be read, **Add to Chrome** opens in the Chrome profile you used
   last. To pair another, switch to it in Chrome first.
3. Add the extension in Chrome. On a first install it opens its own pairing
   page in that profile, with the code field ready.
4. Back in SpecWithCode, press **Copy code**. One press copies the pairing
   code without showing it. Press **Show** if you need to type it by hand.
5. Paste the code in the extension's page. Pick a name (**Personal**,
   **Work**, **Agents**, or your own) and press Enter or **Pair this
   profile**. If the pairing page is closed, click the extension's icon in
   Chrome's toolbar and paste the code there. The icon may sit behind
   Chrome's Extensions menu (the puzzle piece).

The row turns **Paired** within a few seconds and shows the profile's name.
The desktop app then clears the code from the clipboard, or after two
minutes if you did not pair.

Continue in first-run setup is never blocked by this row. You can leave it
and pair later in Settings > Chrome.

## The pairing code

The code is this computer's standing pairing code. Anyone with this code
can pair a browser with this computer, so keep it to yourself.

- **One code pairs every profile.** Each profile you pair on this computer
  uses the same code.
- **Reset code** in Settings > Chrome makes a new code. Every paired profile
  disconnects and must be paired again with the new code.
- **A profile holds one pairing.** A Chrome profile can be paired with one
  computer at a time. Pairing it with another computer replaces the first
  pairing, and the extension says so before it does: "This profile is paired
  with _machine_. Pairing here replaces that."
- The code works only in Chrome on the computer it belongs to. To use
  Chrome on another of your machines, set it up there.

## Pause and unpair

Click the extension's icon in Chrome's toolbar:

- **Pause** stops agents from using this profile until you press
  **Resume**. The pairing stays. The toolbar icon shows ON only while agents
  can use the profile.
- **Unpair** removes the pairing from this profile. Pair it again with the
  code if you want it back.
- **Reconnect** tries the connection again when the profile shows as paired
  but not answering.

## What the row and Settings can say

- **Paired: _names_.** The paired profiles. A profile still called "Chrome"
  or "Chrome (2)" shows "Give it a name agents can tell apart": click the
  extension's icon and type a new name in **Name this Chrome profile**.
- **Paired, not answering.** Chrome is closed or the extension lost its
  connection. Open Chrome, or press **Reconnect**.
- **Update the extension.** The profile runs an older version of the
  extension than this app expects.
- **Not from the Chrome Web Store.** The extension was loaded by hand. Only
  the store version connects unless **Developer: allow copies not from the
  Chrome Web Store** is on in Settings > Chrome.
- **Waiting for your approval.** Another of your machines asks to use this
  Chrome for its threads. Answer with **Allow** or **Decline**.
- **Chrome is not installed**, **_machine_ is offline**, **Turned off by
  your team's rules**, or **This window cannot pair a browser**. Nothing to
  press in the row. The last one means this window's access cannot change
  that machine's settings; pair from the machine itself.

If you rename a paired profile while the pairing steps are open, the app
can read it as a new pairing and close the steps. Open them again with
**Pair another profile** if you were in the middle of pairing a second one.
