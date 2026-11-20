/**
 * What one machine tells another about its sign-ins, and how the asking
 * machine reads it: usage, the grant's accounts, and which models are billed
 * per token or held back from automatic starts.
 */
import type { OrchestratorMcpMachineProvider, ServerProvider } from "@specweave-studio/contracts";
import { isPaidModel } from "@specweave-studio/shared/modelBilling";
import { isHeldSource } from "@specweave-studio/shared/modelTracks";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The billing flags this machine reports for one of its models. `paid` keeps
 * such a model from being a limit handoff target; `held` also covers a
 * sign-in whose billing is unknown, and keeps a model the app picked on
 * another machine from starting here unasked (see `translateModel`).
 */
export const modelBillingFlags = (provider: ServerProvider, slug: string) => ({
  ...(isPaidModel(provider, slug) ? { paid: true as const } : {}),
  ...(isHeldSource(provider, slug) ? { held: true as const } : {}),
});

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;
const isoOrNull = (value: unknown) =>
  typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;

/**
 * The usage another machine shares for one provider, or undefined when it
 * shares none (an older version) or sends something malformed. Unknown
 * usage is never read as room.
 */
export const readProviderUsage = (
  value: unknown,
): OrchestratorMcpMachineProvider["usage"] | undefined => {
  if (!isRecord(value) || typeof value.signedIn !== "boolean") return undefined;
  const fingerprint =
    typeof value.accountFingerprint === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.accountFingerprint)
      ? value.accountFingerprint
      : null;
  const used =
    typeof value.usedPercent === "number" &&
    Number.isFinite(value.usedPercent) &&
    value.usedPercent >= 0 &&
    value.usedPercent <= 100
      ? value.usedPercent
      : null;
  return {
    accountFingerprint: fingerprint,
    usedPercent: used,
    resetsAt: isoOrNull(value.resetsAt),
    signedIn: value.signedIn,
    observedAt: isoOrNull(value.observedAt),
    ...(value.limited === true ? { limited: true } : {}),
  } as OrchestratorMcpMachineProvider["usage"];
};

export const readProviders = (
  capabilities: unknown,
): ReadonlyArray<OrchestratorMcpMachineProvider> =>
  (isRecord(capabilities) && Array.isArray(capabilities.providers) ? capabilities.providers : [])
    .filter(isRecord)
    .flatMap((provider) => {
      if (
        typeof provider.providerInstanceId !== "string" ||
        typeof provider.driverKind !== "string"
      )
        return [];
      const usage = readProviderUsage(provider.usage);
      const models = (Array.isArray(provider.models) ? provider.models : []).filter(isRecord);
      const flagged = (flag: "paid" | "held") =>
        models.flatMap((model) =>
          typeof model.id === "string" && model[flag] === true ? [model.id] : [],
        );
      const paidModels = flagged("paid");
      const heldModels = flagged("held");
      return [
        {
          providerInstanceId: provider.providerInstanceId,
          driverKind: provider.driverKind,
          models: models.flatMap((model) => (typeof model.id === "string" ? [model.id] : [])),
          available: Array.isArray(provider.constraints) && provider.constraints.length === 0,
          ...(usage === undefined ? {} : { usage }),
          ...(typeof provider.allowedByGrant === "boolean"
            ? { allowedByGrant: provider.allowedByGrant }
            : {}),
          ...(paidModels.length === 0 ? {} : { paidModels }),
          ...(heldModels.length === 0 ? {} : { heldModels }),
        } as unknown as OrchestratorMcpMachineProvider,
      ];
    });
