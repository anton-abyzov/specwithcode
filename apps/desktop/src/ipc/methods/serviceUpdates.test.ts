// @effect-diagnostics nodeBuiltinImport:off -- Synthetic local installation fixtures only.
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { it as effectIt } from "@effect/vitest";
import type { DesktopUpdateState, StudioServiceUpdateState } from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vite-plus/test";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironmentModule from "../../app/DesktopEnvironment.ts";
import type { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import * as DesktopLocalService from "../../backend/DesktopLocalService.ts";
import type { AttachedLocalService } from "../../backend/DesktopLocalService.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import {
  makeServiceUpdateController,
  SERVICE_AGENT_DISABLED_MESSAGE,
  ServiceAgentError,
  type ServiceUpdateController,
} from "../../updates/studioServiceUpdates.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

vi.mock("electron", () => ({}));

// A test can swap in a controller that never touches launchd or the disk.
const fake = vi.hoisted(() => ({ controller: null as ServiceUpdateController | null }));
vi.mock("../../updates/studioServiceUpdates.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../updates/studioServiceUpdates.ts")>();
  return {
    ...actual,
    makeServiceUpdateController: (
      input: Parameters<typeof actual.makeServiceUpdateController>[0],
    ) => fake.controller ?? actual.makeServiceUpdateController(input),
  };
});

import {
  appStartAgentRun,
  installServiceUpdates,
  isStaleService,
  controllerForAttachedService,
  serviceCheckFor,
  shouldRequestAppVersion,
} from "./serviceUpdates.ts";

function withInstallations(
  run: (
    home: string,
    environment: DesktopEnvironment["Service"],
    attached: (id: string) => AttachedLocalService,
  ) => void,
) {
  const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "service-attachment-"));
  try {
    for (const id of ["m1", "m4", "work-mac"]) {
      const studioHome = Path.join(home, ".specweave-studio", id);
      FS.mkdirSync(Path.join(studioHome, "updates"), { recursive: true });
      FS.writeFileSync(
        Path.join(studioHome, "installation.json"),
        JSON.stringify({
          schemaVersion: 1,
          identity: id,
          studioHome,
          stateDir: Path.join(studioHome, "userdata"),
          service: { installed: true },
          version: "1.0.17",
        }),
      );
      FS.writeFileSync(
        Path.join(studioHome, "updates/config.json"),
        JSON.stringify({
          schemaVersion: 1,
          checkAutomatically: false,
          downloadInBackground: false,
          installAutomatically: false,
          repository: "private/release-feed",
          quietMinutes: 21,
        }),
      );
    }
    const environment = {
      homeDirectory: home,
      platform: "darwin",
      resolveResourcePathCandidates: () => [],
      path: Path,
      rootDir: "/unused",
    } as unknown as DesktopEnvironment["Service"];
    const attached = (id: string) =>
      ({
        baseDir: Path.join(home, ".specweave-studio", id),
        runtime: { serviceManaged: true },
      }) as AttachedLocalService;
    run(home, environment, attached);
  } finally {
    FS.rmSync(home, { recursive: true, force: true });
  }
}

