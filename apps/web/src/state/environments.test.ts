import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
} from "@specweave-studio/client-runtime/connection";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { desktopLocalConnectionId } from "../connection/desktopLocal";
import {
  environmentReachState,
  isEnvironmentUnreachable,
  unreachableEnvironmentIds,
} from "./environments";

const PRIMARY_ID = EnvironmentId.make("environment-primary");
const WSL_ID = EnvironmentId.make("environment-wsl");
const REMOTE_ID = EnvironmentId.make("environment-m1");

const primaryEntry = {
  target: new PrimaryConnectionTarget({
    environmentId: PRIMARY_ID,
    label: "Anton's MacBook M4MAX",
    httpBaseUrl: "http://127.0.0.1:8319",
    wsBaseUrl: "ws://127.0.0.1:8319",
  }),
  profile: Option.none(),
};

function bearerEntry(environmentId: EnvironmentId, connectionId: string, httpBaseUrl: string) {
  return {
    target: new BearerConnectionTarget({ environmentId, label: connectionId, connectionId }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId,
        label: connectionId,
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
  };
}

const wslEntry = bearerEntry(
  WSL_ID,
  desktopLocalConnectionId("wsl:Ubuntu"),
  "http://127.0.0.1:4000",
);
const remoteEntry = bearerEntry(REMOTE_ID, "saved-m1", "https://m1.tailnet.example.test");

const NOW = 1_000_000;
/** A drop this long ago; the reconnect grace is 60 s. */
const lost = (secondsAgo: number) => ({
  lostAt: NOW - secondsAgo * 1_000,
  lastConnectedAt: NOW - secondsAgo * 1_000,
});

function environment(
  environmentId: EnvironmentId,
  entry: typeof primaryEntry | typeof remoteEntry,
  phase: EnvironmentConnectionPhase,
  facts: Partial<
    Pick<EnvironmentConnectionPresentation, "lostAt" | "lastConnectedAt" | "cause">
  > = {},
) {
  return {
    environmentId,
    entry,
    connection: { phase, error: null, traceId: null, ...facts },
  } as never;
}

describe("environmentReachState", () => {
  const remote = (
    phase: EnvironmentConnectionPhase,
    facts?: Parameters<typeof environment>[3],
    listSyncing = false,
  ) => environmentReachState(environment(REMOTE_ID, remoteEntry, phase, facts), NOW, listSyncing);

  it("reads a drop as reconnecting for its first minute, then by its cause", () => {
    expect(remote("reconnecting", lost(16))).toBe("reconnecting");
    expect(remote("connecting", lost(59))).toBe("reconnecting");
    expect(remote("reconnecting", { ...lost(61), cause: "not-answering" })).toBe("not-answering");
    expect(remote("reconnecting", { ...lost(61), cause: "no-service" })).toBe("offline");
    expect(remote("reconnecting", { ...lost(61), cause: "relay-unreachable" })).toBe("cant-reach");
    expect(remote("offline", lost(61))).toBe("no-network");
    expect(remote("error", lost(5))).toBe("stopped");
    expect(remote("available")).toBe("not-connected");
  });

  it("reads a connected machine whose list is still resyncing as catching up", () => {
    expect(remote("connected")).toBe("connected");
    expect(remote("connected", {}, true)).toBe("catching-up");
  });

  it("never calls this machine down while it is only busy", () => {
    for (const phase of ["connecting", "reconnecting", "offline", "available"] as const)
      expect(
        environmentReachState(environment(PRIMARY_ID, primaryEntry, phase, lost(600)), NOW),
      ).toBe("catching-up");
    expect(environmentReachState(environment(PRIMARY_ID, primaryEntry, "connected"), NOW)).toBe(
      "connected",
    );
    for (const phase of ["error", "unsupported"] as const)
      expect(environmentReachState(environment(PRIMARY_ID, primaryEntry, phase), NOW)).toBe(
        "stopped",
      );
  });
});

describe("isEnvironmentUnreachable", () => {
  it("counts only a machine that is down, never one still inside its grace", () => {
    for (const state of ["connected", "catching-up", "connecting", "reconnecting"] as const)
      expect(isEnvironmentUnreachable(state)).toBe(false);
    for (const state of [
      "not-answering",
      "offline",
      "cant-reach",
      "no-network",
      "stopped",
      "not-connected",
    ] as const)
      expect(isEnvironmentUnreachable(state)).toBe(true);
  });
});

describe("unreachableEnvironmentIds", () => {
  it("leaves out this machine while its server catches up, and keeps remote hosts", () => {
    expect(
      unreachableEnvironmentIds(
        [
          environment(PRIMARY_ID, primaryEntry, "reconnecting", lost(90)),
          environment(WSL_ID, wslEntry, "offline", lost(90)),
          environment(REMOTE_ID, remoteEntry, "reconnecting", lost(90)),
        ],
        NOW,
      ),
    ).toEqual([REMOTE_ID]);
  });

  it("leaves out a remote host that dropped less than a minute ago", () => {
    expect(
      unreachableEnvironmentIds(
        [environment(REMOTE_ID, remoteEntry, "reconnecting", lost(16))],
        NOW,
      ),
    ).toEqual([]);
  });

  it("includes this machine once its connection has stopped for good", () => {
    expect(
      unreachableEnvironmentIds(
        [
          environment(PRIMARY_ID, primaryEntry, "error"),
          environment(REMOTE_ID, remoteEntry, "connected"),
        ],
        NOW,
      ),
    ).toEqual([PRIMARY_ID]);
  });

  it("keeps a primary opened over the network unreachable, as any remote host", () => {
    // A phone or another computer that loaded this Mac's page over Tailscale or
    // the relay: for that viewer the Mac is remote and can be offline.
    const networkPrimary = {
      target: new PrimaryConnectionTarget({
        environmentId: PRIMARY_ID,
        label: "Example Mac",
        httpBaseUrl: "https://mac.tailnet.example.test",
        wsBaseUrl: "wss://mac.tailnet.example.test",
      }),
      profile: Option.none(),
    };
    expect(
      unreachableEnvironmentIds(
        [environment(PRIMARY_ID, networkPrimary, "reconnecting", lost(90))],
        NOW,
      ),
    ).toEqual([PRIMARY_ID]);
  });
});
