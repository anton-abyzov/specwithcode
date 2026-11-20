import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@specweave-studio/client-runtime/connection";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  SESSION_END_BANNER_MS,
  SESSION_END_MENU_MS,
  dependsOnConnectSignIn,
  sessionEndRecheckMs,
  sessionEndStage,
  sessionTimeLeft,
} from "./connectSessionEnd";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 18, 14, 0);
const environmentId = EnvironmentId.make("env-office-mac");

describe("when the window warns that its Connect sign-in ends (1417, AC-11)", () => {
  it("says nothing more than a day before", () => {
    expect(sessionEndStage(NOW + SESSION_END_MENU_MS + 1, NOW)).toBe("none");
    expect(sessionEndStage(null, NOW)).toBe("none");
  });

  it("puts it on the account button from 24 hours before", () => {
    expect(sessionEndStage(NOW + SESSION_END_MENU_MS, NOW)).toBe("menu");
    expect(sessionEndStage(NOW + 3 * HOUR, NOW)).toBe("menu");
  });

  it("adds the banner from 2 hours before", () => {
    expect(sessionEndStage(NOW + SESSION_END_BANNER_MS, NOW)).toBe("banner");
    expect(sessionEndStage(NOW + 60_000, NOW)).toBe("banner");
  });

  it("stops once the sign-in ended, where the signed-out banner takes over", () => {
    expect(sessionEndStage(NOW, NOW)).toBe("none");
    expect(sessionEndRecheckMs(NOW - 1, NOW)).toBeNull();
  });

  it("wakes at the next stage, then every minute while a time shows", () => {
    expect(sessionEndRecheckMs(NOW + 5 * 24 * HOUR, NOW)).toBe(4 * 24 * HOUR);
    expect(sessionEndRecheckMs(NOW + 5 * HOUR, NOW)).toBe(60_000);
    expect(sessionEndRecheckMs(NOW + 30_000, NOW)).toBe(30_000);
  });

  it("writes the time left the way the button shows it", () => {
    expect(sessionTimeLeft(HOUR + 40 * 60_000 + 59_000)).toBe("1h 40m");
    expect(sessionTimeLeft(23 * HOUR)).toBe("23h");
    expect(sessionTimeLeft(12 * 60_000)).toBe("12m");
    expect(sessionTimeLeft(5_000)).toBe("1m");
  });
});

describe("which saved machines depend on the sign-in", () => {
  const relay = new RelayConnectionTarget({ environmentId, label: "Office Mac" });
  const bearerTarget = new BearerConnectionTarget({
    environmentId,
    label: "Office Mac",
    connectionId: "lan",
  });
  const bearer = (authorization?: "studio-connect") =>
    new BearerConnectionProfile({
      connectionId: "lan",
      environmentId,
      label: "Office Mac",
      httpBaseUrl: "https://office-mac.example.test/",
      wsBaseUrl: "wss://office-mac.example.test/",
      ...(authorization ? { authorization } : {}),
    });

  it("a machine reached only through the relay does", () => {
    expect(dependsOnConnectSignIn({ target: relay, profile: Option.none() })).toBe(true);
  });

  it("a direct route that borrows the Connect credential does too", () => {
    expect(
      dependsOnConnectSignIn({
        target: relay,
        profile: Option.none(),
        alternateRoutes: [{ target: bearerTarget, profile: Option.some(bearer("studio-connect")) }],
      }),
    ).toBe(true);
  });

  it("a paired direct route or SSH keeps the machine reachable", () => {
    expect(
      dependsOnConnectSignIn({
        target: relay,
        profile: Option.none(),
        alternateRoutes: [{ target: bearerTarget, profile: Option.some(bearer()) }],
      }),
    ).toBe(false);
    const ssh = new SshConnectionTarget({ environmentId, label: "Build box", connectionId: "ssh" });
    expect(dependsOnConnectSignIn({ target: ssh, profile: Option.none() })).toBe(false);
  });
});
