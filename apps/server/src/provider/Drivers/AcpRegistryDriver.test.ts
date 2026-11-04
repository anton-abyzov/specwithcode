import {
  AcpRegistryOperationError,
  AcpRegistrySettings,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as AcpRegistrySupport from "../acp/AcpRegistrySupport.ts";
import {
  acpRegistrySnapshotReadiness,
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
  withLastProbedSignOut,
  withCopilotLogin,
  resolveCopilotLogin,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
  saveAcpRegistryCredential,
  copilotUsageCacheKey,
  invalidateAcpRegistryCaches,
  withCopilotUsage,
} from "./AcpRegistryDriver.ts";
import { makeCachedCopilotUsageLimits } from "../copilotUsageLimits.ts";
import * as ServerSettings from "../../serverSettings.ts";

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

  it("refuses Copilot identity advertised by another agent", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "devin" }),
      checkedAt: "2026-10-14T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "devin",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
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
      "https://cdn.agentclientprotocol.com/registry/v1/latest/devin.svg",
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

  it("keeps a probed sign-out on the next readiness placeholder", () => {
    const placeholder = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-10-30T10:00:00.000Z",
      inspection: { status: "ready", agentId: "test-agent", version: null, distribution: "binary" },
    });
    expect(placeholder.status).toBe("ready");
    expect(placeholder.auth.status).toBe("unknown");
    expect(withLastProbedSignOut(placeholder, "unauthenticated").auth.status).toBe(
      "unauthenticated",
    );
    for (const probed of [null, "unknown", "authenticated"] as const)
      expect(withLastProbedSignOut(placeholder, probed)).toBe(placeholder);
  });

  it("shows the Copilot login next to the sign-in, never as the plan label", () => {
    const placeholder = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "github-copilot-cli" }),
      checkedAt: "2026-11-04T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "github-copilot-cli",
        version: null,
        distribution: "binary",
      },
    });
    const signedIn = withCopilotLogin(placeholder, " octocat ");
    expect(signedIn.auth.login).toBe("octocat");
    expect(signedIn.auth.label).toBeUndefined();
    expect(withCopilotLogin(signedIn, "octocat")).toBe(signedIn);
    expect(withCopilotLogin(placeholder, undefined)).toBe(placeholder);

    const signedOut = withLastProbedSignOut(signedIn, "unauthenticated");
    expect(withCopilotLogin(signedOut, "octocat").auth.login).toBeUndefined();
    expect(withCopilotLogin(signedIn, undefined).auth.login).toBeUndefined();
  });

  it("prefers the config.json login over a cached usage read after an account switch", () => {
    // First check: config.json and the usage read both say account A.
    const first = resolveCopilotLogin({
      configLogin: "account-a",
      readingLogin: "account-a",
      known: undefined,
    });
    expect(first).toBe("account-a");
    // Second check inside the cache window: config.json now says B, the
    // cached read still says A.
    expect(
      resolveCopilotLogin({ configLogin: "account-b", readingLogin: "account-a", known: first }),
    ).toBe("account-b");
    // No config login (token in the environment or gh fallback): the read decides.
    expect(
      resolveCopilotLogin({ configLogin: undefined, readingLogin: "account-c", known: first }),
    ).toBe("account-c");
    expect(
      resolveCopilotLogin({ configLogin: undefined, readingLogin: undefined, known: first }),
    ).toBe("account-a");
  });

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

