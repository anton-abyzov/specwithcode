import type {
  DesktopUpdateState,
  StatusService,
  StatusSnapshot,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  desktopUpdaterComponent,
  groupStatusServices,
  statusHeadline,
  withLocalComponents,
} from "./statusModel";

const service = (overrides: Partial<StatusService>): StatusService => ({
  id: "local-service",
  group: "app",
  name: "Local service",
  level: "operational",
  detail: "SpecWithCode 1.0.35",
  checkedAt: null,
  source: "This Mac",
  sourceUrl: null,
  dependents: [],
  components: [],
  days: [],
  uptimePercent: null,
  ...overrides,
});

describe("status model", () => {
  it("keeps the banner green when only a dependency has trouble, and names it", () => {
    const headline = statusHeadline([
      service({}),
      service({ id: "provider:claude", group: "dependencies", name: "Claude", level: "degraded" }),
    ]);
    expect(headline).toMatchObject({
      level: "degraded",
      title: "SpecWithCode is operational",
      description: "Claude reports issues.",
    });
  });

  it("counts the app's own trouble with each service's level", () => {
    const headline = statusHeadline([
      service({}),
      service({ id: "machine:m3", group: "machines", name: "M3", level: "major_outage" }),
    ]);
    expect(headline).toMatchObject({
      level: "major_outage",
      title: "1 service needs attention",
      description: "M3: Major outage",
    });
    expect(statusHeadline([service({ level: "unknown" }), service({ id: "b" })]).description).toBe(
      "1 service checked · 1 unknown",
    );
  });

  it("groups in a fixed order and skips empty groups", () => {
    const groups = groupStatusServices([
      service({ id: "github", group: "dependencies", name: "GitHub", level: "unknown" }),
      service({}),
    ]);
    expect(groups.map((group) => [group.id, group.level, group.unknown])).toEqual([
      ["app", "operational", 0],
      ["dependencies", "unknown", 1],
    ]);
  });

  it("folds the desktop updater into Updates", () => {
    const snapshot: StatusSnapshot = {
      generatedAt: "2026-10-16T18:30:00.000Z",
      level: "operational",
      checkedAt: "2026-10-16T18:28:00.000Z",
      checking: false,
      services: [service({ id: "updates", name: "Updates" })],
      incidents: [],
    };
    const failing = desktopUpdaterComponent({
      enabled: true,
      status: "error",
      message: "Could not download the update.",
      errorContext: "download",
      currentVersion: "1.0.35",
    } as DesktopUpdateState);
    const merged = withLocalComponents(snapshot, failing);
    expect(merged.services[0]).toMatchObject({
      level: "degraded",
      detail: "Desktop updater: Could not download the update.",
    });
    expect(merged.level).toBe("degraded");
    expect(withLocalComponents(snapshot, null)).toBe(snapshot);
  });
});
