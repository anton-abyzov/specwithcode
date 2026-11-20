/**
 * One advisor consult in the timeline: the studio-code `advisor` tool or
 * Claude's own advisor, as one row. It names the advising model and opens to
 * the advice as Markdown, or to the sentence that says why there is none. The
 * stored result is never shown as JSON.
 */
import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
} from "@specweave-studio/client-runtime/work-log/item-detail";
import {
  advisorConsultView,
  type AdvisorConsultView,
} from "@specweave-studio/client-runtime/work-log/presentation";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
  ServerProvider,
} from "@specweave-studio/contracts";
import { resolveSelectableModel } from "@specweave-studio/shared/model";
import { ChevronRightIcon, CircleAlertIcon, LightbulbIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useTx } from "../../i18n";
import { cn } from "~/lib/utils";
import { useTurnItemDetail } from "../../state/queries";
import ChatMarkdown from "../ChatMarkdown";
import { WorkLogDetails, WorkLogRow } from "./WorkLog";

/** The advice is the point of the row: fetch the withheld result as soon as it shows. */
export function useAdvisorConsultView(
  projectedItem: OrchestrationV2ProjectedTurnItem,
  environmentId: EnvironmentId,
): AdvisorConsultView | null {
  const wireItem = projectedItem.item;
  const fetches = turnItemNeedsDetailFetch(wireItem);
  const detail = useTurnItemDetail(
    fetches
      ? {
          environmentId,
          threadId: projectedItem.sourceThreadId,
          itemId: projectedItem.sourceItemId,
          revision: turnItemDetailRevision(wireItem),
        }
      : null,
  );
  const fetched = detail.data?.item;
  // The live status wins: a fetch can lag the item it was read for.
  const item = fetched?.type === wireItem.type ? { ...fetched, status: wireItem.status } : wireItem;
  return advisorConsultView(item);
}

/**
 * The name to show for the advising model. Claude's own advisor is named by
 * its model slug, so look it up in the provider list (Claude providers first)
 * and use the display name there; anything else is shown as given.
 */
export function advisorDisplayName(
  view: Pick<AdvisorConsultView, "advisor" | "builtIn">,
  providers: ReadonlyArray<Pick<ServerProvider, "driver" | "models">> | undefined,
): string | null {
  const advisor = view.advisor;
  if (advisor === null || !view.builtIn || !providers) return advisor;
  const ordered = [
    ...providers.filter((provider) => provider.driver.toLowerCase().includes("claude")),
    ...providers.filter((provider) => !provider.driver.toLowerCase().includes("claude")),
  ];
  for (const provider of ordered) {
    const slug = resolveSelectableModel(provider.driver, advisor, provider.models);
    const model = slug === null ? undefined : provider.models.find((entry) => entry.slug === slug);
    if (model) return model.name;
  }
  return advisor;
}

function AdvisorChip(props: { readonly children: ReactNode; readonly tone?: "failed" }) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full border px-1.5 text-2xs/4",
        props.tone === "failed"
          ? "border-destructive/40 text-destructive-foreground"
          : "border-border text-muted-foreground",
      )}
    >
      {props.children}
    </span>
  );
}

const FAILED_STATES: ReadonlySet<AdvisorConsultView["state"]> = new Set([
  "refused",
  "failed",
  "unavailable",
]);

