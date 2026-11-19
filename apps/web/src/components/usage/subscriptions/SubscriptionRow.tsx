import { formatDuration } from "@specweave-studio/shared/usageLimits";
import { useState } from "react";

import { getDriverOption } from "../../settings/providerDriverMeta";
import { Button } from "../../ui/button";
import { AccountHeader } from "../AccountHeader";
import type { SubscriptionRow as Row, SubscriptionWindow } from "./subscriptionRows";

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
export const formatDay = (at: number) => dayFormat.format(new Date(at));
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
/** The reset as a local date and time: "Nov 21, 2:00 PM". */
export const formatDateTime = (at: number) => dateTimeFormat.format(new Date(at));

function WindowLine({
  window,
  color,
  now,
}: {
  readonly window: SubscriptionWindow;
  readonly color: string;
  readonly now: number;
}) {
  const countdown =
    window.resetsAt === null
      ? "No reset reported"
      : `${formatDuration(window.resetsAt - now)} · ${formatDateTime(window.resetsAt)}`;
  return (
    <div
      className="grid grid-cols-[5.5rem_minmax(2rem,1fr)_auto] items-center gap-x-2 text-xs"
      data-subscription-window={window.id}
      data-expiring={window.expiring ? "" : undefined}
    >
      <span className="truncate text-muted-foreground">{window.title}</span>
      <div
        role="img"
        aria-label={`${window.title}: ${window.leftPercent}% left`}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={window.expiring ? "h-full rounded-full bg-warning" : "h-full rounded-full"}
          style={{
            width: `${window.leftPercent}%`,
            ...(window.expiring ? {} : { backgroundColor: color }),
          }}
        />
      </div>
      <span
        className={
          window.expiring
            ? "font-medium text-warning-foreground tabular-nums"
            : "text-muted-foreground tabular-nums"
        }
      >
        {window.leftPercent}% left · {countdown}
      </span>
    </div>
  );
}

function RenewalDay({
  row,
  onSetDay,
}: {
  readonly row: Row;
  readonly onSetDay: (renewalKey: string, day: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const renewalKey = row.renewalKey;
  if (renewalKey === null) {
    return <span>No renewal day: this account reports nothing to save it under.</span>;
  }
  if (editing) {
    const day = Number(value);
    const valid = Number.isInteger(day) && day >= 1 && day <= 31;
    return (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onSetDay(renewalKey, day);
          setEditing(false);
        }}
      >
        <label className="flex items-center gap-1.5">
          Renews on day
          <input
            type="number"
            min={1}
            max={31}
            inputMode="numeric"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label="Day of the month the subscription renews"
            className="h-6 w-12 rounded-md border border-input bg-background px-1.5 text-xs text-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <Button type="submit" size="xs" variant="outline" disabled={!valid}>
          Save
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </form>
    );
  }
  const renewal = row.renewal;
  const text =
    renewal === null
      ? "Renewal: Not reported"
      : renewal.source === "set"
        ? `Renews ${formatDay(renewal.at)} (set by you)`
        : `Renews ${formatDay(renewal.at)} (reported by ${renewal.vendor ?? "the provider"})`;
  return (
    <span className="flex flex-wrap items-center gap-x-1.5" data-renewal={renewal?.source ?? "none"}>
      {text}
      <button
        type="button"
        className="rounded-sm text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          setValue(renewal?.source === "set" ? String(renewal.day ?? new Date(renewal.at).getDate()) : "");
          setEditing(true);
        }}
      >
        {renewal?.source === "set" ? "Change" : "Set day"}
      </button>
    </span>
  );
}

/**
 * One subscription: who and where, what is left in each window and when it
 * resets, then renewal, banked resets and what the last reset left unused.
 */
export function SubscriptionRow({
  row,
  color,
  now,
  onSetDay,
}: {
  readonly row: Row;
  readonly color: string;
  readonly now: number;
  readonly onSetDay: (renewalKey: string, day: number) => void;
}) {
  const label = row.displayName ?? getDriverOption(row.driver)?.label ?? String(row.driver);
  const loss = row.lastLoss;
  return (
    <div
      className="grid grid-cols-1 gap-x-6 gap-y-2 border-t border-border/60 px-3 py-3 first:border-t-0 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1fr)]"
      data-subscription-row={row.key}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <AccountHeader driver={row.driver} label={label} plan={row.plan} email={row.email} />
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {row.machines.map((machine) => (
            <span key={machine} className="rounded-full border border-border px-1.5">
              {machine}
            </span>
          ))}
          {row.offline ? (
            <span>
              offline
              {row.checkedAt === null ? "" : `, read ${formatDuration(now - row.checkedAt)} ago`}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-1">
        {row.windows.length === 0 ? (
          <span className="text-xs text-muted-foreground">No window reported since its reset</span>
        ) : (
          row.windows.map((window) => (
            <WindowLine key={window.id} window={window} color={color} now={now} />
          ))
        )}
        {row.note ? (
          <span className="text-xs text-muted-foreground" data-subscription-note={row.note.id}>
            {row.note.note}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-0.5 text-xs text-muted-foreground">
        <RenewalDay row={row} onSetDay={onSetDay} />
        {row.credits ? (
          <span>
            {row.credits.count} banked {row.credits.count === 1 ? "reset" : "resets"}
            {row.credits.nextExpiresAt === null
              ? ""
              : `, next expires ${formatDay(row.credits.nextExpiresAt)}`}
          </span>
        ) : null}
        <span data-subscription-loss="">
          Lost at last reset:{" "}
          {loss === null ? (
            "Not reported"
          ) : (
            <span
              className={
                loss.lostPercent >= 20 ? "text-destructive-foreground" : "text-success-foreground"
              }
            >
              {loss.upperBound ? "up to " : ""}
              {loss.lostPercent}%
            </span>
          )}
          {loss === null ? "" : ` · ${formatDay(loss.endedAt)}`}
          {loss?.cause === "early" ? " · reset early" : ""}
          {loss?.cause === "redeemed" ? " · banked reset used" : ""}
        </span>
      </div>
    </div>
  );
}
