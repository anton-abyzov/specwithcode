/**
 * Whether this machine can show that it lost its own network (1128). Silent
 * peers alone cannot: a sleeping laptop is silent too. So before handoff mode
 * stops its own work it asks the SpecWithCode Connect relay this machine is
 * linked to. Any HTTP answer, whatever its status, means the network works;
 * only a network error or a timeout reads as offline. Without a relay URL
 * nothing can be shown, so the answer is "unknown" and nothing is fenced.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { RELAY_URL_SECRET } from "../cloud/config.ts";

export type HandoffConnectivityState = "online" | "offline" | "unknown";

export const CONNECTIVITY_PROBE_TIMEOUT_MS = 5_000;

export interface HandoffConnectivityShape {
  /** Never fails. */
  readonly probe: Effect.Effect<HandoffConnectivityState>;
}

/** Unprovided (tests, servers without secrets) it answers "unknown": isolation is never shown. */
export class HandoffConnectivity extends Context.Reference<HandoffConnectivityShape>(
  "specweave-studio/handoff/HandoffConnectivity",
  { defaultValue: () => ({ probe: Effect.succeed("unknown") }) },
) {}

/** One request to `url`: any response is online; an error or no answer in 5 s is offline. */
export const probeUrl = (
  url: string,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<HandoffConnectivityState> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(CONNECTIVITY_PROBE_TIMEOUT_MS)]),
      });
      await response.body?.cancel().catch(() => undefined);
      return "online" as const;
    },
    catch: () => "offline" as const,
  }).pipe(Effect.orElseSucceed(() => "offline" as const));

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const relayUrl = secrets.get(RELAY_URL_SECRET).pipe(
    Effect.map((bytes) =>
      Option.isSome(bytes) && bytes.value.length > 0 ? new TextDecoder().decode(bytes.value) : null,
    ),
    Effect.orElseSucceed(() => null),
  );
  return {
    probe: relayUrl.pipe(
      Effect.flatMap((url) =>
        url === null || url.trim() === "" ? Effect.succeed("unknown" as const) : probeUrl(url),
      ),
    ),
  } satisfies HandoffConnectivityShape;
});

export const layer = Layer.effect(HandoffConnectivity, make);
