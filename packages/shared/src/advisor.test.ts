import * as DateTime from "effect/DateTime";
import {
  DEFAULT_ADVISOR_SETTINGS,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ADVISOR_GUIDANCE,
  advisorGuidance,
  advisorOrder,
  advisorRouteForContext,
  claudeAdvisorPairAllowed,
  claudeBuiltInAdvisorModel,
  claudeCapabilityLevel,
  claudeSessionAdvisor,
  preferredAdvisor,
  resolveAdvisor,
  threadAdvisorPreview,
  threadAdvisorState,
} from "./advisor.ts";

const now = Date.parse("2026-11-16T08:00:00.000Z");
const fresh = DateTime.formatIso(DateTime.makeUnsafe(now));

function provider(
  id: string,
  driver: string,
  slugs: ReadonlyArray<string>,
  used: number | null,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: fresh,
    version: null,
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: fresh,
            windows: [
              {
                id: "seven_day",
                kind: "weekly",
                label: "Weekly",
                usedPercent: used,
                resetsAt: "2026-11-20T00:00:00.000Z",
              },
            ],
          },
        }),
    ...over,
  };
}

const sel = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const claude = provider("claudeAgent", "claudeAgent", ["claude-fable-5-2", "claude-opus-5-5"], 20);
const codex = provider("codex", "codex", ["gpt-6.1-sol", "gpt-6-astra"], 20);
const muse = provider("muse", "muse", ["muse-wonder-1.0"], 20);
const providers = [claude, codex, muse];
const base = {
  providers,
  model: null,
  lanes: null,
  nowMs: now,
};
const complex = (...entries: ReadonlyArray<ModelSelection>) => ({
  complex: entries,
  routine: [],
});
const keys = (list: ReadonlyArray<ModelSelection>) =>
  list.map((entry) => `${entry.instanceId}:${entry.model}`);

describe("threadAdvisorState", () => {
  it("follows the settings when the thread made no choice", () => {
    expect(threadAdvisorState(null, { enabled: false })).toEqual({
      enabled: false,
      source: "settings",
    });
    expect(threadAdvisorState(undefined, { enabled: true })).toEqual({
      enabled: true,
      source: "settings",
    });
  });

  it("the thread's own choice wins either way", () => {
    expect(threadAdvisorState("on", { enabled: false })).toEqual({
      enabled: true,
      source: "thread",
    });
    expect(threadAdvisorState("off", { enabled: true })).toEqual({
      enabled: false,
      source: "thread",
    });
  });
});

describe("advisorOrder", () => {
  it("is the built-in Complex track: Fable 5.2, then GPT-6 Astra", () => {
    expect(keys(advisorOrder(base))).toEqual([
      "claudeAgent:claude-fable-5-2",
      "codex:gpt-6-astra",
    ]);
  });

  it("never takes the Review track", () => {
    expect(keys(advisorOrder(base))).not.toContain("muse:muse-wonder-1.0");
    expect(keys(advisorOrder(base))).not.toContain("codex:gpt-6.1-sol");
  });

  it("puts a saved model first and keeps it once", () => {
    const order = keys(advisorOrder({ ...base, model: sel("codex", "gpt-6-astra") }));
    expect(order[0]).toBe("codex:gpt-6-astra");
    expect(order[1]).toBe("claudeAgent:claude-fable-5-2");
    expect(order.filter((key) => key === "codex:gpt-6-astra")).toHaveLength(1);
  });

  it("follows the project's saved Complex track", () => {
    const order = keys(
      advisorOrder({
        ...base,
        lanes: complex(sel("codex", "gpt-6.1-sol"), sel("claudeAgent", "claude-opus-5-5")),
      }),
    );
    expect(order).toEqual(["codex:gpt-6.1-sol", "claudeAgent:claude-opus-5-5"]);
  });

  it("adds the other accounts that run a saved model", () => {
    const second = provider("claude_2", "claudeAgent", ["claude-fable-5-2"], 10);
    const order = keys(
      advisorOrder({
        ...base,
        providers: [claude, second, codex],
        lanes: complex(sel("claudeAgent", "claude-fable-5-2")),
      }),
    );
    expect(order).toEqual(["claudeAgent:claude-fable-5-2", "claude_2:claude-fable-5-2"]);
  });

  it("never lists Fable on an account billed per token", () => {
    const apiKey = provider("claudeAgent", "claudeAgent", ["claude-fable-5-2"], null, {
      auth: { status: "authenticated", type: "apiKey" },
    });
    const order = keys(advisorOrder({ ...base, providers: [apiKey, codex, muse] }));
    expect(order).not.toContain("claudeAgent:claude-fable-5-2");
    expect(order[0]).toBe("codex:gpt-6-astra");
  });
});

