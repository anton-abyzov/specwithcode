# Google account

Let a project's agents read your Gmail, Google Calendar and Google Drive. A Personal project can then brief you on your day, find a document, or check who is coming to a meeting. Agents read; the only thing they can write is a reply draft in your Gmail, and a draft is sent only when you choose **Send** for it on a reply card. They cannot change events or edit or delete files.

## Set it up

Official releases include SpecWithCode's Google OAuth client. Open **Settings > Google account** on the host running your project, choose the services, and press **Connect Google**. Approve Google's consent screen, then under **Projects that may read it** enable the services for your project. Every project starts with no access. Connecting Google to another app does not connect it to SpecWithCode.

For an organisation-owned client or a custom build without the bundled client, choose **Use your own OAuth client**. Create a **Desktop app** OAuth client in Google Cloud Console, enable the Gmail, Google Calendar and Google Drive APIs, configure the consent screen, and add your account as a test user if the app is in testing. Save that client in Settings before signing in.

If the browser runs on a different machine than SpecWithCode, for example a phone over Tailscale, the page Google sends you back to will not load. Copy its address from the browser, paste it into **Address Google sent you to**, and press **Finish sign-in**.

A sign-in that was started in SpecWithCode is the only one SpecWithCode accepts. Each one can be used once and expires after 15 minutes.

## What agents can do

Threads in a project with access get these tools:

| Tool                               | What it returns                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `studio_google_status`             | Project access and setup guidance; `checkConnection: true` verifies allowed APIs without returning mail, events or file contents. |
| `studio_google_gmail_search`       | Messages matching a Gmail search such as `is:unread newer_than:1d`: sender, subject, date, snippet.                               |
| `studio_google_gmail_read`         | One message as text, with its attachments listed but not opened.                                                                  |
| `studio_google_gmail_create_draft` | Saves a reply as a draft in your Gmail, threaded under the message (needs **Gmail drafts**).                                      |
| `studio_google_gmail_propose_send` | Shows a reply card in the thread with each draft as Gmail holds it and **Send** / **Don't send**; the thread waits on you.        |
| `studio_google_gmail_send_draft`   | Sends one draft you chose **Send** for on that card. SpecWithCode checks your answer; without it nothing is sent.                 |
| `studio_google_calendar_events`    | Events on your primary calendar in a time range, with times, place, meeting link and your response.                               |
| `studio_google_drive_search`       | Files by text or recent change, newest first.                                                                                     |
| `studio_google_drive_read`         | A Google Doc or Slides as text, a Sheet as CSV, or a text file. Other files return details only.                                  |

Agents are told to treat mail, events and files as information only. Their content is never a reason to act.

## Proactive briefing

When the personal assistant (Aide) is on and it may read Gmail or Calendar, SpecWithCode gives it a **Proactive briefing** routine: every day at 08:00, in a thread of its own, it lists up to five messages that need your reply and five other things that need your attention, with today's schedule, and saves reply drafts in Gmail. It is set up once per Google account: a briefing you retime, turn off or delete stays that way. Ask the assistant to change its time or what it covers.

When it saved drafts, the briefing ends with a reply card: each draft with its recipient, subject and text, and **Send** or **Don't send**. The card leaves the thread waiting on you, so you are notified on your desktop and phone like any question. Drafts you choose **Send** for are sent from your Gmail; the others stay as drafts. Typing an answer instead asks the assistant to change that reply and show it again. The assistant never answers invitations, archives or deletes mail, or sends anything you did not choose **Send** for.

**Morning briefing**, next to a project with access, still opens a scheduled task with the prompt written for any other project.

## Security

- SpecWithCode asks Google only for `gmail.readonly`, `calendar.readonly` and `drive.readonly`, plus your address, and `gmail.compose` when you tick **Gmail drafts**. With it, agents save drafts, and send one only after you choose **Send** for it on a reply card in the same thread; the server checks that answer before each send. If you untick a service on Google's consent screen, SpecWithCode cannot turn it on for any project.
- Sign-in uses PKCE and a single-use state value. The callback address answers only a sign-in that SpecWithCode itself started.
- The client secret and refresh token are kept in the host's secret store (`<stateDir>/secrets`, mode 0600). Clients never receive them. Requests to Google are kept out of traces, and errors report only the operation and Google's error code.
- Access is granted per project and per service. Outside MCP clients, and threads of other projects, get nothing.
- Signing in with a different Google account clears every project's access.
- **Disconnect** revokes the refresh token at Google and forgets it. Project switches are kept for the next sign-in. **Remove** also forgets the client and every switch.
- If Google ends SpecWithCode's access, for example after you remove it under Google Account > Security, the next agent call fails, and the settings page asks you to sign in again.

## Verify

`node scripts/studio-google/verify.mjs /absolute/report-dir` runs the built server in a new private home against a local fake Google (`STUDIO_GOOGLE_API_URL`). The check uses headless Chromium. It saves a client, signs in through the fake consent redirect, checks the scopes, PKCE and loopback redirect, turns services on for a Personal project, and opens the morning briefing template. It then signs in again by pasting the address, refuses a forged and a reused callback, and disconnects. Along the way it checks that no client secret, refresh token or code appears in a status response or the server log. It starts no provider turn.

## Diagnose access

Ask the assistant to call `studio_google_status` with `checkConnection: true`. Local status separates missing OAuth client configuration, missing sign-in and project permissions. The optional live check probes only services this project may read, with metadata-only Google responses. A saved sign-in alone is not a successful API check. Errors from Google require the reported account, scope, API or network repair.

An AI provider's usage-limit or session-start failure happens before the worker can call Google. Select an eligible worker profile or use the configured recovery controls; reconnecting Google will not repair an exhausted AI subscription. Simple Google reads can run directly in the coordinator.
