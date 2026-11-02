/**
 * The one account in the app is SpecWithCode Connect, and it is optional. The
 * button shows that account when this window is signed in, and otherwise the
 * machine. A Google account connected for agents is an integration on one
 * machine, so it never appears here.
 */
export type ConnectAccount =
  /** The build has no Connect, or Clerk has not loaded; offline it may never load. */
  | { readonly status: "unavailable" }
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
    case "signedOut":
      return account.linked
        ? {
            name: machine,
            header: `${machine} · Linked to Connect`,
            signIn: {
              label: "Sign in here",
              hint: "This machine is linked to SpecWithCode Connect, and work from your main machine reaches it without signing in. Sign in here to see and open your other machines from this window.",
            },
          }
        : {
            name: machine,
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
