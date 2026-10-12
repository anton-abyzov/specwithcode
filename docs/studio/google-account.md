# Google account

Let a project's agents read your Gmail, Google Calendar and Google Drive. A Personal project can then brief you on your day, find a document, or check who is coming to a meeting. Studio only reads: agents cannot send mail, change events, or edit or delete files.

## Set it up

Studio signs in with an OAuth client that you own, so no Studio server ever sees your Google data.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project. Enable the **Gmail API**, the **Google Calendar API** and the **Google Drive API**.
2. Under **Google Auth Platform**, set up the consent screen. Add your own address as a test user while the app is in testing.
3. Under **Clients**, create an OAuth client. Choose the application type **Desktop app**, and copy its client ID and client secret.
4. In Studio, open **Settings > Google account**. Paste the client ID and secret, and press **Save client**.
5. Tick the services you want and press **Sign in with Google**. Approve the consent screen in the tab that opens. Google sends that tab back to `http://127.0.0.1:<port>/api/google/oauth/callback`, and the settings page shows **Signed in as …**.
6. Under **Projects that may read it**, turn on Gmail, Calendar or Drive for each project that should use them. Every project starts with no access.

If the browser runs on a different machine than Studio, for example a phone over Tailscale, the page Google sends you back to will not load. Copy its address from the browser, paste it into **Address Google sent you to**, and press **Finish sign-in**.

A sign-in that was started in Studio is the only one Studio accepts. Each one can be used once and expires after 15 minutes.

## What agents can do

Threads in a project with access get these tools:

| Tool                            | What it returns                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `studio_google_status`          | The services turned on for this project and the signed-in address.                                  |
| `studio_google_gmail_search`    | Messages matching a Gmail search such as `is:unread newer_than:1d`: sender, subject, date, snippet. |
| `studio_google_gmail_read`      | One message as text, with its attachments listed but not opened.                                    |
| `studio_google_calendar_events` | Events on your primary calendar in a time range, with times, place, meeting link and your response. |
| `studio_google_drive_search`    | Files by text or recent change, newest first.                                                       |
| `studio_google_drive_read`      | A Google Doc or Slides as text, a Sheet as CSV, or a text file. Other files return details only.    |

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
