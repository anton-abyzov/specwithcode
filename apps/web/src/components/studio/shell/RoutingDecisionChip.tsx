/**
 * What Auto model routing or Model lanes decided for a thread: a small chip beside the model
 * badge ("Auto · Translation" or "Lanes · Complex · Code"), and on click the provider, model,
 * lane, skipped entries, reason, billing and learned rule feedback.
 */
import type {
  EnvironmentId,
  LearnedModelPreference,
  ProjectId,
  TaskRoutingDecision,
  TaskRoutingModelBilling,
} from "@specweave-studio/contracts";
import { LANE_LABELS, withLearnedPreference } from "@specweave-studio/shared/modelLanes";
import { TASK_CLASS_LABELS, TIER_LABELS } from "@specweave-studio/shared/taskRouting";
import { RouteIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useProjectOverrideWriteMode } from "../../../hooks/useSettings";
import { projectSettingsOverrideChangesPatch } from "@specweave-studio/shared/projectSettings";
import type { ProviderInstanceEntry } from "../../../providerInstances";
import { useEnvironments } from "../../../state/environments";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { modelLabel } from "../../../studio/shellModel";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";

const BILLING_LABELS: Record<TaskRoutingModelBilling, string> = {
  subscription: "Subscription usage",
  api: "Billed per token (API)",
  local: "Runs on this machine",
  "paid-router": "Billed per token (OpenRouter)",
  unknown: "Billing unknown",
};

type Entries = ReadonlyMap<string, ProviderInstanceEntry> | undefined;

function selectionLabel(entries: Entries, selection: TaskRoutingDecision["selection"]): string {
  return modelLabel(
    entries?.get(selection.instanceId) ?? null,
    selection.instanceId,
    selection.model,
  ).full;
}

/** The chip face: whether Auto or Lanes routed the thread, and its lane or task class. */
export function routingChipText(decision: TaskRoutingDecision): string {
  if (decision.lane) {
    const laneName = decision.lane === "complex" ? "Complex" : "Routine";
    return decision.taskClass === "general"
      ? "Lanes · " + laneName
      : "Lanes · " + laneName + " · " + TASK_CLASS_LABELS[decision.taskClass];
  }
  return "Auto · " + TASK_CLASS_LABELS[decision.taskClass];
}