describe("legacy update controller attachment binding", () => {
  it("selects the exact attached service even when another legacy name sorts first", () =>
    withInstallations((_home, environment, attached) => {
      expect(
        controllerForAttachedService(environment, attached("m4")).installation()?.identity,
      ).toBe("m4");
      expect(
        controllerForAttachedService(environment, attached("m1")).installation()?.identity,
      ).toBe("m1");
    }));
  it("never substitutes a legacy installation for a missing, generic or unmanaged attachment", () =>
    withInstallations((_home, environment, attached) => {
      for (const service of [
        null,
        attached("missing"),
        attached("work-mac"),
        { ...attached("m4"), runtime: { ...attached("m4").runtime, serviceManaged: false } },
      ]) {
        expect(controllerForAttachedService(environment, service).installation()).toBeNull();
      }
    }));
  it("binds a fleet service found through its receipt though its runtime never says managed", () =>
    withInstallations((_home, environment, attached) => {
      const service = {
        ...attached("m4"),
        runtime: { ...attached("m4").runtime, serviceManaged: false },
        installedService: true,
      };
      expect(controllerForAttachedService(environment, service).installation()?.identity).toBe(
        "m4",
      );
    }));
  it("fails closed for ambiguous unscoped callers", () =>
    withInstallations((home) => {
      expect(
        makeServiceUpdateController({
          homeDirectory: home,
          platform: "darwin",
          agentScriptPath: () => null,
        }).installation(),
      ).toBeNull();
    }));
  it("keeps the attached service preferences and private feed without touching any other installation", () =>
    withInstallations((home, environment, attached) => {
      const paths = ["m1", "m4", "work-mac"].map((id) =>
        Path.join(home, ".specweave-studio", id, "updates/config.json"),
      );
      const before = paths.map((path) => FS.readFileSync(path, "utf8"));
      const controller = controllerForAttachedService(environment, attached("m4"));
      controller.writeConfig({
        preferences: {
          checkAutomatically: false,
          downloadAutomatically: false,
          installAutomatically: false,
        },
        channel: "latest",
        checkRequestedAt: "2026-10-14T12:00:00Z",
      });
      expect(FS.readFileSync(paths[0]!, "utf8")).toBe(before[0]);
      expect(FS.readFileSync(paths[2]!, "utf8")).toBe(before[2]);
      expect(JSON.parse(FS.readFileSync(paths[1]!, "utf8"))).toMatchObject({
        checkAutomatically: false,
        downloadInBackground: false,
        installAutomatically: false,
        repository: "private/release-feed",
        quietMinutes: 21,
        checkRequestedAt: "2026-10-14T12:00:00Z",
      });
    }));
});

describe("isStaleService", () => {
  it("is true only for a release service older than the app", () => {
    expect(isStaleService("1.0.20", "1.0.23")).toBe(true);
    expect(isStaleService("1.0.23", "1.0.23")).toBe(false);
    expect(isStaleService("1.0.24", "1.0.23")).toBe(false);
    expect(isStaleService(undefined, "1.0.23")).toBe(false);
    expect(isStaleService("1.0.20", "1.0.23-nightly.1")).toBe(false);
    expect(isStaleService("1.0.20-dev.1", "1.0.23")).toBe(false);
  });
});

describe("appStartAgentRun", () => {
  it("reports a failed agent start at app start instead of leaving a frozen state", () => {
    expect(
      appStartAgentRun({
        checkAutomatically: true,
        automaticUpdatesAllowed: true,
        pendingForcedInstall: false,
      }),
    ).toEqual({ reason: "app start", reportFailure: true });
    expect(
      appStartAgentRun({
        checkAutomatically: false,
        automaticUpdatesAllowed: true,
        pendingForcedInstall: true,
      }),
    ).toEqual({ reason: "pending forced install", reportFailure: true });
    expect(
      appStartAgentRun({
        checkAutomatically: true,
        automaticUpdatesAllowed: false,
        pendingForcedInstall: false,
      }),
    ).toBeNull();
  });
});

describe("shouldRequestAppVersion", () => {
  const forced = {
    requestedAt: "2026-10-20T04:07:30.000Z",
    mode: "force" as const,
    version: "1.0.61",
    holdUntil: "2026-10-20T04:22:30.000Z",
    handled: false,
  };
  const ask = (state: Parameters<typeof shouldRequestAppVersion>[0]["state"]) =>
    shouldRequestAppVersion({
      allowed: true,
      serviceVersion: "1.0.60",
      appVersion: "1.0.61",
      state,
    });

  it("asks for the app's version on an older service with nothing pending", () => {
    expect(ask({ status: "up-to-date", pendingInstall: null })).toBe(true);
    // Older desktops report no pending request at all.
    expect(ask({ status: "downloaded" })).toBe(true);
  });

  it("never turns a forced request into a normal one after the app restarts", () => {
    // The 1.0.58 case: the relaunched app rewrote Update now as a 10-minute quiet wait.
    expect(ask({ status: "downloaded", pendingInstall: forced })).toBe(false);
    expect(ask({ status: "available", pendingInstall: { ...forced, version: "1.0.60" } })).toBe(
      false,
    );
  });

  it("leaves a normal request for the same version, and replaces one for another", () => {
    const normal = { ...forced, mode: "normal" as const, holdUntil: null };
    expect(ask({ status: "downloaded", pendingInstall: normal })).toBe(false);
    expect(ask({ status: "downloaded", pendingInstall: { ...normal, version: "1.0.59" } })).toBe(
      true,
    );
  });

  it("leaves an install or a quiet wait under way, and builds that keep updates off", () => {
    expect(ask({ status: "installing", pendingInstall: null })).toBe(false);
    expect(ask({ status: "waiting-for-quiet", pendingInstall: null })).toBe(false);
    expect(
      shouldRequestAppVersion({
        allowed: false,
        serviceVersion: "1.0.60",
        appVersion: "1.0.61",
        state: { status: "up-to-date" },
      }),
    ).toBe(false);
  });
});

