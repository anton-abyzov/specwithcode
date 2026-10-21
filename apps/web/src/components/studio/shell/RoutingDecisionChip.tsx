/**
 * What Auto model routing decided for a thread: a small chip beside the model
 * badge ("Auto · Translation"), and on click the provider, model, reason,
 * billing and the one escalation step it would take.
 */
import type { TaskRoutingDecision } from "@specweave-studio/contracts";
import { TASK_CLASS_LABELS, TIER_LABELS } from "@specweave-studio/shared/taskRouting";
import { RouteIcon } from "lucide-react";

import type { ProviderInstanceEntry } from "../../../providerInstances";
import { modelLabel } from "../../../studio/shellModel";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";

const BILLING_LABELS: Record<TaskRoutingDecision["billing"], string> = {
  subscription: "Subscription usage",
  api: "Billed per token (API)",
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

/** The chip's face: whether Auto moved the thread, and the task class it read. */
export function routingChipText(decision: TaskRoutingDecision): string {
  return `Auto · ${TASK_CLASS_LABELS[decision.taskClass]}`;
}

export function RoutingDecisionChip(props: {
  routing: TaskRoutingDecision | null | undefined;
  entries: Entries;
}) {
  const decision = props.routing;
  if (!decision) return null;
  const chosen = selectionLabel(props.entries, decision.selection);
  return (
    <Popover>
      <PopoverTrigger
        className="sws-chip sws-routing-chip"
        data-moved={decision.moved ? "true" : undefined}
        aria-label={`Auto routing: ${TASK_CLASS_LABELS[decision.taskClass]}, ${chosen}`}
      >
        <RouteIcon aria-hidden />
        {routingChipText(decision)}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" width="lg" padding="none">
        <div className="sws-routing-popover" data-routing-decision>
          <header>
            <strong>Auto model routing</strong>
            <span>{decision.moved ? "Moved" : "Kept"}</span>
          </header>
          <dl>
            <dt>Task class</dt>
            <dd>
              {TASK_CLASS_LABELS[decision.taskClass]}
              {decision.confidence === "hint" ? " (named by the caller)" : null}
              {decision.confidence === "uncertain" ? " (uncertain)" : null}
            </dd>
            <dt>Runs on</dt>
            <dd>
              {chosen}
              {decision.tier ? ` · ${TIER_LABELS[decision.tier]}` : null}
            </dd>
            {decision.moved ? (
              <>
                <dt>Instead of</dt>
                <dd>{selectionLabel(props.entries, decision.baseline)}</dd>
              </>
            ) : null}
            <dt>Cost</dt>
            <dd>{BILLING_LABELS[decision.billing]}</dd>
            <dt>Why</dt>
            <dd>{decision.reason}</dd>
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
        </div>
      </PopoverPopup>
    </Popover>
  );
}
