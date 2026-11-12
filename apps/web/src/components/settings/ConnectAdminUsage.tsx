import type {
  RelayAdminUsageResponse,
  RelayAdminUsageWeek,
} from "@specweave-studio/contracts/relayAdmin";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { type ConnectAdminFailure, readConnectAdmin } from "~/cloud/connectAdminState";
import { type PublicDownloads, readPublicDownloads } from "~/cloud/publicDownloads";
import { useTx } from "../../i18n";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  failureCopy,
  failureIsFinal,
  formatAdminTime,
  LOADING,
  type Loadable,
} from "./ConnectAdminSettings.logic";
import { formatCount, usageRows, weekBars } from "./ConnectAdminUsage.logic";
import { SettingsSection } from "./settingsLayout";

const ROW = "px-3 py-3 sm:px-4";
const MUTED = "text-xs leading-normal text-muted-foreground";
const HEADING = "text-xs font-semibold text-foreground";
const NUMBER = "text-right text-xs tabular-nums text-foreground";

function Tile({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={MUTED}>{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

/** One count per week as bars, oldest week first, each with its number under it. */
function WeeklyBars({
  title,
  weeks,
  locale,
}: {
  readonly title: string;
  readonly weeks: ReadonlyArray<RelayAdminUsageWeek>;
  readonly locale: string | undefined;
}) {
  const tx = useTx();
  const bars = weekBars(weeks, locale);
  const first = bars[0];
  const last = bars.at(-1);
  return (
    <figure className="min-w-0 space-y-1.5" data-testid="connect-admin-usage-weeks">
      <figcaption className={HEADING}>{title}</figcaption>
      <ol className="flex h-24 items-stretch gap-1">
        {bars.map((bar) => (
          <li key={bar.weekStart} className="flex min-w-0 flex-1 flex-col justify-end gap-1">
            <span className="sr-only">
              {tx("Week of {date}: {count}", {
                date: bar.date,
                count: formatCount(bar.count, locale),
              })}
            </span>
            <span className="flex min-h-0 flex-1 items-end" aria-hidden="true">
              <span
                data-bar=""
                className="w-full rounded-sm bg-primary/70"
                style={{ height: `${bar.height}%` }}
              />
            </span>
            <span
              aria-hidden="true"
              className="text-center text-3xs leading-none tabular-nums text-muted-foreground"
            >
              {formatCount(bar.count, locale)}
            </span>
          </li>
        ))}
      </ol>
      {first !== undefined && last !== undefined ? (
        <p className={`${MUTED} flex justify-between`} aria-hidden="true">
          <span>{first.date}</span>
          <span>{last.date}</span>
        </p>
      ) : null}
    </figure>
  );
}

function UsageNumbers({
  usage,
  locale,
}: {
  readonly usage: RelayAdminUsageResponse;
  readonly locale: string | undefined;
}) {
  const tx = useTx();
  const count = (value: number) => formatCount(value, locale);
  const { signUps, connect } = usage;
  return (
    <div className={`${ROW} space-y-4`} data-testid="connect-admin-usage">
      {signUps === null ? (
        <p className={MUTED} role="status">
          {tx(
            "Sign-ups could not be read from Clerk. The numbers from SpecWithCode Connect are shown.",
          )}
        </p>
      ) : (
        <dl>
          <Tile label={tx("Signed up in total")}>{count(signUps.total)}</Tile>
        </dl>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-72 border-collapse">
          <thead>
            <tr className="border-b border-border/50">
              <td />
              <th scope="col" className={`${MUTED} py-1.5 pl-3 text-right font-normal`}>
                {tx("Last 24 hours")}
              </th>
              <th scope="col" className={`${MUTED} py-1.5 pl-3 text-right font-normal`}>
                {tx("Last 7 days")}
              </th>
              <th scope="col" className={`${MUTED} py-1.5 pl-3 text-right font-normal`}>
                {tx("Last 30 days")}
              </th>
            </tr>
          </thead>
          <tbody>
            {usageRows(tx, usage).map((row) => (
              <tr key={row.id} className="border-b border-border/50 last:border-b-0">
                <th scope="row" className="py-1.5 text-left text-xs font-normal text-foreground">
                  {row.label}
                </th>
                <td className={`${NUMBER} py-1.5 pl-3`}>{count(row.windows.day)}</td>
                <td className={`${NUMBER} py-1.5 pl-3`}>{count(row.windows.week)}</td>
                <td className={`${NUMBER} py-1.5 pl-3`}>{count(row.windows.month)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {signUps !== null && !signUps.complete ? (
        <p className={MUTED}>
          {tx(
            "Clerk returned only part of the people in these periods. The sign-up numbers are at least this many.",
          )}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {signUps !== null ? (
          <WeeklyBars title={tx("Sign-ups per week")} weeks={signUps.weekly} locale={locale} />
        ) : null}
        <WeeklyBars
          title={tx("New accounts on Connect per week")}
          weeks={connect.weekly}
          locale={locale}
        />
      </div>
      <p className={MUTED}>
        {tx(
          "These numbers count people signed in to SpecWithCode Connect. The app sends no usage data, so use without signing in is not counted.",
        )}{" "}
        {tx("As of {time}", { time: formatAdminTime(usage.generatedAt, locale) })}
      </p>
    </div>
  );
}

function Downloads({
  downloads,
  locale,
}: {
  readonly downloads: PublicDownloads | null;
  readonly locale: string | undefined;
}) {
  const tx = useTx();
  const count = (value: number) => formatCount(value, locale);
  return (
    <div
      className={`${ROW} space-y-3 border-t border-border/50`}
      data-testid="connect-admin-downloads"
    >
      <h4 className={HEADING}>{tx("Downloads")}</h4>
      {downloads === null ? (
        <p className={`${MUTED} flex items-center gap-2`} role="status">
          <Spinner size="sm" />
          {tx("Loading downloads…")}
        </p>
      ) : (
        <>
          {downloads.installers === null ? (
            <p className={MUTED} role="status">
              {tx("Installer downloads could not be read from GitHub.")}
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-3 items-end gap-x-6 gap-y-3">
                <Tile label={tx("Mac installer")}>{count(downloads.installers.mac)}</Tile>
                <Tile label={tx("Windows installer")}>{count(downloads.installers.windows)}</Tile>
                <Tile label={tx("Linux packages")}>{count(downloads.installers.linux)}</Tile>
              </dl>
              <p className={MUTED}>
                {tx(
                  "Installer downloads added up over {count} releases on GitHub. Mac counts new installs. Windows and Linux also count updates.",
                  { count: count(downloads.installers.releases) },
                )}
                {downloads.installers.complete
                  ? null
                  : ` ${tx("Older releases were not counted.")}`}
              </p>
            </>
          )}
          {downloads.npm === null ? (
            <p className={MUTED} role="status">
              {tx("Installs from npm could not be read.")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-60 border-collapse">
                <thead>
                  <tr className="border-b border-border/50">
                    <th scope="col" className={`${MUTED} py-1.5 text-left font-normal`}>
                      {tx("Installs from npm")}
                    </th>
                    <th scope="col" className={`${MUTED} py-1.5 pl-3 text-right font-normal`}>
                      {tx("Last 7 days")}
                    </th>
                    <th scope="col" className={`${MUTED} py-1.5 pl-3 text-right font-normal`}>
                      {tx("Last 30 days")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {downloads.npm.map((entry) => (
                    <tr key={entry.name} className="border-b border-border/50 last:border-b-0">
                      <th
                        scope="row"
                        className="py-1.5 text-left font-mono text-xs font-normal text-foreground"
                      >
                        {entry.name}
                      </th>
                      <td className={`${NUMBER} py-1.5 pl-3`}>{count(entry.week)}</td>
                      <td className={`${NUMBER} py-1.5 pl-3`}>{count(entry.month)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function UsageFailure({
  failure,
  onRetry,
}: {
  readonly failure: ConnectAdminFailure;
  readonly onRetry: () => void;
}) {
  const tx = useTx();
  const copy = failureCopy(failure);
  return (
    <div className={`${ROW} flex flex-wrap items-center justify-between gap-3`} role="alert">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-foreground">{tx(copy.title)}</p>
        <p className={MUTED}>{tx(copy.description)}</p>
      </div>
      {failureIsFinal(failure) ? null : (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {tx("Try again")}
        </Button>
      )}
    </div>
  );
}

/** The section without its reads: the usage numbers or their failure, then the downloads. */
export function ConnectAdminUsageView({
  usage,
  downloads,
  locale,
  onRetry,
}: {
  readonly usage: Loadable<RelayAdminUsageResponse>;
  /** Null while the public download counts are being read. */
  readonly downloads: PublicDownloads | null;
  readonly locale: string | undefined;
  readonly onRetry: () => void;
}) {
  const tx = useTx();
  return (
    <SettingsSection title="Usage">
      {usage.status === "loading" ? (
        <p className={`${ROW} ${MUTED} flex items-center gap-2`} role="status">
          <Spinner size="sm" />
          {tx("Loading usage…")}
        </p>
      ) : usage.status === "failed" ? (
        <UsageFailure failure={usage.failure} onRetry={onRetry} />
      ) : (
        <UsageNumbers usage={usage.value} locale={locale} />
      )}
      <Downloads downloads={downloads} locale={locale} />
    </SettingsSection>
  );
}

/**
 * Settings > Connect admin > Usage: how many people signed up and were active,
 * what Connect itself saw, and public download counts. It reads on its own;
 * `refreshKey` changing reads again and keeps what is on screen meanwhile.
 */
export function ConnectAdminUsage({
  refreshKey,
  locale,
}: {
  readonly refreshKey: number;
  readonly locale: string | undefined;
}) {
  const [usage, setUsage] = useState<Loadable<RelayAdminUsageResponse>>(LOADING);
  const [downloads, setDownloads] = useState<PublicDownloads | null>(null);
  const [attempt, setAttempt] = useState(0);

  // A refresh of the page or a retry asks again; an answer to an older read is dropped.
  const read = refreshKey + attempt;
  const latestRead = useRef(read);
  useEffect(() => {
    latestRead.current = read;
    void readConnectAdmin((client, clerkToken) => client.usage({ clerkToken })).then((result) => {
      if (latestRead.current !== read) return;
      setUsage(
        result.ok
          ? { status: "ready", value: result.value }
          : { status: "failed", failure: result.failure },
      );
    });
    void readPublicDownloads().then((downloaded) => {
      if (latestRead.current === read) setDownloads(downloaded);
    });
    return () => {
      // Unmounting drops whatever is still on its way.
      latestRead.current = Number.NaN;
    };
  }, [read]);

  return (
    <ConnectAdminUsageView
      usage={usage}
      downloads={downloads}
      locale={locale}
      onRetry={() => {
        setUsage(LOADING);
        setAttempt((value) => value + 1);
      }}
    />
  );
}