/** The row itself, for a consult already read. */
export function AdvisorConsultLine(props: {
  readonly view: AdvisorConsultView;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly trailing?: ReactNode;
  readonly defaultExpanded?: boolean;
  /** Open state kept by the caller, so it survives a remount; local state otherwise. */
  readonly expanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
  /** The provider list, to name Claude's own advisor by its display name. */
  readonly providers?: ReadonlyArray<Pick<ServerProvider, "driver" | "models">>;
}) {
  const tx = useTx();
  const { view } = props;
  const [localExpanded, setLocalExpanded] = useState(props.defaultExpanded === true);
  const expanded = props.expanded ?? localExpanded;
  const failed = FAILED_STATES.has(view.state);
  const label =
    view.state === "running"
      ? tx("Asking the advisor")
      : view.state === "refused"
        ? tx("Did not ask the advisor")
        : view.state === "failed"
          ? tx("The advisor gave no advice")
          : view.state === "unavailable"
            ? tx("Advisor unavailable")
            : tx("Asked the advisor");
  const advisorName =
    advisorDisplayName(view, props.providers) ?? (view.builtIn ? tx("Claude built-in") : null);
  const body =
    view.state === "advice"
      ? view.detail
      : view.state === "working"
        ? (view.detail ?? tx("The advisor is still working. Its advice arrives as a new message."))
        : view.state === "refused" || view.state === "failed"
          ? view.detail
          : null;
  const canExpand = body !== null;
  const toggle = () => {
    if (!canExpand) return;
    if (props.onExpandedChange) props.onExpandedChange(!expanded);
    else setLocalExpanded(!expanded);
  };
  return (
    <WorkLogRow
      data-advisor-consult={view.state}
      {...(canExpand
        ? {
            role: "button",
            tabIndex: 0,
            "aria-expanded": expanded,
            onClick: toggle,
            onKeyDown: (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              toggle();
            },
          }
        : {})}
      icon={
        failed ? (
          <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
        ) : (
          <LightbulbIcon
            aria-hidden
            className={cn(
              "size-4 text-muted-foreground",
              view.state === "running" && "animate-pulse",
            )}
          />
        )
      }
      // The chips wrap under the label on a narrow window instead of being cut off.
      wrapLabel
      label={
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span
            className={cn(
              "shrink-0 text-sm",
              failed ? "text-destructive-foreground" : "text-secondary-label",
            )}
          >
            {label}
          </span>
          {advisorName ? <AdvisorChip>{advisorName}</AdvisorChip> : null}
          {view.state === "unavailable" && view.code ? (
            <AdvisorChip tone="failed">{view.code}</AdvisorChip>
          ) : null}
          {view.state === "working" ? <AdvisorChip>{tx("Still working")}</AdvisorChip> : null}
          {view.consultsRemaining !== null && view.state !== "refused" ? (
            <AdvisorChip>
              {tx("{count} left this run", { count: String(view.consultsRemaining) })}
            </AdvisorChip>
          ) : null}
          {view.state === "hidden" ? (
            <span className="min-w-0 truncate text-muted-foreground text-xs">
              {tx("Advice applied (hidden by Claude)")}
            </span>
          ) : null}
        </span>
      }
      trailing={
        <>
          {props.trailing}
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center",
              !canExpand && "invisible",
            )}
            aria-hidden
          >
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </span>
        </>
      }
    >
      {expanded && body !== null ? (
        <WorkLogDetails>
          {view.state === "advice" ? (
            <div data-advisor-advice className="border-border border-s-2 ps-3 text-sm">
              <ChatMarkdown
                formatDates
                text={body}
                cwd={props.cwd}
                threadRef={props.threadRef ?? undefined}
              />
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">{body}</p>
          )}
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  );
}

/** A consult row that reads its own result. Null when the item is not a consult. */
export function AdvisorConsultRow(props: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly trailing?: ReactNode;
  readonly defaultExpanded?: boolean;
  readonly expanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly providers?: ReadonlyArray<Pick<ServerProvider, "driver" | "models">>;
}) {
  const view = useAdvisorConsultView(props.projectedItem, props.environmentId);
  if (view === null) return null;
  return (
    <AdvisorConsultLine
      view={view}
      cwd={props.cwd}
      threadRef={props.threadRef}
      trailing={props.trailing}
      defaultExpanded={props.defaultExpanded ?? false}
      {...(props.expanded === undefined ? {} : { expanded: props.expanded })}
      {...(props.onExpandedChange ? { onExpandedChange: props.onExpandedChange } : {})}
      {...(props.providers ? { providers: props.providers } : {})}
    />
  );
}
