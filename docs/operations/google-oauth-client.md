# SpecWithCode's Google OAuth client

Settings > Google account connects Gmail, Calendar and Drive with one click when the SpecWithCode build carries a Google OAuth client. This page is for whoever cuts releases.

## How the flow works

1. The person picks services and clicks **Connect Google**.
2. The SpecWithCode service builds a Google authorization URL with PKCE (S256), a single-use state that expires after 15 minutes, `access_type=offline` and only these scopes: `openid`, `email`, `gmail.readonly`, `calendar.readonly`, `drive.readonly`.
3. Google's consent screen opens in the browser. Google sends the browser back to `http://127.0.0.1:<service port>/api/google/oauth/callback`. When the browser runs on another machine, the person pastes the address it landed on.
4. The service exchanges the code, keeps the refresh token in its secret store and never returns it or the client secret to any client.
5. No project can read anything until the person turns a service on for it.

Tokens never leave the machine running the SpecWithCode service. That is the main difference from Codex, whose connectors sign in to OpenAI's Google app and keep the tokens on OpenAI's servers.

## Creating the client (once)

1. In Google Cloud Console, create or pick a project for SpecWithCode.
2. Enable the Gmail API, Google Calendar API and Google Drive API.
3. Google Auth Platform > Branding: app name `SpecWithCode`, support email, the privacy policy URL from the marketing site.
4. Audience: External. Publish the app to **In production**. In Testing status Google expires refresh tokens after 7 days, so people would have to reconnect every week.
5. Data access: add the three read-only scopes above.
6. Clients > Create client > **Desktop app**. Copy the client ID and secret.

## Shipping it

Put both values in the repo `.env` of the machine that builds releases (or the build environment):

```
STUDIO_GOOGLE_OAUTH_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
STUDIO_GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
```

For builds in GitHub Actions (`release.yml` and `release-macos.yml`), add them as repository secrets with the same names. The server build bakes them in (`apps/server/vite.config.ts`). The same variables set on a running service override the baked values, which is how to test a client without a rebuild. A build without them shows the "use your own OAuth client" form instead of the Connect button.

Google documents that an installed app's client secret cannot be kept secret, so shipping it in the app is expected; PKCE and the loopback redirect protect the authorization code. Do not commit the values to git anyway, since secret scanners flag them.

## Verification limits

Gmail and Drive read scopes are restricted and the Calendar scope is sensitive. Until Google verifies the app:

- People see "Google hasn't verified this app" and continue through **Advanced > Go to SpecWithCode**.
- At most 100 Google accounts can ever connect.

Lifting both needs Google's app verification plus a yearly CASA security assessment for the restricted scopes. Workspace admins can block unverified apps; people in such an organisation get a clear message and can save their own OAuth client under **Use your own OAuth client**.