describe("withCopilotUsage", () => {
  const copilotPlaceholder = buildCheckedAcpRegistrySnapshot({
    ...identity,
    settings: decodeSettings({ agentId: "github-copilot-cli" }),
    checkedAt: "2026-11-04T10:00:00.000Z",
    inspection: {
      status: "ready",
      agentId: "github-copilot-cli",
      version: null,
      distribution: "binary",
    },
  });
  const usageFor = (login: string, usedPercent: number) => ({
    limits: {
      checkedAt: "2026-11-04T10:00:00.000Z",
      windows: [
        {
          id: "premium_interactions",
          kind: "monthly" as const,
          label: "Premium requests",
          usedPercent,
        },
      ],
      subscriptionKey: `copilot:${login}`,
    },
    login,
  });
  // A GitHub read that answers for whichever account is signed in now.
  const setup = (delay: "0 seconds" | "15 seconds" = "0 seconds") =>
    Effect.gen(function* () {
      const account = yield* Ref.make("account-a");
      const reads = yield* Ref.make(0);
      const read = Ref.update(reads, (count) => count + 1).pipe(
        Effect.andThen(Effect.sleep(delay)),
        Effect.andThen(Ref.get(account)),
        Effect.map((login) => usageFor(login, login === "account-a" ? 90 : 10)),
      );
      const cache = yield* makeCachedCopilotUsageLimits(read);
      const configLogin = yield* Ref.make<string | undefined>("account-a");
      const login = yield* Ref.make<string | undefined>(undefined);
      const check = withCopilotUsage({
        provider: copilotPlaceholder,
        cache,
        copilotHome: "/home/me/.copilot",
        configLogin,
        login,
      });
      return { account, reads, cache, configLogin, check };
    });

  it("keys a reading by the sign-in folder and the account", () => {
    expect(copilotUsageCacheKey({ copilotHome: "/h/.copilot", login: " Octocat " })).toBe(
      copilotUsageCacheKey({ copilotHome: "/h/.copilot", login: "octocat" }),
    );
    expect(copilotUsageCacheKey({ copilotHome: "/h/.copilot", login: "a" })).not.toBe(
      copilotUsageCacheKey({ copilotHome: "/h/.copilot", login: "b" }),
    );
    expect(copilotUsageCacheKey({ copilotHome: "/h/.copilot", login: "a" })).not.toBe(
      copilotUsageCacheKey({ copilotHome: "/h/.copilot-work", login: "a" }),
    );
    // With no login in config.json, a gh account switch still changes the key.
    expect(
      copilotUsageCacheKey({ copilotHome: "/h/.copilot", login: undefined, accountStamp: "gh:1" }),
    ).not.toBe(
      copilotUsageCacheKey({ copilotHome: "/h/.copilot", login: undefined, accountStamp: "gh:2" }),
    );
  });

  it.effect("reads afresh after a gh account switch when config.json names no login", () =>
    Effect.gen(function* () {
      const { account, reads, cache } = yield* setup();
      const configLogin = yield* Ref.make<string | undefined>(undefined);
      const login = yield* Ref.make<string | undefined>(undefined);
      const accountStamp = yield* Ref.make<string | undefined>("gh:1");
      const check = withCopilotUsage({
        provider: copilotPlaceholder,
        cache,
        copilotHome: "/home/me/.copilot",
        configLogin,
        login,
        accountStamp,
      });
      expect((yield* check).usageLimits?.subscriptionKey).toBe("copilot:account-a");
      yield* Ref.set(account, "account-b");
      yield* Ref.set(accountStamp, "gh:2");
      expect((yield* check).usageLimits?.subscriptionKey).toBe("copilot:account-b");
      expect(yield* Ref.get(reads)).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("never shows the previous account's quota after an account switch", () =>
    Effect.gen(function* () {
      const { account, reads, configLogin, check } = yield* setup();
      const first = yield* check;
      expect(first.usageLimits?.subscriptionKey).toBe("copilot:account-a");
      expect(first.auth.login).toBe("account-a");
      yield* check;
      expect(yield* Ref.get(reads)).toBe(1);
      // The CLI signs in as another account well inside the cache lifetime.
      yield* Ref.set(account, "account-b");
      yield* Ref.set(configLogin, "account-b");
      const switched = yield* check;
      expect(switched.usageLimits?.subscriptionKey).toBe("copilot:account-b");
      expect(switched.usageLimits?.windows[0]?.usedPercent).toBe(10);
      expect(switched.auth.login).toBe("account-b");
      expect(yield* Ref.get(reads)).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("reads afresh after the caches are invalidated", () =>
    Effect.gen(function* () {
      const { reads, cache, check } = yield* setup();
      const enrichment = yield* Ref.make(0);
      const invalidate = invalidateAcpRegistryCaches({
        copilotUsage: cache.invalidate,
        enrichment: Ref.update(enrichment, (count) => count + 1),
      });
      yield* check;
      yield* invalidate;
      yield* check;
      expect(yield* Ref.get(reads)).toBe(2);
      expect(yield* Ref.get(enrichment)).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("shows usage once a read slower than the check budget finishes", () =>
    Effect.gen(function* () {
      const { reads, check } = yield* setup("15 seconds");
      const slow = yield* Effect.forkChild(check);
      yield* TestClock.adjust("6 seconds");
      expect((yield* Fiber.join(slow)).usageLimits?.unavailable?.reason).toBe("probeFailed");
      // The next check joins the running read rather than starting another.
      const waiting = yield* Effect.forkChild(check);
      yield* TestClock.adjust("6 seconds");
      yield* Fiber.join(waiting);
      yield* TestClock.adjust("6 seconds");
      const later = yield* check;
      expect(later.usageLimits?.subscriptionKey).toBe("copilot:account-a");
      expect(yield* Ref.get(reads)).toBe(1);
    }).pipe(Effect.scoped),
  );
});

describe("saveAcpRegistryCredential", () => {
  const geminiId = ProviderInstanceId.make("acpRegistry_gemini");
  it.effect("stores the API key as a sensitive variable and keeps the rest of the instance", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* saveAcpRegistryCredential(settings, geminiId, {
        envName: "GEMINI_API_KEY",
        value: "AIza-test-not-a-real-key",
        authMethodId: "gemini-api-key",
      });
      const instance = (yield* settings.getSettings).providerInstances[geminiId];
      expect(instance?.enabled).toBe(true);
      expect(instance?.displayName).toBe("Gemini CLI");
      expect(instance?.config).toEqual({ agentId: "gemini", authMethodId: "gemini-api-key" });
      expect(instance?.environment).toEqual([
        { name: "HTTPS_PROXY", value: "http://proxy", sensitive: false },
        { name: "GEMINI_API_KEY", value: "AIza-test-not-a-real-key", sensitive: true },
      ]);
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [geminiId]: {
              driver: "acpRegistry",
              displayName: "Gemini CLI",
              enabled: true,
              config: { agentId: "gemini" },
              environment: [
                { name: "HTTPS_PROXY", value: "http://proxy", sensitive: false },
                { name: "GEMINI_API_KEY", value: "old-key", sensitive: true },
              ],
            },
          },
        } as never),
      ),
    ),
  );

  it.effect("saves only the method when the key is already in the environment", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* saveAcpRegistryCredential(settings, geminiId, {
        envName: "GEMINI_API_KEY",
        value: "AIza-host-test-key",
        authMethodId: "gemini-api-key",
        keepEnvironment: true,
      });
      const instance = (yield* settings.getSettings).providerInstances[geminiId];
      expect(instance?.config).toEqual({ agentId: "gemini", authMethodId: "gemini-api-key" });
      expect(instance?.environment).toEqual([
        { name: "HTTPS_PROXY", value: "http://proxy", sensitive: false },
      ]);
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [geminiId]: {
              driver: "acpRegistry",
              displayName: "Gemini CLI",
              enabled: true,
              config: { agentId: "gemini" },
              environment: [{ name: "HTTPS_PROXY", value: "http://proxy", sensitive: false }],
            },
          },
        } as never),
      ),
    ),
  );

  it.effect("fails without echoing the key when the instance is gone", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const error = yield* Effect.flip(
        saveAcpRegistryCredential(settings, geminiId, {
          envName: "GEMINI_API_KEY",
          value: "AIza-test-not-a-real-key",
          authMethodId: "gemini-api-key",
        }),
      );
      expect(error.detail).toContain("The API key worked but could not be saved on this machine.");
      expect(JSON.stringify(error)).not.toContain("AIza-test-not-a-real-key");
    }).pipe(Effect.provide(ServerSettings.layerTest())),
  );
});
