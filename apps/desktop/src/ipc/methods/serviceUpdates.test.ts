// @effect-diagnostics nodeBuiltinImport:off -- Synthetic local installation fixtures only.
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import type { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import type { AttachedLocalService } from "../../backend/DesktopLocalService.ts";
import { makeServiceUpdateController } from "../../updates/studioServiceUpdates.ts";

vi.mock("electron", () => ({}));
import {
  appStartAgentRun,
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
