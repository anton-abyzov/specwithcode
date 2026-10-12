import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  buildServiceAgentConfig,
  findManagedServiceInstallations,
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
      repository: "acme/studio",
    });
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

  it("names the agent's launchd job after the service", () => {
    expect(serviceAgentLabel("m4")).toBe("com.specweave.studio.m4.updater");
  });
});