describe("serviceCheckFor", () => {
  const service = {
    status: "up-to-date" as const,
    installedVersion: "1.0.60",
    availableVersion: null,
    downloadedVersion: null,
  };
  const app = { availableVersion: "1.0.61", downloadedVersion: null };

  it("asks the agent once per release the service does not run yet", () => {
    expect(serviceCheckFor({ appState: app, service, asked: new Set() })).toBe("1.0.61");
    expect(serviceCheckFor({ appState: app, service, asked: new Set(["1.0.61"]) })).toBeNull();
    // The downloaded release counts first.
    expect(
      serviceCheckFor({
        appState: { availableVersion: "1.0.61", downloadedVersion: "1.0.62" },
        service,
        asked: new Set(["1.0.61"]),
      }),
    ).toBe("1.0.62");
  });

  it("stays quiet when the agent already knows the release or is busy", () => {
    const quiet = (patch: Partial<typeof service> | Record<string, unknown>) =>
      serviceCheckFor({ appState: app, service: { ...service, ...patch }, asked: new Set() });
    expect(quiet({ installedVersion: "1.0.61" })).toBeNull();
    expect(quiet({ status: "downloaded", downloadedVersion: "1.0.61" })).toBeNull();
    expect(quiet({ status: "available", availableVersion: "1.0.62" })).toBeNull();
    expect(quiet({ status: "downloading" })).toBeNull();
    expect(quiet({ status: "installing" })).toBeNull();
    expect(quiet({ status: "not-managed" })).toBeNull();
    expect(
      serviceCheckFor({
        appState: { availableVersion: null, downloadedVersion: null },
        service,
        asked: new Set(),
      }),
    ).toBeNull();
  });
});

