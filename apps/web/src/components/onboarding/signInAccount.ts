import type { ServerProvider } from "@specweave-studio/contracts";

type Auth = Pick<ServerProvider["auth"], "status" | "email" | "login" | "label">;

/**
 * The account a sign-in is told apart by: its email, else its login, and its
 * plan. The plan is there because one email can hold several workspaces, and a
 * move between them is a switch too.
 */
export const signInAccountKey = (auth: Pick<Auth, "email" | "login" | "label">): string =>
  `${(auth.email ?? auth.login ?? "").trim().toLowerCase()}|${(auth.label ?? "").trim().toLowerCase()}`;

/**
 * Whether the sign-in a panel runs is done. A first sign-in is done once the
 * agent reads as signed in. An account switch starts signed in, as `switchFrom`,
 * so it is done only once the agent reads as signed in to another account. A
 * switch that lands on an account the app cannot tell from the old one ends
 * when its command does.
 */
export function signInFinished(auth: Auth | undefined, switchFrom: string | undefined): boolean {
  if (auth?.status !== "authenticated") return false;
  return switchFrom === undefined || signInAccountKey(auth) !== switchFrom;
}

/**
 * Whether this Codex is on a ChatGPT sign-in that `codex login` replaces. An
 * API key, Bedrock and the app's own managed sign-in are not changed that way.
 */
export function codexSignInCanSwitch(
  provider: Pick<ServerProvider, "driver" | "auth"> | undefined,
): boolean {
  return (
    provider?.driver === "codex" &&
    provider.auth.status === "authenticated" &&
    provider.auth.type === "chatgpt" &&
    // The app's own managed sign-in reports a ChatGPT account it shares out.
    provider.auth.subscriptionSharing !== true
  );
}
