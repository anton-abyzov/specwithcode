import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceServiceUpdateProgress,
  INSTALL_TIMEOUT_MS,
  serviceUpdateButtonLabel,
  serviceUpdateToast,
  startServiceUpdateProgress,
  type ServiceUpdateProgress,
} from "./SidebarRestartToUpdate.logic";

// The agent leaves an install for another pass that fetches or checks again,
// then installs later: each install is timed on its own.

const MINUTE = 60_000;
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

const agent = (
  status: StudioServiceUpdateState["status"],
  writtenAt: number,
  message: string | null = null,
): StudioServiceUpdateState => ({ ...serviceWaiting, status, message, updatedAt: iso(writtenAt) });

const requested: ServiceUpdateProgress = {
  ...startServiceUpdateProgress(serviceWaiting),
  phase: "requesting",
  requestedAt,
  startedAt: requestedAt,
  holdUntil: requestedAt + 15 * MINUTE,
};

/** The progress once the agent reported installing at `at`. */
function installingAt(at: number): ServiceUpdateProgress {
  const progress = advanceServiceUpdateProgress(requested, agent("installing", at), at);
  expect(progress).toMatchObject({ phase: "installing", installingSince: at });
  return progress;
}

describe("an install the agent leaves for another pass", () => {
  it("is no longer shown as installing while the agent has the release downloaded", () => {
    const installing = installingAt(requestedAt + MINUTE);
    const at = requestedAt + 2 * MINUTE;
    const back = advanceServiceUpdateProgress(installing, agent("downloaded", at), at);
    expect(back.phase).toBe("requesting");
    expect(back.installingSince).toBeUndefined();
    expect(back.message).toBeNull();
    expect(serviceUpdateButtonLabel(back, at)).not.toBe("Installing…");
    expect(serviceUpdateToast(back, false, { now: at }).title).not.toMatch(/^Installing/);
  });

  it("says what the agent fetches while it downloads again", () => {
    const installing = installingAt(requestedAt + MINUTE);
    const at = requestedAt + 2 * MINUTE;
    const back = advanceServiceUpdateProgress(
      installing,
      agent("downloading", at, "Downloading SpecWithCode 0.2.6"),
      at,
    );
    expect(back).toMatchObject({ phase: "requesting", message: "Downloading SpecWithCode 0.2.6" });
    expect(back.installingSince).toBeUndefined();
    expect(advanceServiceUpdateProgress(installing, agent("downloading", at), at).message).toBe(
      "Downloading SpecWithCode 0.2.5…",
    );
  });

  it("does not fail 45 minutes after the first install when the next began later", () => {
    const first = requestedAt + MINUTE;
    let progress = installingAt(first);
    progress = advanceServiceUpdateProgress(
      progress,
      agent("downloaded", first + MINUTE),
      first + MINUTE,
    );
    expect(progress.phase).toBe("requesting");
    // Installing again 20 minutes after the first install began.
    const second = first + 20 * MINUTE;
    progress = advanceServiceUpdateProgress(progress, agent("installing", second), second);
    expect(progress).toMatchObject({ phase: "installing", installingSince: second });
    const pastFirstDeadline = first + INSTALL_TIMEOUT_MS + MINUTE;
    progress = advanceServiceUpdateProgress(
      progress,
      agent("installing", second),
      pastFirstDeadline,
    );
    expect(progress.phase).toBe("installing");
    expect(serviceUpdateButtonLabel(progress, pastFirstDeadline)).toBe("Installing…");
    // The second install has its own 45 minutes.
    const stuck = advanceServiceUpdateProgress(
      progress,
      agent("installing", second),
      second + INSTALL_TIMEOUT_MS,
    );
    expect(stuck).toMatchObject({
      phase: "failed",
      message:
        "The install has not finished after 45 minutes. See Settings > About for the receipt.",
    });
  });

  it("still fails 45 minutes on when the restart never comes back", () => {
    const first = requestedAt + MINUTE;
    const installing = installingAt(first);
    // The service restarts into the new version and never answers again: the
    // agent's state still says installing, and reads may get nothing at all.
    const still = agent("installing", first);
    expect(advanceServiceUpdateProgress(installing, null, first + 10 * MINUTE)).toBe(installing);
    expect(
      advanceServiceUpdateProgress(installing, { ...still, status: "starting" }, first + MINUTE)
        .phase,
    ).toBe("installing");
    const almost = advanceServiceUpdateProgress(installing, still, first + INSTALL_TIMEOUT_MS - 1);
    expect(almost).toMatchObject({ phase: "installing", installingSince: first });
    expect(advanceServiceUpdateProgress(almost, still, first + INSTALL_TIMEOUT_MS).phase).toBe(
      "failed",
    );
  });

  it("times an install from when the agent wrote it, not when a late read came back", () => {
    const wrote = requestedAt + MINUTE;
    // The read answers 800 ms after the agent wrote "installing"...
    const installing = advanceServiceUpdateProgress(
      requested,
      agent("installing", wrote),
      wrote + 800,
    );
    expect(installing).toMatchObject({ phase: "installing", installingSince: wrote });
    // ...which the agent had already left for another pass, 200 ms after writing it.
    const back = advanceServiceUpdateProgress(
      installing,
      agent("downloaded", wrote + 200),
      wrote + 1_000,
    );
    expect(back.phase).toBe("requesting");
    expect(back.installingSince).toBeUndefined();
    expect(serviceUpdateButtonLabel(back, wrote + 1_000)).not.toBe("Installing…");
    // A state stamped ahead of this window's clock is timed from now.
    expect(
      advanceServiceUpdateProgress(requested, agent("installing", wrote + 5_000), wrote),
    ).toMatchObject({
      phase: "installing",
      installingSince: wrote,
    });
  });

  it("keeps the install's clock for a state older than the install", () => {
    const first = requestedAt + 2 * MINUTE;
    const installing = installingAt(first);
    // A reply read before the install began, written after the request.
    expect(
      advanceServiceUpdateProgress(installing, agent("downloaded", first - MINUTE), first),
    ).toBe(installing);
    // One written before the request answers an earlier request.
    expect(
      advanceServiceUpdateProgress(installing, agent("downloaded", requestedAt - MINUTE), first),
    ).toBe(installing);
    // One without the agent's write time says nothing new.
    const { updatedAt: _unknown, ...unstamped } = agent("downloaded", first + MINUTE);
    expect(advanceServiceUpdateProgress(installing, unstamped, first + MINUTE)).toBe(installing);
  });
});
