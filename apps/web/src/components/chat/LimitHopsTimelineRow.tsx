import { ChevronDown, ChevronRight } from "lucide";
import { ArrowRightLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

import { MorphIcon } from "~/components/MorphIcon";
import { useLocale, useTx } from "../../i18n";
import { modelLabel } from "../../studio/shellModel";
import { useProviderEntries } from "../studio/shell/ModelBadge";
import { limitHopsSummary, type LimitHopsRow } from "./limitHopGroups";
import { WorkLogButton } from "./WorkLog";

type HopRun = {
  readonly id: string;
  readonly modelSelection?: { readonly instanceId: string; readonly model: string } | undefined;
};

/** One line for a stretch of usage-limit hops; it opens to the original rows (1460 AC-06). */
export function LimitHopsTimelineRow(props: {
  row: LimitHopsRow;
  runs: ReadonlyArray<HopRun>;
  environmentId: string;
  onToggle: () => void;
  timestamp: ReactNode;
}) {
  const { row } = props;
  const tx = useTx();
  const locale = useLocale();
  const providers = useProviderEntries(props.environmentId);
  const providerName = (instanceId: string, model = "") =>
    modelLabel(providers.get(instanceId) ?? null, instanceId, model).provider || instanceId;
  // One index per render, not one scan of the runs per hop.
  const runsById =
    row.sourceInstanceIds.length > 0 ? null : new Map(props.runs.map((run) => [run.id, run]));
  const sources =
    runsById === null
      ? row.sourceInstanceIds.map((instanceId) => providerName(instanceId))
      : row.runIds.flatMap((runId) => {
          const selection = runsById.get(runId)?.modelSelection;
          return selection ? [providerName(selection.instanceId, selection.model)] : [];
        });
  const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
  const summary = limitHopsSummary(row.hopCount, sources, tx, (names) => list.format(names));
  return (
    <WorkLogButton
      aria-label={summary}
      aria-expanded={row.expanded}
      data-limit-hops={row.groupId}
      onClick={props.onToggle}
      icon={<ArrowRightLeftIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />}
      label={<span className="truncate text-muted-foreground">{summary}</span>}
      trailing={
        <span className="flex shrink-0 items-center gap-1">
          {props.timestamp}
          <MorphIcon
            className="size-3.5 text-muted-foreground"
            icon={row.expanded ? ChevronDown : ChevronRight}
          />
        </span>
      }
    />
  );
}