describe("resolveAdvisor", () => {
  it("picks Fable 5.2 for a thread on another model, even on the same account", () => {
    expect(
      resolveAdvisor({ ...base, thread: sel("claudeAgent", "claude-opus-5-5") }).advisor,
    ).toEqual(sel("claudeAgent", "claude-fable-5-2"));
    expect(resolveAdvisor({ ...base, thread: sel("codex", "gpt-6.1-sol") }).advisor).toEqual(
      sel("claudeAgent", "claude-fable-5-2"),
    );
  });

  it("on the brief, a thread on the advisor's model uses the next Complex entry", () => {
    const result = resolveAdvisor({ ...base, thread: sel("claudeAgent", "claude-fable-5-2") });
    expect(result.advisor).toEqual(sel("codex", "gpt-6-astra"));
    expect(result.skipped).toEqual([
      { selection: sel("claudeAgent", "claude-fable-5-2"), reason: "same-model" },
    ]);
  });

  it("the same model on another account is still the thread's own model", () => {
    const second = provider("claude_2", "claudeAgent", ["claude-fable-5-2"], 10);
    const result = resolveAdvisor({
      ...base,
      providers: [claude, second, codex],
      thread: sel("claudeAgent", "claude-fable-5-2"),
    });
    expect(result.advisor).toEqual(sel("codex", "gpt-6-astra"));
    expect(result.skipped.map((skip) => skip.reason)).toEqual(["same-model", "same-model"]);
  });

  it("is refused when nothing else can run", () => {
    const result = resolveAdvisor({
      ...base,
      providers: [claude],
      thread: sel("claudeAgent", "claude-fable-5-2"),
      lanes: complex(sel("claudeAgent", "claude-fable-5-2")),
    });
    expect(result.advisor).toBeNull();
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it("tries a saved model first", () => {
    const result = resolveAdvisor({
      ...base,
      model: sel("codex", "gpt-6-astra"),
      thread: sel("claudeAgent", "claude-opus-5-5"),
    });
    expect(result.advisor).toEqual(sel("codex", "gpt-6-astra"));
  });

  it("skips a signed-out advisor and says why", () => {
    const signedOut = provider("claudeAgent", "claudeAgent", ["claude-fable-5-2"], null, {
      auth: { status: "unauthenticated" },
    });
    const result = resolveAdvisor({
      ...base,
      providers: [signedOut, codex, muse],
      thread: sel("codex", "gpt-6.1-sol"),
    });
    expect(result.advisor?.model).toBe("gpt-6-astra");
    expect(result.skipped[0]).toEqual({
      selection: sel("claudeAgent", "claude-fable-5-2"),
      reason: "signed-out",
    });
  });

  it("never picks a Gemini spend account from the built-in order", () => {
    const gemini = provider("acpRegistry_gemini", "acpRegistry", ["gemini-4-carbon"], 5);
    const result = resolveAdvisor({
      ...base,
      providers: [gemini],
      thread: sel("codex", "gpt-6.1-sol"),
    });
    expect(result.advisor).toBeNull();
  });

  it("a saved Complex entry on an agent with unknown billing is the person's choice", () => {
    const agent = provider("acpRegistry_agent", "acpRegistry", ["gpt-6-astra"], null);
    const thread = sel("codex", "gpt-6.1-sol");
    expect(resolveAdvisor({ ...base, providers: [agent, codex], thread }).advisor).toEqual(
      sel("codex", "gpt-6-astra"),
    );
    expect(
      resolveAdvisor({
        ...base,
        providers: [agent],
        lanes: complex(sel("acpRegistry_agent", "gpt-6-astra")),
        thread,
      }).advisor,
    ).toEqual(sel("acpRegistry_agent", "gpt-6-astra"));
    expect(resolveAdvisor({ ...base, providers: [agent], thread }).advisor).toBeNull();
  });
});

describe("Claude advisor pairs", () => {
  it("orders the models as the published compatibility table does", () => {
    const level = (slug: string) => claudeCapabilityLevel(slug)!;
    expect(level("claude-fable-5-2")).toBeGreaterThan(level("claude-fable-5-1"));
    expect(level("claude-fable-5-1")).toBeGreaterThan(level("claude-opus-5-5"));
    // Opus 5, Opus 5.5 and Fable 5 advise each other.
    expect(level("claude-fable-5")).toBe(level("claude-opus-5-5"));
    expect(level("claude-opus-5")).toBe(level("claude-opus-5-5"));
    expect(level("claude-opus-5-5")).toBeGreaterThan(level("claude-sonnet-5-5"));
    expect(level("claude-sonnet-5-5")).toBeGreaterThan(level("claude-opus-4-8"));
    expect(level("claude-opus-4-7")).toBe(level("claude-opus-4-8"));
    expect(level("claude-haiku-5-5")).toBe(level("claude-sonnet-5"));
    expect(level("claude-sonnet-5")).toBeGreaterThan(level("claude-opus-4-6"));
    expect(level("claude-opus-4-6")).toBeGreaterThan(level("claude-sonnet-4-6"));
    expect(level("claude-sonnet-4-6")).toBeGreaterThan(level("claude-haiku-4-5"));
  });

  it.each(["claude-fable-5-2[1m]", "claude-fable-5-2-20261001", "claude-fable-5.2"])(
    "reads %s as Fable 5.2",
    (slug) => {
      expect(claudeCapabilityLevel(slug)).toBe(claudeCapabilityLevel("claude-fable-5-2"));
    },
  );

  it("an unlisted model is never paired", () => {
    expect(claudeCapabilityLevel("claude-next-9")).toBeNull();
    expect(claudeCapabilityLevel("gpt-6.1-sol")).toBeNull();
    expect(claudeAdvisorPairAllowed("claude-next-9", "claude-fable-5-2")).toBe(false);
    expect(claudeAdvisorPairAllowed("claude-opus-5-5", "claude-next-9")).toBe(false);
  });

  it.each([
    // [thread, advisor, allowed], rows of the published table
    ["claude-opus-5-5", "claude-fable-5-2", true],
    ["claude-opus-5-5", "claude-fable-5", true],
    ["claude-opus-5-5", "claude-opus-5", true],
    ["claude-opus-5-5", "claude-sonnet-5-5", false],
    ["claude-sonnet-5-5", "claude-opus-5-5", true],
    ["claude-sonnet-5-5", "claude-opus-4-8", false],
    ["claude-haiku-5-5", "claude-sonnet-5", true],
    ["claude-haiku-5-5", "claude-opus-4-6", false],
    ["claude-opus-4-8", "claude-sonnet-5-5", true],
    ["claude-opus-4-8", "claude-sonnet-5", false],
    ["claude-fable-5-1", "claude-fable-5-2", true],
    ["claude-fable-5-1", "claude-opus-5-5", false],
    ["claude-fable-5", "claude-opus-5-5", true],
    ["claude-haiku-4-5", "claude-sonnet-4-6", true],
    ["claude-sonnet-4-6", "claude-haiku-4-5", false],
    ["claude-fable-5-2", "claude-opus-5-5", false],
  ])("thread %s, advisor %s: %s", (thread, advisor, allowed) => {
    expect(claudeAdvisorPairAllowed(thread, advisor)).toBe(allowed);
  });

  it("a model may advise itself, under either of its names, as Anthropic allows", () => {
    expect(claudeAdvisorPairAllowed("claude-fable-5-2", "claude-fable-5-2[1m]")).toBe(true);
    expect(claudeAdvisorPairAllowed("claude-fable-5-2", "claude-mythos-5-2")).toBe(true);
    expect(claudeAdvisorPairAllowed("claude-opus-5-5", "claude-opus-5-5")).toBe(true);
  });
});

describe("preferredAdvisor", () => {
  it("is the first entry of the order, whatever its usage, the thread's own model too", () => {
    const full = provider(
      "claudeAgent",
      "claudeAgent",
      ["claude-fable-5-2", "claude-opus-5-5"],
      100,
    );
    expect(preferredAdvisor({ ...base, providers: [full, codex, muse] })).toEqual(
      sel("claudeAgent", "claude-fable-5-2"),
    );
  });

  it("follows a saved model", () => {
    expect(
      preferredAdvisor({ ...base, model: sel("claudeAgent", "claude-opus-5-5") }),
    ).toEqual(sel("claudeAgent", "claude-opus-5-5"));
  });
});

describe("claudeBuiltInAdvisorModel", () => {
  const opus = sel("claudeAgent", "claude-opus-5-5");
  const fable = sel("claudeAgent", "claude-fable-5-2");

  it("is the advisor's slug for a Claude thread advised by a stronger Claude model", () => {
    expect(claudeBuiltInAdvisorModel({ providers, thread: opus, advisor: fable })).toBe(
      "claude-fable-5-2",
    );
  });

  it("is null for another provider on either side", () => {
    expect(
      claudeBuiltInAdvisorModel({ providers, thread: sel("codex", "gpt-6.1-sol"), advisor: fable }),
    ).toBeNull();
    expect(
      claudeBuiltInAdvisorModel({
        providers,
        thread: opus,
        advisor: sel("muse", "muse-wonder-1.0"),
      }),
    ).toBeNull();
    expect(claudeBuiltInAdvisorModel({ providers, thread: opus, advisor: null })).toBeNull();
  });

  it("is null when the thread's account is billed per token", () => {
    const apiKey = provider(
      "claudeAgent",
      "claudeAgent",
      ["claude-fable-5-2", "claude-opus-5-5"],
      5,
      {
        auth: { status: "authenticated", type: "apiKey" },
      },
    );
    expect(
      claudeBuiltInAdvisorModel({ providers: [apiKey], thread: opus, advisor: fable }),
    ).toBeNull();
  });

  it("is null when Anthropic does not support the pair", () => {
    expect(claudeBuiltInAdvisorModel({ providers, thread: fable, advisor: opus })).toBeNull();
  });

  it("lets Fable advise a Fable thread", () => {
    expect(claudeBuiltInAdvisorModel({ providers, thread: fable, advisor: fable })).toBe(
      "claude-fable-5-2",
    );
  });

  it("uses the thread's own account for an advisor picked on a second Claude account", () => {
    const second = provider("claude_2", "claudeAgent", ["claude-fable-5-2"], 10);
    expect(
      claudeBuiltInAdvisorModel({
        providers: [claude, second],
        thread: opus,
        advisor: sel("claude_2", "claude-fable-5-2"),
      }),
    ).toBe("claude-fable-5-2");
  });
});

describe("threadAdvisorPreview", () => {
  const preview = { ...base, claudeBuiltIn: true };

  it("an Opus thread is advised by Fable, the same past the limit", () => {
    expect(threadAdvisorPreview({ ...preview, thread: sel("claudeAgent", "claude-opus-5-5") })).toEqual({
      advisor: sel("claudeAgent", "claude-fable-5-2"),
      sameModel: false,
      pastLimit: null,
    });
  });

  it("a Fable thread is advised by Fable, then by the next Complex entry past the limit", () => {
    expect(threadAdvisorPreview({ ...preview, thread: sel("claudeAgent", "claude-fable-5-2") })).toEqual({
      advisor: sel("claudeAgent", "claude-fable-5-2"),
      sameModel: true,
      pastLimit: sel("codex", "gpt-6-astra"),
    });
  });

  it("a thread on another provider always takes the brief", () => {
    expect(threadAdvisorPreview({ ...preview, thread: sel("codex", "gpt-6.1-sol") })).toEqual({
      advisor: sel("claudeAgent", "claude-fable-5-2"),
      sameModel: false,
      pastLimit: null,
    });
  });

  it("without Claude's own advisor a Fable thread takes the brief from the start", () => {
    expect(
      threadAdvisorPreview({
        ...preview,
        claudeBuiltIn: false,
        thread: sel("claudeAgent", "claude-fable-5-2"),
      }),
    ).toEqual({ advisor: sel("codex", "gpt-6-astra"), sameModel: false, pastLimit: null });
  });
});

describe("advisorRouteForContext", () => {
  const limit = 200_000;
  it("uses Claude's advisor under the limit and the brief above it", () => {
    expect(advisorRouteForContext({ contextTokens: 199_999, limit, previous: null })).toBe(
      "built-in",
    );
    expect(advisorRouteForContext({ contextTokens: 200_000, limit, previous: "built-in" })).toBe(
      "studio",
    );
  });

  it("returns only under half the limit", () => {
    expect(advisorRouteForContext({ contextTokens: 150_000, limit, previous: "studio" })).toBe(
      "studio",
    );
    expect(advisorRouteForContext({ contextTokens: 100_000, limit, previous: "studio" })).toBe(
      "studio",
    );
    expect(advisorRouteForContext({ contextTokens: 99_999, limit, previous: "studio" })).toBe(
      "built-in",
    );
  });

  it("keeps the previous route when the size is unknown", () => {
    expect(advisorRouteForContext({ contextTokens: null, limit, previous: "studio" })).toBe(
      "studio",
    );
    expect(advisorRouteForContext({ contextTokens: undefined, limit, previous: null })).toBe(
      "built-in",
    );
  });
});

describe("claudeSessionAdvisor", () => {
  const on = { ...DEFAULT_ADVISOR_SETTINGS, enabled: true };
  const input = {
    advisorChild: false,
    mode: null,
    settings: on,
    builtInModel: "claude-fable-5-2",
    contextTokens: 10_000,
    previousRoute: null,
  } as const;

  it("passes nothing when the setting is off and the thread made no choice", () => {
    expect(claudeSessionAdvisor({ ...input, settings: DEFAULT_ADVISOR_SETTINGS })).toEqual({
      kind: "inherit",
    });
  });

  it("switches Claude's advisor off for a thread that chose off", () => {
    expect(claudeSessionAdvisor({ ...input, mode: "off" })).toEqual({ kind: "disable" });
    expect(
      claudeSessionAdvisor({ ...input, mode: "off", settings: DEFAULT_ADVISOR_SETTINGS }),
    ).toEqual({ kind: "disable" });
  });

  it("switches it off in every advisor child", () => {
    expect(claudeSessionAdvisor({ ...input, advisorChild: true })).toEqual({ kind: "disable" });
    expect(
      claudeSessionAdvisor({ ...input, advisorChild: true, settings: DEFAULT_ADVISOR_SETTINGS }),
    ).toEqual({ kind: "disable" });
  });

  it("names the model when the pair and the context allow it", () => {
    expect(claudeSessionAdvisor(input)).toEqual({ kind: "model", model: "claude-fable-5-2" });
    expect(
      claudeSessionAdvisor({ ...input, mode: "on", settings: DEFAULT_ADVISOR_SETTINGS }),
    ).toEqual({ kind: "model", model: "claude-fable-5-2" });
  });

  it("switches it off when the thread uses the studio-code tool instead", () => {
    expect(claudeSessionAdvisor({ ...input, builtInModel: null })).toEqual({ kind: "disable" });
    expect(claudeSessionAdvisor({ ...input, settings: { ...on, claudeBuiltIn: false } })).toEqual({
      kind: "disable",
    });
    expect(claudeSessionAdvisor({ ...input, contextTokens: 250_000 })).toEqual({
      kind: "disable",
    });
    expect(
      claudeSessionAdvisor({ ...input, contextTokens: 150_000, previousRoute: "studio" }),
    ).toEqual({ kind: "disable" });
  });
});

describe("advisorGuidance", () => {
  it("is present when the advisor is on and absent when it is off", () => {
    expect(advisorGuidance({ mode: null, settings: { enabled: true } })).toBe(ADVISOR_GUIDANCE);
    expect(advisorGuidance({ mode: "on", settings: { enabled: false } })).toBe(ADVISOR_GUIDANCE);
    expect(advisorGuidance({ mode: null, settings: { enabled: false } })).toBeNull();
    expect(advisorGuidance({ mode: "off", settings: { enabled: true } })).toBeNull();
  });

  it("is never given to an advisor child", () => {
    expect(
      advisorGuidance({ mode: "on", settings: { enabled: true }, advisorChild: true }),
    ).toBeNull();
  });

  it("names both tools and when to consult", () => {
    expect(ADVISOR_GUIDANCE).toContain("built-in `advisor` tool");
    expect(ADVISOR_GUIDANCE).toContain("studio-code `advisor` tool");
    expect(ADVISOR_GUIDANCE).toMatch(/before the substantive work/u);
    expect(ADVISOR_GUIDANCE).toMatch(/before you report the work as done/u);
    expect(ADVISOR_GUIDANCE).toMatch(/stuck/u);
    expect(ADVISOR_GUIDANCE).toMatch(/Save your results first/u);
  });
});
