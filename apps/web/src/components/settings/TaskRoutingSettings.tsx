import {
  TASK_CLASSES,
  type ModelTier,
  type TaskClass,
  type TaskRoutingPaidApi,
  type TaskRoutingQuality,
  type TaskRoutingSettings as TaskRoutingPolicy,
} from "@specweave-studio/contracts";
import { canTakeTurn } from "@specweave-studio/shared/providerFallback";
import {
  classTier,
  DEFAULT_CLASS_TIERS,
  HIGH_RISK_FLOOR,
  TASK_CLASS_LABELS,
  taskRoutingConflicts,
  TIER_LABELS,
} from "@specweave-studio/shared/taskRouting";
import { useState } from "react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const QUALITY_LABELS: Record<TaskRoutingQuality, string> = {
  economy: "Save usage",
  balanced: "Balanced",
  best: "Best model always",
};
const PAID_API_LABELS: Record<TaskRoutingPaidApi, string> = {
  never: "Never",
  economy: "Economy models only",
  standard: "Up to Standard models",
};
const MODEL_TIERS: ReadonlyArray<ModelTier> = ["economy", "standard", "frontier"];
const DEFAULT_OPTION = "default";
const NO_FLOOR = "none";

/** The two Copilot harnesses stay side by side, so neither reads as the other's duplicate. */
export function routingProviderEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ProviderInstanceEntry> {
  const isCopilot = (entry: ProviderInstanceEntry) =>
    /copilot/i.test(entry.instanceId) || /copilot/i.test(entry.displayName);
  const first = entries.findIndex(isCopilot);
  if (first < 0) return entries;
  const copilots = entries.filter(isCopilot);
  const rest = entries.filter((entry) => !isCopilot(entry));
  return [...rest.slice(0, first), ...copilots, ...rest.slice(first)];
}

/** What a provider row says about whether Auto can use it right now. */
export function routingProviderState(entry: ProviderInstanceEntry): string {
  if (!entry.isAvailable) return "Unavailable";
  if (!entry.enabled) return "Off";
  if (!entry.installed) return "Not installed";
  if (canTakeTurn(entry.snapshot)) return "Ready";
  return entry.status === "warning" ? "State unknown" : "Not ready";
}

/** The tiers a class may be set to: high-risk work never goes below its floor. */
export function tierOptionsFor(taskClass: TaskClass): ReadonlyArray<ModelTier> {
  const floor = HIGH_RISK_FLOOR[taskClass];
  return floor === undefined
    ? MODEL_TIERS
    : MODEL_TIERS.filter((tier) => MODEL_TIERS.indexOf(tier) >= MODEL_TIERS.indexOf(floor));
}

/**
 * Auto model routing: picks a worker's model by what the task needs. Off by
 * default and project-scoped. A named model always wins; exclusions and the
 * minimum tier always apply; Auto only ever moves work down from the model
 * the thread would use anyway, never up.
 */
