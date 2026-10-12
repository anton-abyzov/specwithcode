import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultCoordinatorModelSelection,
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

  it("sets Medium effort only for Opus 5.5", () => {
    const sonnet = { ...thinkingOpus, slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
    expect(defaultModelOptions(sonnet, "coordinator")).toEqual([{ id: "thinking", value: true }]);
  });

  it("leaves a model it cannot find as it is", () => {
    const other = { ...bare, model: "claude-opus-6" };
    expect(withDefaultModelOptions(other, [claudeWithOptions], "coordinator")).toBe(other);
  });
});
