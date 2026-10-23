import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  formatStorageFreeSpace,
  isPaidModelBilling,
  providerModelBilling,
  resolveEnvironmentMachineKind,
  statfsBytes,
  ServerConfig,
  ServerObservability,
  ServerProvider,
  ServerProviders,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings } from "./settings.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerProviders = Schema.decodeUnknownSync(ServerProviders);
const decodeServerObservability = Schema.decodeUnknownSync(ServerObservability);
const decodeUpsertKeybindingResult = Schema.decodeUnknownSync(ServerUpsertKeybindingResult);
const decodeAvailableEditors = Schema.decodeUnknownSync(ServerConfig.fields.availableEditors);

const baseProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
};

describe("ServerProvider", () => {
  it.each([undefined, true, false])("decodes workspace command discovery pending=%s", (pending) => {
    const workspace = {
      cwd: "/workspace/project",
      checkedAt: baseProviderSnapshot.checkedAt,
      slashCommands: [{ name: "compact" }],
      ...(pending === undefined ? {} : { slashCommandsPending: pending }),
      skills: [{ name: "project", path: "/workspace/project/SKILL.md", enabled: true }],
    };
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      workspaceSnapshots: [workspace],
    });
    expect(parsed.workspaceSnapshots).toEqual([workspace]);
  });

  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      supportedRuntimeModes: ["approval-required", "future-mode", "full-access"],
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.supportedRuntimeModes).toEqual(["approval-required", "full-access"]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/dev/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/dev/.codex");
  });

  it("decodes optional legacy model metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          isLegacy: true,
          capabilities: null,
        },
      ],
    });

    expect(parsed.models[0]?.isLegacy).toBe(true);
  });

  it("decodes a model from before capability and billing fields", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
    });
    const model = parsed.models[0];
    expect(model?.billing).toBeUndefined();
    expect(model?.toolCalls).toBeUndefined();
    expect(model?.reasoning).toBeUndefined();
    expect(model?.imageInput).toBeUndefined();
    expect(model?.contextWindow).toBeUndefined();
    expect(model?.maxOutput).toBeUndefined();
  });

  it("round-trips model capability and billing fields", () => {
    const model = {
      slug: "openrouter/qwen3-coder",
      name: "Qwen3 Coder",
      isCustom: false,
      capabilities: null,
      billing: "paid-router",
      toolCalls: true,
      reasoning: "optional",
      imageInput: false,
      contextWindow: 262_144,
      maxOutput: 65_536,
    };
    const parsed = decodeServerProvider({ ...baseProviderSnapshot, models: [model] });
    expect(parsed.models[0]).toEqual(model);
    const encoded = Schema.encodeSync(ServerProvider)(parsed);
    expect(decodeServerProvider(encoded).models[0]).toEqual(model);
  });

  it("drops a billing or reasoning kind this build does not know instead of the provider", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      models: [
        {
          slug: "m",
          name: "M",
          isCustom: false,
          capabilities: null,
          billing: "metered-future",
          reasoning: "adaptive",
          toolCalls: false,
        },
      ],
    });
    expect(parsed.models[0]?.billing).toBeUndefined();
    expect(parsed.models[0]?.reasoning).toBeUndefined();
    expect(parsed.models[0]?.toolCalls).toBe(false);
  });

  it("rejects a non-positive context window", () => {
    expect(() =>
      decodeServerProvider({
        ...baseProviderSnapshot,
        models: [{ slug: "m", name: "M", isCustom: false, capabilities: null, contextWindow: 0 }],
      }),
    ).toThrow();
  });
});

describe("isPaidModelBilling", () => {
  it.each([
    ["paid-router", true],
    ["api", true],
    ["subscription", false],
    ["local", false],
    ["unknown", false],
    [undefined, false],
  ] as const)("%s -> %s", (billing, paid) => {
    expect(isPaidModelBilling(billing)).toBe(paid);
  });
});

