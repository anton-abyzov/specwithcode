# Signed out of SpecWithCode Connect

The headless fixture renders the production Threads pane, signed-out banner and account button for a window whose Connect sign-in has ended (increment 1417). Synthetic machines only:

- "Office Mac" is reached only through Connect and needs the sign-in.
- "Build box" is a machine this machine's server reaches while this window is still retrying.
- "Mac mini" is connected by a paired route.

`stubs.tsx` answers only what the window would read from Clerk, the catalog and its host. The host-down notes are given as `UnreachableHostsProvider` would build them from the gated projection.

`shoot.mjs` checks four account states in light and dark.

When signed out:

- the banner title and body (no claim the window cannot know);
- the Sign in button opening the sign-in;
- "Needs sign-in" on the Office Mac rows;
- "Not reachable from here" as the group heading and on the Build box row;
- "Signed out" on the account button.

With `?account=signed-in` (the startup race), there is no banner and no "Needs sign-in".

With `?account=ending` (signed in, 100 minutes left), the banner says when the sign-in ends and names Office Mac and Build box, never Mac mini on its paired route. The account button reads "Sign-in ends in 1h 40m", and **Sign in again now** starts a renew.

With `?account=rejected` (the relay refuses the sign-in), the banner says so, and **Sign in again** starts a renew instead of a silent sign-out.

It saves screenshots and `receipt.json`.

From the repository root: `node apps/web/tests/connect-signed-out/shoot.mjs /absolute/evidence-directory` builds the fixture and shoots. Set `STUDIO_PLAYWRIGHT_MODULE` and optionally `STUDIO_CHROME`. The runner always launches headless.

Proof limits:

- The fixture gives the notes directly. The gate that drops the sign-in mark while Clerk loads is proven by `apps/web/src/cloud/connectAccountState.test.ts`, not here.
- Renew is stubbed. Clerk's sign-out, the reload and the sign-in that reopens after it need a real Clerk session.
