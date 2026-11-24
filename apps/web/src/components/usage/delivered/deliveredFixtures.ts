import type {
  UsageDeliveredCost,
  UsageDeliveredGroup,
  UsageDeliveredIncrement,
  UsageDeliveredModelCost,
  UsageDeliveredReport,
} from "@specweave-studio/contracts";

/** Test and fixture data for the Delivered tab. */
export function cost(
  costUsd: number,
  records = 1,
  unpricedRecords = 0,
  tokens = 1000,
): UsageDeliveredCost {
  return { costUsd, tokens, records, unpricedRecords };
}

export function model(
  driver: string,
  name: string,
  costUsd: number,
  provider: UsageDeliveredModelCost["provider"] = null,
): UsageDeliveredModelCost {
  return { ...cost(costUsd), driver, provider, model: name };
}

export function increment(
  overrides: Partial<UsageDeliveredIncrement> & Pick<UsageDeliveredIncrement, "incrementId">,
): UsageDeliveredIncrement {
  const byModel = overrides.byModel ?? [model("claudeAgent", "claude-opus-5-5", 100, "claude")];
  const total = byModel.reduce((sum, entry) => sum + entry.costUsd, 0);
  return {
    projectId: "p1",
    title: overrides.incrementId,
    status: "active",
    state: "in_progress",
    closedAt: null,
    mergedAt: null,
    deliveredInRange: overrides.state !== undefined && overrides.state !== "in_progress",
    pullRequests: [],
    createdAt: null,
    tasks: { total: 4, done: 2, doneInRange: 2 },
    cost: cost(total, byModel.length),
    threads: [
      {
        threadId: `${overrides.incrementId}-t1`,
        title: "Build",
        binding: "claim",
        cost: cost(total, byModel.length),
        byModel,
      },
    ],
    threadCount: 1,
    ...overrides,
    byModel,
  } as UsageDeliveredIncrement;
}

export function group(
  costUsd: number,
  driver = "claudeAgent",
  threadCount = 1,
): UsageDeliveredGroup {
  const byModel = costUsd === 0 ? [] : [model(driver, "claude-opus-5-5", costUsd)];
  return {
    cost: costUsd === 0 ? cost(0, 0) : cost(costUsd),
    byModel,
    threadCount,
    threads:
      costUsd === 0
        ? []
        : [
            {
              threadId: `g-${costUsd}`,
              title: "Release notes draft",
              binding: null,
              cost: cost(costUsd),
              byModel,
            },
          ],
  };
}

export function report(overrides: Partial<UsageDeliveredReport> = {}): UsageDeliveredReport {
  const increments = overrides.increments ?? [];
  const coordinators = overrides.coordinators ?? group(0, "claudeAgent", 0);
  const otherThreads = overrides.otherThreads ?? group(0, "claudeAgent", 0);
  const outsideApp = overrides.outsideApp ?? group(0, "claudeAgent", 0);
  const measured = [
    ...increments.map((entry) => entry.cost),
    coordinators.cost,
    otherThreads.cost,
    outsideApp.cost,
  ].reduce(
    (sum, entry) => ({
      costUsd: sum.costUsd + entry.costUsd,
      tokens: sum.tokens + entry.tokens,
      records: sum.records + entry.records,
      unpricedRecords: sum.unpricedRecords + entry.unpricedRecords,
    }),
    cost(0, 0, 0, 0),
  );
  return {
    version: 1,
    readAt: "2026-11-24T08:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-10-26",
    untilDay: "2026-11-24",
    projects: [{ projectId: "p1", title: "specweave", specweave: true }],
    increments,
    coordinators,
    otherThreads,
    outsideApp,
    measured,
    sourceKeys: [],
    cursorHistoryExcluded: false,
    ...overrides,
  } as UsageDeliveredReport;
}
