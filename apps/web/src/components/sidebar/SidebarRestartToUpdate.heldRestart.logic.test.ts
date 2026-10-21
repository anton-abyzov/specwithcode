import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceServiceUpdateProgress,
  markServiceRestarted,
  SERVICE_RESTARTED,
  type ServiceUpdateProgress,
  serviceUpdateToast,
  startServiceUpdateProgress,
} from "./SidebarRestartToUpdate.logic";

// What the toast says while the service restarted under a request, and how an
// install the window saw begin gives way to a pass that fetches again.

const requestedAt = 1_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

const serviceWaiting: StudioServiceUpdateState = {
  status: "waiting-for-quiet",
  identity: "m4",
  installedVersion: "0.2.4",
  availableVersion: "0.2.5",
  downloadedVersion: "0.2.5",
  checkedAt: null,
  quietSince: null,
  message: null,
  lastInstall: null,
};

const waiting: ServiceUpdateProgress = {
  ...startServiceUpdateProgress(serviceWaiting),
  phase: "waiting",
  requestedAt,
  startedAt: requestedAt,
  holdUntil: requestedAt + 15 * 60_000,
  blockers: [
    {
      kind: "effect",
      count: 1,
      threadId: null,
      threadTitle: null,
      projectId: null,
      projectTitle: null,
    },
  ],
};

describe("the toast while the service restarted under the request", () => {
  it("says the service restarted, not what ran in it before", () => {
    const restarted = markServiceRestarted(waiting, true);
    const { description } = serviceUpdateToast(restarted, false, { now: requestedAt + 20_000 });
    expect(description).toContain(SERVICE_RESTARTED);
    expect(description).not.toContain("Still running");
  });

  it("says what runs again once the work is held again", () => {
    const held = markServiceRestarted(markServiceRestarted(waiting, true), false);
    const { description } = serviceUpdateToast(held, false, { now: requestedAt + 20_000 });
    expect(description).toContain("Still running: 1 provider step finishing.");
    expect(description).not.toContain(SERVICE_RESTARTED);
  });
});

describe("an install the window saw begin, without knowing when", () => {
  const { installingSince: _since, ...rest } = { ...waiting, phase: "installing" as const };
  const installing: ServiceUpdateProgress = rest;
  const downloading = (
    patch: Partial<StudioServiceUpdateState> = {},
  ): StudioServiceUpdateState => ({
    ...serviceWaiting,
    status: "downloading",
    downloadedVersion: null,
    updatedAt: iso(requestedAt + 60_000),
    ...patch,
  });

  it("gives way to a pass the agent wrote since, which fetches the release again", () => {
    expect(
      advanceServiceUpdateProgress(installing, downloading(), requestedAt + 61_000),
    ).toMatchObject({ phase: "requesting", message: "Downloading SpecWithCode 0.2.5…" });
  });

  it("stays while the agent does not say when it wrote its state", () => {
    const { updatedAt: _written, ...undated } = downloading();
    expect(advanceServiceUpdateProgress(installing, undated, requestedAt + 61_000)).toBe(
      installing,
    );
  });
});