export function RoutingDecisionChip(props: {
  routing: TaskRoutingDecision | null | undefined;
  entries: Entries;
  projectId?: ProjectId | null | undefined;
  environmentId?: EnvironmentId | null | undefined;
}) {
  const decision = props.routing;
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const [savingFeedback, setSavingFeedback] = useState(false);
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const { environments } = useEnvironments();
  const primaryId = environments[0]?.environmentId;
  const targetEnvironmentId = props.environmentId ?? primaryId;
  const fallbackId = (targetEnvironmentId ?? "default") as EnvironmentId;
  const settings = useEnvironmentSettings(fallbackId);
  // Unknown until the environment's config loads; feedback waits for it.
  const writeMode = useProjectOverrideWriteMode(fallbackId);

  if (!decision) return null;
  const chosen = selectionLabel(props.entries, decision.selection);

  const handleFeedback = async (kind: "prefer" | "avoid" | "complex" | "routine") => {
    if (!props.projectId || !targetEnvironmentId || writeMode === null) return;
    setSavingFeedback(true);
    try {
      const overrides = settings.projectSettingsOverrides[props.projectId] ?? {};
      const currentPrefs = overrides.learnedModelPreferences ?? [];
      const newPref: LearnedModelPreference = {
        id: "pref-" + Date.now().toString(36),
        keywords: decision.signals?.slice(0, 4) ?? [],
        ...(decision.taskClass !== "general" ? { taskClass: decision.taskClass } : {}),
        action:
          kind === "prefer"
            ? { kind: "prefer", model: decision.selection }
            : kind === "avoid"
              ? { kind: "avoid", model: decision.selection }
              : { kind: "lane", lane: kind },
        createdAt: new Date().toISOString(),
      };
      const updated = withLearnedPreference(currentPrefs, newPref);
      await save({
        environmentId: targetEnvironmentId,
        input: {
          patch: projectSettingsOverrideChangesPatch(
            settings,
            { [props.projectId]: { set: { learnedModelPreferences: updated } } },
            writeMode === "per-key",
          ),
        },
      });
      setFeedbackSaved(true);
    } catch {
      // ignore
    } finally {
      setSavingFeedback(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger
        className="sws-chip sws-routing-chip"
        data-moved={decision.moved ? "true" : undefined}
        aria-label={"Routing decision: " + TASK_CLASS_LABELS[decision.taskClass] + ", " + chosen}
      >
        <RouteIcon aria-hidden />
        {routingChipText(decision)}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" width="lg" padding="none">
        <div className="sws-routing-popover" data-routing-decision>
          <header>
            <strong>{decision.lane ? "Model lane routing" : "Auto model routing"}</strong>
            <span>{decision.moved ? "Moved" : "Kept"}</span>
          </header>
          <dl>
            {decision.lane ? (
              <>
                <dt>Model lane</dt>
                <dd>{LANE_LABELS[decision.lane]}</dd>
              </>
            ) : null}
            <dt>Task class</dt>
            <dd>
              {TASK_CLASS_LABELS[decision.taskClass]}
              {decision.confidence === "hint" ? " (named by the caller)" : null}
              {decision.confidence === "uncertain" ? " (uncertain)" : null}
            </dd>
            <dt>Runs on</dt>
            <dd>
              {chosen}
              {decision.tier ? " · " + TIER_LABELS[decision.tier] : null}
            </dd>
            {decision.moved ? (
              <>
                <dt>Instead of</dt>
                <dd>{selectionLabel(props.entries, decision.baseline)}</dd>
              </>
            ) : null}
            <dt>Cost</dt>
            <dd>{BILLING_LABELS[decision.modelBilling ?? decision.billing]}</dd>
            <dt>Why</dt>
            <dd>{decision.reason}</dd>
            {decision.skipped && decision.skipped.length > 0 ? (
              <>
                <dt>Skipped in lane</dt>
                <dd>
                  <ul className="list-disc ps-4 text-xs">
                    {decision.skipped.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
            {decision.preferenceId ? (
              <>
                <dt>Learned rule</dt>
                <dd>Applied rule {decision.preferenceId}</dd>
              </>
            ) : null}
            {decision.escalation ? (
              <>
                <dt>If it fails</dt>
                <dd>One retry on {selectionLabel(props.entries, decision.escalation)}</dd>
              </>
            ) : null}
            {decision.pipeline && decision.pipeline.length > 0 ? (
              <>
                <dt>Steps</dt>
                <dd>
                  <ol>
                    {decision.pipeline.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </dd>
              </>
            ) : null}
          </dl>
          {props.projectId ? (
            <div className="mt-3 border-t border-border/60 p-3 bg-muted/20">
              <div className="text-xs font-semibold text-muted-foreground mb-1.5">
                Teach this project:
              </div>
              {feedbackSaved ? (
                <div className="text-xs text-success-foreground font-medium">
                  Learned preference saved!
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => handleFeedback("prefer")}
                    disabled={savingFeedback || writeMode === null}
                  >
                    Prefer this model
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => handleFeedback("avoid")}
                    disabled={savingFeedback || writeMode === null}
                  >
                    Avoid this model
                  </Button>
                  {decision.lane !== "complex" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => handleFeedback("complex")}
                      disabled={savingFeedback || writeMode === null}
                    >
                      Treat as Complex
                    </Button>
                  ) : null}
                  {decision.lane !== "routine" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => handleFeedback("routine")}
                      disabled={savingFeedback || writeMode === null}
                    >
                      Treat as Routine
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
