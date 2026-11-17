import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type UsageResetLedgerAccount,
  type UsageResetPeriod,
} from "@specweave-studio/contracts";
import { mergeResetPeriods } from "@specweave-studio/shared/usageResetLedger";
import { useEffect, useMemo, useState } from "react";

import { serverEnvironment } from "../../../state/server";
import { useEnvironmentsWithScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";

/** The whole ledger: the dashboard's year range and its comparison span need it. */
const LEDGER_DAYS = 366;

/**
 * One list from each machine's ledger. Two machines signed in to one account
 * record the same reset from their own reads; the merge keeps the one that
 * read last before it.
 */
export function mergeLedgers(
  ledgers: ReadonlyArray<ReadonlyArray<UsageResetPeriod>>,
): UsageResetPeriod[] {
  const numeric = ledgers.map((ledger) =>
    ledger.flatMap((wire) => {
      const endedAt = Date.parse(wire.endedAt);
      const lastReadAt = Date.parse(wire.lastReadAt);
      if (!Number.isFinite(endedAt) || !Number.isFinite(lastReadAt)) return [];
      const startedAt = wire.startedAt === undefined ? null : Date.parse(wire.startedAt);
      return [
        {
          accountKey: wire.accountKey,
          // Codex's `primary` is weekly on one plan and monthly on another: one id, two windows.
          windowId: `${wire.windowKind}:${wire.windowId}`,
          startedAt: startedAt !== null && Number.isFinite(startedAt) ? startedAt : null,
          endedAt,
          lastReadAt,
          usedPercentAtReset: wire.usedPercentAtReset,
          lostPercent: wire.lostPercent,
          cause: wire.cause,
          wire,
        },
      ];
    }),
  );
  return mergeResetPeriods(numeric).map(({ wire, startedAt }) => {
    if (wire.startedAt !== undefined || startedAt === null) return wire;
    // The other machine saw this period begin.
    return { ...wire, startedAt: new Date(startedAt).toISOString() as UsageResetPeriod["endedAt"] };
  });
}

export interface UsageResetLedgerView {
  readonly periods: readonly UsageResetPeriod[];
  /** Accounts each machine is following, closed period or not; may repeat across machines. */
  readonly openAccounts: readonly UsageResetLedgerAccount[];
}

interface Ledger {
  readonly periods: readonly UsageResetPeriod[];
  readonly accounts: readonly UsageResetLedgerAccount[];
}
const NO_LEDGER: Ledger = { periods: [], accounts: [] };

/**
 * Closed quota periods from every connected environment, merged by account.
 * Null until the first read lands, so a loading view does not claim nothing
 * was ever lost. A server too old to keep a ledger adds nothing.
 */
export function useUsageResetLedger(
  environmentIds: readonly EnvironmentId[],
  refreshKey: number,
  sinceDays: number = LEDGER_DAYS,
): UsageResetLedgerView | null {
  const read = useAtomCommand(serverEnvironment.usageResetLedger, {
    reportFailure: false,
    reportDefect: false,
  });
  const [view, setView] = useState<UsageResetLedgerView | null>(null);
  const requestedKey = [...environmentIds].sort().join("\n");
  const requested = useMemo(
    () =>
      requestedKey === ""
        ? []
        : requestedKey.split("\n").map((environmentId) => ({
            environmentId: environmentId as EnvironmentId,
          })),
    [requestedKey],
  );
  const permitted = useEnvironmentsWithScope(requested, AuthOrchestrationReadScope);
  const environmentsKey = requested
    .map(({ environmentId }) => environmentId)
    .filter((environmentId) => permitted.has(environmentId))
    .join("\n");
  useEffect(() => {
    let cancelled = false;
    const ids = environmentsKey === "" ? [] : (environmentsKey.split("\n") as EnvironmentId[]);
    void Promise.all(
      ids.map((environmentId): Promise<Ledger> =>
        Promise.resolve(read({ environmentId, input: { sinceDays } }))
          .then((result) =>
            result?._tag === "Success"
              ? { periods: result.value.periods, accounts: result.value.openAccounts ?? [] }
              : NO_LEDGER,
          )
          .catch(() => NO_LEDGER),
      ),
    ).then((ledgers) => {
      if (cancelled) return;
      setView({
        periods: mergeLedgers(ledgers.map((ledger) => ledger.periods)),
        openAccounts: ledgers.flatMap((ledger) => ledger.accounts),
      });
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refreshKey re-reads on refresh.
  }, [environmentsKey, read, refreshKey, sinceDays]);
  return view;
}
