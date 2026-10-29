import {
  type LimitHistoryIndex,
  recentLimitAccounts,
} from "@specweave-studio/shared/usageLimitForecast";
import { blockingWindow } from "@specweave-studio/shared/usageWindows";
import {
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  collectUnreportedLimitAccounts,
  cursorUsageWindowDetails,
  describeLimitAccount,
  displayLimitWindows,
  formatDuration,
  formatResetsIn,
  limitAccountKey,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  remainingPercent,
  type UnreportedLimitAccount,
} from "@specweave-studio/shared/usageLimits";
import type { RecentLimitAccount } from "@specweave-studio/shared/usageLimitForecast";
import { AlertTriangleIcon, ExternalLinkIcon, TicketIcon } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { Alert, AlertTitle } from "../ui/alert";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  PaceIcon,
  ResetCreditDialog,
  barColor,
  resetCreditsSummary,
  useResetCredit,
} from "./UsageLimits";
import { blockedLabel, usageToneTextClass } from "../../studio/usageIndicatorModel";
import { instanceLabel, limitAccountLabel } from "./usageAccountLabel";
import { AccountCards, AccountChip, accountCensus } from "./UsageLimitsAccounts";
import { PoolForecastPanel } from "./UsageLimitsPoolForecast";
import { useUsageLimitHistory } from "./usageLimitHistoryState";

/**
 * The same mark the model picker uses for a native instance (provider glyph,
 * initials badge, accent); hub accounts have no instance, so they get the chip.
 */
