import {
  DEFAULT_ADVISOR_SETTINGS,
  MAX_ADVISOR_BRIEF_TOKEN_BUDGET,
  MAX_ADVISOR_BUILT_IN_CONTEXT_LIMIT,
  MAX_ADVISOR_CONSULTS_PER_RUN,
  MIN_ADVISOR_BRIEF_TOKEN_BUDGET,
  MIN_ADVISOR_BUILT_IN_CONTEXT_LIMIT,
  MIN_ADVISOR_CONSULTS_PER_RUN,
  type AdvisorSettings as AdvisorSettingsValue,
  type AdvisorSettingsPatch,
} from "@specweave-studio/contracts";
import { useEffect, useState } from "react";

import { useTx } from "../../i18n";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { planScopedSettingFieldClear, scopedSettingFieldMixed } from "./scopedSettings";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  type SettingsReach,
} from "./settingsLayout";
import { useRunScopedPlan, useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** What an unset advisor model resolves to: the built-in order. */
export const ADVISOR_DEFAULT_MODEL_LABEL = "Fable 5.2, then the Review track";

/**
 * The unset picker shows a label and no provider mark, so it gets the bordered
 * trigger of the Adversarial review "Add model" picker to read as a control.
 */
const UNSET_PICKER_TRIGGER_CLASSNAME = `${SETTINGS_PICKER_TRIGGER_CLASSNAME} h-7 rounded-md border border-input bg-background px-2.5 shadow-xs/5 hover:bg-accent/50 dark:bg-input/32`;

type AdvisorField = keyof AdvisorSettingsValue;

interface AdvisorCapableEnvironment {
  readonly serverConfig: {
    readonly environment?: { readonly capabilities: { readonly advisor?: boolean | undefined } };
  } | null;
}

/**
 * The section shows only when every selected machine reads the `advisor`
 * setting, so a save never reaches a server that would drop it.
 */
export function advisorSettingsAvailable(
  environments: readonly AdvisorCapableEnvironment[],
): boolean {
  return (
    environments.length > 0 &&
    environments.every(
      (environment) => environment.serverConfig?.environment?.capabilities.advisor === true,
    )
  );
}

/** Rounds and clamps a committed number; null keeps the saved value. */
export function clampAdvisorNumber(value: number | null, min: number, max: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function AdvisorNumber(props: {
  readonly label: string;
  readonly unit?: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}) {
  const { label, unit, value, min, max, step, disabled, onChange } = props;
  const [draft, setDraft] = useState<number | null>(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <NumberField
      value={draft}
      min={min}
      max={max}
      step={step}
      size="sm"
      className="w-auto"
      disabled={disabled}
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        const clamped = clampAdvisorNumber(next, min, max);
        setDraft(clamped ?? value);
        if (clamped !== null && clamped !== value) onChange(clamped);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${label}`} />
        <NumberFieldInput
          aria-label={label}
          size={new Intl.NumberFormat().format(draft ?? value).length}
          className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
        />
        {unit ? (
          <span aria-hidden="true" className="self-center pr-2 text-xs">
            {unit}
          </span>
        ) : null}
        <NumberFieldIncrement aria-label={`Increase ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}

/**
 * The advisor: a running thread may ask a stronger model to review its
 * approach and keep working. Every row writes only the field it changes, so
 * a project override holds only what the project changed. Hidden on a
 * machine whose server does not offer the advisor.
 */
export function AdvisorSettings(props: {
  readonly id: string;
  readonly reach?: SettingsReach;
  readonly className?: string;
}) {
  const tx = useTx();
  const { scope, target, targets, environments, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const runPlan = useRunScopedPlan();
  if (!advisorSettingsAvailable(connectedEnvironments)) return null;

  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const advisor: AdvisorSettingsValue = settings.advisor ?? DEFAULT_ADVISOR_SETTINGS;
  const save = (change: AdvisorSettingsPatch) => updateSettings({ advisor: change });
  const representative = target
    ? connectedEnvironments.find(
        (environment) => environment.environmentId === target.environmentId,
      )
    : undefined;
  const providers = representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const pickerSelection = resolveDefaultProviderModelSelection(providers, advisor.model);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    pickerSelection?.instanceId,
    pickerSelection?.model,
  );
  // Each row shows and resets its own field: "Mixed" only when that field
  // differs between the selected machines, and at project scope "Overridden"
  // only when the project's override holds that field.
  const mixedField = (field: AdvisorField) => scopedSettingFieldMixed(targets, "advisor", field);
  const mixed = {
    enabled: mixedField("enabled"),
    model: mixedField("model"),
    claudeBuiltIn: mixedField("claudeBuiltIn"),
    builtInContextLimit: mixedField("builtInContextLimit"),
    maxConsultsPerRun: mixedField("maxConsultsPerRun"),
    briefTokenBudget: mixedField("briefTokenBudget"),
  } satisfies Record<AdvisorField, boolean>;
  // Rows other than the switch wait for it; a mixed selection keeps them usable.
  const off = !mixed.enabled && !advisor.enabled;
  const builtInOff = off || (!mixed.claudeBuiltIn && !advisor.claudeBuiltIn);
  // At project scope the row's own reset removes the field from the override;
  // here it restores the default.
  const reset = (
    field: AdvisorField,
    label: string,
    show: boolean,
    change: AdvisorSettingsPatch,
  ) =>
    !isProjectScope && !mixed[field] && show ? (
      <SettingResetButton label={label} onClick={() => save(change)} />
    ) : null;
  const shared = (field: AdvisorField) => ({
    serverScoped: true,
    settingKeys: ["advisor"] as const,
    settingField: field,
    mixed: mixed[field],
    onResetOverride: () =>
      void runPlan(planScopedSettingFieldClear(scope, environments, "advisor", field)),
  });

  return (
    <SettingsSection
      id={props.id}
      title="Advisor"
      {...(props.reach ? { reach: props.reach } : {})}
      {...(props.className ? { className: props.className } : {})}
    >
      <SettingsRow
        {...shared("enabled")}
        id="advisor-enabled"
        title="Let threads ask a stronger model"
        description="A thread can ask a stronger model to review its approach, then keep working. Each consult spends the advisor model's usage."
        resetAction={reset("enabled", tx("advisor"), advisor.enabled, { enabled: false })}
        control={
          <Switch
            aria-label={tx("Let threads ask a stronger model")}
            mixed={mixed.enabled}
            checked={mixed.enabled ? false : advisor.enabled}
            onCheckedChange={(checked) => save({ enabled: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        {...shared("model")}
        id="advisor-model"
        aria-disabled={off || undefined}
        title="Advisor model"
        description="A thread is never advised by its own model; the next model in the order answers instead."
        resetAction={reset("model", tx("advisor model"), advisor.model !== null, {
          model: null,
        })}
        control={
          mixed.model ? (
            <span className="text-sm text-muted-foreground">{tx("Mixed")}</span>
          ) : (
            <>
              {advisor.model !== null ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={off}
                  aria-label={tx("Use the default advisor order")}
                  onClick={() => save({ model: null })}
                >
                  {tx("Use default")}
                </Button>
              ) : null}
              {pickerSelection ? (
                <ProviderModelPicker
                  activeInstanceId={pickerSelection.instanceId}
                  model={pickerSelection.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={modelOptions}
                  triggerClassName={
                    advisor.model === null
                      ? UNSET_PICKER_TRIGGER_CLASSNAME
                      : SETTINGS_PICKER_TRIGGER_CLASSNAME
                  }
                  triggerAriaLabel={tx("Advisor model")}
                  disabled={off}
                  {...(advisor.model === null
                    ? { unset: true, triggerLabel: tx(ADVISOR_DEFAULT_MODEL_LABEL) }
                    : {})}
                  onInstanceModelChange={(instanceId, model) =>
                    save({ model: { instanceId, model } })
                  }
                />
              ) : (
                <span className="text-sm text-muted-foreground">
                  {tx(ADVISOR_DEFAULT_MODEL_LABEL)}
                </span>
              )}
            </>
          )
        }
      />
      <SettingsRow
        {...shared("claudeBuiltIn")}
        id="advisor-claude-built-in"
        aria-disabled={off || undefined}
        title="Claude's own advisor"
        description="On Claude threads, Claude's built-in advisor reads the whole conversation on each consult. A Fable advisor is billed to Claude usage credits."
        resetAction={reset("claudeBuiltIn", tx("Claude's own advisor"), !advisor.claudeBuiltIn, {
          claudeBuiltIn: true,
        })}
        control={
          <Switch
            aria-label={tx("Claude's own advisor")}
            mixed={mixed.claudeBuiltIn}
            disabled={off}
            checked={mixed.claudeBuiltIn ? false : advisor.claudeBuiltIn}
            onCheckedChange={(checked) => save({ claudeBuiltIn: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        {...shared("builtInContextLimit")}
        id="advisor-built-in-context-limit"
        aria-disabled={builtInOff || undefined}
        title="Context limit for Claude's advisor"
        description="Above this many tokens of context, a Claude thread sends the budgeted brief instead."
        resetAction={reset(
          "builtInContextLimit",
          tx("context limit"),
          advisor.builtInContextLimit !== DEFAULT_ADVISOR_SETTINGS.builtInContextLimit,
          { builtInContextLimit: DEFAULT_ADVISOR_SETTINGS.builtInContextLimit },
        )}
        control={
          mixed.builtInContextLimit ? (
            <span className="text-sm text-muted-foreground">{tx("Mixed")}</span>
          ) : (
            <AdvisorNumber
              label={tx("Context limit for Claude's advisor")}
              unit={tx("tokens")}
              value={advisor.builtInContextLimit}
              min={MIN_ADVISOR_BUILT_IN_CONTEXT_LIMIT}
              max={MAX_ADVISOR_BUILT_IN_CONTEXT_LIMIT}
              step={10_000}
              disabled={builtInOff}
              onChange={(builtInContextLimit) => save({ builtInContextLimit })}
            />
          )
        }
      />
      <SettingsRow
        {...shared("maxConsultsPerRun")}
        id="advisor-consults-per-run"
        aria-disabled={off || undefined}
        title="Consults per run"
        description="Further consults in the same run are refused."
        resetAction={reset(
          "maxConsultsPerRun",
          tx("consults per run"),
          advisor.maxConsultsPerRun !== DEFAULT_ADVISOR_SETTINGS.maxConsultsPerRun,
          { maxConsultsPerRun: DEFAULT_ADVISOR_SETTINGS.maxConsultsPerRun },
        )}
        control={
          mixed.maxConsultsPerRun ? (
            <span className="text-sm text-muted-foreground">{tx("Mixed")}</span>
          ) : (
            <AdvisorNumber
              label={tx("Consults per run")}
              value={advisor.maxConsultsPerRun}
              min={MIN_ADVISOR_CONSULTS_PER_RUN}
              max={MAX_ADVISOR_CONSULTS_PER_RUN}
              step={1}
              disabled={off}
              onChange={(maxConsultsPerRun) => save({ maxConsultsPerRun })}
            />
          )
        }
      />
      <SettingsRow
        {...shared("briefTokenBudget")}
        id="advisor-brief-size"
        aria-disabled={off || undefined}
        title="Brief size"
        description="The most a consult sends to the advisor. Older activity is left out first."
        resetAction={reset(
          "briefTokenBudget",
          tx("brief size"),
          advisor.briefTokenBudget !== DEFAULT_ADVISOR_SETTINGS.briefTokenBudget,
          { briefTokenBudget: DEFAULT_ADVISOR_SETTINGS.briefTokenBudget },
        )}
        control={
          mixed.briefTokenBudget ? (
            <span className="text-sm text-muted-foreground">{tx("Mixed")}</span>
          ) : (
            <AdvisorNumber
              label={tx("Brief size")}
              unit={tx("tokens")}
              value={advisor.briefTokenBudget}
              min={MIN_ADVISOR_BRIEF_TOKEN_BUDGET}
              max={MAX_ADVISOR_BRIEF_TOKEN_BUDGET}
              step={1_000}
              disabled={off}
              onChange={(briefTokenBudget) => save({ briefTokenBudget })}
            />
          )
        }
      />
    </SettingsSection>
  );
}
