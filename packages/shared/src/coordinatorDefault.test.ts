import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  coordinatorSelectionProblem,
  defaultCoordinatorModelSelection,
  capCoordinatorEffort,
  coordinatorEffortIsCapped,
  coordinatorEffortModel,
  coordinatorRunSelection,
  defaultModelOptions,
  defaultProjectModelSelection,
  defaultWorkerModelSelection,
  providersChecking,
  providersSettled,
  resolveCoordinatorModelSelection,
  withDefaultModelOptions,
} from "./coordinatorDefault.ts";

function provider(
  id: string,
  driver: string,
  slugs: ReadonlyArray<string>,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-10T12:00:00.000Z",
    version: null,
    models: slugs.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      isDefault: index === 0,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
    ...over,
  };
}

const claude = provider("claudeAgent", "claudeAgent", [
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-opus-5",
]);
const codex = provider("codex", "codex", ["gpt-6-astra"]);

describe("defaultCoordinatorModelSelection", () => {
  it("prefers Opus 5.5 on a Claude subscription over provider order and its default", () => {
    expect(defaultCoordinatorModelSelection([codex, claude])).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  it("does not mistake a longer version number for Opus 5.5", () => {
    const other = provider("claudeAgent", "claudeAgent", ["claude-sonnet-5-5", "claude-opus-5-55"]);
    expect(defaultCoordinatorModelSelection([other])?.model).toBe("claude-sonnet-5-5");
  });

  it("uses the Claude subscription's own default when it lists no Opus 5.5", () => {
    const older = provider("claudeAgent", "claudeAgent", ["claude-sonnet-5", "claude-opus-5"]);
    expect(defaultCoordinatorModelSelection([codex, older])).toEqual({
      instanceId: "claudeAgent",
      model: "claude-sonnet-5",
    });
  });

  it("never picks a Claude instance billed per token", () => {
    const paid = provider("claude-api", "claudeAgent", ["claude-opus-5-5"], {
      auth: { status: "authenticated", apiKeyBilling: true },
    });
    expect(defaultCoordinatorModelSelection([paid, codex])).toEqual({
      instanceId: "codex",
      model: "gpt-6-astra",
    });
    expect(defaultCoordinatorModelSelection([paid])).toBeNull();
  });

  it("skips a signed-out or limited Claude for a provider that can take a turn", () => {
    const signedOut = { ...claude, auth: { status: "unauthenticated" as const } };
    expect(defaultCoordinatorModelSelection([signedOut, codex])?.instanceId).toBe("codex");
    const limited: ServerProvider = {
      ...claude,
      usageLimits: {
        checkedAt: "2026-10-10T12:00:00.000Z",
        windows: [],
        ordinaryUsageAllowed: false,
      },
    };
    expect(defaultCoordinatorModelSelection([limited, codex])?.instanceId).toBe("codex");
    // With nothing else, a limited subscription is still a better default than none.
    expect(defaultCoordinatorModelSelection([limited])?.model).toBe("claude-opus-5-5");
  });

  it("returns null when no provider is usable", () => {
    expect(defaultCoordinatorModelSelection([])).toBeNull();
    expect(defaultCoordinatorModelSelection([{ ...codex, enabled: false }])).toBeNull();
    expect(defaultCoordinatorModelSelection([{ ...codex, status: "error" }])).toBeNull();
  });
});

describe("defaultWorkerModelSelection", () => {
  it("starts workers on the coordinator default when that provider can take a turn", () => {
    expect(defaultWorkerModelSelection([codex, claude])).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  it("never falls back to a provider billed per token or one that cannot take a turn", () => {
    const paidCodex = provider("codex-key", "codex", ["gpt-6-astra"], {
      auth: { status: "authenticated", type: "apiKey" },
    });
    const broken = provider("broken", "codex", ["gpt-6-astra"], { status: "error" });
    expect(defaultWorkerModelSelection([paidCodex])).toBeNull();
    expect(defaultWorkerModelSelection([broken])).toBeNull();
    expect(defaultWorkerModelSelection([paidCodex, codex])?.instanceId).toBe("codex");
    const limited = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5"], {
      usageLimits: { ordinaryUsageAllowed: false } as ServerProvider["usageLimits"],
    });
    expect(defaultWorkerModelSelection([limited])).toBeNull();
  });

  it("accepts a provider whose sign-in has not been re-checked yet, as delegation does", () => {
    const unchecked = { ...claude, status: "warning" as const };
    expect(defaultWorkerModelSelection([unchecked])).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });
});

describe("coordinatorSelectionProblem", () => {
  const copilot = provider("copilot", "copilot", ["default"], { auth: { status: "unknown" } });
  const pick = { instanceId: ProviderInstanceId.make("copilot"), model: "default" };

  it("accepts a ready provider that never reports its sign-in, as a worker would", () => {
    expect(coordinatorSelectionProblem(pick, [copilot])).toBeNull();
  });

  it("refuses an unknown sign-in before the status check passed, and a signed-out one", () => {
    expect(coordinatorSelectionProblem(pick, [{ ...copilot, status: "warning" }])).toBe(
      "provider_unavailable",
    );
    expect(
      coordinatorSelectionProblem(pick, [{ ...copilot, auth: { status: "unauthenticated" } }]),
    ).toBe("provider_unavailable");
  });
});

describe("resolveCoordinatorModelSelection", () => {
  const saved = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-5-5" };
  const thread = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
  const worker = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5" };
  const scoped = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-mini" };
  const host = { instanceId: "claudeAgent", model: "claude-opus-5-5" };

  it("takes the saved model, then the thread's, the worker default, Settings > Defaults, the host", () => {
    const all = {
      saved,
      coordinatorThreadModel: thread,
      projectDefault: worker,
      scopedDefault: scoped,
      providers: [claude],
    };
    expect(resolveCoordinatorModelSelection(all)).toEqual(saved);
    expect(resolveCoordinatorModelSelection({ ...all, saved: null })).toEqual(thread);
    expect(
      resolveCoordinatorModelSelection({ ...all, saved: null, coordinatorThreadModel: null }),
    ).toEqual(worker);
    expect(
      resolveCoordinatorModelSelection({
        ...all,
        saved: null,
        coordinatorThreadModel: null,
        projectDefault: null,
      }),
    ).toEqual(scoped);
    expect(resolveCoordinatorModelSelection({ providers: [codex, claude] })).toEqual(host);
  });

  it("names no model while providers are unknown or none is usable", () => {
    expect(resolveCoordinatorModelSelection({ saved: null })).toBeNull();
    expect(resolveCoordinatorModelSelection({ providers: [] })).toBeNull();
    expect(resolveCoordinatorModelSelection({ providers: null })).toBeNull();
  });

  it("never falls back to a Claude instance billed per token", () => {
    const paid = provider("claudeApi", "claudeAgent", ["claude-opus-5-5"], {
      auth: { status: "authenticated", type: "apiKey" },
    });
    expect(resolveCoordinatorModelSelection({ providers: [paid] })).toBeNull();
  });
});

describe("providersSettled", () => {
  const unchecked = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5"], {
    installed: false,
    status: "warning",
    auth: { status: "unknown" },
  });

  it("waits while an enabled provider still shows its first-check placeholder", () => {
    expect(providersSettled([codex, unchecked])).toBe(false);
    expect(providersSettled([codex, claude])).toBe(true);
  });

  it("does not wait on a disabled provider or settle on an empty list", () => {
    expect(providersSettled([codex, { ...unchecked, enabled: false }])).toBe(true);
    expect(providersSettled([])).toBe(false);
  });

  it("reports a pending check only for an enabled placeholder", () => {
    expect(providersChecking([codex, unchecked])).toBe(true);
    expect(providersChecking([codex, { ...unchecked, enabled: false }])).toBe(false);
    expect(providersChecking([])).toBe(false);
  });
});

