import type { ServerProvider } from "@specweave-studio/contracts";

type Auth = Pick<ServerProvider["auth"], "status" | "email" | "login">;

/** The account a sign-in is told apart by: its email, else its login, lower-cased. */
export const signInAccountKey = (auth: Pick<Auth, "email" | "login">): string =>
  (auth.email ?? auth.login ?? "").trim().toLowerCase();

/**
 * Whether the sign-in a panel runs is done. A first sign-in is done once the
 * agent reads as signed in. An account switch starts signed in, as `switchFrom`,
 * so it is done only once the agent reads as signed in to another account.
 */
export function signInFinished(auth: Auth | undefined, switchFrom: string | undefined): boolean {
  if (auth?.status !== "authenticated") return false;
  return switchFrom === undefined || signInAccountKey(auth) !== switchFrom;
}
