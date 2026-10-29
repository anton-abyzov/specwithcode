# SpecWithCode Connect launch on spec-weave.com

The runbook for turning on hosted SpecWithCode Connect. You end with:

| What        | Where                                                                     |
| ----------- | ------------------------------------------------------------------------- |
| Relay API   | `https://relay.spec-weave.com` (Cloudflare Worker, derived from the zone) |
| Mac tunnels | `prod-<id>.spec-weave.com` (Cloudflare Tunnel, one per linked Mac)        |
| Accounts    | Clerk production instance on `spec-weave.com`, Sign in with Apple         |
| Database    | Cloudflare D1, bound to the Worker                                        |
| Logs        | Cloudflare Workers Logs                                                   |
| Push        | APNs for `com.specwithcode.ios`                                           |

Plan on about two hours. Steps 1 to 4 collect accounts and values, step 5 writes them into GitHub,
and steps 6 to 8 deploy and check. Keep a scratch file open (outside any repository, mode 600) and
paste each value into it as you go. Nothing in steps 1 to 4 changes the live site.

Background: [connect-setup.md](./connect-setup.md) explains each Clerk setting, and the
[relay README](../../infra/relay/README.md#deployment) covers the deploy itself.

## 1. Cloudflare (20 minutes)

`spec-weave.com` is already a Cloudflare zone (nameservers `dale` and `etta`), and
`relay.spec-weave.com` is unused. The relay and the tunnels share this zone. Tunnels sit directly
under it as `prod-<id>.spec-weave.com`, so Universal SSL's `*.spec-weave.com` certificate covers
them and `RELAY_TUNNEL_BASE_DOMAIN` stays unset.

1. **Workers Paid plan.** Account home > Workers & Pages > Plans: subscribe to Workers Paid
   ($5 a month). Durable Objects and Queues need it.
2. **Account ID.** Copy it from the right column of the spec-weave.com overview. This is
   `CLOUDFLARE_ACCOUNT_ID`.
3. **API token.** My Profile > API Tokens > Create Token > Custom token, named
   `specwithcode-relay-deploy`, with these permissions:
   - Account: Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit,
     Cloudflare Tunnel Edit, D1 Edit, Queues Edit, Account Settings Read, Secrets Store Edit,
     API Tokens Edit
   - Zone: Zone Edit, DNS Edit, Workers Routes Edit, SSL and Certificates Read
   - Account resources: your account. Zone resources: Specific zone, `spec-weave.com`.

   Alchemy keeps its state store's keys in the account Secrets Store, and the stack mints the
   Worker's own tunnel-only token, so without the last two the deploy stops with
   `Unauthorized` (code 10000) before any relay resource exists.

   Save the token as `CLOUDFLARE_API_TOKEN`. If a later deploy fails with a 403 that names a
   permission, add that permission to the token and rerun step 6.

## 2. Apple (15 minutes)

In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources), using the
team that signs the iPhone app:

1. **App ID.** Identifiers > `com.specwithcode.ios`: turn on **Push Notifications** and
   **Sign in with Apple** (primary App ID). Save.
2. **Services ID** for web sign-in. Identifiers > + > Services IDs: `com.specwithcode.signin`,
   description `SpecWithCode`. Turn on Sign in with Apple and configure it with primary App ID
   `com.specwithcode.ios`. Leave the domain and return URL fields until Clerk gives them in
   step 3.4.
3. **Key.** Keys > +, named `SpecWithCode Connect`, with **Apple Push Notifications service
   (APNs)** and **Sign in with Apple** (primary App ID `com.specwithcode.ios`) turned on.
   Download the `.p8` once and record:
   - the Key ID, as `APNS_KEY_ID`
   - the Team ID (top right), as `APNS_TEAM_ID`
   - the full `.p8` text, `-----BEGIN PRIVATE KEY-----` lines included, as `APNS_PRIVATE_KEY`

   Store the `.p8` file in your password manager. Apple will not show it again.

## 3. Clerk production instance (30 minutes)

1. **Create the production instance** for the application in the Clerk dashboard, with domain
   `spec-weave.com`. Clerk lists five CNAME records (`clerk`, `accounts`, `clkmail`,
   `clk._domainkey`, `clk2._domainkey`). Add each one in Cloudflare DNS for spec-weave.com with
   proxy **off** (grey cloud), then click **Verify** in Clerk and wait for SSL to be issued.
2. **API keys.** Configure > API keys. Record `pk_live_...` as the publishable key and
   `sk_live_...` as `CLERK_SECRET_KEY`.