const thinkingOpus = {
  slug: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  isCustom: false,
  isDefault: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select" as const,
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
      },
      { id: "thinking", label: "Thinking", type: "boolean" as const, currentValue: true },
    ],
  },
};
const claudeWithOptions = provider("claudeAgent", "claudeAgent", ["claude-sonnet-5-5"], {
  models: [{ ...claude.models[0]! }, thinkingOpus],
});

describe("defaultProjectModelSelection", () => {
  it("is Opus 5.5 on the Claude subscription with Thinking on", () => {
    expect(defaultProjectModelSelection([codex, claudeWithOptions])).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "thinking", value: true }],
    });
  });

  it("names no options a model does not offer", () => {
    expect(defaultProjectModelSelection([claude])).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  it("is null without a Claude subscription offering Opus 5.5", () => {
    const paid = provider("claude-api", "claudeAgent", ["claude-opus-5-5"], {
      auth: { status: "authenticated", apiKeyBilling: true },
    });
    const older = provider("claudeAgent", "claudeAgent", ["claude-sonnet-5"]);
    const signedOut = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5"], {
      auth: { status: "unauthenticated" },
    });
    expect(defaultProjectModelSelection([paid, codex])).toBeNull();
    expect(defaultProjectModelSelection([older])).toBeNull();
    expect(defaultProjectModelSelection([signedOut])).toBeNull();
  });
});