describe("providerModelBilling", () => {
  const provider = decodeServerProvider({
    ...baseProviderSnapshot,
    models: [
      { slug: "a", name: "A", isCustom: false, capabilities: null, billing: "local" },
      { slug: "b", name: "B", isCustom: false, capabilities: null },
    ],
  });

  it("reads the billing of the model with that slug", () => {
    expect(providerModelBilling(provider, "a")).toBe("local");
    expect(providerModelBilling(provider, "b")).toBeUndefined();
    expect(providerModelBilling(provider, "missing")).toBeUndefined();
    expect(providerModelBilling(provider, undefined)).toBeUndefined();
    expect(providerModelBilling(undefined, "a")).toBeUndefined();
  });
});

describe("server config forward compatibility", () => {
  it("drops config issues with kinds this build does not know", () => {
    const parsed = decodeUpsertKeybindingResult({
      keybindings: [],
      issues: [
        { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
        { kind: "keybindings.future-issue", message: "From a newer server" },
      ],
    });

    expect(parsed.issues).toEqual([
      { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
    ]);
  });

  it("drops editor ids this build does not know", () => {
    const parsed = decodeAvailableEditors(["zed", "some-future-editor", "vscode"]);

    expect(parsed).toEqual(["zed", "vscode"]);
  });

  // A provider status this build has never seen (a new ServerProviderState,
  // ServerProviderAuthStatus, etc. member) previously failed the whole
  // `providers` array, taking every other provider down with it and, since
  // `providers` sits inside `ServerConfig`, failing the whole config decode —
  // an older client would drop its connection over one provider it can't
  // render. Dropping just that element keeps every other provider working.
  it("drops providers this build cannot decode instead of failing the whole array", () => {
    const decodedBase = decodeServerProvider(baseProviderSnapshot);

    const parsed = decodeServerProviders([
      baseProviderSnapshot,
      { ...baseProviderSnapshot, instanceId: "future", status: "some-future-status" },
    ]);

    expect(parsed).toEqual([decodedBase]);
  });

  it("drops usage windows this build cannot decode instead of failing the provider", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      usageLimits: {
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [
          { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
          { id: "future", kind: "some-future-kind", label: "Future", usedPercent: 1 },
          { id: "bad", kind: "weekly", label: "Weekly", usedPercent: 120 },
        ],
      },
    });

    expect(parsed.usageLimits?.windows).toEqual([
      { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
    ]);
  });
});

describe("ServerConfig storage", () => {
  const status = {
    level: "low",
    freeBytes: 3_200_000_000,
    totalBytes: 994_662_584_320,
    checkedAt: "2026-10-18T12:00:00.000Z",
  };
  const decodeStorage = Schema.decodeUnknownSync(
    Schema.Struct({ storage: ServerConfig.fields.storage }),
  );

  it("decodes a server's storage status, and its absence from older servers", () => {
    expect(decodeStorage({ storage: status })).toEqual({ storage: status });
    expect(decodeStorage({})).toEqual({});
  });

  it("is ignored by a client whose config schema predates it", () => {
    // Older clients decode the snapshot against a struct without the field.
    const decodeOlderConfig = Schema.decodeUnknownSync(
      Schema.Struct({ cwd: ServerConfig.fields.cwd }),
    );
    expect(decodeOlderConfig({ cwd: "/repo", storage: status })).toEqual({ cwd: "/repo" });
  });

  // A status this build cannot read must cost only the status: failing the
  // config decode drops the config subscription, and the machine then reads
  // as offline, the failure the field exists to explain.
  it("drops a storage status this build cannot read instead of failing the config", () => {
    const decodeConfig = Schema.decodeUnknownSync(
      Schema.Struct({ cwd: ServerConfig.fields.cwd, storage: ServerConfig.fields.storage }),
    );
    expect(decodeConfig({ cwd: "/repo", storage: { ...status, level: "future" } })).toEqual({
      cwd: "/repo",
    });
    expect(decodeConfig({ cwd: "/repo", storage: { ...status, freeBytes: 2 ** 60 } })).toEqual({
      cwd: "/repo",
    });
  });

  it("sends no storage status rather than failing to encode the config", () => {
    const encodeConfig = Schema.encodeSync(
      Schema.Struct({ cwd: ServerConfig.fields.cwd, storage: ServerConfig.fields.storage }),
    );
    expect(
      encodeConfig({ cwd: "/repo", storage: { ...status, totalBytes: 2 ** 60 } } as never),
    ).toEqual({
      cwd: "/repo",
    });
    expect(encodeConfig({ cwd: "/repo", storage: status } as never)).toEqual({
      cwd: "/repo",
      storage: status,
    });
  });

  it("caps statfs byte counts at the largest safe integer", () => {
    expect(statfsBytes(1_000n, 4_096n)).toBe(4_096_000);
    expect(statfsBytes(2n ** 52n, 4_096n)).toBe(Number.MAX_SAFE_INTEGER);
    expect(statfsBytes(0n, 4_096n)).toBe(0);
  });

  it("formats free space the way a Mac shows it", () => {
    expect(formatStorageFreeSpace(3_249_000_000)).toBe("3.2 GB");
    expect(formatStorageFreeSpace(1_000_000_000)).toBe("1.0 GB");
    expect(formatStorageFreeSpace(48_700_000_000)).toBe("49 GB");
    expect(formatStorageFreeSpace(640_400_000)).toBe("640 MB");
    expect(formatStorageFreeSpace(0)).toBe("0 MB");
    // Rounded before the unit is picked.
    expect(formatStorageFreeSpace(9_970_000_000)).toBe("10 GB");
    expect(formatStorageFreeSpace(9_940_000_000)).toBe("9.9 GB");
    expect(formatStorageFreeSpace(999_700_000)).toBe("1.0 GB");
    expect(formatStorageFreeSpace(999_400_000)).toBe("999 MB");
  });
});

describe("ServerObservability", () => {
  it("reads a server from before the log signal as exporting no logs", () => {
    const parsed = decodeServerObservability({
      logsDirectoryPath: "/tmp/studio/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "https://collector.example.com/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    });

    expect(parsed.otlpLogsEnabled).toBe(false);
    expect(parsed.otlpLogsUrl).toBeUndefined();
    expect(parsed.productUsageEnabled).toBeUndefined();
    expect(parsed.productUsageDestinationConfigured).toBeUndefined();
  });
  it("preserves explicit product collection state without destination credentials", () => {
    const parsed = decodeServerObservability({
      logsDirectoryPath: "/tmp/studio/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      productUsageEnabled: false,
      productUsageDestinationConfigured: true,
    });
    expect(parsed.productUsageEnabled).toBe(false);
    expect(parsed.productUsageDestinationConfigured).toBe(true);
  });
});

describe("resolveEnvironmentMachineKind", () => {
  const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
  const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
  const descriptor = (platform: Record<string, unknown>) =>
    decodeDescriptor({
      environmentId: "env-1",
      label: "Box",
      platform: { os: "linux", arch: "x64", ...platform },
      serverVersion: "1.0.0",
      capabilities: {},
    });

  it("prefers the user's pick over what the server detected", () => {
    expect(
      resolveEnvironmentMachineKind({
        environment: descriptor({ machine: "mac-mini" }),
        settings: decodeSettings({ environmentIcon: "laptop" }),
      }),
    ).toBe("laptop");
  });

  it("uses detection when nothing is picked", () => {
    expect(
      resolveEnvironmentMachineKind({
        environment: descriptor({ machine: "mac-mini" }),
        settings: decodeSettings({}),
      }),
    ).toBe("mac-mini");
  });

  it("uses detection from a bare descriptor before connecting", () => {
    expect(resolveEnvironmentMachineKind({ environment: descriptor({ machine: "laptop" }) })).toBe(
      "laptop",
    );
  });

  it("falls back to a server for older servers and before connect", () => {
    expect(
      resolveEnvironmentMachineKind({
        environment: descriptor({}),
        settings: decodeSettings({}),
      }),
    ).toBe("server");
    expect(resolveEnvironmentMachineKind(null)).toBe("server");
  });

  it("drops a machine kind this build does not know instead of failing the descriptor", () => {
    const parsed = descriptor({ machine: "toaster" });

    expect(parsed.platform.machine).toBeUndefined();
    expect(
      resolveEnvironmentMachineKind({ environment: parsed, settings: decodeSettings({}) }),
    ).toBe("server");
  });
});
