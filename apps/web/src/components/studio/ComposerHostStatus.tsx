import { useId, useState } from "react";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useLocale, useT, useTx, type Locale } from "../../i18n";
import { machineLastSeenAt, useMachineLastSeenVersion } from "../../lib/machineLastSeen";
import { nowFromMinute } from "../../studio/shellModel";
import type { ComposerHostStatus as Status } from "../../studio/projectWorkspaceModel";

const DOT_TONE: Record<Status["tone"], string> = {
  offline: "failed",
  "signed-out": "failed",
  connecting: "waiting",
  busy: "waiting",
};

const UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "Synced just now", "Last synced 12 minutes ago", in the interface language. */
export function syncedAgoPhrase(
  lastSyncedAt: number | null,
  now: number,
  locale: Locale,
): { readonly phrase: string; readonly age?: string } {
  if (lastSyncedAt === null) return { phrase: "Never synced on this device." };
  const elapsed = Math.max(0, now - lastSyncedAt);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  for (const [unit, size] of UNITS)
    if (elapsed >= size)
      return {
        phrase: "Last synced {age}.",
        age: format.format(-Math.floor(elapsed / size), unit),
      };
  return { phrase: "Synced just now." };
}

/** A translated phrase with the machine's name as its own element, so only the name ellipsizes. */
function WithMachine({ text, machine }: { text: string; machine: string | null }) {
  const at = text.indexOf("{machine}");
  if (at < 0 || machine === null) return <span className="sws-host-status-words">{text}</span>;
  const before = text.slice(0, at);
  const after = text.slice(at + "{machine}".length);
  return (
    <>
      {before ? <span className="sws-host-status-words">{before}</span> : null}
      <span className="sws-host-status-machine" title={machine} data-machine-name="">
        {machine}
      </span>
      {after ? <span className="sws-host-status-words">{after}</span> : null}
    </>
  );
}

/**
 * The one line above the coordinator's message box that says why it cannot send:
 * a dot, the machine and its state, what happens next, and Details for the rest.
 * Details opens in place, under the line: nothing here ever covers the message box.
 */
export function ComposerHostStatus({ status, now }: { status: Status; now: number }) {
  const tx = useTx();
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const machine = status.machine;
  const fill = (phrase: string, values?: Record<string, string>) =>
    tx(phrase, { ...values, ...(machine === null ? {} : { machine }) });
  const headline = tx(status.headline);
  const synced = status.showsSync ? syncedAgoPhrase(status.lastSyncedAt, now, locale) : null;
  const detail = [
    ...(synced ? [tx(synced.phrase, synced.age ? { age: synced.age } : undefined)] : []),
    ...status.detail.map((line) => fill(line)),
  ];
  const full = [
    fill(status.headline),
    status.progress && tx(status.progress),
    status.action && tx(status.action),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="sws-host-status-wrap">
      <div className="sws-host-status" data-host-status={status.tone}>
        <span role="status" className="sws-host-status-live">
          <span className="sr-only">{full}</span>
          <span className="sws-host-status-line" title={full} aria-hidden>
            <span className="sws-dot" data-tone={DOT_TONE[status.tone]} />
            <span className="sws-host-status-text">
              <WithMachine text={headline} machine={machine} />
            </span>
          </span>
          {status.progress ? (
            <span className="sws-host-status-next" aria-hidden>
              {tx(status.progress)}
            </span>
          ) : null}
          {status.action ? (
            <span className="sws-host-status-next" aria-hidden>
              {tx(status.action)}
            </span>
          ) : null}
        </span>
        {detail.length > 0 ? (
          <button
            type="button"
            className="sws-host-status-toggle"
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? tx("Hide details") : tx("Details")}
          </button>
        ) : null}
      </div>
      {open && detail.length > 0 ? (
        <p id={detailId} className="sws-host-status-detail" data-host-status-detail="">
          {detail.join(t("common.sentenceSpace"))}
        </p>
      ) : null}
    </div>
  );
}

/** The status line on a project page: it reads when this device last synced the machine. */
export function ProjectComposerHostStatus({
  status,
  environmentId,
}: {
  status: Status;
  environmentId: string;
}) {
  useMachineLastSeenVersion();
  const now = nowFromMinute(useNowMinute());
  return (
    <ComposerHostStatus
      status={{ ...status, lastSyncedAt: machineLastSeenAt(environmentId) }}
      now={now}
    />
  );
}