3. **Sign-in methods.** User & authentication > Email: on. SSO connections > add **Apple**,
   and turn on **Use custom credentials**:
   - Apple Team ID: your `APNS_TEAM_ID`
   - Apple Services ID: `com.specwithcode.signin`
   - Apple Key ID and Private Key: the step 2.3 key ID and `.p8`
4. **Finish the Services ID.** Back in Apple (step 2.2), set the Services ID's domain to
   `clerk.spec-weave.com` and its return URL to the one Clerk shows on the Apple connection page.
5. **Native applications.** Configure > Native applications: turn on the Native API, then:
   - add the iOS app with your Team ID and bundle ID `com.specwithcode.ios`
   - add the iOS app with bundle ID `com.specweave.studio` for the Mac app's passkeys
     (connect-setup.md, Desktop passkeys)
   - under **Allowlist for mobile SSO redirect**, add `studio://app/` (the Mac app) and
     `com.specwithcode.ios://callback` (the Clerk iOS SDK's redirect for providers other than
     Apple; native Sign in with Apple needs no redirect)
6. **Allowed origins** for the Mac app's browser sign-in, keeping any existing entries:

   ```sh
   curl -sS -X PATCH https://api.clerk.com/v1/instance \
     -H "Authorization: Bearer $CLERK_SECRET_KEY" -H "Content-Type: application/json" \
     -d '{"allowed_origins":["studio://app"]}'
   ```

7. **JWT template.** Configure > JWT templates > New > Blank, name `studio-relay`, claims
   `{"aud": "studio-code-relay"}`. Save.
8. **CLI OAuth application.** Configure > OAuth applications > Add: name `SpecWithCode CLI`,
   **Public** client (PKCE), redirect URI `http://127.0.0.1:34338/callback`, scopes `openid`,
   `profile`, `email` and `offline_access`. Record the client ID. Device authorization grant is a
   beta that Clerk turns on per account: email Clerk support asking for it on this application.
   Until they do, `specweave-studio connect login` works on a Mac with a browser but not over SSH.
9. **Sign-ups.** Decide now whether launch is open or invite-only (Restrictions > Allowlist or
   Restricted mode). Open sign-up is the default.

## 4. Write down the values

| Name                               | Value                          | Kind                        |
| ---------------------------------- | ------------------------------ | --------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`            | step 1.2                       | repo variable               |
| `CLOUDFLARE_API_TOKEN`             | step 1.3                       | repo secret                 |
| `RELAY_API_ZONE_NAME`              | `spec-weave.com`               | `production` variable       |
| `RELAY_TUNNEL_ZONE_NAME`           | `spec-weave.com`               | `production` variable       |
| `RELAY_TUNNEL_CLEANUP_MODE`        | `dry-run`                      | `production` variable       |
| `RELAY_GLOBAL_MANAGED_TUNNEL_CAP`  | `180`                          | `production` variable       |
| `RELAY_CONNECT_FREE_TUNNEL_LIMIT`  | unset (default `3`)            | `production` variable       |
| `CLERK_PUBLISHABLE_KEY`            | `pk_live_...`                  | `production` variable       |
| `CLERK_JWT_AUDIENCE`               | `studio-code-relay`            | `production` variable       |
| `CLERK_JWT_TEMPLATE`               | `studio-relay`                 | `production` variable       |
| `APNS_ENVIRONMENT`                 | `production`                   | `production` variable       |
| `APNS_TEAM_ID`                     | step 2.3                       | `production` variable       |
| `APNS_KEY_ID`                      | step 2.3                       | `production` variable       |
| `APNS_BUNDLE_ID`                   | `com.specwithcode.ios`         | `production` variable       |
| `CLERK_SECRET_KEY`                 | `sk_live_...`                  | `production` secret         |
| `APNS_PRIVATE_KEY`                 | `.p8` text                     | `production` secret         |
| `STUDIO_CLERK_PUBLISHABLE_KEY`     | `pk_live_...`                  | repo variable (Mac release) |
| `STUDIO_CLERK_JWT_TEMPLATE`        | `studio-relay`                 | repo variable (Mac release) |
| `STUDIO_CLERK_CLI_OAUTH_CLIENT_ID` | step 3.8                       | repo variable (Mac release) |
| `STUDIO_RELAY_URL`                 | `https://relay.spec-weave.com` | repo variable (Mac release) |

`RELAY_GLOBAL_MANAGED_TUNNEL_CAP` stops new machine links at that total across all accounts;
machines already linked keep working, and new links get a `service_capacity` limit error. Each
linked machine is one DNS record, and the Free zone allows 200 records, so keep it at `180` until
the tunnel zone is on Pro, then raise it to `1500`. Unset means no global cap.
`RELAY_CONNECT_FREE_TUNNEL_LIMIT` is the machine limit for accounts without a founder seat or a
manual override; leave it unset for 3.