export function TaskRoutingSettings() {
  const { scope, target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environments } = useEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers = representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = routingProviderEntries(
    sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
    ),
  );
  const mixed = useScopedSettingsMixed(["taskRouting"]);
  const policy = settings.taskRouting;
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const auto = policy.mode === "auto";
  const [confirmingPaidApi, setConfirmingPaidApi] = useState<TaskRoutingPaidApi | null>(null);
  // The policy is saved whole, so a project override never half-inherits another policy.
  const save = (change: Partial<TaskRoutingPolicy>) =>
    updateSettings({ taskRouting: { ...policy, ...change } });
  const conflicts = mixed
    ? []
    : taskRoutingConflicts({
        policy,
        providers,
        projectWorkerModel: isProjectScope ? settings.defaultModelSelection : null,
      });

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["taskRouting"]}
        mixed={mixed}
        id="task-routing-mode"
        title="Auto model routing"
        description={
          isProjectScope
            ? "Picks the model for this project's delegated workers by what the task needs: routine work such as translation, transcripts or a first animation draft can run on a cheaper model, while final code, review and design stay on a strong one. A model named for a thread always wins. Decided by rules, without a model call."
            : "Picks the model for delegated workers by what the task needs: routine work such as translation, transcripts or a first animation draft can run on a cheaper model, while final code, review and design stay on a strong one. A model named for a thread always wins. Decided by rules, without a model call. Projects can override it."
        }
        status={mixed ? undefined : auto ? "Auto" : "Off: workers keep their usual model"}
        resetAction={
          auto ? (
            <SettingResetButton
              label="Auto model routing"
              tooltip="Turn Auto off"
              onClick={() => save({ mode: "off" })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Auto model routing"
            mixed={mixed}
            checked={mixed ? false : auto}
            onCheckedChange={(enabled) => save({ mode: enabled ? "auto" : "off" })}
          />
        }
      >
        {auto && !mixed ? (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground" data-routing-notes>
            <p>
              Long audio is transcribed first (speech to text), the transcript is split into chunks
              that fit the model's context, and the cheaper model works through the chunks. Auto
              never sends audio to a model that cannot hear it.
            </p>
            <p>
              A failure on the cheaper model gets one retry on the model the work would have used
              without Auto. Model changes happen only between turns.
            </p>
            {conflicts.length > 0 ? (
              <ul className="list-disc ps-4 text-warning-foreground" aria-label="Routing conflicts">
                {conflicts.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </SettingsRow>
      {auto && !mixed ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["taskRouting"]}
            id="task-routing-quality"
            title="Quality preference"
            description="Balanced uses the tiers below. Save usage moves routine text work (translation, transcripts, summaries, research) to Economy models. Best model always keeps every task on its usual model."
            control={
              <Select
                value={policy.quality}
                onValueChange={(value) => {
                  if (value === "economy" || value === "balanced" || value === "best")
                    save({ quality: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Quality preference">
                  <SelectValue>
                    {(value: TaskRoutingQuality | null) =>
                      value === null ? "Mixed" : QUALITY_LABELS[value]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(Object.keys(QUALITY_LABELS) as TaskRoutingQuality[]).map((quality) => (
                    <SelectItem key={quality} value={quality}>
                      {QUALITY_LABELS[quality]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["taskRouting"]}
            id="task-routing-classes"
            title="Model tier per task"
            description="The cheapest tier each kind of task may use. Code, review, design and final animation never go below Standard; other work stays on Frontier. Unclear tasks keep their usual model."
            resetAction={
              Object.keys(policy.classTiers).length > 0 ? (
                <SettingResetButton label="task tiers" onClick={() => save({ classTiers: {} })} />
              ) : null
            }
          >
            <ul className="flex flex-col gap-1.5" aria-label="Model tier per task">
              {TASK_CLASSES.map((taskClass) => {
                const override = policy.classTiers[taskClass];
                const effective = classTier(taskClass, policy);
                return (
                  <li
                    key={taskClass}
                    className="flex items-center justify-between gap-3 text-sm"
                    data-task-class={taskClass}
                  >
                    <span className="min-w-0 flex-1 truncate">{TASK_CLASS_LABELS[taskClass]}</span>
                    <Select
                      value={override ?? DEFAULT_OPTION}
                      onValueChange={(value) => {
                        const next = { ...policy.classTiers };
                        if (value === DEFAULT_OPTION) delete next[taskClass];
                        else if (
                          value === "economy" ||
                          value === "standard" ||
                          value === "frontier"
                        )
                          next[taskClass] = value;
                        else return;
                        save({ classTiers: next });
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-44 shrink-0"
                        aria-label={`Tier for ${TASK_CLASS_LABELS[taskClass]}`}
                      >
                        <SelectValue>
                          {(value: string | null) =>
                            value === DEFAULT_OPTION || value === null
                              ? `${TIER_LABELS[effective]} (default)`
                              : TIER_LABELS[effective]
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="end" alignItemWithTrigger={false}>
                        <SelectItem value={DEFAULT_OPTION}>
                          Default ({TIER_LABELS[DEFAULT_CLASS_TIERS[taskClass]]})
                        </SelectItem>
                        {tierOptionsFor(taskClass).map((tier) => (
                          <SelectItem key={tier} value={tier}>
                            {TIER_LABELS[tier]}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </li>
                );
              })}
            </ul>
          </SettingsRow>
          <SettingsRow
            serverScoped
            settingKeys={["taskRouting"]}
            id="task-routing-floor"
            title="Minimum tier"
            description="No task routes below this tier, whatever its class allows."
            control={
              <Select
                value={policy.minimumTier ?? NO_FLOOR}
                onValueChange={(value) => {
                  if (value === NO_FLOOR) save({ minimumTier: null });
                  else if (value === "economy" || value === "standard" || value === "frontier")
                    save({ minimumTier: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Minimum tier">
                  <SelectValue>
                    {(value: string | null) =>
                      value === NO_FLOOR || value === null
                        ? "None"
                        : TIER_LABELS[value as ModelTier]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={NO_FLOOR}>None</SelectItem>
                  {MODEL_TIERS.map((tier) => (
                    <SelectItem key={tier} value={tier}>
                      {TIER_LABELS[tier]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["taskRouting"]}
            id="task-routing-providers"
            title="Providers Auto may use"
            description="Auto picks only among providers that are switched on here, signed in and below the usage threshold. A worker never moves to a provider you turn off."
          >
            {entries.length === 0 ? (
              <span className="text-sm text-muted-foreground">No providers available</span>
            ) : (
              <ul className="flex flex-col gap-1.5" aria-label="Providers Auto may use">
                {entries.map((entry) => {
                  const excluded = policy.excludedProviders.includes(entry.instanceId);
                  return (
                    <li
                      key={entry.instanceId}
                      className="flex items-center justify-between gap-3 text-sm"
                      data-routing-provider={entry.instanceId}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{entry.displayName}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {entry.instanceId} · {routingProviderState(entry)}
                        </span>
                      </span>
                      <Switch
                        aria-label={`Auto may use ${entry.displayName} (${entry.instanceId})`}
                        checked={!excluded}
                        onCheckedChange={(allowed) =>
                          save({
                            excludedProviders: allowed
                              ? policy.excludedProviders.filter((id) => id !== entry.instanceId)
                              : [...policy.excludedProviders, entry.instanceId],
                          })
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </SettingsRow>
          <SettingsRow
            serverScoped
            settingKeys={["taskRouting"]}
            id="task-routing-paid-api"
            title="Paid API models"
            description="Subscription usage is what Auto spends by default. Providers billed per token (API credits) are left out unless allowed here, and only up to the tier you pick. Auto never adds a key, signs in or buys credits."
            control={
              <Select
                value={policy.paidApi}
                onValueChange={(value) => {
                  if (value === "never") save({ paidApi: "never" });
                  else if (value === "economy" || value === "standard") setConfirmingPaidApi(value);
                }}
              >
                <SelectTrigger size="sm" aria-label="Paid API models">
                  <SelectValue>
                    {(value: TaskRoutingPaidApi | null) =>
                      value === null ? "Mixed" : PAID_API_LABELS[value]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(Object.keys(PAID_API_LABELS) as TaskRoutingPaidApi[]).map((cap) => (
                    <SelectItem key={cap} value={cap}>
                      {PAID_API_LABELS[cap]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["taskRouting"]}
            id="task-routing-escalate"
            title="Retry once on the usual model"
            description="When a thread Auto moved fails for a reason a stronger model may fix, it continues once, in the same thread, on the model it would have used without Auto. A delegated task reports its failure to the thread that started it, which may retry it once on that model. Usage limits are left to the fallback rules above."
            control={
              <Switch
                aria-label="Retry once on the usual model"
                checked={policy.escalate}
                onCheckedChange={(escalate) => save({ escalate })}
              />
            }
          />
        </>
      ) : null}
      <AlertDialog
        open={confirmingPaidApi !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingPaidApi(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Let Auto use paid API models?</AlertDialogTitle>
            <AlertDialogDescription>
              {isProjectScope
                ? "Workers in this project may run on providers billed per token, up to the tier you picked. Those turns are billed to the provider's API account at API rates. SpecWithCode cannot read or cap that balance; set a spend limit with the provider."
                : "Workers may run on providers billed per token, up to the tier you picked, in every project that does not override this. Those turns are billed to the provider's API account at API rates. SpecWithCode cannot read or cap that balance; set a spend limit with the provider."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                if (confirmingPaidApi !== null) save({ paidApi: confirmingPaidApi });
                setConfirmingPaidApi(null);
              }}
            >
              Allow paid API
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
