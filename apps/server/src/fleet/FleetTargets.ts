import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { type FleetConfig, type FleetFetch, readFleetConfig } from "../studioFleet.ts";

export class FleetConfigReadError extends Schema.TaggedError<FleetConfigReadError>()(
  "FleetConfigReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Private machine configuration could not be read securely.";
  }
}

/**
 * The other machines this server may reach, and how it reaches them. In
 * production they come only from the owner's `studio-fleet.json` (private
 * Tailscale HTTPS origins with a pinned environment id); requests can only
 * name a configured machine. Tests supply their own targets and fetch here.
 */
export class FleetTargets extends Context.Service<
  FleetTargets,
  {
    readonly load: Effect.Effect<FleetConfig | null, FleetConfigReadError>;
    readonly fetch: FleetFetch;
  }
>()("specweave-studio/fleet/FleetTargets") {}

export const layer = Layer.effect(
  FleetTargets,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fetch = yield* FetchHttpClient.Fetch;
    return FleetTargets.of({
      load: Effect.tryPromise({
        try: () => readFleetConfig(config.baseDir),
        catch: (cause) => new FleetConfigReadError({ cause }),
      }),
      fetch,
    });
  }),
);
