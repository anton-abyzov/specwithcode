/**
 * The Claude driver's view of an open-model instance (increment 1513): the
 * preset its marker row names, where its turns go, who pays for them, and
 * the snapshot stamp that lists the preset's models instead of Claude's.
 *
 * Everything here keys on the preset marker row (D-05). An instance built by
 * hand with its own base URL has no route, and the stamp returns its
 * snapshot unchanged.
 *
 * @module provider/openModelRoute
 */
import type {
  ModelBilling,
  ProviderInstanceEnvironment,
  ServerProvider,
  ServerProviderModel,
} from "@specweave-studio/contracts";
import { createModelCapabilities } from "@specweave-studio/shared/model";
import { classifyBaseUrlBilling } from "@specweave-studio/shared/modelBilling";
import {
  type OpenModelPreset,
  openModelPresetModelIds,
  openModelPresetOfEnvironment,
  openModelRouteLabel,
} from "@specweave-studio/shared/openModelPresets";
import * as Effect from "effect/Effect";

import { fetchLocalModelIds, normalizeLocalServerUrl } from "./localModelServer.ts";

/** How the Claude probe reports a sign-in made with `ANTHROPIC_AUTH_TOKEN`. */
const CLAUDE_TOKEN_AUTH_TYPE = "subscription-auth-unverified";

export interface OpenModelRoute {
  readonly preset: OpenModelPreset;
  /** The instance's `ANTHROPIC_BASE_URL` row, else the preset's address. */
  readonly baseUrl: string;
  /** Per-token key, paid router or local machine; never a subscription. */
  readonly billing: ModelBilling;
  /** The preset's own model ids, or the one the person chose, before any discovery. */
  readonly modelIds: ReadonlyArray<string>;
}

function rowValue(
  environment: ProviderInstanceEnvironment | undefined,
  name: string,
): string | undefined {
  const value = environment?.find((variable) => variable.name === name)?.value.trim();
  return value ? value : undefined;
}

/** The preset an instance's marker row names; undefined for every other instance. */
export function presetOf(
  environment: ProviderInstanceEnvironment | undefined,
): OpenModelPreset | undefined {
  return openModelPresetOfEnvironment(environment);
}

/** Who pays for a preset instance's turns, from where they go and the preset's billing id. */
export function openModelRouteBilling(
  preset: OpenModelPreset,
  environment: ProviderInstanceEnvironment | undefined,
): ModelBilling {
  return classifyBaseUrlBilling(
    rowValue(environment, "ANTHROPIC_BASE_URL") ?? preset.baseUrl,
    preset.billingProviderId,
  );
}

export function openModelRouteOf(
  environment: ProviderInstanceEnvironment | undefined,
): OpenModelRoute | undefined {
  const preset = presetOf(environment);
  if (preset === undefined) return undefined;
  return {
    preset,
    baseUrl: rowValue(environment, "ANTHROPIC_BASE_URL") ?? preset.baseUrl,
    billing: openModelRouteBilling(preset, environment),
    modelIds: openModelPresetModelIds(
      preset,
      rowValue(environment, "ANTHROPIC_DEFAULT_OPUS_MODEL") ??
        rowValue(environment, "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ),
  };
}

/**
 * The models a local runtime serves, from its OpenAI-style `/v1/models` list
 * with a short timeout. An unreachable runtime gives an empty list. Keyed
 * presets have nothing to discover and give undefined.
 */
export const discoverOpenModelIds = (
  route: OpenModelRoute,
  fetchImpl?: typeof globalThis.fetch,
): Effect.Effect<ReadonlyArray<string> | undefined> =>
  route.preset.kind === "local"
    ? fetchLocalModelIds(normalizeLocalServerUrl(route.baseUrl), fetchImpl)
    : Effect.succeed(undefined);

/** D-09: what a local instance says when its runtime lists no models. */
export function noOpenModelsMessage(baseUrl: string): string {
  return `No models found at ${baseUrl}`;
}

/**
 * Stamps a Claude snapshot for an open-model instance:
 * - `openModelPreset` carries the marker to clients;
 * - the auth label reads "Your key" or "Local". Claude Code reports the
 *   preset's `ANTHROPIC_AUTH_TOKEN` as an unverified subscription token, so
 *   that answer becomes a signed-in `apiKey` (keyed) or `local` sign-in and
 *   its warning clears; a check that failed or found no sign-in stays as is;
 * - the model list is the preset's ids, then discovered ids, then the
 *   person's custom models, all billed as the route is. No built-in Claude
 *   slug or alias is listed, since the vendor or runtime does not serve them;
 * - Anthropic API-key billing and subscription usage limits are dropped,
 *   since the turns never reach Anthropic.
 *
 * `discovered` is undefined until a local runtime has been asked; an empty
 * answer adds the "No models found" message. Without a route the snapshot is
 * returned as it is.
 */
export function stampOpenModelSnapshot(
  snapshot: ServerProvider,
  route: OpenModelRoute | undefined,
  discovered?: ReadonlyArray<string>,
): ServerProvider {
  if (route === undefined) return snapshot;
  const custom = snapshot.models.filter((model) => model.isCustom);
  const customSlugs = new Set(custom.map((model) => model.slug));
  const ids = [...new Set([...route.modelIds, ...(discovered ?? [])])].filter(
    (id) => !customSlugs.has(id),
  );
  const models: ReadonlyArray<ServerProviderModel> = [
    ...ids.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: createModelCapabilities({ optionDescriptors: [] }),
      billing: route.billing,
    })),
    ...custom.map((model) => ({ ...model, billing: route.billing })),
  ];
  const { usageLimits: _usageLimits, ...rest } = snapshot;
  const { apiKeyBilling: _apiKeyBilling, ...auth } = snapshot.auth;
  const noModels =
    discovered !== undefined && discovered.length === 0 && rest.message === undefined;
  const tokenSignIn = auth.type === CLAUDE_TOKEN_AUTH_TYPE;
  return {
    ...rest,
    ...(tokenSignIn && rest.status === "warning" ? { status: "ready" as const } : {}),
    openModelPreset: route.preset.id,
    auth: {
      ...auth,
      ...(tokenSignIn
        ? {
            status: "authenticated" as const,
            type: route.preset.kind === "local" ? "local" : "apiKey",
          }
        : {}),
      label: openModelRouteLabel(route.preset),
    },
    models,
    ...(noModels ? { message: noOpenModelsMessage(route.baseUrl) } : {}),
  };
}
