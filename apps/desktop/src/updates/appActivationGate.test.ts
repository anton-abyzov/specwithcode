import { describe, expect, it } from "@effect/vitest";

import type { StudioServiceUpdateState } from "@specweave-studio/contracts";

import {
  describeAppActivation,
  evaluateAppActivation,
  installOnQuitAllowed,
  LocalServiceProbeError,
  newestServiceVersion,
} from "./appActivationGate.ts";

const service = (
  installedVersion: string | null,
  status: StudioServiceUpdateState["status"] = "error",
  message: string | null = null,
) => ({
  state: { status, installedVersion, message },
  runningVersion: null,
});

describe("evaluateAppActivation", () => {
  it("holds the app swap while the service runs an older release (M4, October 20, 2026)", () => {
    const activation = evaluateAppActivation({
      targetVersion: "1.0.64",
      snapshot: service(
        "1.0.62",
        "error",
        "The SpecWithCode service is using a database log that was deleted from disk. Restart SpecWithCode, then update",
      ),
    });
    expect(activation).toMatchObject({
      gate: "closed",
      reason: "service-behind",
      serviceVersion: "1.0.62",
      serviceStatus: "error",
    });
    expect(describeAppActivation(activation)).toBe(
      "SpecWithCode 1.0.64 installs after the SpecWithCode service on this Mac, which runs 1.0.62 and cannot update yet: The SpecWithCode service is using a database log that was deleted from disk. Restart SpecWithCode, then update.",
    );
    expect(installOnQuitAllowed(true, activation)).toBe(false);
  });

  it("opens once the service runs the release or a newer one", () => {
    for (const installed of ["1.0.64", "1.0.65"]) {
      const activation = evaluateAppActivation({
        targetVersion: "1.0.64",
        snapshot: service(installed, "installed"),
      });
      expect(activation.gate).toBe("open");
      expect(activation.reason).toBe("service-current");
      expect(installOnQuitAllowed(true, activation)).toBe(true);
      expect(installOnQuitAllowed(false, activation)).toBe(false);
    }
  });

  it("takes the newer of the attached service's version and the agent's", () => {
    // The agent records the install only after it verified the new service; the
    // attached descriptor can be older until the app reattaches.
    const activation = evaluateAppActivation({
      targetVersion: "1.0.64",
      snapshot: {
        state: { status: "installed", installedVersion: "1.0.64", message: null },
        runningVersion: "1.0.62",
      },
    });
    expect(activation.gate).toBe("open");
    expect(newestServiceVersion("1.0.62", "1.0.64", null, "dev")).toBe("1.0.64");
  });

  it("has nothing to wait for without a managed service", () => {
    expect(evaluateAppActivation({ targetVersion: "1.0.64", snapshot: null })).toMatchObject({
      gate: "open",
      reason: "no-local-service",
    });
    expect(
      evaluateAppActivation({
        targetVersion: "1.0.64",
        snapshot: {
          state: { status: "not-managed", installedVersion: null, message: null },
          runningVersion: null,
        },
      }).gate,
    ).toBe("open");
  });

  it("never holds dev or nightly builds", () => {
    expect(
      evaluateAppActivation({ targetVersion: "1.0.65-nightly.3", snapshot: service("1.0.62") }),
    ).toMatchObject({ gate: "open", reason: "not-a-release" });
  });

  it("holds the swap when a managed service's version cannot be read", () => {
    const unreadable = evaluateAppActivation({
      targetVersion: "1.0.64",
      snapshot: new LocalServiceProbeError({ detail: "reading it timed out" }),
    });
    expect(unreadable).toMatchObject({ gate: "closed", reason: "service-unknown" });
    expect(describeAppActivation(unreadable)).toContain("could not be read (reading it timed out)");
    expect(
      evaluateAppActivation({ targetVersion: "1.0.64", snapshot: service(null, "starting") }),
    ).toMatchObject({ gate: "closed", reason: "service-unknown" });
  });

  it("says the service is behind without blaming an error it does not have", () => {
    const activation = evaluateAppActivation({
      targetVersion: "1.0.64",
      snapshot: service("1.0.62", "waiting-for-quiet"),
    });
    expect(describeAppActivation(activation)).toBe(
      "SpecWithCode 1.0.64 installs after the SpecWithCode service on this Mac, which runs 1.0.62.",
    );
  });

  it("stops waiting for a service that needs a manual step, which will not catch up alone", () => {
    const activation = evaluateAppActivation({
      targetVersion: "1.0.70",
      snapshot: service("1.0.69", "manual-required", "Update the service from Terminal"),
    });
    expect(activation).toMatchObject({
      gate: "open",
      reason: "service-manual",
      serviceVersion: "1.0.69",
      serviceStatus: "manual-required",
      serviceMessage: "Update the service from Terminal",
    });
    expect(describeAppActivation(activation)).toBeNull();
    expect(installOnQuitAllowed(true, activation)).toBe(true);
  });
  it("lets a press go ahead of a service whose agent lacks the release", () => {
    const lacking = evaluateAppActivation({
      targetVersion: "1.0.69",
      snapshot: service("1.0.68", "up-to-date"),
      serviceLacksRelease: true,
    });
    expect(lacking).toMatchObject({
      gate: "open",
      reason: "service-lacks-release",
      serviceVersion: "1.0.68",
    });
    // Without the press's word, or once the agent has the release, it waits.
    expect(
      evaluateAppActivation({ targetVersion: "1.0.69", snapshot: service("1.0.68", "up-to-date") }),
    ).toMatchObject({ gate: "closed", reason: "service-behind" });
    for (const state of [
      { status: "available" as const, availableVersion: "1.0.69" },
      { status: "up-to-date" as const, availableVersion: "1.0.70" },
      { status: "error" as const, downloadedVersion: "1.0.69" },
      {
        status: "up-to-date" as const,
        pendingInstall: {
          requestedAt: "2026-10-21T00:00:00.000Z",
          mode: "force" as const,
          holdUntil: null,
          version: "1.0.69",
          handled: false,
        },
      },
    ]) {
      expect(
        evaluateAppActivation({
          targetVersion: "1.0.69",
          snapshot: {
            state: { installedVersion: "1.0.68", message: null, ...state },
            runningVersion: null,
          },
          serviceLacksRelease: true,
        }),
      ).toMatchObject({ gate: "closed", reason: "service-behind" });
    }
    // An agent offering only an older release still lacks this one.
    expect(
      evaluateAppActivation({
        targetVersion: "1.0.69",
        snapshot: {
          state: {
            status: "error",
            installedVersion: "1.0.67",
            availableVersion: "1.0.68",
            message: "x",
          },
          runningVersion: null,
        },
        serviceLacksRelease: true,
      }),
    ).toMatchObject({ gate: "open", reason: "service-lacks-release" });
  });
});