describe("withDefaultModelOptions", () => {
  const bare = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };

  it("gives a coordinator Medium effort and Thinking on", () => {
    expect(withDefaultModelOptions(bare, [claudeWithOptions], "coordinator").options).toEqual([
      { id: "effort", value: "medium" },
      { id: "thinking", value: true },
    ]);
    expect(defaultModelOptions(thinkingOpus, "worker")).toEqual([{ id: "thinking", value: true }]);
  });

  it("keeps every option someone chose and adds only the missing ones", () => {
    const chosen = { ...bare, options: [{ id: "effort", value: "high" }] };
    expect(withDefaultModelOptions(chosen, [claudeWithOptions], "coordinator").options).toEqual([
      { id: "effort", value: "high" },
      { id: "thinking", value: true },
    ]);
    const off = {
      ...bare,
      options: [
        { id: "effort", value: "high" },
        { id: "thinking", value: false },
      ],
    };
    expect(withDefaultModelOptions(off, [claudeWithOptions], "coordinator")).toBe(off);
  });

  it("sets Medium effort on every coordinator model that lists it", () => {
    const sonnet = { ...thinkingOpus, slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
    expect(defaultModelOptions(sonnet, "coordinator")).toEqual([
      { id: "effort", value: "medium" },
      { id: "thinking", value: true },
    ]);
    // Codex names the knob differently; the default follows the model's own id.
    const gpt = {
      ...thinkingOpus,
      slug: "gpt-6.1",
      name: "GPT-6.1",
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "medium", label: "Medium" },
              { id: "xhigh", label: "Extra High" },
            ],
          },
        ],
      },
    };
    expect(defaultModelOptions(gpt, "coordinator")).toEqual([
      { id: "reasoningEffort", value: "medium" },
    ]);
  });

  it("leaves a model without Medium on its provider default", () => {
    const noMedium = {
      ...thinkingOpus,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select" as const,
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    };
    expect(defaultModelOptions(noMedium, "coordinator")).toEqual([]);
  });

  it("leaves a model it cannot find as it is", () => {
    const other = { ...bare, model: "claude-opus-6" };
    expect(withDefaultModelOptions(other, [claudeWithOptions], "coordinator")).toBe(other);
  });
});

