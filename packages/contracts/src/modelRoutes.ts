/**
 * Per-model routes: for one model, the sources it may run on and in which
 * order. A model with no route (or an empty one) runs on every source that
 * lists it, in the automatic order (see `providersForModel`).
 *
 * @module modelRoutes
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

const RouteSources = Schema.Array(ProviderInstanceId).check(Schema.isMaxLength(16));

export const ModelRoute = Schema.Struct({
  /** Sources the person ranked for this model, first to last; the rest follow automatically. */
  order: RouteSources.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Sources that never run this model. */
  dropped: RouteSources.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Only the first source in `order` runs this model; none other stands in for it. */
  pinned: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Per-token or unknown-billing sources allowed to run this model without asking. */
  allowed: RouteSources.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ModelRoute = typeof ModelRoute.Type;

/** At most this many models keep a route. */
export const MAX_MODEL_ROUTES = 64;

/**
 * Routes by model identity key (`claude-fable-5-2`): lower case, dots and
 * spaces read as dashes, so every provider's spelling of one model shares it.
 */
export const ModelRoutes = Schema.Record(Schema.String, ModelRoute).check(
  Schema.makeFilter((routes) => Object.keys(routes).length <= MAX_MODEL_ROUTES, {
    expected: `at most ${MAX_MODEL_ROUTES} model routes`,
  }),
);
export type ModelRoutes = typeof ModelRoutes.Type;

export const EMPTY_MODEL_ROUTE: ModelRoute = { order: [], dropped: [], pinned: false, allowed: [] };
