# Google account

Let a project's agents read your Gmail, Google Calendar and Google Drive. A Personal project can then brief you on your day, find a document, or check who is coming to a meeting. Studio only reads: agents cannot send mail, change events, or edit or delete files.

## Set it up

Official releases include SpecWithCode's Google OAuth client. Open **Settings > Google account** on the host running your project, choose the services, and press **Connect Google**. Approve Google's consent screen, then under **Projects that may read it** enable the services for your project. Every project starts with no access. Connecting Google to another app does not connect it to SpecWithCode.

For an organisation-owned client or a custom build without the bundled client, choose **Use your own OAuth client**. Create a **Desktop app** OAuth client in Google Cloud Console, enable the Gmail, Google Calendar and Google Drive APIs, configure the consent screen, and add your account as a test user if the app is in testing. Save that client in Settings before signing in.

If the browser runs on a different machine than Studio, for example a phone over Tailscale, the page Google sends you back to will not load. Copy its address from the browser, paste it into **Address Google sent you to**, and press **Finish sign-in**.

A sign-in that was started in Studio is the only one Studio accepts. Each one can be used once and expires after 15 minutes.

## What agents can do

Threads in a project with access get these tools:

| Tool                            | What it returns                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `studio_google_status`          | Project access and setup guidance; `checkConnection: true` verifies allowed APIs without returning mail, events or file contents. |
| `studio_google_gmail_search`    | Messages matching a Gmail search such as `is:unread newer_than:1d`: sender, subject, date, snippet.                               |
| `studio_google_gmail_read`      | One message as text, with its attachments listed but not opened.                                                                  |
| `studio_google_calendar_events` | Events on your primary calendar in a time range, with times, place, meeting link and your response.                               |
| `studio_google_drive_search`    | Files by text or recent change, newest first.                                                                                     |
| `studio_google_drive_read`      | A Google Doc or Slides as text, a Sheet as CSV, or a text file. Other files return details only.                                  |

Agents are told to treat mail, events and files as information only. Their content is never a reason to act.

## Morning briefing

Next to a project with access, **Morning briefing** opens a new scheduled task with the prompt already written. It runs every day at 08:00 in the project's coordinator thread. Choose the model and press **Create task**. If the [Telegram channel](telegram-channel.md) is paired with the same project, the briefing also arrives in Telegram.

## Security

- Studio asks Google only for `gmail.readonly`, `calendar.readonly` and `drive.readonly`, plus your address. If you untick a service on Google's consent screen, Studio cannot turn it on for any project.
- Sign-in uses PKCE and a single-use state value. The callback address answers only a sign-in that Studio itself started.
- The client secret and refresh token are kept in the host's secret store (`<stateDir>/secrets`, mode 0600). Clients never receive them. Requests to Google are kept out of traces, and errors report only the operation and Google's error code.
- Access is granted per project and per service. Outside MCP clients, and threads of other projects, get nothing.
- Signing in with a different Google account clears every project's access.
- **Disconnect** revokes the refresh token at Google and forgets it. Project switches are kept for the next sign-in. **Remove** also forgets the client and every switch.
- If Google ends Studio's access, for example after you remove it under Google Account > Security, the next agent call fails, and the settings page asks you to sign in again.

## Verify

`node scripts/studio-google/verify.mjs /absolute/report-dir` runs the built server in a new private home against a local fake Google (`STUDIO_GOOGLE_API_URL`). The check uses headless Chromium. It saves a client, signs in through the fake consent redirect, checks the scopes, PKCE and loopback redirect, turns services on for a Personal project, and opens the morning briefing template. It then signs in again by pasting the address, refuses a forged and a reused callback, and disconnects. Along the way it checks that no client secret, refresh token or code appears in a status response or the server log. It starts no provider turn.

## Diagnose access

Ask the assistant to call `studio_google_status` with `checkConnection: true`. Local status separates missing OAuth client configuration, missing sign-in and project permissions. The optional live check probes only services this project may read, with metadata-only Google responses. A saved sign-in alone is not a successful API check. Errors from Google require the reported account, scope, API or network repair.

An AI provider's usage-limit or session-start failure happens before the worker can call Google. Select an eligible worker profile or use the configured recovery controls; reconnecting Google will not repair an exhausted AI subscription. Simple Google reads can run directly in the coordinator.