describe("clean-profile coordinator prerequisites", () => {
  it.each(["apiKey", "api_key", "bedrock"])("does not auto-spend through %s", (type) => {
    const paid = { ...codex, auth: { status: "authenticated" as const, type } };
    expect(defaultCoordinatorModelSelection([paid])).toBeNull();
    expect(defaultWorkerModelSelection([paid])).toBeNull();
  });

  it("requires known sign-in while preserving local models without cloud auth", () => {
    expect(
      defaultCoordinatorModelSelection([{ ...codex, auth: { status: "unknown" } }]),
    ).toBeNull();
    const base = provider("pi", "pi", ["local/model"], { auth: { status: "unknown" } });
    const local: ServerProvider = {
      ...base,
      models: base.models.map((m) => ({ ...m, billing: "local", toolCalls: true })),
    };
    expect(defaultCoordinatorModelSelection([local])?.model).toBe("local/model");
  });

  it("skips paid and tool-less defaults within a mixed supplier catalog", () => {
    const base = provider("pi", "pi", ["router/paid", "local/text", "local/tools"]);
    const mixed: ServerProvider = {
      ...base,
      models: base.models.map((m, i) => ({
        ...m,
        billing: i === 0 ? "paid-router" : "local",
        toolCalls: i !== 1,
      })),
    };
    expect(defaultCoordinatorModelSelection([mixed])?.model).toBe("local/tools");
    expect(defaultWorkerModelSelection([mixed])?.model).toBe("local/tools");
    expect(
      defaultCoordinatorModelSelection([{ ...mixed, models: mixed.models.slice(0, 2) }]),
    ).toBeNull();
  });

  it("does not infer free billing for an unclassified supplier model", () => {
    expect(
      defaultCoordinatorModelSelection([provider("opencode", "opencode", ["default"])]),
    ).toBeNull();
  });

  it("never auto-picks Gemini/Vertex even without an API auth label", () => {
    expect(
      defaultCoordinatorModelSelection([
        { ...codex, instanceId: ProviderInstanceId.make("gemini-vertex") },
      ]),
    ).toBeNull();
  });
});

describe("coordinator effort cap", () => {
  const wideOpus = {
    ...thinkingOpus,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select" as const,
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
            { id: "max", label: "Max" },
            { id: "ultracode", label: "Ultracode" },
          ],
        },
      ],
    },
  };
  const wide = provider("claudeAgent", "claudeAgent", [], { models: [wideOpus] });
  const pick = (value: string) => ({
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [
      { id: "effort", value },
      { id: "thinking", value: true },
    ],
  });

  it("runs a saved effort above High at High and keeps the other options", () => {
    for (const value of ["xhigh", "max", "ultracode"]) {
      expect(capCoordinatorEffort(pick(value), [wide]).options).toEqual([
        { id: "effort", value: "high" },
        { id: "thinking", value: true },
      ]);
      expect(coordinatorEffortIsCapped(pick(value), [wide])).toBe(true);
    }
  });

  it("leaves Low, Medium and High, and a selection without effort, untouched", () => {
    for (const value of ["low", "medium", "high"]) {
      const selection = pick(value);
      expect(capCoordinatorEffort(selection, [wide])).toBe(selection);
    }
    const bare = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
    expect(capCoordinatorEffort(bare, [wide])).toBe(bare);
    expect(coordinatorEffortIsCapped(null, [wide])).toBe(false);
  });

  it("runs a model picked without an effort at Medium, never its provider default", () => {
    const bare = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
    expect(coordinatorRunSelection(bare, [wide]).options).toEqual([
      { id: "effort", value: "medium" },
    ]);
    expect(coordinatorRunSelection(pick("max"), [wide]).options?.[0]).toEqual({
      id: "effort",
      value: "high",
    });
  });

  it("offers the coordinator only the levels up to High", () => {
    const effort = coordinatorEffortModel(wideOpus).capabilities?.optionDescriptors?.[0];
    expect(effort?.type === "select" ? effort.options.map((option) => option.id) : []).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(coordinatorEffortModel(thinkingOpus)).toBe(thinkingOpus);
  });
});
