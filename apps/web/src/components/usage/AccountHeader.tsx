/**
 * One account, named the same way on every usage surface: the provider's logo,
 * its name, the plan, the signed-in email and a one-click link to the provider's
 * own usage page. Where it was read and its fallback place are small marks with
 * the sentence in their tooltip. Nothing is printed for what is not known.
 */
import type { ProviderDriverKind } from "@specweave-studio/contracts";
import {
  providerUsageLink,
  type ProviderUsageLink,
} from "@specweave-studio/shared/providerUsageLinks";
import { ArrowUpRightIcon, MonitorIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { ensureLocalApi } from "../../localApi";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Tip } from "../studio/shell/Tip";
import "./account-header.css";

interface AccountHeaderProps {
  readonly driver: ProviderDriverKind | string;
  readonly label: string;
  readonly iconUrl?: string | undefined;
  readonly agentId?: string | undefined;
  readonly plan?: string | null | undefined;
  readonly email?: string | null | undefined;
  /** Where the reading comes from: `M4`, with the sentence for its tooltip. */
  readonly machine?: { readonly name: string; readonly tip: string } | null | undefined;
  /** Its place in the fallback order, with the model it stands for. */
  readonly rank?: { readonly position: number; readonly label: string } | null | undefined;
  /** False for an API key or cloud account: no plan page to open. */
  readonly subscription?: boolean;
  /** A role beside the name, such as `Coordinator`. */
  readonly tag?: string | null | undefined;
  readonly size?: "sm" | "md";
}

/**
 * Opens the provider's page in the system browser. Without a local API the link
 * opens in a new tab on its own; when the desktop bridge refuses, a tab opens instead.
 */
function openOutside(event: MouseEvent<HTMLAnchorElement>, url: string) {
  let api: ReturnType<typeof ensureLocalApi>;
  try {
    api = ensureLocalApi();
  } catch {
    return;
  }
  event.preventDefault();
  void api.shell.openExternal(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

export function AccountHeader(props: AccountHeaderProps) {
  const link = providerUsageLink({
    driver: props.driver,
    agentId: props.agentId,
    label: props.label,
    ...(props.subscription === undefined ? {} : { subscription: props.subscription }),
  });
  const icon = props.size === "md" ? "size-4" : "size-3.5";
  return (
    <div className="sws-account-header" data-account-header="">
      <ProviderInstanceIcon
        driverKind={props.driver as ProviderDriverKind}
        displayName={props.label}
        acpRegistryAgentId={props.agentId}
        acpRegistryIconUrl={props.iconUrl}
        showBadge={false}
        className={`${icon} sws-account-logo`}
        iconClassName={`${icon} text-foreground/80`}
      />
      <span className="sws-account-main">
        <span className="sws-account-name">{props.label}</span>
        {props.tag ? <span className="sws-account-plan sws-hl-tag">{props.tag}</span> : null}
        {props.plan ? <span className="sws-account-plan">{props.plan}</span> : null}
        {props.email ? (
          <Tip label={props.email} side="top">
            <span className="sws-account-email" tabIndex={0}>
              {props.email}
            </span>
          </Tip>
        ) : null}
      </span>
      <span className="sws-account-marks">
        {props.rank ? (
          <Tip label={`Fallback ${props.rank.position}: ${props.rank.label}`} side="top">
            <span
              className="sws-account-rank"
              role="img"
              tabIndex={0}
              aria-label={`Fallback ${props.rank.position}: ${props.rank.label}`}
            >
              {props.rank.position}
            </span>
          </Tip>
        ) : null}
        {props.machine ? (
          <Tip label={props.machine.tip} side="top">
            <span className="sws-account-machine" tabIndex={0}>
              <MonitorIcon aria-hidden />
              {props.machine.name}
              <span className="sr-only">: {props.machine.tip}</span>
            </span>
          </Tip>
        ) : null}
        {link ? <UsagePageLink link={link} /> : null}
      </span>
    </div>
  );
}

/** The arrow that opens a provider's own usage page, with its name as tooltip. */
export function UsagePageLink(props: {
  readonly link: ProviderUsageLink;
  /** -1 inside a list that keeps its own keyboard order. */
  readonly tabIndex?: number;
}) {
  const { link } = props;
  return (
    <Tip label={`Open ${link.label}`} side="top">
      <a
        className="sws-account-link"
        href={link.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${link.label}`}
        data-usage-link={link.kind}
        {...(props.tabIndex === undefined ? {} : { tabIndex: props.tabIndex })}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          openOutside(event, link.url);
        }}
      >
        <ArrowUpRightIcon aria-hidden />
      </a>
    </Tip>
  );
}

/** `2d`, `5h`, `12m`: the largest unit of a reset, for a column of short times. */
export function shortDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes >= 1_440) return `${Math.floor(minutes / 1_440)}d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
  return `${minutes}m`;
}
