/**
 * What Muse Code's own command line says about the account on this machine.
 *
 * The served host (`muse serve`) cannot say whether an account is signed in:
 * it lists models only from a catalog cached on disk, and a signed-in machine
 * that has never run `muse exec` has no such cache, so it answers with the
 * empty compiled-in list exactly as a signed-out machine does. `muse usage
 * --json` asks the account itself: it prints the plan and its allowance when
 * signed in, and exits with "not logged in" when not. No credential is read
 * here; the command line reads its own.
 *
 * @module provider/muse/MuseAccount
 */
import type {
  ServerProvider,
  ServerProviderModel,
  ServerProviderUsageLimits,
} from "@specweave-studio/contracts";

import { parseJson } from "../../json.ts";
import { museUsageFromCliJson } from "./MuseDiscovery.ts";

export interface MuseCliAccount {
  readonly signedIn: boolean;
  /** The plan's name as Muse Code prints it ("Muse Code Max Usage"). */
  readonly plan?: string;
  readonly limits?: ServerProviderUsageLimits;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Reads one run of `muse usage --json`. Undefined when the run says nothing
 * either way (a network failure, a version that prints something else): the
 * caller then keeps what the host's model list says.
 */
export function museCliAccount(
  run: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  nowMs: number,
): MuseCliAccount | undefined {
  if (run.exitCode !== 0) {
    return /\bnot logged in\b/i.test(`${run.stderr}\n${run.stdout}`)
      ? { signedIn: false }
      : undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseJson(run.stdout);
  } catch {
    return undefined;
  }
  const answer = record(parsed);
  if (Object.keys(answer).length === 0) return undefined;
  // 1.4.20 wraps the numbers in `allowance`; earlier versions used `usage` or no wrapper.
  const tier = [record(answer.allowance).tier, record(answer.usage).tier, answer.tier].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  const limits = museUsageFromCliJson(run.stdout, nowMs);
  return {
    signedIn: true,
    ...(tier === undefined ? {} : { plan: tier.trim() }),
    ...(limits === undefined ? {} : { limits }),
  };
}

/**
 * A model id no account has. `muse exec` downloads the account's model
 * catalog before it sends its first request, and Meta refuses this id, so the
 * catalog lands on disk and no turn runs and nothing is spent.
 */
const MUSE_CATALOG_REQUEST_MODEL = "specwithcode-model-list";

/** The run that makes Muse Code download its model catalog (see above). */
export const museCatalogDownloadArgs: ReadonlyArray<string> = [
  "exec",
  "--model",
  MUSE_CATALOG_REQUEST_MODEL,
  "--reasoning-effort",
  "minimal",
  "List the models of this account.",
];

/** What the row says, from what the host listed and what the command line reported. */
export function museReadiness(input: {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly account: MuseCliAccount | undefined;
  readonly apiKey: boolean;
}): Pick<ServerProvider, "status" | "auth" | "message"> {
  const { models, limits, account, apiKey } = input;
  // The command line's own word comes first: a list cached from an earlier
  // login can outlive a sign-out. Without that word, a list is a sign-in,
  // since the host lists models only for a signed-in account.
  const signedOut = !apiKey && account?.signedIn === false;
  const signedIn = !signedOut && (models.length > 0 || account?.signedIn === true);
  const plan = apiKey ? undefined : account?.plan;
  const auth: ServerProvider["auth"] = {
    status: signedIn ? "authenticated" : signedOut ? "unauthenticated" : "unknown",
    type: apiKey ? "api_key" : "subscription",
    ...(plan === undefined ? {} : { label: plan }),
  };
  if (signedOut) {
    return {
      status: "error",
      auth,
      message: "Muse Code is not signed in. Run `muse login` in a terminal on this machine.",
    };
  }
  if (models.length === 0) {
    return {
      status: "warning",
      auth,
      message: signedIn
        ? "Signed in to Muse Code, but its model list is not on this machine yet. Choose Check again to download it."
        : "Muse Code reported neither its models nor its sign-in. Run `muse login` in a terminal on this machine if it is not signed in.",
    };
  }
  return {
    status: "ready",
    auth,
    message: limits
      ? "Muse Code native subscription. Wonder Full requires an eligible plan and account model availability."
      : "Signed in to Muse Code. Usage limits appear after this provider runs a turn; until then it will not be suggested as a fallback.",
  };
}
