# Connect fleet routes and account capacity

SpecWithCode Connect is the primary configured fleet route. Tailscale remains a private fallback. Every route must answer as the pinned environment before a credential is sent. Connect accepts only a token bound to the coordinator's own DPoP key; legacy bearer credentials remain private-network only.

## Repair an existing machine

A working managed tunnel does not register that tunnel in another machine's fleet. Read the destination's identity and Connect status first. Refresh the existing pairing using its supported Connect invitation and the same coordinator identity. A Connect-only refresh retains the same machine's existing Tailscale fallback, nickname and requested scopes. It must not create a worker grant, change a Stop hold, restart the destination or replace a different pinned machine.

Management reachability and worker reachability are separate. An old worker grant may remain bearer-only even after management pairing succeeds. Do not send it through Connect or broaden consent to make a status badge green. Reconcile the destination's current sessions and grants before changing worker authentication or installing an update.

## Managed tunnel entitlement

The relay limits managed tunnels per authenticated account, not total fleet machines and not Clerk connections. The limit resolves from a per-user override row, else the founder seat limit, else the free limit. The override row has an explicit unlimited flag: it removes the per-account count from the allocation insert, but the global service cap, Cloudflare quotas and other provider limits still apply. Existing finite overrides retain their values; an invalid finite override fails closed.

Authenticated environment listing returns either an explicit unlimited policy or a finite maximum. The client treats an older relay without that field as unknown. Account transitions clear the displayed policy, and a response from the previous account cannot supply the next account's label. The override is keyed only by the server-authenticated stable user ID. Email and client flags are never entitlement inputs.

Apply the schema migration and deploy the relay before enabling the authorized account row. Verify the account server-to-server, match its existing environment links, set only that user's explicit override, then read it back. Verify normal-account isolation and fourth-machine admission using an already-authorized real machine when safe. Do not create a paid dummy tunnel for testing.

## Installation acceptance

Record app and running-service versions separately. Publication, relay health, a managed hostname and a source-ready copy job do not establish destination quiescence or installed acceptance. Reconcile operation outcomes, active sessions, update admission and backups with the existing release and migration owners before installation. Preserve unknown remote outcomes as unknown.
