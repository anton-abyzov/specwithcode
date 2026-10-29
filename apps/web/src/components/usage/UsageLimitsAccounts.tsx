import type { RecentLimitAccount } from "@specweave-studio/shared/usageLimitForecast";
import {
  formatDuration,
  type LimitAccount,
  type LimitPool,
  remainingPercent,
  type UnreportedLimitAccount,
} from "@specweave-studio/shared/usageLimits";
import type { ServerProviderUsageWindow } from "@specweave-studio/contracts";
import { CircleSlashIcon, HistoryIcon, KeyRoundIcon, TicketIcon, UserXIcon } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { usageTone, usageToneTextClass } from "../../studio/usageIndicatorModel";
import { limitAccountLabel } from "./usageAccountLabel";

/** `someone@example.com` → `SE`: enough to tell accounts apart, too little to identify one. */
export function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

/** A stable hue per email, so the same account gets the same chip on every visit. */
function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** The two-letter chip for an email, coloured by a stable hue per address. */
export function AccountChip({
  email,
  className,
}: {
  readonly email: string;
  readonly className?: string;
}) {
  const hue = accountHue(email);
  return (
    <span
      role="img"
      aria-label={`Account ${accountInitials(email)}`}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold",
        className,
      )}
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}

const WINDOW_ORDER: Record<string, number> = { session: 0, weekly: 1, monthly: 2, other: 3 };

/** "Session", "Weekly", "Fable": the scoped weekly is named by its model alone. */
function ringLabel(window: Pick<ServerProviderUsageWindow, "label" | "modelScope">): string {
  return window.modelScope ?? window.label;
}

/**
 * One window of one account as a radial meter: the arc is what is left, the
 * track the same hue lighter, so the whole ring reads as one quota. The
 * number in the middle carries the value; the arc's colour only adds the
 * tone. The arc sweeps in once when it mounts, and not at all under reduced
 * motion.
 */
function LimitRing({
  leftPercent,
  color,
  label,
  caption,
  size = 64,
  muted = false,
}: {
  readonly leftPercent: number;
  readonly color: string;
  readonly label: string;
  readonly caption: string | null;
  readonly size?: number;
  readonly muted?: boolean;
}) {
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const tone = usageTone(leftPercent);
  const arc = muted
    ? "var(--muted-foreground)"
    : tone === "full"
      ? "var(--destructive)"
      : tone === "warn"
        ? "var(--warning)"
        : color;
  const shown = drawn ? Math.max(0, Math.min(100, leftPercent)) : 0;
  return (
    <div
      className="flex min-w-0 flex-col items-center gap-1"
      role="img"
      aria-label={`${label}: ${leftPercent}% left${caption ? `, ${caption}` : ""}`}
      data-limit-ring=""
    >
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            style={{ stroke: `color-mix(in oklab, ${arc} 16%, transparent)` }}
          />
          {leftPercent > 0 ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - shown / 100)}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-700 motion-safe:ease-out"
              style={{ stroke: arc }}
            />
          ) : null}
        </svg>
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 flex items-center justify-center text-sm font-semibold",
            muted ? "text-muted-foreground" : usageToneTextClass(leftPercent),
          )}
        >
          {leftPercent}%
        </span>
      </div>
      <span aria-hidden className="max-w-full truncate text-2xs font-medium text-foreground">
        {label}
      </span>
      <span aria-hidden className="max-w-full truncate text-2xs text-muted-foreground tabular-nums">
        {caption ?? " "}
      </span>
    </div>
  );
}

/** `↻ 2h 14m`, `reset`, or null without a reset time. */
function resetCaption(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  return resetsAt <= now ? "reset" : `↻ ${formatDuration(resetsAt - now)}`;
}

