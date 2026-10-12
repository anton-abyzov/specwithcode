# Studio Connect setup

Deployment and client configuration for Studio Connect. The [architecture note](../internals/studio-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions.

## Public application configuration

Studio Connect is disabled in a fresh clone, and the repository configures no hosted deployment
to build against. Every value in the repository-root `.env.example` is empty, so
`cp .env.example .env` builds the same app as a checkout with no `.env`.

To run Studio Connect against a Clerk instance and relay you operate, set these values in the
repository-root `.env` or `.env.local`:

```dotenv
STUDIO_CLERK_PUBLISHABLE_KEY=<publishable key>
STUDIO_CLERK_JWT_TEMPLATE=<JWT template name>
STUDIO_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
STUDIO_RELAY_URL=https://relay.example.com
```

Process variables take precedence over `.env.local`, then `.env`. Use these canonical names;
the build loader supplies framework-specific aliases. These values are public identifiers.
`CLERK_SECRET_KEY` belongs only in the relay's secrets, never in client configuration.

The identifiers alone do not turn hosted services on. The gate must also be on in both places
that check it:

- `STUDIO_ENABLE_HOSTED_SERVICES=true` in the server's environment. The server reads it when it
  starts.
- `VITE_STUDIO_ENABLE_HOSTED_SERVICES=true` in the environment the web client is built in. The
  value is baked into the bundle.

`vp run dev` loads the root `.env` and `.env.local` into the environment it starts the server and
web client with, so both lines can go there during development. Any other value, or none, leaves
Studio Connect off and direct private pairing working.

Client and bundled-server builds embed the public values, so set them before building.
EAS preview and production environments need the publishable key, JWT template name, and relay URL.
The repository also names no Apple Developer team and no App Store Connect app: set
`STUDIO_APPLE_TEAM_ID` to pin iOS signing to your team, and add your app's ID as
`submit.<profile>.ios.ascAppId` in `apps/mobile/eas.json` before `eas submit`, because that file
no longer carries one. See the [mobile README](../../apps/mobile/README.md).
Bundled servers also accept runtime overrides for operator-managed deployments.

Copy `infra/relay/.env.example` to `infra/relay/.env` for relay deployment settings.
Deploy `prod` before personal stages because it owns the retained database that their branches
depend on. The stack's `PublishClientConfig` action writes the resulting relay URL back to the root `.env`.

## CLI OAuth application

In Clerk's OAuth applications settings:

1. Create a public OAuth application for the Studio CLI, using authorization-code exchange with PKCE.
2. Allow the redirect URI `http://127.0.0.1:34338/callback`.
3. Enable the `openid`, `profile`, `email`, and `offline_access` scopes.
4. Enable **Device authorization grant** on the application. Headless and SSH authorization use
   it, and Clerk only advertises the device endpoint once it is on. The feature is in beta and
   Clerk enables it per account on request.
5. Set `STUDIO_CLERK_CLI_OAUTH_CLIENT_ID` to the generated public client ID in local and release
   build environments.

## JWT template

Create a Clerk JWT template named `studio-relay` with claims:

```json
{ "aud": "studio-code-relay" }
```

Set `STUDIO_CLERK_JWT_TEMPLATE=studio-relay` for clients and
`CLERK_JWT_AUDIENCE=studio-code-relay` for the relay. The production relay deployment environment
also defines `CLERK_JWT_TEMPLATE`. The audience stays the same across relay stages; the relay
URL selects the deployment.

## Desktop OAuth redirects

Enable Clerk's Native API and add the desktop redirects to its SSO redirect allowlist:

```text
studio-dev://app/
studio://app/
```

Add the corresponding origin to the Clerk instance's Backend API `allowed_origins` array.
Development uses `studio-dev://app`; production uses `studio://app`. Update the array with
`PATCH https://api.clerk.com/v1/instance` using the Clerk secret key, preserving existing entries.
The Clerk Electron integration handles token
persistence and system-browser callback delivery.

## Android native sign-in redirects

Clerk's native Android SDK uses `clerk://<applicationId>.callback`. In the Clerk instance selected by the app's publishable key, add each supported package to **Native applications > Allowlist for mobile SSO redirect**:

| Variant     | Callback                                        |
| ----------- | ----------------------------------------------- |
| Development | `clerk://com.specweave.studio.dev.callback`     |
| Preview     | `clerk://com.specweave.studio.preview.callback` |
| Production  | `clerk://com.specweave.studio.callback`         |

Preserve existing entries. These callbacks are separate from the `studio-dev` / `studio-preview` / `studio` navigation schemes. A private development build using the production Clerk key still needs its development callback allowed by that instance's administrator; rebuilding the same package does not change the allowlist.

## Desktop passkeys

For a production macOS app with bundle ID `com.specweave.studio`:

1. Create an explicit macOS App ID in the Apple Developer portal with **Associated Domains**.
2. Create a provisioning profile for that App ID and the distribution signing certificate.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID.
   This setting also configures Electron/macOS passkeys.
4. Check `https://<frontend-api>/.well-known/apple-app-site-association`. Its
   `webcredentials.apps` must include `<TEAM_ID>.com.specweave.studio`.
5. Configure signing as described in the [release runbook](./release.md#2-apple-signing--notarization-setup-macos).

Local signed builds additionally use:

```dotenv
STUDIO_APPLE_TEAM_ID=ABC1234567
STUDIO_MACOS_PROVISIONING_PROFILE=/absolute/path/to/studio.provisionprofile
# Override only when the RP domain differs from the Clerk Frontend API hostname.
STUDIO_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

Without the override, the build derives the RP domain from the Clerk publishable key.
After changing Associated Domains, bump the build version before rebuilding. macOS can otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

The ordinary `dev:desktop` launcher is unsigned and cannot exercise macOS passkeys. For renderer
HMR, install a signed build, start `vp run dev:web`, and launch the installed executable with the
actual web and server ports. For example, with the default ports:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
STUDIO_PORT=13773 \
  "/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode"
```

Rebuild the signed app after native dependency, main-process, preload, entitlement, provisioning,
or signing changes. Renderer edits can reuse it. Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/SpecWithCode.app"
codesign -d --entitlements :- "/Applications/SpecWithCode.app"
```

## Restricting sign-ups

Use Clerk's allowlist for permitted email addresses or domains, or Restricted mode for invitation-only
sign-up. An enabled empty allowlist blocks all new sign-ups.

Sign-up restrictions do not revoke an existing account's access. Ban the account in Clerk when
its active sessions and future sign-ins must be disabled.
