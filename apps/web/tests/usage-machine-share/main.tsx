// Synthetic data by default: no server, account, provider or store. A capture of
// real reports can be shown instead with ?data=<url of a JSON file>.
import type { MachineColorId, UsageLimitHistorySeries } from "@specweave-studio/contracts";
import type {
  ShareCell,
  ShareMachineInput,
  ShareReport,
} from "@specweave-studio/shared/usageMachineShare";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { UsageMachines } from "../../src/components/usage/machines/UsageMachines";
import type { ShareMachineIdentity } from "../../src/components/usage/machines/UsageMachinesCharts";
import type { SharePeriod } from "../../src/components/usage/machines/machineShareView";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface FixtureData {
  readonly now: number;
  readonly inputs: readonly ShareMachineInput[];
  readonly histories: ReadonlyArray<ReadonlyArray<UsageLimitHistorySeries>>;
  readonly scopedWindowIds: readonly string[];
  readonly identities: Record<string, ShareMachineIdentity>;
}

const iso = (at: number) => new Date(at).toISOString();

/** A small seeded generator, so every run draws the same charts. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function synthetic(): FixtureData {
  const now = Date.parse("2026-11-20T18:00:00.000Z");
  const start = Math.floor((now - 14 * DAY) / HOUR) * HOUR;
  const random = seeded(7);
  const CLAUDE_A = "claudeAgent:alex.rivers@example.com";
  const CLAUDE_B = "claudeAgent:team.build@example.com";
  const CLAUDE_C = "claudeAgent:shared.seat@example.com";
  const CODEX = "codex:alex.rivers@example.com";
  const COPILOT = "acpRegistry:login:alexrivers";

  /** How busy an hour is: working hours on weekdays, a trickle otherwise. */
  const busy = (at: number) => {
    const date = new Date(at);
    const hour = date.getUTCHours();
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    return (hour >= 8 && hour < 22 ? 1 : 0.08) * (weekend ? 0.35 : 1) * (0.5 + random());
  };

  interface Plan {
    readonly accountKey: string;
    readonly origin: "app" | "native";
    /** Dollars an hour at full activity. */
    readonly rate: number;
    readonly models: readonly string[];
    readonly projects: readonly string[];
    readonly source?: string;
    readonly fromDay?: number;
    readonly untilDay?: number;
  }
  const projectTitles: Record<string, string> = {
    site: "Marketing site",
    api: "Orders API",
    app: "Mobile app",
    infra: "Infrastructure",
  };

  const recordedByAccount = new Map<string, Map<number, number>>();
  const build = (plans: readonly Plan[], until = now): ShareReport => {
    const cells = new Map<string, ShareCell>();
    const hourly = new Map<
      string,
      {
        hourStartMs: number;
        accountKey: string;
        origin?: "app" | "native";
        source?: number;
        tokens: number;
        costUsd: number;
        requests: number;
      }
    >();
    const sources: Array<{ key: string; provider: string }> = [];
    for (const plan of plans) {
      let source: number | undefined;
      if (plan.source !== undefined) {
        source = sources.findIndex((entry) => entry.key === plan.source);
        if (source === -1) {
          source = sources.length;
          sources.push({
            key: plan.source,
            provider: plan.accountKey.startsWith("codex") ? "codex" : "claude",
          });
        }
      }
      for (let at = start; at < until; at += HOUR) {
        const dayIndex = Math.floor((at - start) / DAY);
        if (plan.fromDay !== undefined && dayIndex < plan.fromDay) continue;
        if (plan.untilDay !== undefined && dayIndex > plan.untilDay) continue;
        const costUsd = Math.round(plan.rate * busy(at) * 100) / 100;
        if (costUsd <= 0) continue;
        const model = plan.models[Math.floor(random() * plan.models.length)]!;
        const projectId =
          plan.origin === "app"
            ? plan.projects[Math.floor(random() * plan.projects.length)]
            : undefined;
        const day = iso(at).slice(0, 10);
        const key = [day, plan.accountKey, model, plan.origin, projectId ?? "", source ?? ""].join(
          "|",
        );
        const cell = cells.get(key);
        const tokens = Math.round(costUsd * 210_000);
        const requests = Math.max(1, Math.round(costUsd * 5));
        cells.set(key, {
          day,
          accountKey: plan.accountKey,
          model,
          origin: plan.origin,
          ...(projectId === undefined ? {} : { projectId }),
          ...(source === undefined ? {} : { source }),
          tokens: (cell?.tokens ?? 0) + tokens,
          costUsd: (cell?.costUsd ?? 0) + costUsd,
          requests: (cell?.requests ?? 0) + requests,
          unpricedRequests: 0,
          sessions: (cell?.sessions ?? 0) + 1,
        } as ShareCell);
        const hourKey = `${at}|${plan.accountKey}|${plan.origin}|${source ?? ""}`;
        const hour = hourly.get(hourKey);
        hourly.set(hourKey, {
          hourStartMs: at,
          accountKey: plan.accountKey,
          ...(plan.origin === "unsplit" ? {} : { origin: plan.origin }),
          ...(source === undefined ? {} : { source }),
          tokens: (hour?.tokens ?? 0) + tokens,
          costUsd: (hour?.costUsd ?? 0) + costUsd,
          requests: (hour?.requests ?? 0) + requests,
        });
        const recorded = recordedByAccount.get(plan.accountKey) ?? new Map<number, number>();
        recorded.set(at, (recorded.get(at) ?? 0) + costUsd);
        recordedByAccount.set(plan.accountKey, recorded);
      }
    }
    const accountKeys = [...new Set(plans.map((plan) => plan.accountKey))];
    return {
      version: 1,
      readAt: iso(until),
      timeZone: "UTC",
      sinceDay: iso(start).slice(0, 10),
      untilDay: iso(until).slice(0, 10),
      accounts: accountKeys.map((accountKey) => ({
        accountKey,
        driver: accountKey.split(":")[0],
        identity: "recorded",
        signedIn: true,
        ...(accountKey === COPILOT ? { label: "GitHub Copilot" } : {}),
      })),
      sources,
      projects: Object.entries(projectTitles).map(([projectId, title]) => ({ projectId, title })),
      cells: [...cells.values()],
      hourly: [...hourly.values()],
      hourlySinceMs: start,
    } as unknown as ShareReport;
  };

  const claudeModels = ["claude-fable-5", "claude-opus-5", "claude-haiku-5"];
  const codexModels = ["gpt-6-codex", "gpt-6-mini"];
  const studio = build([
    {
      accountKey: CLAUDE_A,
      origin: "app",
      rate: 7,
      models: claudeModels,
      projects: ["site", "api", "app"],
      source: "studio claude",
    },
    {
      accountKey: CLAUDE_A,
      origin: "native",
      rate: 0.9,
      models: claudeModels,
      projects: [],
      source: "studio claude",
    },
    {
      accountKey: CODEX,
      origin: "app",
      rate: 1.6,
      models: codexModels,
      projects: ["api"],
      source: "studio codex",
    },
    {
      accountKey: CLAUDE_C,
      origin: "app",
      rate: 1.2,
      models: claudeModels,
      projects: ["infra"],
      fromDay: 9,
    },
    {
      accountKey: COPILOT,
      origin: "app",
      rate: 0.5,
      models: ["gemini-4-neon"],
      projects: ["site"],
    },
  ]);
  const laptop = build([
    {
      accountKey: CLAUDE_A,
      origin: "app",
      rate: 3.2,
      models: claudeModels,
      projects: ["app", "site"],
      source: "laptop claude",
    },
    {
      accountKey: COPILOT,
      origin: "app",
      rate: 0.3,
      models: ["gemini-4-neon", "gpt-6-mini"],
      projects: ["app"],
    },
  ]);
  const box = build([
    {
      accountKey: CODEX,
      origin: "app",
      rate: 3.8,
      models: codexModels,
      projects: ["api", "infra"],
      source: "box codex",
    },
    {
      accountKey: CODEX,
      origin: "native",
      rate: 0.7,
      models: codexModels,
      projects: [],
      source: "box codex",
    },
  ]);
  // Out of reach for three days: its last report ends there.
  const travel = build(
    [
      {
        accountKey: CLAUDE_C,
        origin: "app",
        rate: 2.2,
        models: claudeModels,
        projects: ["site"],
        untilDay: 10,
      },
    ],
    now - 3 * DAY,
  );
  // An older version: totals only, no account and no split.
  const oldCells = build([
    {
      accountKey: CLAUDE_C,
      origin: "app",
      rate: 0.9,
      models: claudeModels,
      projects: [],
      source: "old claude",
    },
  ]);
  const old: ShareReport = {
    ...oldCells,
    version: 0,
    hourly: [],
    cells: oldCells.cells.map((cell) => {
      const { projectId: _projectId, ...rest } = cell;
      return { ...rest, origin: "unsplit" as const };
    }),
  };

  /** A weekly limit read every hour: the machines' cost at `rate`, plus use elsewhere. */
  const history = (
    accountKey: string,
    dollarsPerPoint: number,
    outside: (at: number) => number,
    resetOffset: number,
  ): UsageLimitHistorySeries => {
    const recorded = recordedByAccount.get(accountKey) ?? new Map<number, number>();
    const samples = [];
    let percent = 22;
    let resetsAt = start + resetOffset;
    for (let at = start; at <= now; at += HOUR) {
      if (at >= resetsAt) {
        percent = 0;
        resetsAt += 7 * DAY;
      }
      samples.push({
        at: iso(at),
        usedPercent: Math.min(100, Math.floor(percent)),
        resetsAt: iso(resetsAt),
      });
      percent += (recorded.get(at) ?? 0) / dollarsPerPoint + outside(at);
    }
    return {
      accountKey,
      driver: accountKey.split(":")[0],
      windowId: "seven_day",
      windowKind: "weekly",
      windowDurationMins: 7 * 24 * 60,
      samples,
    } as unknown as UsageLimitHistorySeries;
  };
  const elsewhere = (from: number, until: number, points: number) => (at: number) => {
    const day = (at - start) / DAY;
    const hour = new Date(at).getUTCHours();
    return day >= from && day < until && hour >= 9 && hour < 21 ? points : 0;
  };

  return {
    now,
    inputs: [
      {
        machineId: "studio",
        name: "Studio Mac",
        state: "live",
        report: studio,
        heldAccountKeys: [CLAUDE_A, CLAUDE_B, CODEX, COPILOT],
      },
      {
        machineId: "laptop",
        name: "Work laptop",
        state: "live",
        report: laptop,
        heldAccountKeys: [CLAUDE_A, COPILOT],
      },
      { machineId: "box", name: "Build box", state: "live", report: box, heldAccountKeys: [CODEX] },
      {
        machineId: "travel",
        name: "Travel laptop",
        state: "cached",
        report: travel,
        heldAccountKeys: [CLAUDE_C],
      },
      {
        machineId: "old",
        name: "Old mini",
        state: "summary",
        report: old,
        heldAccountKeys: [],
        note: "older version, totals only",
      },
    ],
    histories: [
      [
        history(CLAUDE_A, 21, elsewhere(10.2, 12.4, 0.9), 9.5 * DAY),
        history(CODEX, 14, () => 0, 4.25 * DAY),
        history(CLAUDE_C, 9, () => 0, 6 * DAY),
        history(CLAUDE_B, 10, elsewhere(8, 14, 0.35), 2 * DAY),
        { ...history(CLAUDE_A, 21, () => 0.4, 9.5 * DAY), windowId: "seven_day_opus" },
      ],
    ],
    scopedWindowIds: ["seven_day_opus"],
    identities: {
      studio: { name: "Studio Mac", short: "SM", color: "violet" },
      laptop: { name: "Work laptop", short: "WL", color: "teal" },
      box: { name: "Build box", short: "BB", color: "amber" },
      travel: { name: "Travel laptop", short: "TL", color: "rose" },
      old: { name: "Old mini", short: "OM", color: "blue" },
    },
  };
}

