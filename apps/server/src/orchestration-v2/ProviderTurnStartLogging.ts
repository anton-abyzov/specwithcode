import type { RunId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { providerFailureDiagnostics } from "./ProviderFailure.ts";

/** Keep startup logs useful without retaining provider payloads or raw nested defects. */
export function logProviderTurnStartFailure(runId: RunId, cause: unknown) {
  return Effect.logError("orchestration V2 provider turn start failed", {
    runId,
    ...providerFailureDiagnostics(cause),
  });
}
