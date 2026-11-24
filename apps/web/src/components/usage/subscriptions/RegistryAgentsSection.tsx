/** The "Agents and models" section with live data from every machine's report. */
import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type UsageMachineReport,
} from "@specweave-studio/contracts";
import { type LimitAccount, limitAccountKey } from "@specweave-studio/shared/usageLimits";
import { zonedDay } from "@specweave-studio/shared/usageMachineShareView";
import { useEffect, useMemo, useState } from "react";

import { environmentPresentations } from "../../../state/presentation";
import { serverEnvironment } from "../../../state/server";
import { useEnvironmentsWithScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useMachineIdentities } from "../../../studio/machineIdentity";
import { VIEWER_TIME_ZONE } from "../machines/machineShareView";
import { providerGroupOf } from "./providerGroups";
import { type AgentOf, agentStats } from "./registryAgents";
import { AGENT_DAYS, RegistryAgentsView } from "./RegistryAgentsView";

const DAY_MS = 24 * 60 * 60 * 1000;

type Answer = UsageMachineReport | "failed";

/** The section with live data: asks every connected machine that can report. */
export function RegistryAgentsSection({
  accounts,
  now,
}: {
  readonly accounts: readonly LimitAccount[];
  readonly now: number;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const identities = useMachineIdentities();
  const readReport = useAtomCommand(serverEnvironment.usageMachineReport, {
    reportFailure: false,
    reportDefect: false,
  });
  const [answers, setAnswers] = useState<ReadonlyMap<string, Answer> | null>(null);
  const range = useMemo(
    () => ({
      sinceDay: zonedDay(now - (AGENT_DAYS - 1) * DAY_MS, VIEWER_TIME_ZONE),
      untilDay: zonedDay(now, VIEWER_TIME_ZONE),
    }),
    [now],
  );
  const machineIds = useMemo(() => [...presentations.keys()].sort(), [presentations]);
  const requested = useMemo(
    () => machineIds.map((environmentId) => ({ environmentId })),
    [machineIds],
  );
  const permitted = useEnvironmentsWithScope(requested, AuthDiagnosticsReadScope);
  const canAsk = (id: EnvironmentId) => {
    const presentation = presentations.get(id);
    return (
      permitted.has(id) &&
      presentation?.connection.phase === "connected" &&
      presentation.serverConfig?.environment.capabilities.usageMachineReport === true
    );
  };
  const askKey = machineIds.filter(canAsk).join("\n");

  useEffect(() => {
    let cancelled = false;
    const ids = askKey === "" ? [] : (askKey.split("\n") as EnvironmentId[]);
    void Promise.all(
      ids.map((environmentId): Promise<readonly [string, Answer]> =>
        Promise.resolve(
          readReport({
            environmentId,
            input: {
              sinceDay: range.sinceDay as UsageMachineReport["sinceDay"],
              untilDay: range.untilDay as UsageMachineReport["untilDay"],
              timeZone: VIEWER_TIME_ZONE,
            },
          }),
        )
          .then((result): readonly [string, Answer] => [
            environmentId,
            result?._tag === "Success" ? result.value : "failed",
          ])
          .catch((): readonly [string, Answer] => [environmentId, "failed"]),
      ),
    ).then((entries) => {
      if (!cancelled) setAnswers(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [askKey, range.sinceDay, range.untilDay, readReport]);

  // An account is named by the instance that holds it: its registry icon first, then its name.
  const agentOf = useMemo((): AgentOf => {
    const byKey = new Map<string, LimitAccount>();
    for (const account of accounts) {
      const key = limitAccountKey(account.driver, account.email, account.limits);
      if (key !== null) byKey.set(key, account);
    }
    const instances = new Map<string, { displayName?: string; iconUrl?: string }>();
    for (const presentation of presentations.values()) {
      for (const provider of presentation.serverConfig?.providers ?? []) {
        if (!instances.has(provider.instanceId)) {
          instances.set(provider.instanceId, {
            ...(provider.displayName ? { displayName: provider.displayName } : {}),
            ...(provider.iconUrl ? { iconUrl: provider.iconUrl } : {}),
          });
        }
      }
    }
    return (accountKey, driver, label) => {
      const account = byKey.get(accountKey);
      const instance = instances.get(accountKey.split(":instance:")[1] ?? "");
      return providerGroupOf({
        driver: driver as LimitAccount["driver"],
        displayName: account?.displayName ?? instance?.displayName ?? label,
        iconUrl: account?.iconUrl ?? instance?.iconUrl,
      });
    };
  }, [accounts, presentations]);

  const reports = useMemo(
    () =>
      [...(answers?.values() ?? [])].filter(
        (answer): answer is UsageMachineReport => answer !== "failed",
      ),
    [answers],
  );
  const view = useMemo(
    () => (answers === null && askKey !== "" ? null : agentStats(reports, agentOf, range)),
    [answers, askKey, reports, agentOf, range],
  );
  const unreached = machineIds
    .filter((id) => !canAsk(id) || answers?.get(id) === "failed")
    .map((id) => identities(id, presentations.get(id)?.entry.target.label).name);

  return (
    <RegistryAgentsView
      view={view}
      loading={answers === null && askKey !== ""}
      unreached={unreached}
    />
  );
}
