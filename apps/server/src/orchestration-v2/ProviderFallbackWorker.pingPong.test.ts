import {
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { provider } from "../studio/fixtures.ts";
import {
  providerLimitStep,
  unreportedLimitStops,
  withHeldSources,
} from "./ProviderFallbackWorker.ts";
import {
  heldSourceKeys,
  type LimitChain,
  limitChainParked,
  limitFallbackChains,
  limitSourceHolds,
  type LimitSourceHolds,
} from "./limitSourceHolds.ts";

// Two sources of one model, both out of that model's quota, and a track model with room.
const now = Date.parse("2026-11-24T15:14:00.000Z");
const copilotId = ProviderInstanceId.make("acpRegistry_copilot");
const cursorId = ProviderInstanceId.make("cursor");
const claudeId = ProviderInstanceId.make("claudeAgent");
const neon = "gemini-4-neon";
const opus = "claude-opus-5-5";

type UsageState = "none" | "unavailable" | "room";

function source(id: ProviderInstanceId, driver: string, slug: string, state: UsageState) {
  const base = provider(id, driver, now);
  const usageLimits: ServerProvider["usageLimits"] =
    state === "none"
      ? undefined
      : state === "unavailable"
        ? { ...base.usageLimits!, unavailable: { reason: "not read" } as never, windows: [] }
        : {
            ...base.usageLimits!,
            windows: [
              {
                id: "monthly",
                kind: "weekly",
                label: "Monthly",
                usedPercent: 40,
                resetsAt: "2026-12-01T00:00:00.000Z",
              },
            ],
          };
  return {
    ...base,
    models: [{ slug, name: slug, isCustom: false, isDefault: true, capabilities: null }],
    usageLimits,
  } satisfies ServerProvider;
}

const claude: ServerProvider = {
  ...provider(claudeId, "claudeAgent", now),
  models: [{ slug: opus, name: opus, isCustom: false, isDefault: true, capabilities: null }],
  usageLimits: {
    ...provider(claudeId, "claudeAgent", now).usageLimits!,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 10,
        resetsAt: "2026-11-24T18:00:00.000Z",
      },
    ],
  },
};

const rule = {
  providerLimitAction: "switch" as const,
  providerLimitFallbackModelSelection: null,
  providerLimitSwitchAtPercent: 90,
  defaultModelSelection: { instanceId: claudeId, model: opus },
  threadModelMode: "tracks" as const,
  modelLanes: { routine: [{ instanceId: claudeId, model: opus }], complex: [] },
};

/** Runs the sweep's hold-and-step loop on a thread whose every run stops on a limit. */
function hops(
  state: UsageState,
  count: number,
  providers: ReadonlyArray<ServerProvider> = [
    source(copilotId, "acpRegistry", neon, state),
    source(cursorId, "cursor", neon, state),
    claude,
  ],
): string[] {
  let held: ReadonlyMap<string, number> = new Map();
  let sources: LimitSourceHolds = new Map();
  let chains: ReadonlyMap<string, LimitChain> = new Map();
  let on = { instanceId: copilotId, model: neon };
  const path: string[] = [`${on.instanceId}`];
  for (let run = 1; run <= count; run++) {
    const at = now + run * 7_000;
    const thread = {
      id: ThreadId.make("t1"),
      providerInstanceId: on.instanceId,
      modelSelection: on,
      status: "failed" as const,
      lastErrorClass: "usage_limit" as const,
      usageLimitResetAt: null,
      latestRunId: RunId.make(`r${run}`),
      latestRunCompletedAt: DateTime.makeUnsafe(at),
      activeRunId: null,
      pendingRuntimeRequest: null,
      settledOverride: null,
    };
    held = unreportedLimitStops(held, [thread], providers, at);
    sources = limitSourceHolds(sources, [thread], at);
    chains = limitFallbackChains(chains, [thread], at);
    const step = providerLimitStep(thread, providers, rule, at, {
      resetAttempted: false,
      limited: new Set(held.keys()),
      failedTargets: withHeldSources(undefined, heldSourceKeys(sources, at)),
      parked: limitChainParked(chains.get(thread.id)),
    });
    if (step?.type !== "switch" || step.command.type !== "message.dispatch") {
      path.push("parked");
      break;
    }
    on = step.command.modelSelection as typeof on;
    path.push(`${on.instanceId}`);
    if (on.instanceId === claudeId) break;
  }
  return path;
}

describe("limit fallback between two spent sources of one model", () => {
  it.each(["none", "unavailable", "room"] as const)(
    "never returns to a source that just refused (%s usage read)",
    (state) => {
      const path = hops(state, 6);
      // Each source is tried at most once; the track's next model takes over.
      expect(new Set(path).size).toBe(path.length);
      expect(path.at(-1)).toBe(claudeId);
    },
  );

  it("parks after the hop cap when every source keeps refusing", () => {
    // Six sources of one model, all refusing: four hops, then the card.
    const ids = ["a", "b", "c", "d", "e", "f"].map((id) => ProviderInstanceId.make(`acp_${id}`));
    const many = [
      source(copilotId, "acpRegistry", neon, "room"),
      ...ids.map((id) => source(id, "acpRegistry", neon, "room")),
    ];
    const path = hops("room", 10, many);
    expect(path.at(-1)).toBe("parked");
    expect(path.length).toBe(1 + 4 + 1);
  });
});
