// @effect-diagnostics nodeBuiltinImport:off -- Synthetic local installation fixtures only.
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import type { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import type { AttachedLocalService } from "../../backend/DesktopLocalService.ts";
import { makeServiceUpdateController } from "../../updates/studioServiceUpdates.ts";

vi.mock("electron", () => ({}));
import { isStaleService, controllerForAttachedService } from "./serviceUpdates.ts";

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
