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
import { describeModel, sameModelOn } from "@specweave-studio/shared/modelIdentity";
import {
  defaultTrackSelections,
  effectiveModelLanes,
  isHeldSource,
  providersForModel,
} from "@specweave-studio/shared/modelTracks";
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
  /** Nothing ready reviews, or one model family is all the lists name. */
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

/**
 * Whether a list entry can run on the ready agents: its own agent is ready, or
 * a ready agent the app would pick by itself runs the same model, as a thread
 * walking the track would (`launchTrackLanes`). A saved entry on a signed-out
 * agent that nothing ready runs is left out of the block.
 */
function runsOnReady(selection: ModelSelection, ready: ReadonlyArray<ServerProvider>): boolean {
  if (ready.some((provider) => provider.instanceId === selection.instanceId)) return true;
  return providersForModel({ providers: ready, model: { slug: selection.model } }).some(
    ({ provider, slug }) => !isHeldSource(provider, slug),
  );
}

/**
 * A list entry's names: from its own agent when the machine lists it, else
 * from a ready agent that runs the same model, so a saved entry that outlived
 * its agent is not shown by its raw slug.
 */
function namesOf(
  selection: ModelSelection,
  listed: ReadonlyArray<ServerProvider>,
  ready: ReadonlyArray<ServerProvider>,
) {
  const own = listed.find((entry) => entry.instanceId === selection.instanceId);
  if (own !== undefined) return describeModel(own, selection.model);
  for (const provider of ready) {
    const slug = sameModelOn(provider, { slug: selection.model });
    if (slug !== undefined) return describeModel(provider, slug);
  }
  return describeModel(undefined, selection.model);
}

function entryOf(
  selection: ModelSelection,
  listed: ReadonlyArray<ServerProvider>,
  ready: ReadonlyArray<ServerProvider>,
): ModelLineEntry {
  const names = namesOf(selection, listed, ready);
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
  // Names come from every listed agent: a saved entry may name an agent that is not ready.
  const listed = input.providers ?? [];
  const lists = modelTrackLists(input.settings, ready);
  const fit = (list: ReadonlyArray<ModelSelection>) =>
    list.filter((selection) => runsOnReady(selection, ready));
  const shown: Readonly<Record<ModelTrack, ReadonlyArray<ModelSelection>>> = {
    daily: fit(lists.daily),
    complex: fit(lists.complex),
    review: fit(lists.review),
  };
  const familyOf = (selection: ModelSelection) =>
    modelFamily(namesOf(selection, listed, ready));
  // The family that does the everyday work: the first Daily model's, else the first ready agent's.
  const first = shown.daily[0] ?? shown.complex[0];
  const firstFamily =
    first === undefined
      ? (ready.flatMap((provider) => provider.models.map((model) => modelFamily(model)))[0] ??
        null)
      : familyOf(first);
  // A second family is ready when a ready agent runs a model outside the everyday family.
  const secondFamilyReady = ready.some((provider) =>
    provider.models.some((model) => {
      const family = modelFamily(model);
      return family !== "other" && family !== firstFamily;
    }),
  );
  // No reviewer: nothing ready reviews, or every reviewer is of the everyday family and no
  // second family is ready. A saved same-family reviewer with a second family ready stays a
  // list, as Settings > Models shows it with its own warning.
  const noReviewer =
    shown.review.length === 0 ||
    (!secondFamilyReady && shown.review.every((selection) => familyOf(selection) === firstFamily));
  const lines = MODEL_TRACKS.map((track): ModelLine => {
    const list = shown[track];
    if (track === "review" && noReviewer) {
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
      shown: list.slice(0, SHOWN_MODELS).map((selection) => entryOf(selection, listed, ready)),
      more: Math.max(0, list.length - SHOWN_MODELS),
    };
  });
  return { kind: "lines", lines };
}