function AccountAvatar({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.redeem) {
    return (
      <ProviderInstanceIcon
        driverKind={account.driver}
        displayName={
          account.displayName ?? getDriverOption(account.driver)?.label ?? String(account.driver)
        }
        accentColor={account.accentColor}
        showBadge={Boolean(account.displayName)}
        indicatorBackground="var(--popover)"
        className={cn("size-5", className)}
        iconClassName="size-4 text-foreground/80"
      />
    );
  }
  return account.email ? <AccountChip email={account.email} /> : null;
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

/**
 * Everything about one account in one window: the signed-in email, plan,
 * the machine it is signed in on, reset time and share of the pool it restores, and the
 * reset-credit action. Opens on hover for a glance, on click to act.
 */
function SegmentPopover({
  account,
  window,
  resetSinceRead,
  reset,
  now,
  redeem,
  onRedeem,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly resetSinceRead: boolean;
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  /** Redeem state owned by the segment, since the confirm lives outside this popover. */
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly onRedeem: () => void;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const resetsIn = formatResetsIn(window, now);
  const identity = describeLimitAccount(account);
  const checkedAt = Date.parse(account.limits.checkedAt);
  const credits =
    redeem && account.limits.resetCredits?.availableCount ? account.limits.resetCredits : null;
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="truncate">{instanceLabel(account)}</span>
        </span>
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        {account.email ? (
          <Row label="Account">
            <span className="break-all select-text">{account.email}</span>
          </Row>
        ) : identity.accountKind === "name" && identity.account ? (
          <Row label="Account">{identity.account}</Row>
        ) : null}
        {account.plan ? <Row label="Plan">{account.plan}</Row> : null}
        {identity.machine ? (
          <Row
            label={
              identity.machineKind === "source"
                ? "Via"
                : account.environments.length > 1
                  ? "Machines"
                  : "Machine"
            }
          >
            <span className="break-words">{identity.machine}</span>
          </Row>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <Row label="Left">
          {remaining}%{resetSinceRead ? " · reset since the last read" : ""}
        </Row>
        {account.offline && Number.isFinite(checkedAt) ? (
          <Row label="Read">
            {formatDuration(now - checkedAt)} ago ·{" "}
            {account.environments.length > 1 ? "machines" : "machine"} offline
          </Row>
        ) : null}
        {window.resetsAt ? (
          <Row label="Resets">
            {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            {resetsIn ? ` · ${resetsIn.replace("resets in ", "in ")}` : ""}
          </Row>
        ) : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label="Restores">+{reset.restoresPercent}% of pool</Row>
        ) : null}
      </div>
      {credits && redeem ? (
        <div className="border-t border-border/60 pt-2.5 text-muted-foreground">
          <span className="flex items-center gap-3">
            <span className="tabular-nums">{resetCreditsSummary(credits, now, true)}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={redeem.busy || !redeem.canManageProviders}
              className="ms-auto"
              onClick={onRedeem}
            >
              {redeem.busy ? "Using…" : "Use reset"}
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One account's share of one pooled window: the segment, its popover, and the
 * reset confirm. The confirm is a sibling of the popover, not a child: dialogs
 * stack under popovers, and the popover closes as the confirm opens.
 */
function PoolSegment({
  account,
  window,
  resetSinceRead,
  reset,
  color,
  now,
  index,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly resetSinceRead: boolean;
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly color: string;
  readonly now: number;
  /** 1-based position in the bar, shown on the strip and its legend row to tie them together. */
  readonly index: number;
}) {
  const label = limitAccountLabel(account);
  const [open, setOpen] = useState(false);
  const remaining = remainingPercent(window);
  const resetsIn = resetSinceRead ? "reset" : formatResetsIn(window, now);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        render={
          <button
            type="button"
            style={{ gridColumn: index, gridRow: 1 }}
            aria-label={`${label.summary}: ${remaining}% left${resetsIn ? `, ${resetsIn}` : ""}${credits ? `, ${credits} reset ${credits === 1 ? "credit" : "credits"} banked` : ""}`}
            className="relative h-3 min-w-0 cursor-pointer overflow-hidden rounded-full bg-muted text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[popup-open]:ring-1 data-[popup-open]:ring-border"
          />
        }
      >
        {/* Translucent so the label reads over the fill for any provider colour and theme. */}
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 rounded-full opacity-70 motion-safe:transition-[width] motion-safe:duration-700"
          style={{ width: `${remaining}%`, backgroundColor: color }}
        />
        {/* The spent share is hatched, not blank: it is what the countdown restores. */}
        {remaining < 100 && reset ? (
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 opacity-20"
            style={{
              width: `${100 - remaining}%`,
              backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 1px, transparent 1px 5px)`,
            }}
          />
        ) : null}
      </PopoverTrigger>
      {account.redeem ? (
        <RedeemableSegmentPopup
          account={account}
          window={window}
          resetSinceRead={resetSinceRead}
          reset={reset}
          now={now}
          redeemAt={account.redeem}
          closePopover={() => setOpen(false)}
        />
      ) : (
        <PopoverPopup side="top" sideOffset={6}>
          <SegmentPopover
            account={account}
            window={window}
            resetSinceRead={resetSinceRead}
            reset={reset}
            now={now}
            redeem={null}
            onRedeem={() => {}}
          />
        </PopoverPopup>
      )}
    </Popover>
  );
}

/** Split out so the redeem hook only runs for accounts that can redeem. */
function RedeemableSegmentPopup({
  account,
  window,
  resetSinceRead,
  reset,
  now,
  redeemAt,
  closePopover,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly resetSinceRead: boolean;
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
  readonly closePopover: () => void;
}) {
  const redeem = useResetCredit(redeemAt.environmentId, redeemAt.input);
  return (
    <>
      <PopoverPopup side="top" sideOffset={6}>
        <SegmentPopover
          account={account}
          window={window}
          resetSinceRead={resetSinceRead}
          reset={reset}
          now={now}
          redeem={redeem}
          onRedeem={() => {
            closePopover();
            redeem.setConfirming(true);
          }}
        />
      </PopoverPopup>
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
      {/* The popover closed before the confirm, so the outcome needs a home outside it. */}
      {redeem.status ? (
        <span role="status" className="col-span-full text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{limitAccountLabel(account).primary}</span>{" "}
          {redeem.status}
        </span>
      ) : null}
    </>
  );
}

/**
 * One pooled window as a thin strip of equal-width segments, one per account
 * in the same order as the account cards, each filled by what that account
 * has left. Equal widths are honest: every account contributes the same
 * share of the pool, whatever its plan. A segment opens the account's
 * popover, with its reset time and reset credits.
 */
function PoolBar({
  pool,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  const restores = new Map(pool.resets.map((reset) => [reset.member.account.key, reset]));
  return (
    <div className="@container/pool min-w-0">
      <div
        className="grid gap-x-1 gap-y-1"
        style={{ gridTemplateColumns: `repeat(${pool.columns.length}, minmax(0, 1fr))` }}
      >
        {pool.columns.map((member, position) =>
          member.window ? (
            <PoolSegment
              key={member.account.key}
              account={member.account}
              window={member.window}
              resetSinceRead={member.resetSinceRead === true}
              reset={restores.get(member.account.key)}
              color={color}
              now={now}
              index={position + 1}
            />
          ) : null,
        )}
        {pool.columns.map((member, position) =>
          member.window ? (
            <span
              key={`${member.account.key}:legend`}
              aria-hidden
              style={{ gridColumn: position + 1, gridRow: 2 }}
              className="flex min-w-0 items-center gap-1.5 pt-1 text-2xs text-muted-foreground"
            >
              {member.account.email ? <AccountChip email={member.account.email} /> : null}
              <span className="font-medium text-foreground tabular-nums">
                {remainingPercent(member.window)}%
              </span>
              <span className="min-w-0 truncate">{limitAccountLabel(member.account).primary}</span>
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

/**
 * Big pooled number and the segment bar. Accounts keep the same column across
 * windows; each segment's popover shows its own reset time and share restored.
 */
function PoolWindowCard({
  pool,
  history,
  color,
  now,
  label,
  description,
  blockedBy,
}: {
  readonly pool: LimitPoolWindow;
  readonly history: LimitHistoryIndex | null;
  readonly color: string;
  readonly now: number;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly blockedBy?: { readonly label: string; readonly resetsAt: number | null } | undefined;
}) {
  // The soonest reset that hands anything back; an untouched account resets to no effect.
  const nextRefill = pool.resets.find((reset) => reset.restoresPercent > 0);
  if (blockedBy) {
    return (
      <div className="grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted-foreground">{label ?? pool.label}</span>
          <span className="text-sm text-muted-foreground">{blockedLabel(blockedBy, now)}</span>
        </div>
        <div className="opacity-40">
          <PoolBar pool={pool} color={color} now={now} />
        </div>
      </div>
    );
  }
  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{label ?? pool.label}</span>
        <span className="flex items-baseline gap-2">
          <span
            className={`text-3xl font-semibold tabular-nums ${usageToneTextClass(pool.remainingPercent)}`}
          >
            {pool.remainingPercent}%
          </span>
          <span className="text-sm text-muted-foreground">left</span>
          {pool.pace ? <PaceIcon pace={pool.pace} /> : null}
        </span>
        {pool.members.length > 1 ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {accountsWorth(pool)} of {pool.members.length} accounts' quota
          </span>
        ) : null}
        {nextRefill && pool.columns.length > 1 ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            +{nextRefill.restoresPercent}% at the next reset
          </span>
        ) : null}
      </div>
      <PoolBar pool={pool} color={color} now={now} />
      <PoolForecastPanel pool={pool} history={history} color={color} now={now} />
      {description ? (
        <p className="text-xs text-muted-foreground md:col-span-2">{description}</p>
      ) : null}
    </div>
  );
}

/** What the pool holds in whole accounts: 142 points of 200 is "1.4". */
function accountsWorth(pool: LimitPoolWindow): string {
  const worth = (pool.remainingPercent * pool.members.length) / 100;
  return Number.isInteger(worth) ? String(worth) : worth.toFixed(1);
}

function PoolSection({
  driver,
  pool,
  unreported,
  recent,
  history,
  now,
}: {
  readonly driver: LimitAccount["driver"];
  readonly pool: LimitPool | null;
  readonly unreported: readonly UnreportedLimitAccount[];
  readonly recent: readonly RecentLimitAccount[];
  readonly history: LimitHistoryIndex | null;
  readonly now: number;
}) {
  const color = barColor(driver);
  const label = getDriverOption(driver)?.label ?? String(driver);
  const census = accountCensus(pool, unreported);
  const windows = pool ? displayLimitWindows(pool) : [];
  // A pooled window is spent once every account in it is; it then caps the rest.
  const gauges = windows.map((window) => {
    const at = window.resets[window.resets.length - 1]?.at;
    const scope = window.columns.find((column) => column.window?.modelScope)?.window?.modelScope;
    return {
      source: window,
      id: window.id,
      label: window.label,
      usedPercent: 100 - window.remainingPercent,
      ...(at === undefined || at <= now ? {} : { resetsAt: new Date(at).toISOString() }),
      ...(scope ? { modelScope: scope } : {}),
    };
  });
  const blockerOf = (window: LimitPoolWindow) => {
    const gauge = gauges.find((entry) => entry.source === window);
    const blocker = gauge ? blockingWindow(gauge, gauges, now) : null;
    if (!blocker) return undefined;
    // The pool opens again as soon as its first account resets.
    const reopens = blocker.source.resets.find((reset) => reset.at > now)?.at ?? null;
    return { label: blocker.label, resetsAt: reopens };
  };
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={label}
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        {label}
        {census ? (
          <span className="text-xs font-normal text-muted-foreground">{census}</span>
        ) : null}
      </h2>
      <AccountCards pool={pool} unreported={unreported} recent={recent} color={color} now={now} />
      {windows.map((window) => {
        const details = driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
        return (
          <PoolWindowCard
            key={`${window.kind}:${window.id}`}
            pool={window}
            history={history}
            color={color}
            now={now}
            label={details?.label}
            description={details?.description}
            blockedBy={blockerOf(window)}
          />
        );
      })}
    </section>
  );
}

/**
 * Accounts pooled per provider: what is open across all of them, who resets
 * next, and how much of the pool that hands back. Answers "can I keep going"
 * before "on which account".
 */
export function UsageLimitsPooled({
  presentations,
  now,
  cursorPrompt,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
  readonly cursorPrompt?: ReactNode;
}) {
  const accounts = collectLimitAccounts(presentations);
  const pools = collectLimitPools(accounts, now);
  const unreported = collectUnreportedLimitAccounts(presentations, accounts);
  const history = useUsageLimitHistory(
    // An offline machine cannot answer; its accounts' last reads still show.
    [...presentations]
      .filter(
        ([, presentation]) =>
          presentation.connection === undefined || presentation.connection.phase === "connected",
      )
      .map(([environmentId]) => environmentId),
    now,
  );
  const notices = collectLimitNotices(presentations, { excludeSubscriptionAgents: true });
  const reported = new Set(
    [
      ...accounts.map((account) => limitAccountKey(account.driver, account.email, account.limits)),
      ...unreported.map((entry) => limitAccountKey(entry.driver, entry.email)),
    ].filter((key): key is string => key !== null),
  );
  const recent = history ? recentLimitAccounts(history, reported) : [];
  // A provider shows when it has pooled accounts, or only accounts it cannot pool.
  const drivers = [
    ...new Set<LimitAccount["driver"]>([
      ...pools.map((pool) => pool.driver),
      ...unreported.map((entry) => entry.driver),
      ...recent.map((entry) => entry.driver as LimitAccount["driver"]),
    ]),
  ];
  const sections = drivers.map((driver) => ({
    driver,
    pool: pools.find((pool) => pool.driver === driver) ?? null,
    unreported: unreported.filter((entry) => entry.driver === driver),
    recent: recent.filter((entry) => entry.driver === driver),
  }));
  const externalLinks = collectExternalUsageLinks(presentations);
  const cursorPromptAt =
    Math.max(
      sections.findIndex((section) => section.driver === "codex"),
      sections.findIndex((section) => section.driver === "claudeAgent"),
    ) + 1;
  return (
    <div className="flex flex-col gap-8">
      {sections.length === 0 &&
      notices.length === 0 &&
      !cursorPrompt &&
      externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      {sections.map((section, index) => (
        <Fragment key={section.driver}>
          {index === cursorPromptAt ? cursorPrompt : null}
          <PoolSection {...section} history={history} now={now} />
        </Fragment>
      ))}
      {cursorPromptAt === sections.length ? cursorPrompt : null}
      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {link.url === CHATGPT_USAGE_URL ? (
              <OpenAI className="size-5 shrink-0" aria-hidden="true" />
            ) : null}
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">{link.label}</h2>
              {link.url === CHATGPT_USAGE_URL ? (
                <p className="text-xs text-muted-foreground">
                  View usage in ChatGPT with your connected account.
                </p>
              ) : link.message ? (
                <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            Manage usage
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}
      <LimitNotices notices={notices} />
    </div>
  );
}

/** Sources and providers that could not be read, so a missing bar is not mistaken for a full one. */
function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}
