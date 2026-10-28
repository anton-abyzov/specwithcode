import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceServiceUpdateProgress,
  isStaleServiceAnswer,
  startServiceUpdateProgress,
} from "./SidebarRestartToUpdate.logic";

// What the agent wrote in the very millisecond a request was written is no
// answer to it: the agent could not have read the request yet. The desktop's
// own failure for the request carries the request's time, and does answer it.

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

const requested = { ...startServiceUpdateProgress(serviceWaiting), phase: "requesting" as const };

describe("service update progress", () => {
  it("takes no state the agent wrote in the request's own millisecond as its answer", () => {
    const requestedAt = Date.parse("2026-10-12T20:08:31.000Z");
    const retry = { ...requested, requestedAt };
    // The agent's refusal (the desktop flags it as not its own), written as the
    // request was: the agent could not have read the request yet.
    const refusal: StudioServiceUpdateState = {
      ...serviceWaiting,
      status: "error",
      message: "Did not install",
      updatedAt: "2026-10-12T20:08:31.000412+00:00",
      agentStartFailed: false,
    };
    expect(isStaleServiceAnswer(retry, refusal, requestedAt)).toBe(true);
    expect(advanceServiceUpdateProgress(retry, refusal, requestedAt + 1_000)).toBe(retry);
    // The desktop's own failure carries the request's time: it answers it.
    const desktopFailure = {
      ...refusal,
      updatedAt: "2026-10-12T20:08:31.000Z",
      agentStartFailed: true,
    };
    expect(isStaleServiceAnswer(retry, desktopFailure, requestedAt)).toBe(false);
    // So does one from an older desktop, which flags no state.
    const { agentStartFailed: _flag, ...unflagged } = desktopFailure;
    expect(isStaleServiceAnswer(retry, unflagged, requestedAt)).toBe(false);
  });
});
