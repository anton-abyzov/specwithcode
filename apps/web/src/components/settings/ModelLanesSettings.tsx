import {
  MAX_LANE_MODELS,
  type LearnedModelPreference,
  type ModelLane,
  type ModelLanes,
  type ModelSelection,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import {
  describePreference,
  laneEntryLabel,
  laneEntryUnavailable,
  LANE_LABELS,
} from "@specweave-studio/shared/modelLanes";
import { ArrowDownIcon, ArrowUpIcon, SparklesIcon, Trash2Icon, XIcon } from "lucide-react";
import { useMemo } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function addLaneModel(
  list: ReadonlyArray<ModelSelection>,
  instanceId: ModelSelection["instanceId"],
  model: string,
): ReadonlyArray<ModelSelection> {
  if (list.length >= MAX_LANE_MODELS) return list;
  if (list.some((entry) => entry.instanceId === instanceId && entry.model === model)) return list;
  return [...list, createModelSelection(instanceId, model)];
}

export function moveLaneModel(
  list: ReadonlyArray<ModelSelection>,
  index: number,
  by: -1 | 1,
): ReadonlyArray<ModelSelection> {
  const to = index + by;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

function LaneList(props: {
  readonly lane: ModelLane;
  readonly models: ReadonlyArray<ModelSelection>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onChange: (models: ReadonlyArray<ModelSelection>) => void;
}) {
  const { lane, models, providers, onChange } = props;
  if (models.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic">
        No models configured for this lane. Workers keep their baseline model.
      </div>
    );
  }
  return (
    <ol className="flex flex-col gap-1" aria-label={`${LANE_LABELS[lane]} lane order`}>
      {models.map((entry, index) => {
        const label = laneEntryLabel(providers, entry);
        const provider = providers.find((p) => p.instanceId === entry.instanceId);
        const unavailable =
          provider === undefined
            ? "not on this machine"
            : !provider.models.some((m) => m.slug === entry.model)
              ? "model not offered"
              : null;
        return (
          <li
            key={`${entry.instanceId}:${entry.model}`}
            className="flex items-center gap-2 rounded-md border border-border/70 px-2 py-1 text-sm"
          >
            <span className="w-4 text-right text-xs text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate" title={label}>
              {label}
              {unavailable ? (
                <span className="ml-2 text-xs text-muted-foreground">({unavailable})</span>
              ) : null}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${label} up`}
              disabled={index === 0}
              onClick={() => onChange(moveLaneModel(models, index, -1))}
            >
              <ArrowUpIcon className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${label} down`}
              disabled={index === models.length - 1}
              onClick={() => onChange(moveLaneModel(models, index, 1))}
            >
              <ArrowDownIcon className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove ${label}`}
              onClick={() => onChange(models.filter((_, at) => at !== index))}
            >
              <XIcon className="size-3" />
            </Button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Model lanes: ordered lists for Complex/Creative and Routine work, plus
 * learned preferences per project. Replaces simple favorites as the primary
 * fallback and default routing lists.
 */
export function ModelLanesSettings() {
  const { scope, target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environments } = useEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers = representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );

  const lanes: ModelLanes = settings.modelLanes ?? { complex: [], routine: [] };
  const complexList = lanes.complex ?? [];
  const routineList = lanes.routine ?? [];
  const learnedList: ReadonlyArray<LearnedModelPreference> =
    settings.learnedModelPreferences ?? [];

  const mixedLanes = useScopedSettingsMixed(["modelLanes"]);
  const mixedLearned = useScopedSettingsMixed(["learnedModelPreferences"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  const pickerSelection = resolveDefaultProviderModelSelection(
    providers,
    complexList[0] ?? routineList[0] ?? null,
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    pickerSelection?.instanceId,
    pickerSelection?.model,
  );

  const favorites = settings.favorites ?? [];
  const canSeedFavorites = useMemo(() => favorites.length > 0, [favorites]);

  const saveLane = (lane: ModelLane, models: ReadonlyArray<ModelSelection>) => {
    updateSettings({
      modelLanes: {
        ...lanes,
        [lane]: [...models],
      },
    });
  };

  const seedFavoritesIntoLane = (lane: ModelLane) => {
    const current = lanes[lane] ?? [];
    const existing = new Set(current.map((s) => `${s.instanceId}:${s.model}`));
    const additions: ModelSelection[] = [];
    for (const fav of favorites) {
      const key = `${fav.provider}:${fav.model}`;
      if (!existing.has(key) && current.length + additions.length < MAX_LANE_MODELS) {
        additions.push(createModelSelection(fav.provider, fav.model));
        existing.add(key);
      }
    }
    if (additions.length > 0) {
      saveLane(lane, [...current, ...additions]);
    }
  };

  const deleteLearnedRule = (id: string) => {
    updateSettings({
      learnedModelPreferences: learnedList.filter((rule) => rule.id !== id),
    });
  };

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["modelLanes"]}
        mixed={mixedLanes}
        id="model-lanes-complex"
        title="Complex and creative lane"
        description={
          isProjectScope
            ? "Frontier models for architecture, design, deep debugging and open-ended creative tasks in this project. The coordinator starts on the first available model."
            : "Frontier models for architecture, design, deep debugging and open-ended creative tasks. The coordinator starts on the first available model. Projects can override it."
        }
        resetAction={
          complexList.length > 0 ? (
            <SettingResetButton
              label="complex lane"
              onClick={() => saveLane("complex", [])}
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            {canSeedFavorites && complexList.length < MAX_LANE_MODELS ? (
              <Button
                size="xs"
                variant="outline"
                className="gap-1.5"
                onClick={() => seedFavoritesIntoLane("complex")}
              >
                <SparklesIcon className="size-3" />
                Seed from favorites
              </Button>
            ) : null}
            {pickerSelection ? (
              <ProviderModelPicker
                activeInstanceId={pickerSelection.instanceId}
                model={pickerSelection.model}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={modelOptions}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerLabel={mixedLanes ? "Mixed" : "Add model"}
                triggerAriaLabel="Add model to complex lane"
                disabled={complexList.length >= MAX_LANE_MODELS}
                onInstanceModelChange={(instanceId, model) =>
                  saveLane("complex", addLaneModel(complexList, instanceId, model))
                }
              />
            ) : null}
          </div>
        }
      >
        <LaneList
          lane="complex"
          models={complexList}
          providers={providers}
          onChange={(models) => saveLane("complex", models)}
        />
      </SettingsRow>

      <SettingsRow
        serverScoped
        settingKeys={["modelLanes"]}
        mixed={mixedLanes}
        id="model-lanes-routine"
        title="Routine lane"
        description={
          isProjectScope
            ? "Default models for regular and well-specified tasks in this project (e.g. Claude Opus 5.5). When a provider is exhausted or limited, advances to the next available model."
            : "Default models for regular and well-specified tasks (e.g. Claude Opus 5.5). When a provider is exhausted or limited, advances to the next available model. Projects can override it."
        }
        resetAction={
          routineList.length > 0 ? (
            <SettingResetButton
              label="routine lane"
              onClick={() => saveLane("routine", [])}
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            {canSeedFavorites && routineList.length < MAX_LANE_MODELS ? (
              <Button
                size="xs"
                variant="outline"
                className="gap-1.5"
                onClick={() => seedFavoritesIntoLane("routine")}
              >
                <SparklesIcon className="size-3" />
                Seed from favorites
              </Button>
            ) : null}
            {pickerSelection ? (
              <ProviderModelPicker
                activeInstanceId={pickerSelection.instanceId}
                model={pickerSelection.model}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={modelOptions}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerLabel={mixedLanes ? "Mixed" : "Add model"}
                triggerAriaLabel="Add model to routine lane"
                disabled={routineList.length >= MAX_LANE_MODELS}
                onInstanceModelChange={(instanceId, model) =>
                  saveLane("routine", addLaneModel(routineList, instanceId, model))
                }
              />
            ) : null}
          </div>
        }
      >
        <LaneList
          lane="routine"
          models={routineList}
          providers={providers}
          onChange={(models) => saveLane("routine", models)}
        />
      </SettingsRow>

      <SettingsRow
        serverScoped
        settingKeys={["learnedModelPreferences"]}
        mixed={mixedLearned}
        id="learned-model-preferences"
        title="Learned model preferences"
        description={
          isProjectScope
            ? "Rules learned from your feedback in this project, or recorded by the coordinator. Matching prefer rules are tried first; avoid rules are skipped."
            : "Rules learned from your feedback, or recorded by the coordinator. Matching prefer rules are tried first; avoid rules are skipped."
        }
        resetAction={
          learnedList.length > 0 ? (
            <SettingResetButton
              label="learned preferences"
              onClick={() => updateSettings({ learnedModelPreferences: [] })}
            />
          ) : null
        }
      >
        {learnedList.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">
            No learned model preferences yet. Rules are learned when you give feedback in chat, or can be recorded by the coordinator.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5" aria-label="Learned model preferences">
            {learnedList.map((pref) => {
              const text = describePreference(pref, providers);
              return (
                <li
                  key={pref.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm"
                  data-preference-id={pref.id}
                >
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium truncate">{text}</span>
                    {pref.note ? (
                      <span className="text-xs text-muted-foreground truncate">
                        Feedback: &ldquo;{pref.note}&rdquo;
                      </span>
                    ) : null}
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Delete preference ${pref.id}`}
                    onClick={() => deleteLearnedRule(pref.id)}
                  >
                    <Trash2Icon className="size-3.5 text-muted-foreground hover:text-destructive-foreground" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsRow>
    </>
  );
}
