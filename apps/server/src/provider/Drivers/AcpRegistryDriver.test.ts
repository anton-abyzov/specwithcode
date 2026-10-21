import {
  AcpRegistryOperationError,
  AcpRegistrySettings,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as AcpRegistrySupport from "../acp/AcpRegistrySupport.ts";
import {
  acpRegistrySnapshotReadiness,
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
} from "./AcpRegistryDriver.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const identity = {
  instanceId: ProviderInstanceId.make("acpRegistry_test"),
  displayName: "Test ACP",
  accentColor: undefined,
  continuationKey: "acpRegistry:instance:acpRegistry_test",
};
const noSessionManagement = {
  canList: false,
  canLoad: false,
  canResume: false,
  canLogout: false,
  canDelete: false,
  canConfigureProviders: false,
} as const;

function catalogWithInspection(
  inspection: AcpRegistrySupport.AcpRegistryInspection,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  return {
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.succeed(inspection),
    resolve: () => Effect.die("unused resolve"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  };
}

describe("acpRegistrySnapshotReadiness", () => {
  it("treats a live empty command advertisement as an authoritative replacement", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
        documentationUrl: "https://example.test/agent/setup",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "stale" }],
        skills: [{ name: "stale-skill", path: "stale", enabled: true }],
      },
    });

    const replaced = applyAcpRegistryAvailableCommands(
      provider,
      Option.some({ slashCommands: [], skills: [] }),
    );
    expect(replaced.slashCommands).toEqual([]);
    expect(replaced.skills).toEqual([]);
    expect(applyAcpRegistryAvailableCommands(provider, Option.none()).slashCommands).toEqual([
      { name: "stale" },
    ]);
    expect(provider.iconUrl).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/test-agent.svg",
    );
    expect(provider.setup).toMatchObject({
      canAuthenticate: false,
      documentationUrl: "https://example.test/agent/setup",
    });
  });

  it("keeps Copilot identity when probe metadata names another allowlisted icon", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "github-copilot-cli" }),
      checkedAt: "2026-10-14T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "github-copilot-cli",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/grok-build.svg",
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(provider.iconUrl).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
    );
  });

  it.each([
    ["/usr/local/lib/node_modules/@github/copilot/copilot", "github-copilot-cli", true],
    ["/usr/local/bin/dsh", "github-copilot-cli", false],
    ["/usr/local/bin/copilot", "test-agent", false],
  ] as const)(
    "brands a local %s as Copilot only for Copilot itself",
    (commandPath, agentId, copilot) => {
      const provider = buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({ source: "local", agentId, commandPath }),
        checkedAt: "2026-10-15T10:00:00.000Z",
        inspection: { status: "ready", agentId, version: null, distribution: "local" },
      });
      expect(provider.iconUrl).toBe(
        copilot
          ? "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg"
          : undefined,
      );
    },
  );

  it("keeps authentication unknown when an agent permits a discovery session before sign-in", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [{ id: "browser", name: "Browser", description: null, type: "agent" }],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.setup?.canAuthenticate).toBe(true);
    expect(
      applyAcpRegistryLiveConfiguration(
        snapshot,
        { models: [], currentModelId: null, configOptions: [] },
        { customModels: [], agentId: "test-agent" },
      ).auth.status,
    ).toBe("unknown");
  });

  it("overlays live configuration without dropping probe-owned session capabilities", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "probe-model", name: "Probe model", description: null }],
          currentModelId: "probe-model",
          configOptions: [],
          sessionManagement: {
            canList: true,
            canLoad: true,
            canResume: true,
            canLogout: true,
            canDelete: true,
            canConfigureProviders: true,
          },
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        {
          models: [{ id: "live-model", name: "Live model", description: null }],
          currentModelId: "live-model",
          configOptions: [],
        },
        { customModels: [], agentId: "test-agent" },
      ),
    ).toMatchObject({
      auth: { status: "unknown", canLogout: true },
      nativeSessions: { canList: true, canLoad: true, canResume: true },
      models: [{ slug: "live-model", isDefault: true }],
    });
  });

  it("offers Gemini 4 Argon for Gemini CLI once its catalog is probed", () => {
    const geminiCatalog = {
      models: [
        { id: "auto", name: "Auto", description: null },
        { id: "gemini-3.8-flash", name: "gemini-3.8-flash", description: null },
      ],
      currentModelId: "auto",
      configOptions: [],
    };
    const slugs = (
      configuration: Parameters<typeof applyAcpRegistryLiveConfiguration>[1],
      settings: Parameters<typeof applyAcpRegistryLiveConfiguration>[2],
    ) =>
      applyAcpRegistryLiveConfiguration(
        buildCheckedAcpRegistrySnapshot({
          ...identity,
          settings: decodeSettings({ agentId: "gemini" }),
          checkedAt: "2026-10-17T06:00:00.000Z",
          inspection: {
            status: "ready",
            agentId: "gemini",
            version: "0.63.0",
            distribution: "npx",
          },
        }),
        configuration,
        settings,
      ).models.map((model) => [model.slug, model.isCustom]);

    expect(slugs(geminiCatalog, { customModels: [], agentId: "gemini" })).toEqual([
      ["auto", false],
      ["gemini-3.8-flash", false],
      ["gemini-4-argon", false],
    ]);
    // A catalog that lists Argon, or a custom entry typed earlier, is not duplicated.
    expect(
      slugs(
        {
          ...geminiCatalog,
          models: [{ id: "gemini-4-argon", name: "Gemini 4 Argon", description: null }],
        },
        { customModels: [], agentId: "gemini" },
      ),
    ).toEqual([["gemini-4-argon", false]]);
    expect(
      slugs(geminiCatalog, {
        customModels: ["gemini-4-argon"],
        agentId: "gemini",
      }).filter(([slug]) => slug === "gemini-4-argon"),
    ).toEqual([["gemini-4-argon", false]]);
    // Other agents and an unprobed Gemini CLI get nothing extra.
    expect(slugs(geminiCatalog, { customModels: [], agentId: "test-agent" })).toHaveLength(2);
    expect(
      slugs(
        { models: [], currentModelId: null, configOptions: [] },
        { customModels: [], agentId: "gemini" },
      ),
    ).toEqual([["default", false]]);
  });

  it("maps registry inspection status to provider readiness", () => {
    expect(
      acpRegistrySnapshotReadiness({
        status: "ready",
        agentId: "gemini-cli",
        version: "1.2.3",
        distribution: "npx",
      }),
    ).toEqual({ installed: true, version: "1.2.3", status: "ready" });

    // A registry bump keeps the prepared version ready and points at the update.
    expect(
      acpRegistrySnapshotReadiness({
        status: "ready",
        agentId: "github-copilot-cli",
        agentName: "Copilot",
        version: "1.0.98",
        availableVersion: "1.0.101",
        distribution: "npx",
      }),
    ).toEqual({
      installed: true,
      version: "1.0.98",
      status: "ready",
      message:
        "Copilot 1.0.98 is running; 1.0.101 is available. Use Install / update agent in Settings → Providers.",
    });

    // A registry that rolled back never suggests a downgrade.
    expect(
      acpRegistrySnapshotReadiness({
        status: "ready",
        agentId: "github-copilot-cli",
        agentName: "Copilot",
        version: "1.0.101",
        availableVersion: "1.0.98",
        distribution: "npx",
      }),
    ).toEqual({
      installed: true,
      version: "1.0.101",
      status: "ready",
      message: "Copilot 1.0.101 is running; the ACP Registry lists 1.0.98.",
    });

    expect(
      acpRegistrySnapshotReadiness({
        status: "missing_runner",
        agentId: "gemini-cli",
        version: "1.2.3",
        distribution: "npx",
        runner: "npx",
      }),
    ).toMatchObject({ installed: false, version: "1.2.3", status: "error" });

    expect(
      acpRegistrySnapshotReadiness({
        status: "missing_runner",
        version: null,
        distribution: "local",
      }),
    ).toEqual({
      installed: false,
      version: null,
      status: "error",
      message: "Local ACP executable is not available on this environment's PATH.",
    });

    expect(
      acpRegistrySnapshotReadiness({
        status: "unprepared",
        agentId: "zed-agent",
        version: "2.0.0",
        distribution: "binary",
      }),
    ).toMatchObject({ installed: false, version: "2.0.0", status: "warning" });

    expect(
      acpRegistrySnapshotReadiness({ status: "failed", message: "Registry unavailable." }),
    ).toEqual({
      installed: false,
      version: null,
      status: "error",
      message: "Registry unavailable.",
    });
  });

  it("projects discovery without claiming authentication when no login methods are advertised", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "test-agent",
        customModels: [" custom-model ", "gpt-discovered"],
      }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "gpt-discovered", name: "GPT Discovered", description: null }],
          currentModelId: "gpt-discovered",
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "plan", description: "Create a plan", input: { hint: "topic" } }],
        skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
      },
    });

    expect(snapshot.auth).toEqual({ status: "unknown", canLogout: false });
    expect(snapshot.supportsTextGeneration).toBe(false);
    expect(
      snapshot.models.map(({ slug, name, isCustom, isDefault }) => ({
        slug,
        name,
        isCustom,
        isDefault,
      })),
    ).toEqual([
      {
        slug: "gpt-discovered",
        name: "GPT Discovered",
        isCustom: false,
        isDefault: true,
      },
      {
        slug: "custom-model",
        name: "custom-model",
        isCustom: true,
        isDefault: undefined,
      },
    ]);
    expect(snapshot.slashCommands).toEqual([
      { name: "plan", description: "Create a plan", input: { hint: "topic" } },
    ]);
    expect(snapshot.skills).toEqual([
      { name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true },
    ]);
  });

  it("keeps a default model only when the agent advertises none", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "uvx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    expect(snapshot.models[0]?.isDefault).toBe(true);
  });

  it.each(["registry", "local"] as const)(
    "reports failed authentication after successful %s inspection",
    (source) => {
      const snapshot = buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({
          source,
          ...(source === "local" ? { commandPath: "test-agent" } : { agentId: "test-agent" }),
          authMethodId: "grok-login",
        }),
        checkedAt: "2026-08-13T10:00:00.000Z",
        inspection: {
          status: "ready",
          agentId: "test-agent",
          version: source === "local" ? null : "1.0.0",
          distribution: source === "local" ? "local" : "binary",
        },
        probeError: new AcpRegistryOperationError({
          reason: "authentication_failed",
          message: "Login required.",
          authMethods: [
            {
              id: "api-key",
              name: "API key",
              description: null,
              type: "env_var",
            },
            {
              id: "grok-login",
              name: "Log in with Grok",
              description: null,
              type: "agent",
            },
          ],
        }),
      });

      expect(snapshot).toMatchObject({
        installed: true,
        version: source === "local" ? null : "1.0.0",
        status: "warning",
        setup: { canAuthenticate: true },
        auth: {
          status: "unauthenticated",
          type: "agent",
          label: "Log in with Grok",
        },
        message: 'Sign in in provider settings using "Log in with Grok".',
      });
    },
  );

  it.effect("runs the disposable probe only after local inspection is ready", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ agentId: "test-agent" });
      const environment = { PATH: "/provider/bin" };
      let receivedEnvironment: NodeJS.ProcessEnv | undefined;
      const snapshot = yield* checkAcpRegistryProviderStatus(
        {
          ...identity,
          settings,
          cwd: "/workspace",
          environment,
        },
        (input) =>
          Effect.sync(() => {
            receivedEnvironment = input.environment;
            return {
              probe: {
                instanceId: identity.instanceId,
                ready: true as const,
                icon: null,
                authMethods: [],
                models: [{ id: "agent-model", name: "Agent Model", description: null }],
                currentModelId: "agent-model",
                configOptions: [],
                sessionManagement: noSessionManagement,
              },
              slashCommands: [{ name: "review" }],
              skills: [],
            };
          }),
      ).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(receivedEnvironment).toBe(environment);
      expect(snapshot).toMatchObject({
        auth: { status: "unknown" },
        models: [{ slug: "agent-model" }],
        slashCommands: [{ name: "review" }],
        skills: [],
      });
    }),
  );

  it.effect("publishes concrete local readiness before background ACP discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderReadiness({
        ...identity,
        settings: decodeSettings({ agentId: "test-agent" }),
        environment: { PATH: "/provider/bin" },
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(snapshot).toMatchObject({
        installed: true,
        status: "ready",
        version: "1.0.0",
        auth: { status: "unknown" },
        message: "Checking ACP authentication, models, and commands in the background...",
      });
    }),
  );
});
