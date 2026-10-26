import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type UsageLimitHistorySeries,
} from "@specweave-studio/contracts";
import {
  LIMIT_HISTORY_LOOKBACK_HOURS,
  type LimitHistoryIndex,
  indexLimitHistory,
} from "@specweave-studio/shared/usageLimitForecast";
import { useEffect, useState } from "react";

import { readEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Quota history from every connected environment, merged by account. Each
 * machine records what it reads itself, so together they cover every account
 * the pooled view shows. Re-read when `refreshKey` changes, which the Usage
 * page advances on refresh. A server too old to record history adds nothing,
 * and the view says it is still collecting.
 *
 * Null until the first read lands, so a loading page does not claim there is
 * no history.
 */
export function useUsageLimitHistory(
  environmentIds: readonly EnvironmentId[],
  refreshKey: number,
): LimitHistoryIndex | null {
  const read = useAtomCommand(serverEnvironment.usageLimitHistory, {
    reportFailure: false,
    reportDefect: false,
  });
  const [index, setIndex] = useState<LimitHistoryIndex | null>(null);
  const environmentsKey = [...environmentIds].sort().join("\n");
  useEffect(() => {
    let cancelled = false;
    const ids = environmentsKey === "" ? [] : (environmentsKey.split("\n") as EnvironmentId[]);
    void Promise.all(
      ids
        .filter((environmentId) => readEnvironmentScope(environmentId, AuthOrchestrationReadScope))
        .map((environmentId): Promise<readonly UsageLimitHistorySeries[]> =>
          Promise.resolve(
            read({ environmentId, input: { sinceHours: LIMIT_HISTORY_LOOKBACK_HOURS } }),
          )
            .then((result) => (result?._tag === "Success" ? result.value.series : []))
            .catch(() => []),
        ),
    ).then((histories) => {
      if (!cancelled) setIndex(indexLimitHistory(histories));
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refreshKey re-reads on refresh.
  }, [environmentsKey, read, refreshKey]);
  return index;
}
