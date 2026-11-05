import {
  ACCESS_REQUEST_FOOTNOTE,
  accessRequestAnswerInput,
  accessRequestDisplay,
  accessRequestFailureMessage,
  accessRequestHeadline,
  accessRequestNote,
  accessSubjectGlyph,
  accessSubjectIconUrl,
  accessSubjectTag,
  type AccessRequestItem,
  type AccessSubjectGlyph,
} from "@specweave-studio/client-runtime/access-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import {
  PROVIDER_DISPLAY_NAMES,
  type AccessRequestScope,
  type AccessRequestSubject,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type ServerProvider,
} from "@specweave-studio/contracts";
import {
  AppWindowIcon,
  CheckIcon,
  FolderIcon,
  LaptopIcon,
  MinusIcon,
  ShieldIcon,
  SmartphoneIcon,
  TabletIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkLogRow } from "./WorkLog";
import {
  ACCESS_CARD_CLASS,
  ACCESS_SUBJECT_LIST_CLASS,
  AccessCardTile,
  AccessCardHeader,
  AccessChip,
  AccessChipTag,
  ACCESS_SECONDARY_BUTTON_CLASS,
  ACCESS_PRIMARY_BUTTON_CLASS,
  ACCESS_BUTTON_ROW_CLASS,
} from "./AccessCardChrome";

export {
  ACCESS_CARD_CLASS,
  ACCESS_SUBJECT_LIST_CLASS,
  AccessCardTile,
  AccessCardHeader,
  AccessChip,
  AccessChipTag,
  ACCESS_SECONDARY_BUTTON_CLASS,
  ACCESS_PRIMARY_BUTTON_CLASS,
  ACCESS_BUTTON_ROW_CLASS,
};

export type AccessRequestAnswer =
  | { readonly type: "allow"; readonly scope: AccessRequestScope }
  | { readonly type: "deny" };

/** Resolves with null on success, or the message to show under the buttons. */
export type AccessRequestAnswerHandler = (answer: AccessRequestAnswer) => Promise<string | null>;

/**
 * Who is asking, as the card names it: the provider's brand ("Claude",
 * "Codex"), or an ACP agent's own name. Null lets the copy say "The agent".
 */
export function accessAgentLabel(
  provider: Pick<ServerProvider, "driver" | "displayName"> | null | undefined,
): string | null {
  if (!provider) return null;
  const brand = PROVIDER_DISPLAY_NAMES[provider.driver];
  if (brand !== undefined && brand !== "ACP Registry") return brand;
  return provider.displayName?.trim() || null;
}

// ── The access request card ─────────────────────────────────────────────

const SUBJECT_GLYPHS: Record<AccessSubjectGlyph, LucideIcon> = {
  app: AppWindowIcon,
  phone: SmartphoneIcon,
  tablet: TabletIcon,
  android: SmartphoneIcon,
  machine: LaptopIcon,
  folder: FolderIcon,
};

/**
 * The timeline row for an access request. A pending one is answered on the
 * card above the composer, so the timeline only notes the wait; answered ones
 * keep their one-line outcome.
 */
export function AccessRequestCard(props: {
  readonly item: AccessRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly agentLabel?: string | null;
}) {
  return (
    <AccessRequestCardView
      item={props.item}
      visibility={props.visibility}
      agentLabel={props.agentLabel ?? null}
    />
  );
}

/**
 * The pending card above the composer: apps, devices or machines an agent
 * asked to use. One answer covers every subject on it.
 */
