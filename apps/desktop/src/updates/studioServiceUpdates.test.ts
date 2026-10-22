// @effect-diagnostics nodeBuiltinImport:off -- the config test writes a real file to check its mode.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as Path from "node:path";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  agentSupportsRuns,
  buildServiceAgentConfig,
  cancelServiceInstallChange,
  findManagedServiceInstallations,
  hasPendingForcedInstall,
  launchdFailureReason,
  makeServiceUpdateController,
  parseServiceInstallOptions,
  refreshThenRunAgent,
  repairServiceAgent,
  SERVICE_AGENT_DISABLED_MESSAGE,
  ServiceAgentError,
  SERVICE_INSTALL_HOLD_LIMIT_MS,
  SERVICE_INSTALL_REQUEST_TTL_MS,
  serviceInstallRequestRecord,
  withAgentStartFailure,
  selectAgentScriptPath,
  serviceAgentLabel,
  toServiceUpdateState,
  effectiveUpdatePreferences,
} from "./studioServiceUpdates.ts";

const HOME = "/Users/someone";
const ROOT = Path.join(HOME, ".specweave-studio");

const installationJson = (identity: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    identity,
    version: "0.1.4",
    studioHome: Path.join(ROOT, identity),
    stateDir: Path.join(ROOT, identity, "userdata"),
    service: { installed: true },
    ...overrides,
  });

const PREFERENCES = {
  checkAutomatically: true,
  downloadAutomatically: true,
  installAutomatically: true,
};