const PERIODS: Record<string, SharePeriod> = {
  "7": { kind: "days", days: 7 },
  "14": { kind: "days", days: 14 },
  "30": { kind: "days", days: 30 },
  reset: { kind: "reset" },
};

function Fixture({ data }: { readonly data: FixtureData }) {
  const [period, setPeriod] = useState<SharePeriod>(
    PERIODS[params.get("period") ?? "7"] ?? PERIODS["7"]!,
  );
  const scoped = new Set(data.scopedWindowIds);
  const fallback: ShareMachineIdentity = {
    name: "Machine",
    short: "M",
    color: "slate" as MachineColorId,
  };
  return (
    <TooltipProvider delay={0}>
      <main className="mx-auto max-w-5xl p-4 sm:p-6" data-fixture-ready>
        <UsageMachines
          inputs={data.inputs}
          histories={data.histories}
          scopedWindowIds={scoped}
          identityOf={(machineId) => data.identities[machineId] ?? { ...fallback, name: machineId }}
          now={data.now}
          period={period}
          onPeriodChange={setPeriod}
          loading={false}
        />
      </main>
    </TooltipProvider>
  );
}

const source = params.get("data");
const data: FixtureData = source
  ? await fetch(source).then((response) => response.json())
  : synthetic();
createRoot(document.getElementById("root")!).render(<Fixture data={data} />);