export function PendingAccessRequestPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly item: AccessRequestItem;
  readonly agentLabel: string | null;
  /** A viewer who cannot operate the thread sees the card but cannot answer it. */
  readonly disabled?: boolean;
}) {
  const answer = useAtomCommand(serverEnvironment.answerAccessRequest, {
    label: "answer access request",
    reportFailure: false,
    reportDefect: false,
  });
  const onAnswer: AccessRequestAnswerHandler = async (reply) => {
    const result = await answer({
      environmentId: props.environmentId,
      input: accessRequestAnswerInput(props.item, reply),
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
    return accessRequestFailureMessage(squashAtomCommandFailure(result));
  };
  return (
    <AccessRequestPrompt
      key={props.item.id}
      item={props.item}
      agentLabel={props.agentLabel}
      onAnswer={onAnswer}
      disabled={props.disabled === true}
    />
  );
}

/** The one-line timeline row, without its RPC, so fixtures and tests can render every state. */
export function AccessRequestCardView(props: {
  readonly item: AccessRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly agentLabel?: string | null;
}) {
  const { item } = props;
  const display = accessRequestDisplay(item, props.visibility);
  const Icon =
    display.kind === "answered"
      ? display.outcome === "allowed"
        ? CheckIcon
        : MinusIcon
      : ShieldIcon;
  const label =
    display.kind === "pending"
      ? `Waiting for your answer: ${accessRequestHeadline(props.agentLabel, item.subjects)}`
      : `${display.label}: ${item.accessTitle}`;
  return (
    <WorkLogRow
      data-v2-item-type={item.type}
      data-access-status={item.accessStatus}
      icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
      label={label}
    />
  );
}

/** The pending card itself, without its RPC. */
export function AccessRequestPrompt(props: {
  readonly item: AccessRequestItem;
  readonly agentLabel: string | null;
  readonly onAnswer: AccessRequestAnswerHandler;
  readonly disabled?: boolean;
}) {
  const { item } = props;
  const titleId = useId();
  const headline = accessRequestHeadline(props.agentLabel, item.subjects);
  // Filled after mount, so screen readers announce the card when it appears.
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    setAnnouncement(`Access request: ${headline}`);
  }, [headline]);
  const errorId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A double click can run twice before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (reply: AccessRequestAnswer) => {
    if (inFlight.current || props.disabled) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      // The card goes away once the item updates.
      setError(await props.onAnswer(reply));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };
  const describedBy = error !== null ? errorId : undefined;
  const buttonsDisabled = submitting || props.disabled === true;

  return (
    <section
      role="region"
      data-v2-item-type={item.type}
      data-access-request-card
      aria-labelledby={titleId}
      aria-busy={submitting || undefined}
      className={ACCESS_CARD_CLASS}
    >
      <p className="sr-only" role="status" aria-live="polite" data-access-request-announcement>
        {announcement}
      </p>
      <AccessCardHeader
        titleId={titleId}
        title={headline}
        reason={item.reason.trim() ? item.reason : undefined}
      />

      <ul aria-label="Asked for" className={ACCESS_SUBJECT_LIST_CLASS}>
        {item.subjects.map((subject) => (
          <AccessSubjectChip key={subject.key} subject={subject} />
        ))}
      </ul>

      <p className="text-xs/5 text-muted-foreground">{accessRequestNote(item.subjects)}</p>

      <div className={ACCESS_BUTTON_ROW_CLASS}>
        <button
          type="button"
          className={ACCESS_SECONDARY_BUTTON_CLASS}
          disabled={buttonsDisabled}
          data-access-decision="deny"
          aria-describedby={describedBy}
          onClick={() => void send({ type: "deny" })}
        >
          Deny
        </button>
        <button
          type="button"
          className={ACCESS_PRIMARY_BUTTON_CLASS}
          disabled={buttonsDisabled}
          data-access-decision="allow"
          data-access-scope="thread"
          aria-describedby={describedBy}
          onClick={() => void send({ type: "allow", scope: "thread" })}
        >
          Allow for this session
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="cursor-pointer rounded-sm text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
                disabled={buttonsDisabled}
                data-access-decision="allow-machine"
                data-access-scope="machine"
                aria-description={ACCESS_REQUEST_FOOTNOTE}
                aria-describedby={describedBy}
                onClick={() => void send({ type: "allow", scope: "machine" })}
              />
            }
          >
            Always allow on this machine
          </TooltipTrigger>
          <TooltipPopup>{ACCESS_REQUEST_FOOTNOTE}</TooltipPopup>
        </Tooltip>
      </div>
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function AccessSubjectChip({ subject }: { readonly subject: AccessRequestSubject }) {
  const iconUrl = accessSubjectIconUrl(subject);
  const Glyph = SUBJECT_GLYPHS[accessSubjectGlyph(subject)];
  const detail = subject.detail.trim();
  // An app's detail stays a tooltip; a device, folder or machine shows it, often a path or model.
  const showDetail = subject.kind !== "app" && detail.length > 0;
  return (
    <AccessChip
      data-access-subject={subject.key}
      title={subject.kind === "app" ? detail || undefined : undefined}
      icon={
        iconUrl !== null ? (
          <img src={iconUrl} alt="" className="size-5 rounded-[0.3125rem] object-contain" />
        ) : (
          <span className="flex size-5 items-center justify-center rounded-[0.3125rem] bg-card text-muted-foreground shadow-xs ring-1 ring-border/70 dark:bg-white/[0.08] dark:ring-white/10">
            <Glyph className="size-3" />
          </span>
        )
      }
      label={
        <span className="min-w-0">
          {subject.label}
          {subject.hostLabel ? (
            <span className="font-normal text-muted-foreground"> on {subject.hostLabel}</span>
          ) : null}
          {showDetail ? (
            <span
              className="block text-xs font-normal text-muted-foreground wrap-anywhere"
              data-access-subject-detail
            >
              {detail}
            </span>
          ) : null}
        </span>
      }
      trailing={<AccessChipTag>{accessSubjectTag(subject)}</AccessChipTag>}
    />
  );
}