Leave `RELAY_DOMAIN` unset: the `prod` stage derives `relay.spec-weave.com` from the zone. Leave
`RELAY_TUNNEL_BASE_DOMAIN` unset so tunnels sit directly under `spec-weave.com`. Leave
`FCM_SERVICE_ACCOUNT` unset until there is an Android app. `APNS_ENVIRONMENT=production` serves
TestFlight and App Store builds. A phone running an Xcode debug build gets no push from this relay.

## 5. Set them in GitHub (10 minutes)

From a checkout of `anton-abyzov/specwithcode`, with `gh` signed in as the owner:

```sh
R=anton-abyzov/specwithcode
gh api -X PUT "repos/$R/environments/production" >/dev/null   # creates it if missing

# Repository variables
gh variable set CLOUDFLARE_ACCOUNT_ID            -R $R -b '<account id>'
gh variable set STUDIO_CLERK_PUBLISHABLE_KEY     -R $R -b 'pk_live_...'
gh variable set STUDIO_CLERK_JWT_TEMPLATE        -R $R -b 'studio-relay'
gh variable set STUDIO_CLERK_CLI_OAUTH_CLIENT_ID -R $R -b '<client id>'
gh variable set STUDIO_RELAY_URL                 -R $R -b 'https://relay.spec-weave.com'

# Repository secrets: each command prompts for the value, so it stays out of shell history
gh secret set CLOUDFLARE_API_TOKEN -R $R

# production environment variables
E="-R $R --env production"
gh variable set RELAY_API_ZONE_NAME       $E -b 'spec-weave.com'
gh variable set RELAY_TUNNEL_ZONE_NAME    $E -b 'spec-weave.com'
gh variable set RELAY_TUNNEL_CLEANUP_MODE $E -b 'dry-run'
gh variable set RELAY_GLOBAL_MANAGED_TUNNEL_CAP $E -b '180'
gh variable set CLERK_PUBLISHABLE_KEY     $E -b 'pk_live_...'
gh variable set CLERK_JWT_AUDIENCE        $E -b 'studio-code-relay'
gh variable set CLERK_JWT_TEMPLATE        $E -b 'studio-relay'
gh variable set APNS_ENVIRONMENT          $E -b 'production'
gh variable set APNS_TEAM_ID              $E -b '<team id>'
gh variable set APNS_KEY_ID               $E -b '<key id>'
gh variable set APNS_BUNDLE_ID            $E -b 'com.specwithcode.ios'

# production environment secrets
gh secret set CLERK_SECRET_KEY $E
gh secret set APNS_PRIVATE_KEY $E < ~/Downloads/AuthKey_<KEYID>.p8
```

Check with `gh variable list -R $R`, `gh variable list $E` and `gh secret list $E`.

Releases cut on the M4 with `scripts/release/release.sh` read the four `STUDIO_*` values from
`~/.config/skill-studio-release/release.env` instead. Add them there too (see
`scripts/release/release.env.example`). With all four present and an https relay URL, the
release builds with Connect on. If any is missing, it builds without Connect, as it does today.

## 6. Turn on the relay deploy (2 minutes)

The deploy workflow is disabled. Turn it on and start it from `main`:

```sh
gh workflow enable deploy-relay.yml -R $R
gh workflow run deploy-relay.yml -R $R --ref main
gh run watch -R $R "$(gh run list -R $R -w deploy-relay.yml -L 1 --json databaseId -q '.[0].databaseId')"
```

The first deploy takes about 10 minutes. It creates the D1 database and applies its migrations,
the queues and the Worker on `relay.spec-weave.com`. From then on, every push to `main` redeploys
the relay.

## 7. Check the relay (5 minutes)

```sh
curl -fsS https://relay.spec-weave.com/health
curl -fsS https://relay.spec-weave.com/.well-known/oauth-authorization-server | head -c 300; echo
dig +short relay.spec-weave.com
```

Expected: `/health` returns 200, the metadata names `https://relay.spec-weave.com` as its issuer,
and `dig` returns Cloudflare addresses. A 522 or a DNS miss means the Worker custom domain is not
attached yet. Wait two minutes and try again before reading the deploy log.

## 8. Ship a Mac build and try it end to end (60 to 90 minutes, mostly waiting)

