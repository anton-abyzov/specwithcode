import { formatTokens } from "@specweave-studio/shared/usageFormat";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";
import { formatDay } from "./SubscriptionRow";
import type { ResetReport as Report } from "./resetReportModel";

const CHART_HEIGHT = 120;

/**
 * Used against lost at each reset, week over week: a stacked bar per account
 * and week, and the same figures as a table. Percent of one window; nothing
 * is drawn for a week with no reset recorded.
 */
export function ResetReport({
  report,
  labelOf,
  colorOf,
}: {
  readonly report: Report;
  readonly labelOf: (accountKey: string) => string;
  readonly colorOf: (accountKey: string) => string;
}) {
  if (report.accounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-reset-report="empty">
        No reset recorded yet. The report fills in as each weekly or monthly window resets while
        the app is running.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-reset-report="">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>
          Lost this week:{" "}
          <span className="font-medium tabular-nums">{Math.round(report.lostThisWeek)}%</span>
        </span>
        <span>
          Lost over {report.weekStarts.length} weeks:{" "}
          <span className="font-medium tabular-nums">{Math.round(report.lostAllWeeks)}%</span>
        </span>
        <span className="text-xs text-muted-foreground">Percent of one account's window.</span>
      </div>
      <div
        role="img"
        aria-label="Used and lost quota per account for each week; the table below has the figures"
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${report.weekStarts.length}, minmax(0, 1fr))` }}
      >
        {report.weekStarts.map((weekStart, index) => (
          <div key={weekStart} className="flex flex-col gap-1">
            <div className="flex items-end gap-1" style={{ height: CHART_HEIGHT }}>
              {report.accounts.map((account) => {
                const cell = account.weeks[index] ?? null;
                if (cell === null) {
                  return (
                    <div
                      key={account.accountKey}
                      className="h-full flex-1 rounded-sm border border-dashed border-border/60"
                    />
                  );
                }
                const total = Math.max(1, cell.usedPercent + cell.lostPercent);
                return (
                  <div
                    key={account.accountKey}
                    className="flex h-full flex-1 flex-col-reverse overflow-hidden rounded-sm bg-muted"
                    title={`${labelOf(account.accountKey)}: ${Math.round(cell.usedPercent)}% used, ${Math.round(cell.lostPercent)}% lost`}
                  >
                    <div
                      style={{
                        height: `${(cell.usedPercent / total) * 100}%`,
                        backgroundColor: colorOf(account.accountKey),
                      }}
                    />
                    <div
                      className="bg-destructive/80"
                      style={{ height: `${(cell.lostPercent / total) * 100}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <span className="text-center text-xs text-muted-foreground">
              {formatDay(weekStart)}
            </span>
          </div>
        ))}
      </div>
      <p className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
        <span>
          <span className="mr-1 inline-block size-2 rounded-sm bg-foreground/60" aria-hidden />
          Used, in the account's colour
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-sm bg-destructive/80" aria-hidden />
          Lost at reset
        </span>
        <span>Dashed: no reset recorded that week</span>
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead className="text-right">Used</TableHead>
            <TableHead className="text-right">Lost</TableHead>
            <TableHead className="text-right">Average lost</TableHead>
            <TableHead className="text-right">Tokens lost (estimate)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.accounts.map((account) => (
            <TableRow key={account.accountKey} data-report-account={account.accountKey}>
              <TableCell>{labelOf(account.accountKey)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {account.latest === null ? "Not reported" : `${Math.round(account.latest.usedPercent)}%`}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {account.latest === null ? "Not reported" : `${Math.round(account.latest.lostPercent)}%`}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {account.averageLostPercent === null
                  ? "Not reported"
                  : `${Math.round(account.averageLostPercent)}% over ${account.resets} ${account.resets === 1 ? "reset" : "resets"}`}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {account.tokensLostEstimate === null
                  ? "Not measurable"
                  : `~${formatTokens(account.tokensLostEstimate)}`}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        Used and Lost are for each account's latest reset. A token estimate appears only where one
        account of that provider was in use, so the spend behind its percent can be measured.
      </p>
    </div>
  );
}
