/**
 * The Models block of the first-run Agents step: the three model tracks this
 * machine will use, in order, fitted to the agents that are ready. It holds no
 * model names and no fallback rule of its own. The lists come from
 * `modelTrackLists`, which Settings > Models reads its saved lists from too,
 * and which fits a track the person never saved with the same functions the
 * runtime uses (`effectiveModelLanes`, `defaultTrackSelections`).
 *
 * @module firstRunModels.logic
 */
import {
  MODEL_TRACKS,
  type ModelLanes,
  type ModelSelection,
  type ModelTrack,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describeModel } from "@specweave-studio/shared/modelIdentity";
import { defaultTrackSelections, effectiveModelLanes } from "@specweave-studio/shared/modelTracks";
import { type ModelFamily, modelFamily } from "@specweave-studio/shared/modelVendor";

import type { ProviderBrand } from "../components/ProviderLogo";
import { getOnboardingProviderState } from "./providerReadiness.logic";

/** The settings the three tracks are stored in, as Settings > Models reads them. */
export interface ModelTrackSettings {
  readonly modelLanes?: Partial<ModelLanes> | null | undefined;
  readonly adversarialReview: { readonly reviewers: ReadonlyArray<ModelSelection> };
  readonly defaultModelProviders?: ReadonlyArray<ProviderInstanceId> | null | undefined;
}

/** Each track's saved list; an empty one means the built-in order. */
export function savedModelTracks(
  settings: ModelTrackSettings,
): Readonly<Record<ModelTrack, ReadonlyArray<ModelSelection>>> {
  return {
    daily: settings.modelLanes?.routine ?? [],
    complex: settings.modelLanes?.complex ?? [],
    review: settings.adversarialReview.reviewers,
  };
}

/**
 * The three lists a machine uses, in order: a saved list as it is, else the
 * built-in order fitted to `providers` and the saved Sources order.
 */
export function modelTrackLists(
  settings: ModelTrackSettings,
  providers: ReadonlyArray<ServerProvider>,
): Readonly<Record<ModelTrack, ReadonlyArray<ModelSelection>>> {
  const saved = savedModelTracks(settings);
  const order = settings.defaultModelProviders ?? [];
  const { lanes } = effectiveModelLanes(
    { routine: [...saved.daily], complex: [...saved.complex] },
    providers,
    order,
  );
  return {
    daily: lanes.routine,
    complex: lanes.complex,
    review: saved.review.length > 0 ? saved.review : defaultTrackSelections("review", providers, order),
  };
}

/** The agents that are ready on the step: installed, on and signed in. */
export function readyAgents(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
): ReadonlyArray<ServerProvider> {
  return (providers ?? []).filter((provider) => getOnboardingProviderState(provider) === "ready");
}

const BRAND_BY_FAMILY: Readonly<Record<ModelFamily, ProviderBrand | null>> = {
  claude: "claude",
  openai: "openai",
  google: "gemini",
  xai: "grok",
  meta: "meta",
  other: null,
};

/** The mark a model carries: its maker's, whichever agent runs it. */
export function modelBrand(model: {
  readonly slug: string;
  readonly name?: string | undefined;
}): ProviderBrand | null {
  return BRAND_BY_FAMILY[modelFamily(model)];
}

/** How many models a line names before "+{n} more". */
export const SHOWN_MODELS = 3;

export interface ModelLineEntry {
  readonly key: string;
  readonly name: string;
  readonly brand: ProviderBrand | null;
}

/** An agent named as an example of a second family, with the mark it carries. */
export interface ReviewerExample {
  readonly name: string;
  readonly brand: ProviderBrand;
}

export type ModelLine =
  | {
      readonly track: ModelTrack;
      readonly kind: "models";
      /** The first `SHOWN_MODELS`; the first of them is the one marked "first". */
      readonly shown: ReadonlyArray<ModelLineEntry>;
      readonly more: number;
    }
  /** Agents are ready, and none of them runs a model of this list. */
  | { readonly track: ModelTrack; readonly kind: "empty" }
  /** No reviewer outside the family that does the everyday work. */
  | {
      readonly track: "review";
      readonly kind: "no-reviewer";
      readonly examples: readonly [ReviewerExample, ReviewerExample];
    };

export type FirstRunModels =
  /** No agent is ready: one line, "Ready once an agent is signed in." */
  | { readonly kind: "none-ready" }
  | { readonly kind: "lines"; readonly lines: ReadonlyArray<ModelLine> };

/** Agents suggested for a second family, in this order; the first two outside the family are named. */
const REVIEWER_EXAMPLES: ReadonlyArray<ReviewerExample & { readonly family: ModelFamily }> = [
  { name: "Codex", brand: "openai", family: "openai" },
  { name: "Muse Code", brand: "meta", family: "meta" },
  { name: "Claude Code", brand: "claude", family: "claude" },
];

function familyOf(selection: ModelSelection, providers: ReadonlyArray<ServerProvider>) {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  return modelFamily(describeModel(provider, selection.model));
}

function entryOf(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ModelLineEntry {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const names = describeModel(provider, selection.model);
  return {
    key: `${selection.instanceId}:${selection.model}`,
    name: names.name ?? selection.model,
    brand: modelBrand(names),
  };
}

/**
 * The block's lines for one machine. `providers` is every agent the machine
 * lists; only the ready ones fit the tracks.
 */
export function firstRunModels(input: {
  readonly settings: ModelTrackSettings;
  readonly providers: ReadonlyArray<ServerProvider> | null | undefined;
}): FirstRunModels {
  const ready = readyAgents(input.providers);
  if (ready.length === 0) return { kind: "none-ready" };
  const lists = modelTrackLists(input.settings, ready);
  const first = lists.daily[0];
  const firstFamily = first === undefined ? null : familyOf(first, ready);
  const lines = MODEL_TRACKS.map((track): ModelLine => {
    const list = lists[track];
    if (
      track === "review" &&
      !list.some((selection) => familyOf(selection, ready) !== firstFamily)
    ) {
      const [one, two] = REVIEWER_EXAMPLES.filter((example) => example.family !== firstFamily);
      return {
        track,
        kind: "no-reviewer",
        examples: [
          { name: one!.name, brand: one!.brand },
          { name: two!.name, brand: two!.brand },
        ],
      };
    }
    if (list.length === 0) return { track, kind: "empty" };
    return {
      track,
      kind: "models",
      shown: list.slice(0, SHOWN_MODELS).map((selection) => entryOf(selection, ready)),
      more: Math.max(0, list.length - SHOWN_MODELS),
    };
  });
  return { kind: "lines", lines };
}
