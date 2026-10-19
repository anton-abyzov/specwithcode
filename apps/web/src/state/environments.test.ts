import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type EnvironmentConnectionPhase,
} from "@specweave-studio/client-runtime/connection";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { desktopLocalConnectionId } from "../connection/desktopLocal";
import { isEnvironmentUnreachable, unreachableEnvironmentIds } from "./environments";

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

function environment(
  environmentId: EnvironmentId,
  entry: typeof primaryEntry | typeof remoteEntry,
  phase: EnvironmentConnectionPhase,
) {
  return { environmentId, entry, connection: { phase, error: null, traceId: null } } as never;
}

describe("isEnvironmentUnreachable", () => {
  it("keeps today's rule for other machines", () => {
    expect(isEnvironmentUnreachable("connected")).toBe(false);
    expect(isEnvironmentUnreachable("connecting")).toBe(false);
    expect(isEnvironmentUnreachable("reconnecting")).toBe(true);
    expect(isEnvironmentUnreachable("offline")).toBe(true);
    expect(isEnvironmentUnreachable("error")).toBe(true);
  });

  it("never calls this machine unreachable while it is only busy", () => {
    for (const phase of [
      "connected",
      "connecting",
      "reconnecting",
      "offline",
      "available",
    ] as const)
      expect(isEnvironmentUnreachable(phase, true)).toBe(false);
    expect(isEnvironmentUnreachable("error", true)).toBe(true);
    expect(isEnvironmentUnreachable("unsupported", true)).toBe(true);
  });
});

describe("unreachableEnvironmentIds", () => {
  it("leaves out this machine while its server catches up, and keeps remote hosts", () => {
    expect(
      unreachableEnvironmentIds([
        environment(PRIMARY_ID, primaryEntry, "reconnecting"),
        environment(WSL_ID, wslEntry, "offline"),
        environment(REMOTE_ID, remoteEntry, "reconnecting"),
      ]),
    ).toEqual([REMOTE_ID]);
  });

  it("includes this machine once its connection has stopped for good", () => {
    expect(
      unreachableEnvironmentIds([
        environment(PRIMARY_ID, primaryEntry, "error"),
        environment(REMOTE_ID, remoteEntry, "connected"),
      ]),
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
      unreachableEnvironmentIds([environment(PRIMARY_ID, networkPrimary, "reconnecting")]),
    ).toEqual([PRIMARY_ID]);
  });
});
