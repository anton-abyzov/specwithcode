/**
 * The one account in the app is SpecWithCode Connect, and it is optional. The
 * button shows that account when this window is signed in, and says so plainly
 * when it is not. Only a build without Connect shows just the machine. A Google
 * account connected for agents is an integration on one machine, so it never
 * appears here.
 */
export type ConnectAccount =
  /** The build has no Connect. */
  | { readonly status: "unavailable" }
  /** Clerk is still starting. */
  | { readonly status: "loading" }
  /** Clerk did not start, so this window cannot tell whether it is signed in. */
  | { readonly status: "notLoaded"; readonly linked: boolean }
  | { readonly status: "signedOut"; readonly linked: boolean }
  | {
      readonly status: "signedIn";
      readonly name: string | null;
      readonly email: string | null;
    };

export interface AccountMenuPresentation {
  /** Shown on the button and read out as "Account: ...". */
  readonly name: string;
  readonly header: string;
  /** Null when this window cannot sign in, or already has. */
  readonly signIn: { readonly label: string; readonly hint: string } | null;
}

export function accountMenuPresentation(
  account: ConnectAccount,
  machine: string,
): AccountMenuPresentation {
  switch (account.status) {
    case "unavailable":
      return { name: machine, header: machine, signIn: null };
    case "loading":
      return { name: machine, header: `${machine} · Checking sign-in`, signIn: null };
    case "notLoaded":
      return {
        name: "Sign-in did not load",
        header: `${machine} · Sign-in did not load`,
        signIn: {
          label: "Reload to sign in",
          hint: `This window could not load your SpecWithCode Connect account. Reloading tries again.${
            account.linked
              ? " This machine is still linked, so work from your main machine reaches it."
              : ""
          }`,
        },
      };
    case "signedOut":
      return account.linked
        ? {
            name: "Not signed in",
            header: `${machine} · Linked to Connect`,
            signIn: {
              label: "Sign in here",
              hint: "This machine is linked to SpecWithCode Connect, and work from your main machine reaches it without signing in. Sign in here to see and open your other machines from this window.",
            },
          }
        : {
            name: "Not signed in",
            header: `${machine} · Not signed in`,
            signIn: {
              label: "Sign in to SpecWithCode Connect",
              hint: "Optional. Sign in to see and open your machines from this window, or to link this machine to SpecWithCode Connect. Work from your main machine does not need it.",
            },
          };
    case "signedIn": {
      const label = account.email ?? account.name;
      return {
        name: account.name ?? account.email ?? "SpecWithCode account",
        header: label ? `${label} · ${machine}` : machine,
        signIn: null,
      };
    }
  }
}