1. Run the release: `gh workflow run release-macos.yml -R $R -f version=<next 1.x.y>`, or
   `bash scripts/release/release.sh <version>` on the M4. The run log prints
   `build: SpecWithCode Connect on (relay https://relay.spec-weave.com)` when it picked up the values.
2. After the update installs, open SpecWithCode > Settings > Connections > **Use SpecWithCode on
   your phone** and sign in with Apple. The Mac publishes itself and starts its tunnel.
3. In a terminal on the Mac: `specweave-studio connect status`. It should show the account,
   this Mac as linked, and a `https://prod-....spec-weave.com/` endpoint. Then
   `curl -sI <that endpoint>` should return an HTTP status, not a TLS error.
4. Install the iPhone build (TestFlight) and sign in with the same Apple ID. The Mac appears in
   the phone's list with no Tailscale or VPN, on cellular too.
5. Restart the Mac app, then check the phone again. The Mac should come back within two minutes.

Connect covers reaching a Mac from your other devices and worker delegation: a main machine starting
work on another Mac, managing it or copying folders to it tries that Mac's Tailscale (ts.net) address
first and falls back to its Connect address. Tailscale on both machines is optional.

## 9. A week later

- In Cloudflare, open Workers & Pages > the relay Worker > Logs and search for
  `Finished managed tunnel cleanup`. The five-minute cron logs it whenever it found inactive
  tunnels. In `dry-run` mode, its `wouldDelete` field counts the tunnels it would remove (and
  `wouldDeleteLegacy` the legacy ones). If that count matches Macs that are really gone, run
  `gh variable set RELAY_TUNNEL_CLEANUP_MODE $E -b enabled` and then
  `gh workflow run deploy-relay.yml -R $R --ref main`.
- Each linked Mac holds one Cloudflare Tunnel. Check Zero Trust > Networks > Tunnels against
  Cloudflare's per-account tunnel limit once sign-ups grow.

## Founding 1,000 seats

The first 1,000 accounts to link a managed machine get a founder number and 10 machines; everyone
else gets `RELAY_CONNECT_FREE_TUNNEL_LIMIT` (3). A row in `relay_managed_tunnel_limits` overrides
both for one account. A seat is granted atomically only after a managed link succeeds, so a link
refused at a cap or failing in Cloudflare never takes one. Seats are never resold when an account
is deleted. `GET https://relay.spec-weave.com/v1/public/founders` (no auth, cached for 60 seconds)
returns `seatCap`, `seatsGranted`, `seatsLeft` and `grantsOpen`.

The free limit was 5 before this release. The `connect_founders` migration gives every account that
already holds a live managed machine a founder number, in order of its earliest allocation, so no
existing account drops below its machines.

Stop new founder seats without touching existing founders (the kill switch), or reopen them:

```sh
cd infra/relay
npx wrangler d1 execute <prod D1 database name> --remote \
  --command "UPDATE relay_connect_promos SET grants_open = 0 WHERE id = 'founders'"
```

Raise the cap the same way with `SET seat_cap = <n>`. After grants reopen or the cap is raised,
an account without a seat (including one first linked while grants were closed) takes the next
seat on its next successful managed link.

A machine counts toward the account and global caps while its link is live with managed tunnels
on, and for 15 minutes after its allocation was reserved or last re-claimed, so concurrent links
cannot overshoot. An allocation left by a failed link stops counting after that window. The global
cap also counts any allocation that still holds a DNS record, such as one whose teardown failed.

## Before the iPhone app goes to App Store review

App Review guideline 5.1.1(v) requires deleting the account from inside the app. The app calls
`DELETE /v1/client/account` on the relay with the signed-in user's Clerk session token as
`Authorization: Bearer <token>`. The relay revokes and unlinks every environment the user linked,
deletes their Cloudflare tunnels and DNS records, held webhook deliveries, mobile devices, push
registrations and Live Activities, then deletes the Clerk user. It answers
`200 {"deleted": true, "environmentCount": N}`. A `500` with `reason: "upstream_unavailable"`
means Cloudflare or Clerk failed partway; the call is idempotent, so the app retries it. The
relay needs `CLERK_SECRET_KEY` to delete the Clerk user. TestFlight does not need any of this. The
App Store submission does.

## Undo

- Stop new sign-ins: Clerk > Restrictions > Restricted mode.
- Ship without Connect: delete the four `STUDIO_*` repository variables (and the lines in
  `release.env`), then release. Installed Macs keep working through Tailscale and direct pairing.
- Stop the relay: `gh workflow disable deploy-relay.yml -R $R`, then remove the Worker's custom
  domain in Cloudflare. The D1 database and the zone are retained on purpose. Delete them
  by hand only once you are sure.