function resetAt(window: ServerProviderUsageWindow): number | null {
  if (!window.resetsAt) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

function sortedWindows<T extends { readonly kind: string }>(windows: readonly T[]): T[] {
  return [...windows].sort(
    (left, right) => (WINDOW_ORDER[left.kind] ?? 9) - (WINDOW_ORDER[right.kind] ?? 9),
  );
}

/** Where an account is signed in: a dot per machine, live or holding its last read. */
function MachineChips({ account, now }: { readonly account: LimitAccount; readonly now: number }) {
  const checkedAt = Date.parse(account.limits.checkedAt);
  const machines =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label)
      : account.sourceLabel
        ? [account.sourceLabel]
        : [];
  if (machines.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {machines.map((machine) => (
        <span
          key={machine}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-2xs text-foreground"
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              account.offline ? "bg-muted-foreground/50" : "bg-success",
            )}
          />
          <span className="truncate">{machine}</span>
          {account.offline ? (
            <span className="shrink-0 text-muted-foreground">
              offline
              {Number.isFinite(checkedAt) ? ` · read ${formatDuration(now - checkedAt)} ago` : ""}
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

/**
 * One subscription: who it is, where it is signed in, and a ring per window
 * with its own reset countdown. The ring order matches every other account,
 * so a row of cards compares at a glance.
 */
function AccountCard({
  account,
  color,
  now,
  index,
}: {
  readonly account: LimitAccount;
  readonly color: string;
  readonly now: number;
  readonly index: number;
}) {
  const label = limitAccountLabel(account);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  const windows = sortedWindows(account.limits.windows);
  return (
    <article
      aria-label={label.summary}
      data-limit-account=""
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-xs/5 motion-safe:animate-[usage-card-in_420ms_ease-out_both]"
      style={{ animationDelay: `${Math.min(index, 6) * 50}ms` } as CSSProperties}
    >
      <header className="flex min-w-0 items-start gap-2.5">
        {account.email ? (
          <AccountChip email={account.email} className="mt-0.5 size-6 text-2xs" />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground select-text">
            {label.primary}
          </span>
          {account.plan ? (
            <span className="truncate text-xs text-muted-foreground">{account.plan}</span>
          ) : null}
        </div>
        {credits ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-foreground"
            title={`${credits} reset ${credits === 1 ? "credit" : "credits"} banked`}
          >
            <TicketIcon className="size-3" aria-hidden />
            {credits}
          </span>
        ) : null}
      </header>
      <MachineChips account={account} now={now} />
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, windows.length)}, minmax(0, 1fr))` }}
      >
        {windows.map((window) => {
          const at = resetAt(window);
          const passed = at !== null && at <= now;
          return (
            <LimitRing
              key={`${window.kind}:${window.id}`}
              leftPercent={passed ? 100 : remainingPercent(window)}
              color={color}
              label={ringLabel(window)}
              caption={resetCaption(at, now)}
              muted={account.offline && !passed}
            />
          );
        })}
      </div>
    </article>
  );
}

const UNREPORTED_COPY: Record<
  UnreportedLimitAccount["reason"],
  { readonly title: string; readonly icon: typeof KeyRoundIcon }
> = {
  apiBilling: { title: "Billed to the API", icon: KeyRoundIcon },
  signedOut: { title: "Not signed in", icon: UserXIcon },
  unread: { title: "Limits not read", icon: CircleSlashIcon },
};

/**
 * A subscription agent that reports no usable windows, drawn where its
 * account would be so a missing subscription is visible, with the reason.
 */
function UnreportedCard({ entry }: { readonly entry: UnreportedLimitAccount }) {
  const copy = UNREPORTED_COPY[entry.reason];
  const Icon = copy.icon;
  return (
    <article
      aria-label={`${entry.environmentLabel}: ${copy.title}`}
      data-limit-unreported={entry.reason}
      className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-dashed border-border p-4 motion-safe:animate-[usage-card-in_420ms_ease-out_both]"
    >
      <header className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-warning-surface text-warning-foreground">
          <Icon className="size-3.5" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">{copy.title}</span>
          <span className="truncate text-xs text-muted-foreground">
            {[entry.email, entry.plan].filter(Boolean).join(" · ") || "Account not reported"}
          </span>
        </div>
      </header>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-2xs text-foreground">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              entry.offline ? "bg-muted-foreground/50" : "bg-warning",
            )}
          />
          <span className="truncate">{entry.environmentLabel}</span>
          {entry.offline ? <span className="text-muted-foreground">offline</span> : null}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{entry.message}</p>
    </article>
  );
}

/**
 * An account a machine read within the last few days that nothing reports
 * now. The rings show its last read, dimmed, so it is not taken for live.
 */
function RecentCard({ entry, now }: { readonly entry: RecentLimitAccount; readonly now: number }) {
  const windows = sortedWindows(entry.windows).filter((window) =>
    ["session", "weekly"].includes(window.kind),
  );
  return (
    <article
      aria-label={`${entry.email}: not reported now`}
      data-limit-recent=""
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-dashed border-border p-4 opacity-90 motion-safe:animate-[usage-card-in_420ms_ease-out_both]"
    >
      <header className="flex min-w-0 items-start gap-2.5">
        <AccountChip email={entry.email} className="mt-0.5 size-6 text-2xs opacity-70" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground select-text">
            {entry.email}
          </span>
          <span className="inline-flex min-w-0 items-start gap-1 text-xs text-muted-foreground">
            <HistoryIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
            No machine reports it now · last read {formatDuration(now - entry.lastReadAt)} ago
          </span>
        </div>
      </header>
      {windows.length > 0 ? (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${windows.length}, minmax(0, 1fr))` }}
        >
          {windows.map((window) => {
            const passed = window.resetsAt !== null && window.resetsAt <= now;
            return (
              <LimitRing
                key={`${window.kind}:${window.id}`}
                leftPercent={passed ? 100 : Math.round(100 - Math.min(100, window.usedPercent))}
                color="var(--muted-foreground)"
                label={
                  window.id.startsWith("seven_day_")
                    ? "Model weekly"
                    : window.kind === "session"
                      ? "Session"
                      : "Weekly"
                }
                caption={resetCaption(window.resetsAt, now)}
                muted
              />
            );
          })}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Every account for one provider, one card each: the pooled ones live, then
 * the ones a machine has but cannot pool (API billing, signed out, unread),
 * then the ones read recently that nothing reports now.
 */
export function AccountCards({
  pool,
  unreported,
  recent,
  color,
  now,
}: {
  readonly pool: LimitPool | null;
  readonly unreported: readonly UnreportedLimitAccount[];
  readonly recent: readonly RecentLimitAccount[];
  readonly color: string;
  readonly now: number;
}) {
  const accounts = pool?.accounts ?? [];
  if (accounts.length + unreported.length + recent.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" data-limit-accounts="">
      {accounts.map((account, index) => (
        <AccountCard key={account.key} account={account} color={color} now={now} index={index} />
      ))}
      {unreported.map((entry) => (
        <UnreportedCard key={entry.key} entry={entry} />
      ))}
      {recent.map((entry) => (
        <RecentCard key={entry.accountKey} entry={entry} now={now} />
      ))}
    </div>
  );
}

/** "3 accounts on 2 machines", the census a provider heading carries. */
export function accountCensus(
  pool: LimitPool | null,
  unreported: readonly UnreportedLimitAccount[],
): string | null {
  const accounts = pool?.accounts.length ?? 0;
  const machines = new Set([
    ...(pool?.accounts ?? []).flatMap((account) =>
      account.environments.map((environment) => environment.label),
    ),
    ...unreported.map((entry) => entry.environmentLabel),
  ]);
  if (accounts === 0 && unreported.length === 0) return null;
  const counted = `${accounts} ${accounts === 1 ? "account" : "accounts"} pooled`;
  return machines.size > 0
    ? `${counted} · ${machines.size} ${machines.size === 1 ? "machine" : "machines"}`
    : counted;
}
