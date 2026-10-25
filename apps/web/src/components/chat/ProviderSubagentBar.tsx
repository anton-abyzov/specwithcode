import {
  formatProviderSubagentStatus,
  type ProviderSubagentStatus,
} from "@specweave-studio/client-runtime/state/thread-execution";
import {
  ArrowUpLeftIcon,
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleHelpIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  formatProviderSubagentShortStatus,
  providerSubagentStatusTone,
  type ProviderSubagentStatusTone,
} from "./providerSubagentStatusDisplay";

function StatusGlyph({ tone }: { tone: ProviderSubagentStatusTone }) {
  switch (tone) {
    case "live":
      return (
        <span
          aria-hidden
          data-subagent-status-glyph="live"
          className="mx-1 size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
        />
      );
    case "done":
      return (
        <CheckIcon
          aria-hidden
          data-subagent-status-glyph="done"
          className="size-3.5 shrink-0 text-success-foreground"
        />
      );
    case "failed":
      return (
        <CircleAlertIcon
          aria-hidden
          data-subagent-status-glyph="failed"
          className="size-3.5 shrink-0 text-destructive-foreground"
        />
      );
    case "stopped":
      return (
        <CircleSlashIcon
          aria-hidden
          data-subagent-status-glyph="stopped"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      );
    case "unknown":
      return (
        <CircleHelpIcon
          aria-hidden
          data-subagent-status-glyph="unknown"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      );
    case "idle":
      return (
        <CirclePauseIcon
          aria-hidden
          data-subagent-status-glyph="idle"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      );
    case "starting":
      return (
        <LoaderCircleIcon
          aria-hidden
          data-subagent-status-glyph="starting"
          className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
      );
  }
}

/**
 * Stands in for the composer on a provider-native subagent thread. The
 * provider runs that conversation, so there is nothing to send; the bar says
 * which model is working, for how long, and leads back to the parent. It stays
 * compact: the model is a glyph with a tooltip (its name shows only in wide
 * panes), the status is a glyph and a few words, and the parent is an icon.
 */
export function ProviderSubagentBar(props: {
  /** The provider running the subagent; a generic glyph while its catalog loads. */
  readonly provider: ProviderInstanceEntry | null;
  /** Several accounts on this provider: badge the glyph, as the composer does. */
  readonly showInstanceBadge: boolean;
  readonly modelLabel: string;
  /** Reasoning effort as the composer names it, when the subagent has one. */
  readonly effortLabel: string | null;
  /** Null until the subagent's root turn arrives. */
  readonly status: ProviderSubagentStatus | null;
  /** What the subagent is doing right now, while it works. */
  readonly step?: string | null;
  readonly onOpenParent: (() => void) | null;
}) {
  const statusRef = useRef<HTMLSpanElement>(null);
  const { status } = props;
  const tone = providerSubagentStatusTone(status);
  const live = tone === "live";
  const modelDescription =
    props.effortLabel === null ? props.modelLabel : `${props.modelLabel}, ${props.effortLabel}`;
  // Announced once per transition; the ticking label below is not.
  const announcement = formatProviderSubagentStatus(
    status === null ? null : { ...status, startedAt: null },
    0,
  );

  // The label is written from an effect, and live bars tick through DOM
  // writes, so a running timer never re-renders the chat view.
  useLayoutEffect(() => {
    const update = () => {
      if (statusRef.current) {
        statusRef.current.textContent = formatProviderSubagentShortStatus(status, Date.now());
      }
    };
    update();
    if (!live) return;
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [live, status]);

  return (
    <div className="@container/subagent-bar flex min-h-12 min-w-0 items-center gap-2 rounded-3xl py-2 ps-4 pe-2 text-sm">
      <Tooltip>
        <TooltipTrigger
          render={
            // Focusable, so keyboard users can open the tooltip in narrow panes.
            <span
              role="img"
              tabIndex={0}
              aria-label={`Model: ${modelDescription}`}
              className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {props.provider ? (
            <ProviderInstanceIcon
              driverKind={props.provider.driverKind}
              displayName={props.provider.displayName}
              accentColor={props.provider.accentColor}
              acpRegistryAgentId={props.provider.acpRegistryAgentId}
              acpRegistryIconUrl={props.provider.acpRegistryIconUrl}
              showBadge={props.showInstanceBadge}
              className="size-4 shrink-0"
              iconClassName="size-4"
              badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
            />
          ) : (
            <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="hidden max-w-48 truncate font-medium text-foreground @[36rem]/subagent-bar:inline">
            {props.modelLabel}
          </span>
          {props.effortLabel === null ? null : (
            <span className="hidden shrink-0 text-muted-foreground @[42rem]/subagent-bar:inline">
              {props.effortLabel}
            </span>
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{modelDescription}</TooltipPopup>
      </Tooltip>
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusGlyph tone={tone} />
        <span ref={statusRef} aria-hidden className="shrink-0 text-muted-foreground tabular-nums" />
        {live && props.step ? (
          <span aria-hidden className="min-w-0 truncate text-muted-foreground">
            · {props.step}
          </span>
        ) : null}
      </span>
      <span role="status" className="sr-only">
        {`${modelDescription} subagent: ${announcement}`}
      </span>
      {/* While it works, the live step says more than this, in little room. */}
      {live ? (
        <span className="ms-auto" />
      ) : (
        <span className="ms-auto hidden shrink-0 text-muted-foreground @[30rem]/subagent-bar:inline">
          Runs on its own
        </span>
      )}
      {props.onOpenParent ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Open parent thread"
                className="shrink-0"
                onClick={props.onOpenParent}
              />
            }
          >
            <ArrowUpLeftIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="top">Open parent thread</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
