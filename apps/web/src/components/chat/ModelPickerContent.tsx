import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
  type ServerProviderModel,
} from "@specweave-studio/contracts";
import { resolveSelectableModel } from "@specweave-studio/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { memo, useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ChevronRightIcon } from "lucide-react";
import { ModelListRow } from "./ModelListRow";
import { baseModelSlug } from "@specweave-studio/shared/threadModelIdentity";
import type { ModelStateHeader } from "./fallbackStatus";
import { FallbackStatusCard } from "./FallbackStatusCard";
import { ModelPickerProviderChips, type ModelPickerView } from "./ModelPickerProviderChips";
import {
  ModelPickerActions,
  ModelPickerKeyHints,
  ModelPickerSetupFooter,
} from "./ModelPickerFooter";
import {
  adjacentEffort,
  ModelPickerEffortStrip,
  type ModelPickerEffort,
} from "./ModelPickerEffortStrip";
import { ProviderGroupHeader } from "./ProviderGroupHeader";
import { ModelSearchGroupHeader, ModelSearchOlderRow, useToggleSet } from "./ModelSearchGroupRows";
import { useModelFamilyFavorites } from "./useModelFamilyFavorites";
import { useRevealOlderVersions } from "./useRevealOlderVersions";
import {
  layoutModelSearchResults,
  modelSearchIdentity,
  modelSearchProviderPlan,
  parseModelPickerOlderVersionsKey,
  type ModelSearchHeader,
  type ModelSearchOlderSection,
} from "./modelSearchGroups";
import { HarnessDescription } from "./HarnessDescription";
import type { ProviderQuickSetup } from "~/hooks/useProviderQuickSetup";
import { findEffortDescriptor } from "@specweave-studio/shared/effortLevel";
import {
  modelPickerGroupStarts,
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";
import { countModelSearchMatches, rankModelPickerSearch } from "./modelPickerSearch";
import {
  Combobox,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { getTriggerDisplayModelName, ModelEsque } from "./providerIconUtils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { TooltipProvider } from "../ui/tooltip";
import {
  isProviderInstancePickerSelectable,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { ModelPickerAlternativesNote } from "./ModelPickerAlternativesNote";
import {
  ModelPickerAccountLine,
  ModelPickerRunningNote,
  ModelPickerUsageBand,
  rowAvailability,
  rowShowsAvailability,
  type ModelPickerUsage,
} from "./ModelUsage";
import { isAvailabilityBlocking, railLimitSentence } from "../../studio/modelAvailability";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  continuationGroupKey?: string | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

import {
  resolveModelPickerSelectedModel,
  shouldIncludeModelPickerOption,
  shouldOfferModelPickerSetup,
} from "./modelPickerOptions";
import { adjacentModelPickerProvider } from "./modelPickerProviderOrder";

const fallbackRoleKey = (instanceId: string, model: string) =>
  `${instanceId}\u0000${baseModelSlug(model)}`;

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const EMPTY_GROUP_STARTS: ReadonlyMap<string, ProviderInstanceId> = new Map();
const EMPTY_SEARCH_HEADERS: ReadonlyMap<string, ModelSearchHeader> = new Map();
const EMPTY_OLDER_SECTIONS: ReadonlyMap<string, ModelSearchOlderSection> = new Map();

/** The effort a model runs at unless the user picks another, from its option descriptors. */
function defaultModelEffort(
  runtimeModel: ServerProviderModel | undefined,
): { readonly id: string; readonly label: string } | null {
  const descriptor = findEffortDescriptor(runtimeModel?.capabilities?.optionDescriptors);
  if (!descriptor) return null;
  const id = descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
  const option = descriptor.options.find((candidate) => candidate.id === id);
  return option ? { id: option.id, label: option.label } : null;
}
const MODEL_LIST_ESTIMATED_ITEM_SIZE = 52;
const MODEL_LIST_MIN_VISIBLE_ROWS = 4;

function ModelListSeparator() {
  return <div className="h-0.5" />;
}

export type { ModelStateHeader } from "./fallbackStatus";

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  /** The instance currently selected in the composer (combobox "value"). */
  activeInstanceId: ProviderInstanceId;
  model: string;
  stateHeader?: ModelStateHeader | null;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  /**
   * When set, the picker is locked to the given driver kind — typically
   * because the user is editing a previously-sent message and can't change
   * which driver served the turn. Multiple instances of the same kind
   * remain selectable (e.g. locked to `codex` still lets the user switch
   * between the default Codex and a custom Codex Personal).
   */
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /**
   * All configured provider instances in display order. Used to render
   * the sidebar (one button per instance) and to resolve display names
   * for the locked-mode header.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  /**
   * Model options per instance. Keyed by `ProviderInstanceId` so the
   * default Codex instance and any custom Codex instances each have their
   * own list (custom instances typically start with the same built-in
   * model set but are free to diverge via customModels).
   */
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  onManageProviders?: () => void;
  /** Open the settings where the fallback order is set. */
  onEditFallbackOrder?: () => void;
  /** One-click install here, and providers ready on the user's other machines. */
  quickSetup?: ProviderQuickSetup;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  /**
   * Usage beside each model, for pickers that choose what a chat runs next.
   * A model whose confirmed read says its limit is spent stays selectable; it
   * keeps its place and shortcut, and its warning says why. Only
   * getModelDisabledReason disables a row.
   */
  usage?: ModelPickerUsage;
  /**
   * The picked model's effort and Fast mode, set from the strip at the foot of the list.
   * Left and Right in an empty search move along it.
   */
  effort?: ModelPickerEffort | null;
  /** A footer button that swaps the list for the host's second view. */
  secondaryAction?: { readonly label: string; readonly onOpen: () => void };
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const {
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
    onToggleModel,
    usage,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<LegendListRef | null>(null);
  const pickerContentRef = useRef<HTMLDivElement>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const favorites = useClientSettings((s) => s.favorites ?? []);
  const favoriteFamilyCount = useClientSettings((s) => s.favoriteModelFamilies?.length ?? 0);
  const activeEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.activeInstanceId,
  );
  const activeModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const activeModelSlug =
    activeModel?.slug ?? (props.model === ANTIGRAVITY_DEFAULT_MODEL ? "" : props.model);
  const activeModelKey = activeModelSlug
    ? modelPickerModelKey(props.activeInstanceId, activeModelSlug)
    : null;
  const selectedModelKeys = useMemo(
    () =>
      props.selectedModels?.map((selection) => {
        const entry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
        const model = resolveModelPickerSelectedModel({
          driverKind: entry?.driverKind,
          model: selection.model,
          options: modelOptionsByInstance.get(selection.instanceId) ?? [],
        });
        return modelPickerModelKey(selection.instanceId, model?.slug ?? selection.model);
      }),
    [instanceEntries, modelOptionsByInstance, props.selectedModels],
  );
  const selectedModelKeySet = useMemo(
    () => new Set(selectedModelKeys ?? (activeModelKey ? [activeModelKey] : [])),
    [selectedModelKeys, activeModelKey],
  );
  const activeInstanceHasSelectableUnavailableModel =
    activeEntry !== undefined &&
    (modelOptionsByInstance.get(props.activeInstanceId) ?? []).some((option) =>
      shouldIncludeModelPickerOption({
        entry: activeEntry,
        option,
        activeInstanceId: props.activeInstanceId,
        activeModel: activeModelSlug,
      }),
    ) &&
    !isProviderInstancePickerSelectable(activeEntry);
  const activeInstanceNeedsSetup =
    props.onOpenProviderSetup !== undefined &&
    activeEntry !== undefined &&
    shouldOfferModelPickerSetup(
      activeEntry,
      modelOptionsByInstance.get(props.activeInstanceId) ?? [],
      props.quickSetup?.installable.has(props.activeInstanceId),
    );
  const [selectedInstanceId, setSelectedInstanceId] = useState<ModelPickerView>(() => {
    if (
      props.lockedProvider !== null ||
      activeInstanceHasSelectableUnavailableModel ||
      activeInstanceNeedsSetup
    ) {
      // Keep the active instance visible when it is locked or needs setup.
      return props.activeInstanceId;
    }
    return favorites.length + favoriteFamilyCount > 0 ? "favorites" : props.activeInstanceId;
  });
  const [expandedOlderFamilies, toggleOlderFamily] = useToggleSet();
  const [expandedLegacyInstances, setExpandedLegacyInstances] = useState(
    () =>
      new Set<ProviderInstanceId>(
        modelOptionsByInstance
          .get(props.activeInstanceId)
          ?.some((model) => model.slug === activeModelSlug && model.isLegacy)
          ? [props.activeInstanceId]
          : [],
      ),
  );
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = providedKeybindings ?? serverKeybindings;
  const updateSettings = useUpdateClientSettings();

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  // While searching, the providers narrow the results; each new search starts on All.
  const [searchScope, setSearchScope] = useState<ModelPickerView>("all");
  const searching = searchQuery.trim().length > 0;
  const handleSelectInstance = useCallback(
    (instanceId: ModelPickerView) => {
      (searching ? setSearchScope : setSelectedInstanceId)(instanceId);
      window.requestAnimationFrame(() => {
        focusSearchInput();
      });
    },
    [focusSearchInput, searching],
  );

  useLayoutEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(() => {
      focusSearchInput();
    });
    const timeout = window.setTimeout(() => {
      focusSearchInput();
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearchInput]);

  // Create a Set for efficient lookup. Favorites are keyed by
  // `${instanceId}:${slug}`; the storage schema widened from ProviderDriverKind
  // to ProviderInstanceId so pre-migration favorites keyed by driver slugs
  // (e.g. `"codex:gpt-5"`) still resolve — the default instance id equals
  // the driver slug.
  const favoritesSet = useMemo(() => {
    return new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  }, [favorites]);

  /**
   * Lookup table keyed by `instanceId`. Used for display name + driver
   * kind enrichment and for `ready`/enabled filtering before flattening
   * models into the search list.
   */
  const entryByInstanceId = useMemo(
    () => new Map(instanceEntries.map((entry) => [entry.instanceId, entry])),
    [instanceEntries],
  );
  const matchesLockedProvider = useCallback(
    (entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">): boolean => {
      if (props.lockedProvider === null) return true;
      if (entry.driverKind !== props.lockedProvider) return false;
      if (!props.lockedContinuationGroupKey) return true;
      return entry.continuationGroupKey === props.lockedContinuationGroupKey;
    },
    [props.lockedContinuationGroupKey, props.lockedProvider],
  );

  const selectableUnavailableInstanceIds = useMemo(() => {
    const instanceIds = new Set<ProviderInstanceId>();
    if (activeInstanceHasSelectableUnavailableModel) {
      instanceIds.add(props.activeInstanceId);
    }
    if (props.onOpenProviderSetup) {
      for (const entry of instanceEntries) {
        if (
          shouldOfferModelPickerSetup(
            entry,
            modelOptionsByInstance.get(entry.instanceId) ?? [],
            props.quickSetup?.installable.has(entry.instanceId),
          )
        ) {
          instanceIds.add(entry.instanceId);
        }
      }
    }
    return instanceIds.size > 0 ? instanceIds : undefined;
  }, [
    activeInstanceHasSelectableUnavailableModel,
    instanceEntries,
    modelOptionsByInstance,
    props.activeInstanceId,
    props.onOpenProviderSetup,
    props.quickSetup,
  ]);

  // Flatten models into a searchable array. One pass over the
  // instance-keyed map; each model carries its instance id + driver kind
  // so the list row can render the right icon and display name without
  // another lookup.
  const flatModels = useMemo(() => {
    const out: ModelPickerItem[] = [];
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        // Instance disappeared between renders (configuration change). Skip
        // its models — stale options shouldn't appear in the picker.
        continue;
      }
      for (const model of models) {
        if (
          !shouldIncludeModelPickerOption({
            entry,
            option: model,
            activeInstanceId: props.activeInstanceId,
            activeModel: activeModelSlug,
          })
        ) {
          continue;
        }
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.badge ? { badge: model.badge } : {}),
          ...(model.isLegacy ? { isLegacy: true } : {}),
          ...(model.isUnavailable ? { isUnavailable: true } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.acpRegistryAgentId ? { acpRegistryAgentId: entry.acpRegistryAgentId } : {}),
          ...(entry.acpRegistryIconUrl ? { acpRegistryIconUrl: entry.acpRegistryIconUrl } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
        });
      }
    }
    return out;
  }, [modelOptionsByInstance, entryByInstanceId, props.activeInstanceId, activeModelSlug]);
  // Favorites: models starred one by one, plus every version of a starred family.
  const familyFavorites = useModelFamilyFavorites(modelOptionsByInstance);
  const { familySet: favoriteFamilies, isFamilyFavorite, notePicked } = familyFavorites;
  const favoriteKeys = useMemo(() => {
    if (favoriteFamilies.size === 0) return favoritesSet;
    const keys = new Set(favoritesSet);
    for (const m of flatModels)
      if (isFamilyFavorite(m)) keys.add(providerModelKey(m.instanceId, m.slug));
    return keys;
  }, [favoriteFamilies, favoritesSet, flatModels, isFamilyFavorite]);

  const isLocked = props.lockedProvider !== null;
  const isSearching = searching;
  const view = isSearching ? searchScope : selectedInstanceId;
  // Search and Favorites list each model once with its providers under it.
  const byModel = isSearching || selectedInstanceId === "favorites";
  const lockedDisabledInstanceIds = useMemo(() => {
    if (!isLocked) {
      return undefined;
    }
    const disabled = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (!matchesLockedProvider(entry)) {
        disabled.add(entry.instanceId);
      }
    }
    return disabled;
  }, [instanceEntries, isLocked, matchesLockedProvider]);
  const sidebarInstanceEntries = useMemo(() => {
    const enabledEntries = instanceEntries.filter(isProviderInstancePickerVisible);
    if (!isLocked) {
      return enabledEntries;
    }
    const available: ProviderInstanceEntry[] = [];
    const disabled: ProviderInstanceEntry[] = [];
    for (const entry of enabledEntries) {
      if (matchesLockedProvider(entry)) {
        available.push(entry);
      } else {
        disabled.push(entry);
      }
    }
    return [...available, ...disabled];
  }, [instanceEntries, isLocked, matchesLockedProvider]);
  const showChips = sidebarInstanceEntries.length > 0;
  // Wide enough for a 10rem provider column beside the models: it lists them top to bottom.
  const providersColumn = useMediaQuery({ min: 504 }) && showChips;
  const instanceOrder = useMemo(
    () => instanceEntries.map((entry) => entry.instanceId),
    [instanceEntries],
  );

  // A provider tab that can't run on this machine (not installed, not prepared,
  // signed out) has no models of its own; the list then offers ready ones.
  const alternativesFor = useMemo(() => {
    if (isSearching || selectedInstanceId === "favorites" || selectedInstanceId === "all") {
      return null;
    }
    const entry = entryByInstanceId.get(selectedInstanceId);
    if (!entry || (isProviderInstancePickerSelectable(entry) && entry.installed)) return null;
    const ownSelectable = flatModels.some(
      (model) => model.instanceId === selectedInstanceId && !model.isUnavailable,
    );
    return ownSelectable ? null : entry;
  }, [entryByInstanceId, flatModels, isSearching, selectedInstanceId]);

  // Every match across providers, so each provider can say how many of them it offers.
  const searchMatches = useMemo(
    () =>
      isSearching
        ? rankModelPickerSearch(flatModels, searchQuery, (model) =>
            favoriteKeys.has(providerModelKey(model.instanceId, model.slug)),
          ).filter((model) => props.lockedProvider === null || matchesLockedProvider(model))
        : null,
    [
      favoriteKeys,
      flatModels,
      isSearching,
      matchesLockedProvider,
      props.lockedProvider,
      searchQuery,
    ],
  );
  const searchCounts = useMemo(
    () => (searchMatches ? countModelSearchMatches(searchMatches, favoriteKeys) : undefined),
    [favoriteKeys, searchMatches],
  );
  // Filter models based on search query and selected instance
  const filteredModels = useMemo(() => {
    let result = flatModels;

    // Apply tokenized fuzzy search across the combined provider/model search fields.
    // When searching, we only respect locked provider (by driver kind), ignoring sidebar
    // selection so account-scoped searches can find a model before choosing an instance.
    if (searchMatches) {
      if (searchScope === "all") return searchMatches;
      return searchMatches.filter((model) =>
        searchScope === "favorites"
          ? favoriteKeys.has(providerModelKey(model.instanceId, model.slug))
          : model.instanceId === searchScope,
      );
    }

    if (props.lockedProvider !== null) {
      result = result.filter((m) => matchesLockedProvider(m));
    }
    if (selectedInstanceId === "favorites") {
      result = result.filter((m) => favoriteKeys.has(providerModelKey(m.instanceId, m.slug)));
    } else if (selectedInstanceId === "all") {
      // Every provider in its own group, in the configured order, favorites first in each.
      const rank = new Map(instanceOrder.map((id, index) => [id, index] as const));
      return sortProviderModelItems(result, {
        favoriteModelKeys: favoriteKeys,
        groupFavorites: true,
      }).toSorted(
        (a, b) => (rank.get(a.instanceId) ?? rank.size) - (rank.get(b.instanceId) ?? rank.size),
      );
    } else {
      result = result.filter((m) => m.instanceId === selectedInstanceId);
    }
    if (alternativesFor !== null) {
      // The chosen provider can't run here: offer what can, never an empty list.
      return sortProviderModelItems(
        flatModels.filter((m) => {
          const entry = entryByInstanceId.get(m.instanceId);
          return (
            entry !== undefined &&
            isProviderInstancePickerSelectable(entry) &&
            entry.installed &&
            !m.isUnavailable &&
            (props.lockedProvider === null || matchesLockedProvider(m))
          );
        }),
        { favoriteModelKeys: favoriteKeys, groupFavorites: true, instanceOrder },
      );
    }

    return sortProviderModelItems(result, {
      favoriteModelKeys: favoriteKeys,
      groupFavorites: selectedInstanceId !== "favorites",
      instanceOrder: selectedInstanceId === "favorites" ? instanceOrder : [],
    });
  }, [
    alternativesFor,
    entryByInstanceId,
    favoriteKeys,
    flatModels,
    instanceOrder,
    matchesLockedProvider,
    props.lockedProvider,
    searchMatches,
    searchScope,
    selectedInstanceId,
  ]);

  // The list in display order: each provider's current models, then its legacy section
  // (expanded in place). Search and Favorites keep their ranked order, without sections.
  const listLayout = useMemo(() => {
    const keyOf = (model: ModelPickerItem) => modelPickerModelKey(model.instanceId, model.slug);
    const legacy = new Map<
      string,
      {
        readonly instanceId: ProviderInstanceId;
        readonly count: number;
        readonly isExpanded: boolean;
      }
    >();
    if (byModel) {
      // Each model once, its providers best first: subscriptions here, Copilot, Cursor, rest.
      const layout = layoutModelSearchResults(
        filteredModels,
        instanceEntries,
        keyOf,
        expandedOlderFamilies,
      );
      return { ...layout, legacy };
    }
    const groups = new Map<ProviderInstanceId, ModelPickerItem[]>();
    for (const model of filteredModels) {
      const group = groups.get(model.instanceId);
      if (group) group.push(model);
      else groups.set(model.instanceId, [model]);
    }
    const visibleModels: ModelPickerItem[] = [];
    const keys: string[] = [];
    for (const [instanceId, models] of groups) {
      const current = models.filter((model) => !model.isLegacy);
      const old = models.filter((model) => model.isLegacy);
      visibleModels.push(...current);
      keys.push(...current.map(keyOf));
      if (old.length === 0) continue;
      const key = modelPickerLegacySectionKey(instanceId);
      const isExpanded = expandedLegacyInstances.has(instanceId);
      legacy.set(key, { instanceId, count: old.length, isExpanded });
      keys.push(key);
      if (isExpanded) {
        visibleModels.push(...old);
        keys.push(...old.map(keyOf));
      }
    }
    return { visibleModels, keys, legacy };
  }, [
    expandedLegacyInstances,
    expandedOlderFamilies,
    filteredModels,
    instanceEntries,
    isSearching,
    selectedInstanceId,
  ]);
  const searchHeaders: ReadonlyMap<string, ModelSearchHeader> =
    "headers" in listLayout ? listLayout.headers : EMPTY_SEARCH_HEADERS;
  const olderSections: ReadonlyMap<string, ModelSearchOlderSection> =
    "older" in listLayout ? listLayout.older : EMPTY_OLDER_SECTIONS;
  const visibleModels = listLayout.visibleModels;
  const filteredItemKeys = listLayout.keys;
  useRevealOlderVersions(modelListRef, filteredItemKeys, searchHeaders, expandedOlderFamilies);
  // Lists that mix providers show a header over each provider's first row.
  const grouped = !byModel && (selectedInstanceId === "all" || alternativesFor !== null);
  const groupStarts = useMemo(
    () => (grouped ? modelPickerGroupStarts(filteredItemKeys) : EMPTY_GROUP_STARTS),
    [filteredItemKeys, grouped],
  );
  const inProviderView =
    !isSearching && selectedInstanceId !== "favorites" && selectedInstanceId !== "all";

  const selectedEntry =
    selectedInstanceId === "favorites" || selectedInstanceId === "all"
      ? undefined
      : entryByInstanceId.get(selectedInstanceId);
  const providerSetupEntries =
    !isSearching && props.onOpenProviderSetup
      ? instanceEntries.filter(
          (entry) =>
            matchesLockedProvider(entry) &&
            shouldOfferModelPickerSetup(
              entry,
              modelOptionsByInstance.get(entry.instanceId) ?? [],
              props.quickSetup?.installable.has(entry.instanceId),
            ) &&
            (selectedEntry
              ? entry.instanceId === selectedEntry.instanceId
              : filteredModels.length === 0),
        )
      : [];

  const elsewhereSetup = props.quickSetup;
  const showElsewhere =
    elsewhereSetup !== undefined && !isSearching && props.lockedProvider === null;
  // A turned-on provider keeps its row while it runs, failed, or is on here;
  // one turned off again goes back to "On your other machines" only.
  const turnedOnProviders = showElsewhere
    ? (elsewhereSetup.turnedOn ?? []).filter(
        ({ provider, instanceId }) =>
          elsewhereSetup.pending.has(provider.identity) ||
          elsewhereSetup.errors.has(provider.identity) ||
          entryByInstanceId.get(instanceId)?.enabled === true,
      )
    : [];
  const otherMachineProviders = showElsewhere
    ? elsewhereSetup.elsewhere.filter(
        (provider) =>
          !turnedOnProviders.some((item) => item.provider.identity === provider.identity),
      )
    : [];

  const toggleLegacySection = useCallback((instanceId: ProviderInstanceId) => {
    setExpandedLegacyInstances((expanded) => {
      const next = new Set(expanded);
      if (next.has(instanceId)) {
        next.delete(instanceId);
      } else {
        next.add(instanceId);
      }
      return next;
    });
  }, []);

  /** Opens or closes a legacy or older-versions section; false when the key is a model. */
  const toggleSection = useCallback(
    (key: string): boolean => {
      const legacyInstanceId = parseModelPickerLegacySectionKey(key);
      if (legacyInstanceId) toggleLegacySection(legacyInstanceId);
      const family = parseModelPickerOlderVersionsKey(key);
      if (family !== null) toggleOlderFamily(family);
      return legacyInstanceId !== null || family !== null;
    },
    [toggleLegacySection, toggleOlderFamily],
  );

  const handleModelSelect = useCallback(
    (modelSlug: string, instanceId: ProviderInstanceId, additive = false) => {
      if (getModelDisabledReason?.(instanceId, modelSlug)) {
        return;
      }
      const options = modelOptionsByInstance.get(instanceId);
      if (!options || options.some((option) => option.slug === modelSlug && option.isUnavailable)) {
        return;
      }
      const entry = entryByInstanceId.get(instanceId);
      if (!entry || !isProviderInstancePickerSelectable(entry)) {
        return;
      }
      // `resolveSelectableModel` uses the driver kind for normalization
      // (slug casing etc.). Custom instances share their driver's
      // normalization rules, so pass the driver kind here.
      const resolvedModel = resolveSelectableModel(
        entry.driverKind,
        modelSlug,
        options.filter((option) => !option.isUnavailable),
      );
      if (resolvedModel) {
        if (additive && onToggleModel) {
          onToggleModel(instanceId, resolvedModel);
        } else {
          notePicked(instanceId, resolvedModel);
          onInstanceModelChange(instanceId, resolvedModel);
        }
      }
    },
    [
      notePicked,
      entryByInstanceId,
      getModelDisabledReason,
      modelOptionsByInstance,
      onInstanceModelChange,
      onToggleModel,
    ],
  );

  const toggleFavorite = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const newFavorites = [...favorites];
      const index = newFavorites.findIndex((f) => f.provider === instanceId && f.model === model);
      const option = modelOptionsByInstance.get(instanceId)?.find((o) => o.slug === model);
      if (index < 0 && option && isFamilyFavorite(option)) {
        // A row listed through its starred family: its filled star unstars the family.
        familyFavorites.toggleFamily(modelSearchIdentity(option).family);
        return;
      }
      if (index >= 0) {
        newFavorites.splice(index, 1);
      } else {
        newFavorites.push({ provider: instanceId, model });
      }
      updateSettings({ favorites: newFavorites });
    },
    [familyFavorites, favorites, isFamilyFavorite, modelOptionsByInstance, updateSettings],
  );

  const modelJumpCommandByKey = useMemo(() => {
    const mapping = new Map<
      string,
      NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>
    >();
    let selectableModelIndex = 0;
    for (const model of visibleModels) {
      if (model.isUnavailable || getModelDisabledReason?.(model.instanceId, model.slug)) {
        continue;
      }
      const jumpCommand = modelPickerJumpCommandForIndex(selectableModelIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(modelPickerModelKey(model.instanceId, model.slug), jumpCommand);
      selectableModelIndex += 1;
    }
    return mapping;
  }, [getModelDisabledReason, visibleModels]);
  const modelJumpModelKeys = useMemo(
    () => [...modelJumpCommandByKey.keys()],
    [modelJumpCommandByKey],
  );
  const allItemKeys = useMemo(
    (): string[] => [
      ...flatModels.map((model) => modelPickerModelKey(model.instanceId, model.slug)),
      ...new Set(
        flatModels
          .filter((model) => model.isLegacy)
          .map((model) => modelPickerLegacySectionKey(model.instanceId)),
      ),
      ...olderSections.keys(),
    ],
    [flatModels, olderSections],
  );
  const filteredModelByKey = useMemo(
    (): ReadonlyMap<string, ModelPickerItem> =>
      new Map(
        visibleModels.map(
          (model) => [modelPickerModelKey(model.instanceId, model.slug), model] as const,
        ),
      ),
    [visibleModels],
  );
  const [modelListContentSize, setModelListContentSize] = useState(
    () => filteredItemKeys.length * MODEL_LIST_ESTIMATED_ITEM_SIZE,
  );
  const [searchHeight, setSearchHeight] = useState(0);
  useLayoutEffect(
    () => modelListRef.current?.getState().listen("totalSize", setModelListContentSize),
    [],
  );
  // Fit the list to its rows plus the combobox list `py-1` and LegendList `py-1.5`.
  const modelListHeight =
    filteredItemKeys.length === 0 ? 0 : `calc(${modelListContentSize}px + var(--spacing) * 5)`;
  const updateModelListScrollFades = useCallback(() => {
    const scrollElement = modelListRef.current?.getScrollableNode();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  }, []);
  const modelJumpShortcutContext = useMemo(
    () =>
      ({
        terminalFocus: false,
        terminalOpen: props.terminalOpen,
        modelPickerOpen: true,
      }) as const,
    [props.terminalOpen],
  );
  const modelJumpLabelByKey = useMemo((): ReadonlyMap<string, string> => {
    if (modelJumpCommandByKey.size === 0) {
      return EMPTY_MODEL_JUMP_LABELS;
    }
    const shortcutLabelOptions = {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    };
    const mapping = new Map<string, string>();
    for (const [modelKey, command] of modelJumpCommandByKey) {
      const label = shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
      if (label) {
        mapping.set(modelKey, label);
      }
    }
    return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
  }, [keybindings, modelJumpCommandByKey, modelJumpShortcutContext]);
  // Each model's part in the fallback, so the list says which runs now, which is the
  // pick and where the rest sit in the order, not only which are starred.
  const stateChain = props.stateHeader?.chain;
  const fallbackRoleByKey = useMemo(() => {
    const roles = new Map<
      string,
      { readonly label: string; readonly tone: "now" | "pick" | "order" }
    >();
    for (const entry of stateChain ?? []) {
      // `claude-opus-5-5[1m]` runs the row `claude-opus-5-5`: the bracket names a variant.
      roles.set(
        fallbackRoleKey(entry.instanceId, entry.model),
        entry.role === "now"
          ? {
              label: entry.position === null ? "Now" : `Now · fallback ${entry.position}`,
              tone: "now",
            }
          : entry.role === "pick"
            ? { label: "Your pick", tone: "pick" }
            : { label: `Fallback ${entry.position}`, tone: "order" },
      );
    }
    return roles;
  }, [stateChain]);
  // The strip sets the picked model's effort, so it shows only for one picked model.
  const effort = !onToggleModel && activeModelSlug ? (props.effort ?? null) : null;
  const activeEffortOption = effort?.options.find((option) => option.id === effort.value) ?? null;
  // Rows render from the list's closure: anything they show must be in its extra data.
  const modelListExtraData = useMemo(
    () => ({
      favoriteKeys,
      favoriteFamilies,
      modelJumpLabelByKey,
      activeModelKey,
      selectedModelKeySet,
      fallbackRoleByKey,
      groupStarts,
      legacy: listLayout.legacy,
      searchHeaders,
      olderSections,
      activeEffortOption,
      usage,
    }),
    [
      favoriteKeys,
      favoriteFamilies,
      modelJumpLabelByKey,
      activeModelKey,
      selectedModelKeySet,
      fallbackRoleByKey,
      groupStarts,
      listLayout.legacy,
      searchHeaders,
      olderSections,
      activeEffortOption,
      usage,
    ],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) {
        return;
      }
      // Cmd+K inside the picker brings focus back to the search, as from a provider chip.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k" &&
        event.target instanceof Node &&
        pickerContentRef.current?.contains(event.target)
      ) {
        event.preventDefault();
        event.stopPropagation();
        focusSearchInput();
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: modelJumpShortcutContext,
      });
      if (command === "modelPicker.previousProvider" || command === "modelPicker.nextProvider") {
        event.preventDefault();
        event.stopPropagation();
        handleSelectInstance(
          adjacentModelPickerProvider({
            entries: sidebarInstanceEntries,
            selectedInstanceId: view,
            direction: command === "modelPicker.nextProvider" ? 1 : -1,
            disabledInstanceIds: lockedDisabledInstanceIds,
            selectableUnavailableInstanceIds,
          }),
        );
        return;
      }
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const targetModelKey = modelJumpModelKeys[jumpIndex];
      if (!targetModelKey) {
        return;
      }
      const model = parseModelPickerModelKey(targetModelKey);
      if (!model) {
        return;
      }
      handleModelSelect(model.slug, model.instanceId);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [
    focusSearchInput,
    handleModelSelect,
    handleSelectInstance,
    keybindings,
    lockedDisabledInstanceIds,
    modelJumpModelKeys,
    modelJumpShortcutContext,
    selectableUnavailableInstanceIds,
    sidebarInstanceEntries,
    view,
  ]);

  useLayoutEffect(() => {
    setShowTopScrollFade(false);
    setShowBottomScrollFade(filteredItemKeys.length > 5);
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      updateModelListScrollFades();
      nestedFrame = window.requestAnimationFrame(updateModelListScrollFades);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
  }, [filteredItemKeys, updateModelListScrollFades]);

  const instanceUsageMark = useCallback(
    (entry: ProviderInstanceEntry) => {
      if (!usage) return null;
      // Account-wide windows only: a spent Fable weekly never marks all of Claude.
      const state = usage.availability(entry.instanceId, null);
      const sentence = () =>
        railLimitSentence(state, {
          nowMs: usage.nowMs,
          label: usage.text(entry.instanceId, state).label,
        });
      if (isAvailabilityBlocking(state)) return { tone: "full" as const, text: sentence() };
      if (state.kind === "exhausted") return { tone: "warn" as const, text: sentence() };
      if (state.kind === "room" && state.tone !== "ok") {
        return { tone: "warn" as const, text: sentence() };
      }
      return null;
    },
    [usage],
  );

  const running = usage?.running ?? null;
  const runningEntry = running ? entryByInstanceId.get(running.instanceId) : undefined;
  const runningOption = running
    ? modelOptionsByInstance
        .get(running.instanceId)
        ?.find((option) => option.slug === running.model)
    : undefined;
  // No band over a mixed list: the account line names the limits of the providers
  // whose rows show, the displayed model's provider first.
  const accountLineMarked = usage?.running?.instanceId ?? props.activeInstanceId;
  const accountLineEntries = useMemo(() => {
    const ids = new Set<ProviderInstanceId>();
    for (const model of filteredModelByKey.values()) ids.add(model.instanceId);
    return [...ids]
      .toSorted(
        (left, right) => Number(right === accountLineMarked) - Number(left === accountLineMarked),
      )
      .flatMap((id) => {
        const entry = entryByInstanceId.get(id);
        return entry ? [entry] : [];
      });
  }, [accountLineMarked, entryByInstanceId, filteredModelByKey]);
  // The fallback status names the running model already; the note stays only to say a
  // different pick waits for the next message.
  const pickedDiffers =
    running !== null &&
    (running.instanceId !== props.activeInstanceId || running.model !== activeModelSlug);
  const activeEntryForNote = entryByInstanceId.get(props.activeInstanceId);
  const activeOption = modelOptionsByInstance
    .get(props.activeInstanceId)
    ?.find((option) => option.slug === activeModelSlug);
  const runningNote =
    running && !onToggleModel && (!props.stateHeader || pickedDiffers) ? (
      <ModelPickerRunningNote
        runningLabel={`${runningOption ? getTriggerDisplayModelName(runningOption) : running.model}${
          runningEntry ? ` (${runningEntry.displayName})` : ""
        }`}
        pickLabel={
          pickedDiffers
            ? `${activeOption ? getTriggerDisplayModelName(activeOption) : activeModelSlug}${
                activeEntryForNote ? ` (${activeEntryForNote.displayName})` : ""
              }`
            : null
        }
      />
    ) : null;

  const switchView = (direction: 1 | -1) => {
    handleSelectInstance(
      adjacentModelPickerProvider({
        entries: sidebarInstanceEntries,
        selectedInstanceId: view,
        direction,
        disabledInstanceIds: lockedDisabledInstanceIds,
        selectableUnavailableInstanceIds,
      }),
    );
  };

  return (
    <TooltipProvider delay={0}>
      <div
        ref={pickerContentRef}
        className={cn(
          "relative flex w-screen max-w-[min(34rem,calc(100vw-1.5rem))] flex-col overflow-hidden",
          // The usage band takes room from the list, not from the models; a fallback
          // status takes more, so the picker grows rather than hiding the list. It
          // never outgrows the room beside the trigger, so the list scrolls, not the popup.
          props.stateHeader
            ? "max-h-[min(44rem,85dvh,var(--available-height,100dvh))]"
            : usage
              ? "max-h-[min(34rem,80dvh,var(--available-height,100dvh))]"
              : "max-h-[min(26rem,70dvh,var(--available-height,100dvh))]",
        )}
        // Hold the height from when the search started; results scroll instead of resizing.
        style={isSearching ? { height: searchHeight } : undefined}
        data-model-picker-content="true"
        data-sws-picker=""
      >
        <Combobox<string, boolean>
          inline
          items={allItemKeys}
          filteredItems={filteredItemKeys}
          filter={null}
          autoHighlight
          open
          virtualized
          multiple={onToggleModel !== undefined}
          value={onToggleModel ? [...selectedModelKeySet] : activeModelKey}
          onItemHighlighted={(modelKey, eventDetails) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
            if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
              void modelListRef.current?.scrollIndexIntoView?.({
                index: eventDetails.index,
                animated: false,
              });
            }
          }}
          onValueChange={(value, details) => {
            const modelKey = Array.isArray(value)
              ? (value.find((key) => !selectedModelKeySet.has(key)) ??
                [...selectedModelKeySet].find((key) => !value.includes(key)))
              : value;
            if (typeof modelKey !== "string") {
              return;
            }
            if (toggleSection(modelKey)) return;
            const model = parseModelPickerModelKey(modelKey);
            if (model) {
              handleModelSelect(
                model.slug,
                model.instanceId,
                "shiftKey" in details.event && details.event.shiftKey === true,
              );
            }
          }}
        >
          {/* Scrolls as a whole only when the room beside the trigger is shorter
              than the bands plus the list's four-row minimum. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
            {props.stateHeader ? <FallbackStatusCard header={props.stateHeader} /> : null}
            <div className="sws-picker-search shrink-0 px-2 pt-2 pb-1.5">
              <ComboboxSearchInput
                ref={searchInputRef}
                placeholder="Search models or providers"
                value={searchQuery}
                onChange={(e) => {
                  if (!isSearching) setSearchHeight(pickerContentRef.current?.offsetHeight ?? 0);
                  if (!isSearching) setSearchScope("all");
                  setSearchQuery(e.target.value);
                }}
                onKeyDown={(e) => {
                  const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
                  if (showChips && plain && e.key === "Tab" && e.shiftKey) {
                    const chips = e.currentTarget
                      .closest("[data-model-picker-content]")
                      ?.querySelector("[data-model-picker-chips]");
                    const button =
                      chips?.querySelector<HTMLButtonElement>(
                        'button[aria-pressed="true"]:not(:disabled)',
                      ) ?? chips?.querySelector<HTMLButtonElement>("button:not(:disabled)");
                    if (button) {
                      e.preventDefault();
                      e.stopPropagation();
                      button.focus();
                      return;
                    }
                  }
                  // Cmd+Up and Cmd+Down step through the provider chips.
                  if (
                    showChips &&
                    (e.metaKey || e.ctrlKey) &&
                    !e.altKey &&
                    !e.shiftKey &&
                    (e.key === "ArrowUp" || e.key === "ArrowDown")
                  ) {
                    e.preventDefault();
                    e.stopPropagation();
                    switchView(e.key === "ArrowDown" ? 1 : -1);
                    return;
                  }
                  // In an empty search, Left and Right move the picked model's effort.
                  if (
                    effort &&
                    plain &&
                    !e.shiftKey &&
                    searchQuery.length === 0 &&
                    (e.key === "ArrowLeft" || e.key === "ArrowRight")
                  ) {
                    const next = adjacentEffort(effort, e.key === "ArrowRight" ? 1 : -1);
                    e.preventDefault();
                    e.stopPropagation();
                    if (next) effort.select(next);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    props.onRequestClose?.();
                    return;
                  }
                  if (e.key === "Enter" && highlightedModelKeyRef.current) {
                    (
                      e as typeof e & { preventBaseUIHandler?: () => void }
                    ).preventBaseUIHandler?.();
                    e.preventDefault();
                    e.stopPropagation();
                    const key = highlightedModelKeyRef.current;
                    // Enter on a model's heading picks its best provider; a click opens older versions.
                    const older = parseModelPickerOlderVersionsKey(key) !== null;
                    if (!older && toggleSection(key)) return;
                    const model = parseModelPickerModelKey(
                      older ? (filteredItemKeys[filteredItemKeys.indexOf(key) + 1] ?? "") : key,
                    );
                    if (model) {
                      handleModelSelect(model.slug, model.instanceId, e.shiftKey);
                    }
                    return;
                  }
                  e.stopPropagation();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
              />
            </div>
            <div className={cn("flex min-h-0 flex-1", providersColumn ? "flex-row" : "flex-col")}>
              {showChips ? (
                <ModelPickerProviderChips
                  layout={providersColumn ? "column" : "wrap"}
                  selected={view}
                  onSelect={handleSelectInstance}
                  {...(searchCounts ? { counts: searchCounts } : {})}
                  onFocusSearch={focusSearchInput}
                  instanceEntries={sidebarInstanceEntries}
                  {...(selectableUnavailableInstanceIds
                    ? { selectableUnavailableInstanceIds }
                    : {})}
                  {...(usage ? { getInstanceUsage: instanceUsageMark } : {})}
                  {...(lockedDisabledInstanceIds
                    ? {
                        disabledInstanceIds: lockedDisabledInstanceIds,
                        getDisabledInstanceTooltip: (entry: ProviderInstanceEntry) =>
                          `${entry.displayName} is unavailable in this thread. Start a new thread to switch providers.`,
                      }
                    : {})}
                />
              ) : null}
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {selectedEntry && !isSearching && alternativesFor === null ? (
                  <HarnessDescription entry={selectedEntry} />
                ) : null}
                {usage && selectedEntry && !isSearching && alternativesFor === null ? (
                  <ModelPickerUsageBand entry={selectedEntry} usage={usage} />
                ) : usage ? (
                  <ModelPickerAccountLine
                    entries={accountLineEntries}
                    usage={usage}
                    markedInstanceId={onToggleModel ? null : accountLineMarked}
                  />
                ) : null}

                {alternativesFor !== null ? (
                  <ModelPickerAlternativesNote
                    entry={alternativesFor}
                    hasReady={filteredModels.length > 0}
                  />
                ) : null}

                {/* Model list */}
                <div
                  className="relative min-h-0 overflow-hidden pr-px"
                  style={{
                    height: modelListHeight,
                    // At least four rows stay in view however much the bands above take;
                    // the fallback status scrolls inside its own band instead.
                    ...(filteredItemKeys.length > 0
                      ? {
                          minHeight: `min(${modelListContentSize}px + var(--spacing) * 5, ${
                            MODEL_LIST_MIN_VISIBLE_ROWS * MODEL_LIST_ESTIMATED_ITEM_SIZE
                          }px + var(--spacing) * 5)`,
                        }
                      : {}),
                  }}
                >
                  <ComboboxListVirtualized>
                    <LegendList<string>
                      ref={modelListRef}
                      data={filteredItemKeys}
                      extraData={modelListExtraData}
                      keyExtractor={(modelKey) => modelKey}
                      renderItem={({ item: modelKey, index }) => {
                        const groupInstanceId = groupStarts.get(modelKey);
                        const groupEntry = groupInstanceId
                          ? entryByInstanceId.get(groupInstanceId)
                          : undefined;
                        const header = groupEntry ? (
                          <ProviderGroupHeader entry={groupEntry} usage={usage} />
                        ) : null;
                        const olderSection = olderSections.get(modelKey);
                        if (olderSection) {
                          return (
                            <ModelSearchOlderRow
                              index={index}
                              value={modelKey}
                              section={olderSection}
                              familyStar={familyFavorites}
                            />
                          );
                        }
                        const searchHeader = searchHeaders.get(modelKey);
                        const legacySection = listLayout.legacy.get(modelKey);
                        if (legacySection) {
                          return (
                            <>
                              {header}
                              <ComboboxItem
                                hideIndicator
                                index={index}
                                value={modelKey}
                                aria-expanded={legacySection.isExpanded}
                                className="group w-full cursor-pointer"
                              >
                                <div className="min-w-0 flex-1 text-left">
                                  <div className="text-sm leading-snug">Legacy models</div>
                                  <div className="mt-0.5 text-xs font-normal leading-snug text-muted-foreground">
                                    {legacySection.count} models
                                  </div>
                                </div>
                                <ChevronRightIcon
                                  className={cn(
                                    "size-4 transition-transform",
                                    legacySection.isExpanded && "rotate-90",
                                  )}
                                />
                              </ComboboxItem>
                            </>
                          );
                        }
                        const model = filteredModelByKey.get(modelKey);
                        if (!model) {
                          return null;
                        }
                        const usageState = usage?.availability(model.instanceId, model.slug);
                        const disabledReason = model.isUnavailable
                          ? "This model is unavailable on this account."
                          : (getModelDisabledReason?.(model.instanceId, model.slug) ?? null);
                        const runtimeModel = entryByInstanceId
                          .get(model.instanceId)
                          ?.models.find((item) => item.slug === model.slug);
                        const isActiveRow = modelKey === activeModelKey;
                        return (
                          <>
                            {header}
                            {searchHeader ? (
                              <ModelSearchGroupHeader
                                header={searchHeader}
                                familyStar={familyFavorites}
                              />
                            ) : null}
                            <ModelListRow
                              key={modelKey}
                              index={index}
                              model={model}
                              runtimeModel={runtimeModel}
                              instanceId={model.instanceId}
                              driverKind={model.driverKind}
                              providerDisplayName={model.instanceDisplayName}
                              providerAccentColor={model.instanceAccentColor}
                              acpRegistryAgentId={model.acpRegistryAgentId}
                              acpRegistryIconUrl={model.acpRegistryIconUrl}
                              isFavorite={favoriteKeys.has(
                                providerModelKey(model.instanceId, model.slug),
                              )}
                              isSelected={
                                selectedModelKeys !== undefined
                                  ? selectedModelKeySet.has(modelKey)
                                  : isActiveRow
                              }
                              showSelection={selectedModelKeys !== undefined}
                              showProvider
                              providerInHeader={grouped}
                              providerAsTitle={
                                byModel
                                  ? {
                                      plan: modelSearchProviderPlan(
                                        entryByInstanceId.get(model.instanceId),
                                      ),
                                    }
                                  : undefined
                              }
                              effort={
                                isActiveRow && activeEffortOption
                                  ? activeEffortOption
                                  : defaultModelEffort(runtimeModel)
                              }
                              preferShortName={!isLocked}
                              useTriggerLabel={false}
                              showNewBadge={model.badge === "new"}
                              unavailable={model.isUnavailable === true}
                              jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                              disabledReason={disabledReason}
                              warningReason={
                                usage?.warningReason(model.instanceId, model.slug) ?? null
                              }
                              availability={
                                usage &&
                                usageState &&
                                rowShowsAvailability(usageState, inProviderView)
                                  ? usage.text(model.instanceId, rowAvailability(usageState))
                                  : null
                              }
                              fallbackRole={
                                fallbackRoleByKey.get(
                                  fallbackRoleKey(model.instanceId, model.slug),
                                ) ?? null
                              }
                              onToggleFavorite={() => toggleFavorite(model.instanceId, model.slug)}
                            />
                          </>
                        );
                      }}
                      estimatedItemSize={MODEL_LIST_ESTIMATED_ITEM_SIZE}
                      drawDistance={480}
                      recycleItems
                      contentContainerClassName="px-1.5"
                      ItemSeparatorComponent={ModelListSeparator}
                      onLayout={updateModelListScrollFades}
                      onScroll={updateModelListScrollFades}
                      className={cn(
                        "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
                        getVirtualizedScrollFadeClassName({
                          top: showTopScrollFade,
                          bottom: showBottomScrollFade,
                        }),
                      )}
                    />
                  </ComboboxListVirtualized>
                </div>
              </div>
            </div>
            <ModelPickerSetupFooter
              providerSetupEntries={providerSetupEntries}
              quickSetup={elsewhereSetup}
              turnedOnProviders={turnedOnProviders}
              otherMachineProviders={otherMachineProviders}
              entryByInstanceId={entryByInstanceId}
              onRequestClose={props.onRequestClose}
              onOpenProviderSetup={props.onOpenProviderSetup}
            />
            {runningNote}
            {effort ? (
              <ModelPickerEffortStrip
                effort={effort}
                modelLabel={
                  activeOption ? getTriggerDisplayModelName(activeOption) : activeModelSlug
                }
              />
            ) : null}
            <ModelPickerActions
              onRequestClose={props.onRequestClose}
              onManageProviders={props.onManageProviders}
              secondaryAction={props.secondaryAction}
              onEditFallbackOrder={props.onEditFallbackOrder}
              hints={<ModelPickerKeyHints effort={effort !== null} />}
            />
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
