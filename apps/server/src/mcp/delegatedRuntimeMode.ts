import type { RuntimeMode } from "@specweave-studio/contracts";

import { providerRuntimeMode } from "../orchestration-v2/RuntimePolicy.ts";

/** The names the app shows for each mode (apps/web/src/components/chat/runtimeModeConfig.ts). */
const MODE_LABEL: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

/** What the delegating thread needs to know about the target provider's modes. */
export interface DelegatedRuntimeModeProvider {
  readonly displayName?: string | undefined;
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined;
}

/**
 * The launch warning for a worker whose provider cannot run the mode it was
 * given. The thread keeps the asked mode, but each turn runs in
 * `providerRuntimeMode`'s fallback (Supervised), so an unattended worker would
 * otherwise stop on its first approval with nobody told why.
 */
export function delegatedRuntimeModeWarning(input: {
  readonly requested: RuntimeMode;
  readonly parentMode: RuntimeMode;
  readonly provider: DelegatedRuntimeModeProvider | undefined;
}): string | undefined {
  const provider = input.provider;
  if (provider === undefined) return undefined;
  const effective = providerRuntimeMode(input.requested, provider.supportedRuntimeModes);
  if (effective === input.requested) return undefined;
  const name = provider.displayName ?? "This provider";
  const supported = provider.supportedRuntimeModes ?? [];
  const asked = MODE_LABEL[input.requested];
  const parts = [`${name} has no ${asked} mode, so this worker runs ${MODE_LABEL[effective]}.`];
  if (effective === "approval-required")
    parts.push(
      "Each command it runs waits for a person to approve it in the app; nobody approves for you.",
    );
  if (input.parentMode === "full-access" && supported.includes("full-access"))
    parts.push(
      `For unattended work, delegate with runtimeMode "full-access" or to a provider that offers ${asked}.`,
    );
  else parts.push(`For unattended work, delegate to a provider that offers ${asked}.`);
  parts.push(`${name} offers ${supported.map((mode) => MODE_LABEL[mode]).join(" and ")}.`);
  return parts.join(" ");
}

/** Joins launch warnings into the one `warning` field a launch result carries. */
export function joinLaunchWarnings(
  ...warnings: ReadonlyArray<string | undefined>
): string | undefined {
  const present = warnings.filter((warning): warning is string => !!warning);
  return present.length === 0 ? undefined : present.join(" ");
}