describe("studioServiceUpdates", () => {
  it("never picks an update agent inside app.asar, which python cannot open", () => {
    const resources = "/Applications/SpecWeave Studio (Alpha).app/Contents/Resources";
    const asarCopy = `${resources}/app.asar/apps/desktop/prod-resources/studio-updater/update_agent.py`;
    const realCopy = `${resources}/studio-updater/update_agent.py`;
    // Electron's fs reports both as present; only the real file is usable.
    const exists = (candidate: string) => candidate === asarCopy || candidate === realCopy;

    expect(
      selectAgentScriptPath(
        [
          `${resources}/app.asar/apps/desktop/resources/studio-updater/update_agent.py`,
          asarCopy,
          `${resources}/resources/studio-updater/update_agent.py`,
          realCopy,
        ],
        exists,
      ),
    ).toBe(realCopy);
    expect(selectAgentScriptPath([asarCopy], exists)).toBeNull();
    expect(
      selectAgentScriptPath(["C:\\Studio\\resources\\app.asar\\agent.py"], () => true),
    ).toBeNull();
    // A folder that merely starts with ".asar" text is still a real path.
    expect(selectAgentScriptPath(["/opt/my.asarchive/agent.py"], () => true)).toBe(
      "/opt/my.asarchive/agent.py",
    );
  });

  it("finds fleet-installed services by identity folder", () => {
    const files: Record<string, string> = {
      [Path.join(ROOT, "m4", "installation.json")]: installationJson("m4"),
      [Path.join(ROOT, "m1", "installation.json")]: installationJson("m1", {
        service: { installed: false },
      }),
      [Path.join(ROOT, "m3", "installation.json")]: installationJson("m4"),
      [Path.join(ROOT, "userdata", "installation.json")]: installationJson("userdata"),
    };
    const found = findManagedServiceInstallations(
      HOME,
      () => ["userdata", "m4", "m1", "m3", "notes.txt"],
      (path) => {
        const text = files[path];
        if (text === undefined) throw new Error("missing");
        return text;
      },
    );
    expect(found).toEqual([
      { identity: "m4", studioHome: Path.join(ROOT, "m4"), version: "0.1.4" },
    ]);
  });

  it("finds branded services first and unmigrated legacy services beside them", () => {
    const BRANDED = Path.join(HOME, ".specwithcode");
    const receiptAt = (root: string, identity: string) =>
      installationJson(identity, {
        studioHome: Path.join(root, identity),
        stateDir: Path.join(root, identity, "userdata"),
      });
    const files: Record<string, string> = {
      [Path.join(BRANDED, "m4", "installation.json")]: receiptAt(BRANDED, "m4"),
      [Path.join(ROOT, "m4", "installation.json")]: receiptAt(ROOT, "m4"),
      [Path.join(ROOT, "m1", "installation.json")]: receiptAt(ROOT, "m1"),
    };
    const found = findManagedServiceInstallations(
      HOME,
      (path) => (path === BRANDED ? ["m4", "userdata"] : ["m1", "m4"]),
      (path) => {
        const text = files[path];
        if (text === undefined) throw new Error("missing");
        return text;
      },
    );
    expect(found).toEqual([
      { identity: "m1", studioHome: Path.join(ROOT, "m1"), version: "0.1.4" },
      { identity: "m4", studioHome: Path.join(BRANDED, "m4"), version: "0.1.4" },
    ]);
  });

  it("finds nothing when Studio was never installed", () => {
    expect(
      findManagedServiceInstallations(HOME, () => {
        throw new Error("ENOENT");
      }),
    ).toEqual([]);
  });

  it("writes preferences and keeps requests and the quiet period from before", () => {
    const config = buildServiceAgentConfig({
      previous: {
        quietMinutes: 25,
        installRequestedAt: "2026-10-10T01:00:00.000Z",
        repository: "acme/studio",
      },
      preferences: { ...PREFERENCES, installAutomatically: false },
      channel: "nightly",
      checkRequestedAt: "2026-10-10T02:00:00.000Z",
    });
    expect(config).toEqual({
      schemaVersion: 1,
      checkAutomatically: true,
      downloadInBackground: true,
      installAutomatically: false,
      channel: "preview",
      quietMinutes: 25,
      installRequestedAt: "2026-10-10T01:00:00.000Z",
      checkRequestedAt: "2026-10-10T02:00:00.000Z",
      installMode: "normal",
      installHoldUntil: null,
      installCancelledAt: null,
      installRequest: null,
      repository: "acme/studio",
    });
  });

  it("writes a forced install with its hold, and keeps it across other writes", () => {
    const forced = buildServiceAgentConfig({
      previous: { installCancelledAt: "2026-10-10T00:30:00.000Z" },
      preferences: PREFERENCES,
      channel: "latest",
      installRequestedAt: "2026-10-10T01:00:00.000Z",
      installMode: "force",
      installHoldUntil: "2026-10-10T01:15:00.000Z",
    });
    expect(forced).toMatchObject({
      installRequestedAt: "2026-10-10T01:00:00.000Z",
      installMode: "force",
      installHoldUntil: "2026-10-10T01:15:00.000Z",
      installCancelledAt: "2026-10-10T00:30:00.000Z",
    });
    // A preferences save or a check leaves the request as it is.
    const saved = buildServiceAgentConfig({
      previous: forced,
      preferences: PREFERENCES,
      channel: "latest",
      checkRequestedAt: "2026-10-10T01:01:00.000Z",
    });
    expect(saved).toMatchObject({
      installMode: "force",
      installHoldUntil: "2026-10-10T01:15:00.000Z",
    });
    // Cancelling withdraws the request itself, so an older agent copy that
    // ignores installCancelledAt has nothing pending either, plus the force and the hold.
    expect(
      buildServiceAgentConfig({
        previous: saved,
        preferences: PREFERENCES,
        channel: "latest",
        ...cancelServiceInstallChange("2026-10-10T01:02:00.000Z"),
      }),
    ).toMatchObject({
      installRequestedAt: null,
      installMode: "normal",
      installHoldUntil: null,
      installCancelledAt: "2026-10-10T01:02:00.000Z",
    });
    // Junk from an older or edited file is not carried over.
    expect(
      buildServiceAgentConfig({
        previous: {
          installMode: "sideways" as never,
          installHoldUntil: 5 as never,
          installCancelledAt: false as never,
        },
        preferences: PREFERENCES,
        channel: "latest",
      }),
    ).toMatchObject({ installMode: "normal", installHoldUntil: null, installCancelledAt: null });
  });

  it("accepts only a forced install's hold within the next 30 minutes", () => {
    const now = Date.parse("2026-10-12T20:00:00.000Z");
    expect(parseServiceInstallOptions(undefined, now)).toEqual({
      mode: "normal",
      holdUntil: null,
      version: null,
    });
    expect(parseServiceInstallOptions(null, now)).toEqual({
      mode: "normal",
      holdUntil: null,
      version: null,
    });
    expect(parseServiceInstallOptions({ force: "yes" }, now)).toEqual({
      mode: "normal",
      holdUntil: null,
      version: null,
    });
    expect(
      parseServiceInstallOptions({ force: false, holdUntil: "2026-10-12T20:15:00.000Z" }, now),
    ).toEqual({ mode: "normal", holdUntil: null, version: null });
    expect(
      parseServiceInstallOptions({ force: true, holdUntil: "2026-10-12T20:15:00.000Z" }, now),
    ).toEqual({ mode: "force", holdUntil: "2026-10-12T20:15:00.000Z", version: null });
    // Normalised to UTC.
    expect(
      parseServiceInstallOptions({ force: true, holdUntil: "2026-10-12T16:15:00-04:00" }, now),
    ).toEqual({ mode: "force", holdUntil: "2026-10-12T20:15:00.000Z", version: null });
    for (const holdUntil of [
      "2026-10-12T19:59:00.000Z",
      DateTime.formatIso(DateTime.makeUnsafe(now + SERVICE_INSTALL_HOLD_LIMIT_MS + 1)),
      "tomorrow",
      "Oct 12 2026 20:10",
      "2026-10-12",
      12345,
      `2026-10-12T20:10:00.000Z${" ".repeat(80)}`,
    ]) {
      expect(parseServiceInstallOptions({ force: true, holdUntil }, now)).toEqual({
        mode: "force",
        holdUntil: null,
        version: null,
      });
    }
    expect(
      parseServiceInstallOptions(
        {
          force: true,
          holdUntil: DateTime.formatIso(DateTime.makeUnsafe(now + SERVICE_INSTALL_HOLD_LIMIT_MS)),
        },
        now,
      ).holdUntil,
    ).not.toBeNull();
  });

  it("ties an install request to the version shown, from the renderer or the agent's state", () => {
    const now = Date.parse("2026-10-12T20:00:00.000Z");
    expect(parseServiceInstallOptions({ force: true, version: "1.0.7" }, now).version).toBe(
      "1.0.7",
    );
    expect(parseServiceInstallOptions({ version: "1.0.7" }, now)).toEqual({
      mode: "normal",
      holdUntil: null,
      version: "1.0.7",
    });
    for (const version of ["latest", "v1.0.7", "1.0", "1.0.7-beta.1", "01.0.7", 107, null]) {
      expect(parseServiceInstallOptions({ force: true, version }, now).version).toBeNull();
    }
    const at = "2026-10-12T20:00:00.000Z";
    const offered = { downloadedVersion: "1.0.8", availableVersion: "1.0.8" };
    // What the renderer showed wins over what the agent offers by the time the request lands.
    expect(serviceInstallRequestRecord(at, "1.0.7", offered)).toEqual({ at, version: "1.0.7" });
    // An older renderer names none: Settings showed the agent's version.
    expect(serviceInstallRequestRecord(at, null, offered)).toEqual({ at, version: "1.0.8" });
    expect(
      serviceInstallRequestRecord(at, null, { downloadedVersion: null, availableVersion: "1.0.9" }),
    ).toEqual({ at, version: "1.0.9" });
    expect(
      serviceInstallRequestRecord(at, null, { downloadedVersion: null, availableVersion: null }),
    ).toBeNull();
    expect(serviceInstallRequestRecord(at, null, null)).toBeNull();
  });

  it("keeps the request's version across other writes and clears it on cancel", () => {
    const installRequest = { at: "2026-10-12T20:00:00.000Z", version: "1.0.7" };
    const requested = buildServiceAgentConfig({
      previous: null,
      preferences: PREFERENCES,
      channel: "latest",
      installRequestedAt: installRequest.at,
      installMode: "force",
      installHoldUntil: "2026-10-12T20:15:00.000Z",
      installRequest,
    });
    expect(requested).toMatchObject({ installRequestedAt: installRequest.at, installRequest });
    const saved = buildServiceAgentConfig({
      previous: requested,
      preferences: PREFERENCES,
      channel: "latest",
      checkRequestedAt: "2026-10-12T20:01:00.000Z",
    });
    expect(saved.installRequest).toEqual(installRequest);
    expect(
      buildServiceAgentConfig({
        previous: saved,
        preferences: PREFERENCES,
        channel: "latest",
        ...cancelServiceInstallChange("2026-10-12T20:02:00.000Z"),
      }).installRequest,
    ).toBeNull();
    for (const junk of [
      "1.0.7",
      { at: "soon", version: "1.0.7" },
      { at: installRequest.at, version: "latest" },
    ]) {
      expect(
        buildServiceAgentConfig({
          previous: { installRequest: junk as never },
          preferences: PREFERENCES,
          channel: "latest",
        }).installRequest,
      ).toBeNull();
    }
  });

  it("names an Update now run to the agent, keeps it across writes, and clears it otherwise", () => {
    const named = buildServiceAgentConfig({
      previous: null,
      preferences: PREFERENCES,
      channel: "latest",
      installRequestedAt: "2026-10-21T12:00:00.000Z",
      installMode: "force",
      installHoldUntil: "2026-10-21T12:30:00.000Z",
      installRunId: "6f1c2a34-7d1e-4f5a-9b2c-0e1d2c3b4a59",
    });
    expect(named.installRunId).toBe("6f1c2a34-7d1e-4f5a-9b2c-0e1d2c3b4a59");
    const saved = buildServiceAgentConfig({
      previous: named,
      preferences: PREFERENCES,
      channel: "latest",
      checkRequestedAt: "2026-10-21T12:01:00.000Z",
    });
    expect(saved.installRunId).toBe(named.installRunId);
    // A request outside a run (an older renderer, a fleet rollout) never names the old run.
    const plain = buildServiceAgentConfig({
      previous: saved,
      preferences: PREFERENCES,
      channel: "latest",
      installRequestedAt: "2026-10-21T13:00:00.000Z",
      installRunId: null,
    });
    expect(plain.installRunId).toBeNull();
    expect(
      buildServiceAgentConfig({
        previous: saved,
        preferences: PREFERENCES,
        channel: "latest",
        ...cancelServiceInstallChange("2026-10-21T12:02:00.000Z"),
      }).installRunId,
    ).toBeNull();
    // A config that never had a run is written exactly as before runs.
    expect(
      "installRunId" in
        buildServiceAgentConfig({ previous: null, preferences: PREFERENCES, channel: "latest" }),
    ).toBe(false);
    expect(
      buildServiceAgentConfig({
        previous: { installRunId: "../../x" as never },
        preferences: PREFERENCES,
        channel: "latest",
      }).installRunId,
    ).toBeNull();
  });

  it("reads run support from the agent's state, and the run every window follows", () => {
    expect(agentSupportsRuns(null)).toBe(false);
    expect(agentSupportsRuns("{")).toBe(false);
    expect(agentSupportsRuns(JSON.stringify({ status: "up-to-date" }))).toBe(false);
    expect(agentSupportsRuns(JSON.stringify({ status: "up-to-date", runSupport: 1 }))).toBe(true);
    const home = NodeFS.mkdtempSync(Path.join(NodeOS.tmpdir(), "service-runs-"));
    try {
      const studioHome = Path.join(home, ".specweave-studio", "m4");
      const updates = Path.join(studioHome, "updates");
      NodeFS.mkdirSync(updates, { recursive: true });
      NodeFS.writeFileSync(
        Path.join(studioHome, "installation.json"),
        installationJson("m4", { studioHome, stateDir: Path.join(studioHome, "userdata") }),
      );
      const controller = makeServiceUpdateController({
        homeDirectory: home,
        platform: "darwin",
        agentScriptPath: () => null,
      });
      expect(controller.runSupported()).toBe(false);
      expect("run" in controller.readState()).toBe(false);
      NodeFS.writeFileSync(
        Path.join(updates, "state.json"),
        JSON.stringify({ status: "downloaded", runSupport: 1 }),
      );
      expect(controller.runSupported()).toBe(true);
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      NodeFS.writeFileSync(
        Path.join(updates, "run.json"),
        JSON.stringify({
          schemaVersion: 1,
          runId: "run-1",
          rev: 3,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - 5_000)),
          createdBy: "desktop",
          targetVersion: "0.2.0",
          fromVersion: "0.1.4",
          appTargetVersion: null,
          requestedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 4_000)),
          deadlineAt: DateTime.formatIso(DateTime.makeUnsafe(now + 600_000)),
          phase: "waiting",
          owner: null,
          heartbeatAt: null,
          leaseUntil: null,
          message: "Waiting for running tasks (attempt 1)",
          receipt: null,
          endedAt: null,
        }),
      );
      expect(controller.readState().run).toMatchObject({
        runId: "run-1",
        phase: "waiting",
        terminal: false,
        message: "Waiting for running tasks (attempt 1)",
      });
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not restart the agent for a request that has lapsed", () => {
    const at = "2026-10-12T20:00:00.000Z";
    const config = (installRequest: unknown) =>
      JSON.stringify({
        installRequestedAt: at,
        installMode: "force",
        installHoldUntil: "2026-10-12T20:15:00.000Z",
        installCancelledAt: null,
        installRequest,
      });
    const lapse = Date.parse(at) + SERVICE_INSTALL_REQUEST_TTL_MS;
    expect(SERVICE_INSTALL_REQUEST_TTL_MS).toBe(10 * 60_000);
    expect(hasPendingForcedInstall(config({ at, version: "1.0.7" }), lapse)).toBe(true);
    expect(hasPendingForcedInstall(config({ at, version: "1.0.7" }), lapse + 1)).toBe(false);
    // A request without its record (an older desktop wrote it) keeps the hold as its limit.
    expect(hasPendingForcedInstall(config(null), lapse + 1)).toBe(true);
    expect(
      hasPendingForcedInstall(
        config({ at: "2026-10-12T19:00:00.000Z", version: "1.0.7" }),
        lapse + 1,
      ),
    ).toBe(true);
  });

  it("writes the agent config privately, with the forced request", () => {
    const home = NodeFS.mkdtempSync(Path.join(NodeOS.tmpdir(), "service-updates-"));
    try {
      const studioHome = Path.join(home, ".specweave-studio", "m4");
      NodeFS.mkdirSync(studioHome, { recursive: true });
      NodeFS.writeFileSync(
        Path.join(studioHome, "installation.json"),
        installationJson("m4", { studioHome, stateDir: Path.join(studioHome, "userdata") }),
      );
      const controller = makeServiceUpdateController({
        homeDirectory: home,
        platform: "darwin",
        agentScriptPath: () => null,
      });
      controller.writeConfig({
        preferences: PREFERENCES,
        channel: "latest",
        installRequestedAt: "2026-10-12T20:00:00.000Z",
        installMode: "force",
        installHoldUntil: "2026-10-12T20:15:00.000Z",
      });
      const configPath = Path.join(studioHome, "updates", "config.json");
      expect(NodeFS.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(NodeFS.readFileSync(configPath, "utf8"))).toMatchObject({
        installRequestedAt: "2026-10-12T20:00:00.000Z",
        installMode: "force",
        installHoldUntil: "2026-10-12T20:15:00.000Z",
        installCancelledAt: null,
      });
      expect(controller.pendingForcedInstall(Date.parse("2026-10-12T20:05:00.000Z"))).toBe(true);
      controller.writeConfig({
        preferences: PREFERENCES,
        channel: "latest",
        ...cancelServiceInstallChange("2026-10-12T20:01:00.000Z"),
      });
      expect(controller.pendingForcedInstall(Date.parse("2026-10-12T20:05:00.000Z"))).toBe(false);
      expect(NodeFS.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(NodeFS.readFileSync(configPath, "utf8"))).toMatchObject({
        installRequestedAt: null,
        installMode: "normal",
        installHoldUntil: null,
        installCancelledAt: "2026-10-12T20:01:00.000Z",
      });
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("finds a forced install still pending after an app restart", () => {
    const now = Date.parse("2026-10-12T20:05:00.000Z");
    const config = (change: Record<string, unknown>) =>
      JSON.stringify({
        installRequestedAt: "2026-10-12T20:00:00.000Z",
        installMode: "force",
        installHoldUntil: "2026-10-12T20:15:00.000Z",
        installCancelledAt: null,
        ...change,
      });
    expect(hasPendingForcedInstall(config({}), now)).toBe(true);
    // A cancel made before this request does not withdraw it.
    expect(
      hasPendingForcedInstall(config({ installCancelledAt: "2026-10-12T19:00:00.000Z" }), now),
    ).toBe(true);
    expect(
      hasPendingForcedInstall(config({ installCancelledAt: "2026-10-12T20:01:00.000Z" }), now),
    ).toBe(false);
    expect(hasPendingForcedInstall(config({ installMode: "normal" }), now)).toBe(false);
    expect(hasPendingForcedInstall(config({ installRequestedAt: null }), now)).toBe(false);
    expect(
      hasPendingForcedInstall(config({ installHoldUntil: "2026-10-12T20:04:00.000Z" }), now),
    ).toBe(false);
    expect(hasPendingForcedInstall(config({ installHoldUntil: null }), now)).toBe(false);
    expect(hasPendingForcedInstall("{not json", now)).toBe(false);
    expect(hasPendingForcedInstall("null", now)).toBe(false);
    expect(hasPendingForcedInstall(null, now)).toBe(false);
  });

  it("defaults to a ten minute quiet period on the stable track", () => {
    const config = buildServiceAgentConfig({
      previous: null,
      preferences: PREFERENCES,
      channel: "latest",
    });
    expect(config.quietMinutes).toBe(10);
    expect(config.channel).toBe("stable");
    expect(config.installRequestedAt).toBeNull();
    expect("repository" in config).toBe(false);
  });

  it("maps the agent's state file to what Settings shows", () => {
    const installation = { identity: "m4", studioHome: Path.join(ROOT, "m4"), version: "0.1.4" };
    expect(toServiceUpdateState({ installation: null, stateText: null }).status).toBe(
      "not-managed",
    );
    expect(toServiceUpdateState({ installation, stateText: null })).toMatchObject({
      status: "starting",
      identity: "m4",
      installedVersion: "0.1.4",
    });
    expect(
      toServiceUpdateState({
        installation,
        stateText: JSON.stringify({
          status: "waiting-for-quiet",
          installedVersion: "0.1.4",
          availableVersion: "0.2.0",
          downloadedVersion: "0.2.0",
          quietSince: "2026-10-10T03:00:00Z",
          message: "Waiting for sessions to finish.",
          lastInstall: { version: "0.1.4", at: "2026-10-09T00:00:00Z", result: "updated" },
        }),
      }),
    ).toMatchObject({
      status: "waiting-for-quiet",
      availableVersion: "0.2.0",
      downloadedVersion: "0.2.0",
      message: "Waiting for sessions to finish.",
      lastInstall: { version: "0.1.4", at: "2026-10-09T00:00:00Z", result: "updated" },
    });
  });

  it("reports automatic checks off when the agent config says so and has no state yet", () => {
    const installation = { identity: "m4", studioHome: Path.join(ROOT, "m4"), version: "0.2.0" };
    const off = JSON.stringify({
      schemaVersion: 1,
      checkAutomatically: false,
      downloadInBackground: false,
      installAutomatically: false,
    });
    expect(toServiceUpdateState({ installation, stateText: null, configText: off })).toMatchObject({
      status: "disabled",
      installedVersion: "0.2.0",
    });
    expect(
      toServiceUpdateState({
        installation,
        stateText: null,
        configText: JSON.stringify({ checkAutomatically: true }),
      }).status,
    ).toBe("starting");
    expect(toServiceUpdateState({ installation, stateText: null, configText: "{" }).status).toBe(
      "starting",
    );
  });

  it("does not trust unknown statuses or malformed files", () => {
    const installation = { identity: "m4", studioHome: Path.join(ROOT, "m4"), version: "0.1.4" };
    expect(
      toServiceUpdateState({ installation, stateText: JSON.stringify({ status: "hacked" }) })
        .status,
    ).toBe("starting");
    expect(toServiceUpdateState({ installation, stateText: "{" }).status).toBe("starting");
    expect(
      toServiceUpdateState({
        installation,
        stateText: JSON.stringify({ status: "error", lastInstall: { result: "maybe" } }),
      }).lastInstall,
    ).toBeNull();
  });

  it("reports the switches that actually run, off when the build keeps self-update off", () => {
    const saved = {
      checkAutomatically: true,
      downloadAutomatically: true,
      installAutomatically: false,
    };
    expect(effectiveUpdatePreferences(saved, true)).toEqual({
      ...saved,
      automaticUpdatesAllowed: true,
    });
    expect(effectiveUpdatePreferences(saved, false)).toEqual({
      checkAutomatically: false,
      downloadAutomatically: false,
      installAutomatically: false,
      automaticUpdatesAllowed: false,
    });
  });

  it("reports the agent's write time", () => {
    const installation = { identity: "m4", studioHome: Path.join(ROOT, "m4"), version: "0.1.4" };
    expect(
      toServiceUpdateState({
        installation,
        stateText: JSON.stringify({
          status: "waiting-for-quiet",
          updatedAt: "2026-10-12T20:08:31.123456+00:00",
        }),
      }).updatedAt,
    ).toBe("2026-10-12T20:08:31.123456+00:00");
  });

  describe("the pending install request every window follows", () => {
    const installation = { identity: "m4", studioHome: Path.join(ROOT, "m4"), version: "0.1.4" };
    const at = "2026-10-20T04:07:30.000Z";
    const atMs = Date.parse(at);
    const forced = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        installRequestedAt: at,
        installMode: "force",
        installHoldUntil: "2026-10-20T04:22:30.000Z",
        installCancelledAt: null,
        installRequest: { at, version: "0.2.0" },
        ...overrides,
      });
    const state = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({ status: "waiting-for-quiet", ...overrides });
    const pending = (configText: string | null, stateText: string | null, nowMs = atMs + 5_000) =>
      toServiceUpdateState({ installation, stateText, configText, nowMs }).pendingInstall;

    it("reports a forced request with its hold and version", () => {
      expect(pending(forced(), state())).toEqual({
        requestedAt: at,
        mode: "force",
        version: "0.2.0",
        holdUntil: "2026-10-20T04:22:30.000Z",
        handled: false,
      });
      // Before the agent has written any state, too.
      expect(pending(forced(), null)?.mode).toBe("force");
    });

    it("reports a request the agent is installing as handled", () => {
      expect(
        pending(forced(), state({ status: "installing", handledInstallRequestAt: at })),
      ).toMatchObject({ handled: true, mode: "force" });
    });

    it("drops a request the agent finished, cancelled or let lapse", () => {
      expect(pending(forced(), state({ status: "installed", handledInstallRequestAt: at }))).toBe(
        null,
      );
      expect(pending(forced({ installCancelledAt: "2026-10-20T04:08:00.000Z" }), state())).toBe(
        null,
      );
      // A forced request the agent stopped retrying once its hold ended.
      expect(pending(forced(), state(), Date.parse("2026-10-20T04:22:30.001Z"))).toBe(null);
      // A normal one tied to a version that no pass took up in time.
      expect(
        pending(
          forced({ installMode: "normal", installHoldUntil: null }),
          state(),
          atMs + SERVICE_INSTALL_REQUEST_TTL_MS + 1,
        ),
      ).toBe(null);
      expect(pending(forced({ installRequestedAt: null }), state())).toBe(null);
      expect(pending("{", state())).toBe(null);
      expect(pending(null, state())).toBe(null);
    });

    it("keeps a forced request the agent still retries past the lapse, until its hold ends", () => {
      // Minute 11: the pass that took the request up retries until 04:22:30.
      expect(pending(forced(), state(), atMs + 11 * 60_000)).toMatchObject({
        mode: "force",
        handled: false,
        holdUntil: "2026-10-20T04:22:30.000Z",
      });
      expect(pending(forced(), state(), Date.parse("2026-10-20T04:22:30.000Z"))?.mode).toBe(
        "force",
      );
      // A hold shorter than the lapse still leaves the request to the next pass.
      expect(
        pending(
          forced({ installHoldUntil: "2026-10-20T04:10:00.000Z" }),
          state(),
          atMs + 9 * 60_000,
        )?.mode,
      ).toBe("force");
    });

    it("keeps a normal request not tied to a version, which never lapses", () => {
      expect(
        pending(
          forced({ installMode: "normal", installRequest: null }),
          state(),
          atMs + SERVICE_INSTALL_REQUEST_TTL_MS + 1,
        ),
      ).toEqual({
        requestedAt: at,
        mode: "normal",
        version: null,
        holdUntil: null,
        handled: false,
      });
    });
  });

  it("shows a failed agent start until the agent writes something newer", () => {
    const state = toServiceUpdateState({
      installation: { identity: "m4", studioHome: Path.join(ROOT, "m4"), version: "0.1.4" },
      stateText: JSON.stringify({
        status: "waiting-for-quiet",
        message: "Waiting",
        updatedAt: "2026-10-12T20:00:00+00:00",
      }),
    });
    // Every state says whether the failure is the desktop's own, so a renderer
    // tells this desktop from an older one that never says.
    expect(withAgentStartFailure(state, null)).toEqual({ ...state, agentStartFailed: false });
    const failure = { at: "2026-10-12T20:05:00.000Z", message: "The agent did not start." };
    // Flagged as the desktop's own failure: no forced request gets past it.
    expect(withAgentStartFailure(state, failure)).toMatchObject({
      status: "error",
      message: "The agent did not start.",
      updatedAt: failure.at,
      agentStartFailed: true,
    });
    const newer = withAgentStartFailure(
      { ...state, updatedAt: "2026-10-12T20:06:00.000000+00:00" },
      failure,
    );
    expect(newer).toMatchObject({ status: "waiting-for-quiet", agentStartFailed: false });
    // Without a write time the failure stands.
    expect(withAgentStartFailure({ ...state, updatedAt: null }, failure).status).toBe("error");
    expect(withAgentStartFailure({ ...state, status: "not-managed" }, failure)).toMatchObject({
      status: "not-managed",
      agentStartFailed: false,
    });
  });

  it("names the agent's launchd job after the service", () => {
    expect(serviceAgentLabel("m4")).toBe("com.specweave.studio.m4.updater");
  });
  describe("refreshThenRunAgent", () => {
    const recorder = (ensureAgent: () => Promise<void>) => {
      const calls: string[] = [];
      return {
        calls,
        controller: {
          ensureAgent: () => {
            calls.push("ensure");
            return ensureAgent().then(() => {
              calls.push("ensured");
            });
          },
          runAgentNow: async () => {
            calls.push("kick");
          },
        },
      };
    };

    it("installs the bundled agent before kicking the job, which then holds the lock", async () => {
      const { calls, controller } = recorder(async () => {});
      await expect(Effect.runPromise(refreshThenRunAgent(controller))).resolves.toBe("refreshed");
      expect(calls).toEqual(["ensure", "ensured", "kick"]);
    });

    it("still kicks the installed job when the refresh fails", async () => {
      const { calls, controller } = recorder(() => Promise.reject(new Error("python failed")));
      await expect(Effect.runPromise(refreshThenRunAgent(controller))).resolves.toBe("failed");
      expect(calls).toEqual(["ensure", "kick"]);
    });

    it("kicks after a bounded wait without cutting off a slow refresh", async () => {
      let finish: () => void = () => {};
      const { calls, controller } = recorder(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      await expect(Effect.runPromise(refreshThenRunAgent(controller, 5))).resolves.toBe(
        "timed out",
      );
      expect(calls).toEqual(["ensure", "kick"]);
      finish();
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toEqual(["ensure", "kick", "ensured"]);
    });

    it("fails with launchctl's reason when the kick does", async () => {
      const error = await Effect.runPromise(
        Effect.flip(
          refreshThenRunAgent({
            ensureAgent: async () => {},
            runAgentNow: () =>
              Promise.reject(
                new ServiceAgentError({
                  step: "kickstart",
                  message:
                    "launchctl could not start the update agent: Operation not permitted (exit 1)",
                }),
              ),
          }),
        ),
      );
      expect(error.step).toBe("kickstart");
      expect(error.message).toBe(
        "launchctl could not start the update agent: Operation not permitted (exit 1)",
      );
    });

    it("names the failed refresh too when the kick fails after it", async () => {
      const error = await Effect.runPromise(
        Effect.flip(
          refreshThenRunAgent({
            ensureAgent: () => Promise.reject(new Error("python failed")),
            runAgentNow: () => Promise.reject(new Error("launchctl failed")),
          }),
        ),
      );
      expect(error.message).toBe(
        "The update agent did not start: launchctl failed (refreshing it failed too: The update agent did not start: python failed)",
      );
    });

    it("never kicks a job launchd has turned off", async () => {
      const calls: string[] = [];
      const error = await Effect.runPromise(
        Effect.flip(
          refreshThenRunAgent({
            ensureAgent: () =>
              Promise.reject(
                new ServiceAgentError({
                  step: "disabled",
                  message: SERVICE_AGENT_DISABLED_MESSAGE,
                }),
              ),
            runAgentNow: async () => {
              calls.push("kick");
            },
          }),
        ),
      );
      expect(error).toMatchObject({ step: "disabled", message: SERVICE_AGENT_DISABLED_MESSAGE });
      expect(calls).toEqual([]);
    });
  });

  describe("agent failures and Repair", () => {
    it("keeps what launchctl or the helper said", () => {
      expect(
        launchdFailureReason({
          code: 3,
          stdout: '{"result": "disabled", "message": "Update agent is turned off in launchd"}\n',
          stderr: "",
        }),
      ).toBe("Update agent is turned off in launchd");
      expect(
        launchdFailureReason({
          code: 1,
          stdout: "",
          stderr:
            "update-agent m4: error: launchctl could not load the update agent:\n Bootstrap failed: 5\n",
        }),
      ).toBe(
        "update-agent m4: error: launchctl could not load the update agent: Bootstrap failed: 5 (exit 1)",
      );
      expect(launchdFailureReason({ code: 113, stdout: "", stderr: "" })).toBe("exit 113");
      expect(launchdFailureReason({ message: "spawn ENOENT" })).toBe("spawn ENOENT");
    });

    it("reports Repair's outcome as the message Settings shows", async () => {
      await expect(
        Effect.runPromise(repairServiceAgent({ repairAgent: async () => {} })),
      ).resolves.toBe(null);
      await expect(
        Effect.runPromise(
          repairServiceAgent({
            repairAgent: () =>
              Promise.reject(
                new ServiceAgentError({
                  step: "repair",
                  message:
                    "The update agent could not be repaired: Operation not permitted (exit 1)",
                }),
              ),
          }),
        ),
      ).resolves.toBe("The update agent could not be repaired: Operation not permitted (exit 1)");
    });

    it("maps the helper's exits to typed failures and runs Repair only through the agent", async () => {
      const home = NodeFS.mkdtempSync(Path.join(NodeOS.tmpdir(), "service-agent-"));
      try {
        const studioHome = Path.join(home, ".specweave-studio", "m4");
        NodeFS.mkdirSync(studioHome, { recursive: true });
        NodeFS.writeFileSync(
          Path.join(studioHome, "installation.json"),
          installationJson("m4", { studioHome, stateDir: Path.join(studioHome, "userdata") }),
        );
        // A stand-in for update_agent.py: records its arguments, never runs launchctl.
        const script = Path.join(home, "fake_agent.py");
        const record = Path.join(home, "argv.json");
        NodeFS.writeFileSync(
          script,
          [
            "import json, os, sys",
            `open(${JSON.stringify(record)}, 'w').write(json.dumps(sys.argv[1:]))`,
            `mode = open(${JSON.stringify(Path.join(home, "mode"))}).read().strip()`,
            "if mode == 'disabled':",
            "    print(json.dumps({'result': 'disabled', 'label': 'x', 'message': 'Update agent is turned off in launchd'}))",
            "    sys.exit(3)",
            "if mode == 'broken':",
            "    print('update-agent m4: error: launchctl could not load the update agent: Bootstrap failed: 5', file=sys.stderr)",
            "    sys.exit(1)",
            "print(json.dumps({'result': 'repaired'}))",
          ].join("\n"),
        );
        const controller = makeServiceUpdateController({
          homeDirectory: home,
          platform: "darwin",
          agentScriptPath: () => script,
        });
        const mode = (value: string) => NodeFS.writeFileSync(Path.join(home, "mode"), value);
        const argv = () => JSON.parse(NodeFS.readFileSync(record, "utf8")) as string[];

        mode("disabled");
        await expect(controller.ensureAgent()).rejects.toMatchObject({
          step: "disabled",
          message: SERVICE_AGENT_DISABLED_MESSAGE,
        });
        expect(argv()).toEqual(["--identity", "m4", "--install-launch-agent"]);

        mode("broken");
        await expect(controller.ensureAgent()).rejects.toMatchObject({
          step: "refresh",
          message:
            "The update agent could not be installed: update-agent m4: error: launchctl could not load the update agent: Bootstrap failed: 5 (exit 1)",
        });
        await expect(controller.repairAgent()).rejects.toMatchObject({ step: "repair" });

        mode("ok");
        await expect(controller.repairAgent()).resolves.toBeUndefined();
        expect(argv()).toEqual(["--identity", "m4", "--repair-launch-agent"]);
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