describe("installServiceUpdates", () => {
  const frozen: StudioServiceUpdateState = {
    status: "up-to-date",
    identity: "m4",
    installedVersion: "1.0.60",
    availableVersion: null,
    downloadedVersion: null,
    checkedAt: null,
    quietSince: null,
    message: null,
    lastInstall: null,
  };
  const appState = (availableVersion: string | null) =>
    ({
      enabled: true,
      status: availableVersion === null ? "idle" : "available",
      channel: "latest",
      currentVersion: "1.0.60",
      hostArch: "arm64",
      appArch: "arm64",
      runningUnderArm64Translation: false,
      availableVersion,
      downloadedVersion: null,
      releaseNotes: [],
      omittedReleaseCount: 0,
      downloadPercent: null,
      checkedAt: null,
      message: null,
      errorContext: null,
      canRetry: false,
      productionBuild: true,
    }) satisfies DesktopUpdateState;
  // Real promises (the agent's launchctl calls) settle outside the test clock.
  // @effect-diagnostics-next-line globalTimers:off -- A real macrotask, which the test clock does not run.
  const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
  const settleAll = Effect.gen(function* () {
    for (let step = 0; step < 5; step += 1) yield* settle;
  });
  // The states the desktop sent its windows.
  const published: StudioServiceUpdateState[] = [];

  /**
   * Installs the service-update IPC with `controller` and lets the app settle,
   * so its own agent run is done; then `afterStart` publishes the app's update
   * states and reads what Settings would show.
   */
  const withServiceUpdates = (
    controller: ServiceUpdateController,
    afterStart: (
      appChanges: Queue.Queue<DesktopUpdateState>,
      readState: Effect.Effect<StudioServiceUpdateState>,
    ) => Effect.Effect<void>,
  ) => {
    fake.controller = controller;
    const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const ipcMain: DesktopIpc.DesktopIpcMain = {
      handle: (channel, listener) => void handlers.set(channel, listener),
      removeHandler: (channel) => void handlers.delete(channel),
      on: () => undefined,
      removeAllListeners: () => undefined,
    };
    const readState = Effect.promise(
      async () =>
        (await handlers.get(IpcChannels.SERVICE_UPDATE_GET_STATE_CHANNEL)!(
          { sender: { id: 1 } },
          undefined,
        )) as StudioServiceUpdateState,
    );
    return Effect.gen(function* () {
      const changes = yield* Queue.unbounded<DesktopUpdateState>();
      const layer = Layer.mergeAll(
        DesktopIpc.layer(ipcMain),
        Layer.succeed(DesktopEnvironmentModule.DesktopEnvironment, {
          homeDirectory: "/synthetic/home",
          platform: "darwin",
          appVersion: "1.0.60",
          resolveResourcePathCandidates: () => [],
          path: Path,
          rootDir: "/synthetic/root",
        } as unknown as DesktopEnvironment["Service"]),
        DesktopAppSettings.layerTest(),
        DesktopConfig.layerTest({}),
        Layer.succeed(ElectronWindow.ElectronWindow, {
          sendAll: (channel: string, value: unknown) =>
            Effect.sync(() => {
              if (channel === IpcChannels.SERVICE_UPDATE_STATE_CHANNEL) {
                published.push(value as StudioServiceUpdateState);
              }
            }),
        } as unknown as ElectronWindow.ElectronWindow["Service"]),
        Layer.succeed(DesktopUpdates.DesktopUpdates, {
          subscribe: Effect.succeed({
            latest: appState(null),
            changes: Stream.fromQueue(changes),
          }),
          applyPreferences: Effect.void,
        } as unknown as DesktopUpdates.DesktopUpdates["Service"]),
        Layer.succeed(DesktopLocalService.DesktopLocalService, {
          attached: Effect.succeed(Option.none()),
        } as unknown as DesktopLocalService.DesktopLocalService["Service"]),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installServiceUpdates();
          // The app settles and runs its own agent pass.
          yield* TestClock.adjust(Duration.seconds(20));
          yield* settleAll;
          yield* afterStart(changes, readState);
        }),
      ).pipe(Effect.provide(layer));
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.ensuring(
        Effect.sync(() => {
          fake.controller = null;
        }),
      ),
    );
  };

  /** A controller for the m4 installation whose agent runs report as `ensureAgent` does. */
  const controllerWith = (
    overrides: Pick<ServiceUpdateController, "ensureAgent"> & Partial<ServiceUpdateController>,
    kicks: string[],
  ): ServiceUpdateController => ({
    installation: () => ({ identity: "m4", studioHome: "/synthetic/m4", version: "1.0.60" }),
    readState: () => frozen,
    writeConfig: () => undefined,
    runAgentNow: async () => {
      kicks.push("runAgentNow");
    },
    repairAgent: async () => undefined,
    pendingForcedInstall: () => false,
    ...overrides,
  });

  effectIt.effect(
    "keeps a turned-off agent's failure when the app finds a release on its own",
    () => {
      const configs: Array<Record<string, unknown>> = [];
      const kicks: string[] = [];
      const controller = controllerWith(
        {
          writeConfig: (input) => {
            configs.push({ ...input });
          },
          // launchd has the agent's label turned off.
          ensureAgent: async () => {
            kicks.push("ensureAgent");
            throw new ServiceAgentError({
              step: "disabled",
              message: SERVICE_AGENT_DISABLED_MESSAGE,
            });
          },
        },
        kicks,
      );
      return withServiceUpdates(controller, (appChanges, readState) =>
        Effect.gen(function* () {
          // The app's own agent run found the label turned off, and says the
          // failure is its own, so no window offers a forced request for it.
          expect(yield* readState).toMatchObject({
            status: "error",
            message: SERVICE_AGENT_DISABLED_MESSAGE,
            agentStartFailed: true,
          });

          // Hours later the app finds a release the service does not know.
          yield* Queue.offer(appChanges, appState("1.0.61"));
          yield* settleAll;
          // The agent was asked to check...
          expect(configs.at(-1)).toMatchObject({ checkRequestedAt: expect.any(String) });
          expect(kicks.filter((kick) => kick === "ensureAgent")).toHaveLength(2);
          // ...and Settings still says why it cannot run, not a frozen "up to date".
          expect(yield* readState).toMatchObject({
            status: "error",
            message: SERVICE_AGENT_DISABLED_MESSAGE,
            agentStartFailed: true,
          });
        }),
      );
    },
  );

  effectIt.effect("sends its windows the agent's state as soon as it asks for a check", () => {
    const kicks: string[] = [];
    let current = frozen;
    const controller = controllerWith(
      {
        readState: () => current,
        writeConfig: (input) => {
          // The agent wrote a newer state since the windows last heard.
          if (input.checkRequestedAt !== undefined) {
            current = { ...frozen, checkedAt: "2026-10-20T10:00:00.000Z" };
          }
        },
        ensureAgent: async () => {
          kicks.push("ensureAgent");
        },
      },
      kicks,
    );
    return withServiceUpdates(controller, (appChanges) =>
      Effect.gen(function* () {
        published.length = 0;
        // Well before the next 20-second look at the agent's state.
        yield* Queue.offer(appChanges, appState("1.0.61"));
        yield* settleAll;
        // Not the desktop's own failure, and it says so: a window then trusts
        // the agent's words for a refusal Update now gets past.
        expect(published.at(-1)).toMatchObject({
          checkedAt: "2026-10-20T10:00:00.000Z",
          agentStartFailed: false,
        });
      }),
    );
  });

  effectIt.effect("never shows a failure of a check nobody asked for", () => {
    const configs: Array<Record<string, unknown>> = [];
    const kicks: string[] = [];
    const controller = controllerWith(
      {
        writeConfig: (input) => {
          configs.push({ ...input });
        },
        // The app start's run works; by the time the app finds a release, launchd has the label turned off.
        ensureAgent: async () => {
          kicks.push("ensureAgent");
          if (kicks.filter((kick) => kick === "ensureAgent").length === 1) return;
          throw new ServiceAgentError({
            step: "disabled",
            message: SERVICE_AGENT_DISABLED_MESSAGE,
          });
        },
      },
      kicks,
    );
    return withServiceUpdates(controller, (appChanges, readState) =>
      Effect.gen(function* () {
        expect(yield* readState).toMatchObject({ status: "up-to-date" });
        yield* Queue.offer(appChanges, appState("1.0.61"));
        yield* settleAll;
        expect(configs.at(-1)).toMatchObject({ checkRequestedAt: expect.any(String) });
        expect(kicks.filter((kick) => kick === "ensureAgent")).toHaveLength(2);
        expect(yield* readState).toMatchObject({ status: "up-to-date", agentStartFailed: false });
      }),
    );
  });

  effectIt.effect("does not run the agent for a check it could not write", () => {
    const kicks: string[] = [];
    const controller = controllerWith(
      {
        writeConfig: (input) => {
          if (input.checkRequestedAt !== undefined) throw new Error("disk full");
        },
        ensureAgent: async () => {
          kicks.push("ensureAgent");
        },
      },
      kicks,
    );
    return withServiceUpdates(controller, (appChanges) =>
      Effect.gen(function* () {
        const before = kicks.length;
        yield* Queue.offer(appChanges, appState("1.0.61"));
        yield* settleAll;
        expect(kicks.slice(before)).toEqual([]);
      }),
    );
  });

  effectIt.effect("passes later releases on while an agent refresh hangs", () => {
    const configs: Array<Record<string, unknown>> = [];
    const kicks: string[] = [];
    const controller = controllerWith(
      {
        writeConfig: (input) => {
          configs.push({ ...input });
        },
        // launchctl hangs from the first check nobody asked for on.
        ensureAgent: () => {
          kicks.push("ensureAgent");
          const runs = kicks.filter((kick) => kick === "ensureAgent").length;
          return runs === 1 ? Promise.resolve() : new Promise<void>(() => undefined);
        },
      },
      kicks,
    );
    return withServiceUpdates(controller, (appChanges) =>
      Effect.gen(function* () {
        yield* Queue.offer(appChanges, appState("1.0.61"));
        yield* settleAll;
        yield* Queue.offer(appChanges, appState("1.0.62"));
        yield* settleAll;
        expect(configs.filter((config) => config.checkRequestedAt !== undefined)).toHaveLength(2);
      }),
    );
  });
});
