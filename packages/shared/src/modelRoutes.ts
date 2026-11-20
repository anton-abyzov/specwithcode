/**
 * Per-model routes: the sources one model may run on, in the person's order.
 * A route reorders, drops or pins the sources `providersForModel` found; it
 * never adds one that does not list the model. A model with no route, or an
 * empty one, keeps the automatic order.
 *
 * @module modelRoutes
 */
import {
  EMPTY_MODEL_ROUTE,
  type ModelRoute,
  type ModelRoutes,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@specweave-studio/contracts";

import { identityKey, modelIdentityKeys } from "./modelIdentity.ts";

type ModelNames = Pick<ServerProviderModel, "slug"> &
  Partial<Pick<ServerProviderModel, "name" | "aliases">>;

/** The key a model's route is stored under: every spelling of one model shares it. */
export function modelRouteKey(model: ModelNames): string {
  return identityKey(model.slug) ?? model.slug.trim().toLowerCase();
}

/** Whether `route` changes nothing: the automatic order. */
export function isEmptyRoute(route: ModelRoute | null | undefined): boolean {
  return (
    route == null ||
    (route.order.length === 0 &&
      route.dropped.length === 0 &&
      !route.pinned &&
      route.allowed.length === 0)
  );
}

/** The saved route for `model` under any of its spellings, or null for the automatic order. */
export function routeFor(
  routes: ModelRoutes | null | undefined,
  model: ModelNames,
): ModelRoute | null {
  if (routes == null) return null;
  for (const key of [modelRouteKey(model), ...modelIdentityKeys(model)]) {
    const route = routes[key];
    if (route !== undefined && !isEmptyRoute(route)) return route;
  }
  return null;
}

/**
 * `choices` (best first) with the route applied: dropped sources out, the
 * person's order first, the rest after in their own order. A pinned route
 * keeps only its first source, which may leave nothing.
 */
export function applyRoute<C extends { readonly provider: { readonly instanceId: string } }>(
  choices: ReadonlyArray<C>,
  route: ModelRoute | null,
): ReadonlyArray<C> {
  if (route === null) return choices;
  const kept = choices.filter(
    (choice) => !route.dropped.includes(choice.provider.instanceId as ProviderInstanceId),
  );
  const rank = (choice: C) => {
    const at = route.order.indexOf(choice.provider.instanceId as ProviderInstanceId);
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  const ordered = kept
    .map((choice, listed) => ({ choice, listed }))
    .sort((a, b) => rank(a.choice) - rank(b.choice) || a.listed - b.listed)
    .map(({ choice }) => choice);
  if (!route.pinned) return ordered;
  const pin = route.order[0];
  return pin === undefined ? [] : ordered.filter((choice) => choice.provider.instanceId === pin);
}

/**
 * How a source may run a model: `plan` needs nobody's say, `allowed` was
 * allowed for this model, `ask` is a held source (per token or unknown
 * billing) the person listed in the route but never allowed, and `never` is
 * a held source the route does not list.
 */
export type RouteConsent = "plan" | "allowed" | "ask" | "never";

export function routeConsent(
  route: ModelRoute | null,
  instanceId: ProviderInstanceId,
  held: boolean,
): RouteConsent {
  if (!held) return "plan";
  if (route === null) return "never";
  if (route.allowed.includes(instanceId)) return "allowed";
  return route.order.includes(instanceId) ? "ask" : "never";
}

const base = (route: ModelRoute | null): ModelRoute => route ?? EMPTY_MODEL_ROUTE;
const without = (list: ReadonlyArray<ProviderInstanceId>, id: ProviderInstanceId) =>
  list.filter((entry) => entry !== id);

/** The route with `shown` (the sources as the person sees them) reordered: `from` moved to `to`. */
export function moveRouteSource(
  route: ModelRoute | null,
  shown: ReadonlyArray<ProviderInstanceId>,
  from: number,
  to: number,
): ModelRoute {
  const order = [...shown];
  const [moved] = order.splice(from, 1);
  if (moved === undefined) return base(route);
  order.splice(to, 0, moved);
  return { ...base(route), order };
}

/** Never run the model on `id`. A pin on it goes too. */
export function dropRouteSource(route: ModelRoute | null, id: ProviderInstanceId): ModelRoute {
  const current = base(route);
  return {
    ...current,
    order: without(current.order, id),
    dropped: current.dropped.includes(id) ? current.dropped : [...current.dropped, id],
    pinned: current.pinned && current.order[0] !== id,
    allowed: without(current.allowed, id),
  };
}

/** Undo a drop: the source goes back to the automatic order. */
export function restoreRouteSource(route: ModelRoute | null, id: ProviderInstanceId): ModelRoute {
  const current = base(route);
  return { ...current, dropped: without(current.dropped, id) };
}

/** Run the model only on `id`, or, when `id` is already pinned, on every source again. */
export function togglePinRouteSource(
  route: ModelRoute | null,
  shown: ReadonlyArray<ProviderInstanceId>,
  id: ProviderInstanceId,
): ModelRoute {
  const current = base(route);
  if (current.pinned && current.order[0] === id) return { ...current, pinned: false };
  return { ...current, order: [id, ...without(shown, id)], pinned: true };
}

/** List a source the automatic order leaves out (a per-token one) at the end of the route. */
export function addRouteSource(
  route: ModelRoute | null,
  shown: ReadonlyArray<ProviderInstanceId>,
  id: ProviderInstanceId,
): ModelRoute {
  const current = base(route);
  return {
    ...current,
    order: [...without(shown, id), id],
    dropped: without(current.dropped, id),
  };
}

/** "Always allow for this model": a held source runs it without asking again. */
export function allowRouteSource(route: ModelRoute | null, id: ProviderInstanceId): ModelRoute {
  const current = base(route);
  return {
    ...current,
    order: current.order.includes(id) ? current.order : [...current.order, id],
    allowed: current.allowed.includes(id) ? current.allowed : [...current.allowed, id],
  };
}

/** The settings patch value that saves `route` for `model`; an empty route stands for "automatic". */
export function withModelRoute(
  routes: ModelRoutes | null | undefined,
  model: ModelNames,
  route: ModelRoute,
): ModelRoutes {
  // Settings merge per key, so a route is cleared by saving it empty, never by leaving it out.
  return { ...routes, [modelRouteKey(model)]: isEmptyRoute(route) ? EMPTY_MODEL_ROUTE : route };
}
