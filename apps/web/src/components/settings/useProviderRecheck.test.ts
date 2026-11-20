import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerInstancesToRecheck, shouldRecheckProviders } from "./useProviderRecheck";

const agent = (id: string, patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(id),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-16T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...patch,
});

describe("the agents read again when the Providers page opens or comes back", () => {
  it("picks each agent that is on and not installed, signed out or needing attention", () => {
    expect(
      providerInstancesToRecheck([
        agent("ready"),
        agent("missing", { installed: false, status: "error", auth: { status: "unknown" } }),
        agent("signedOut", { status: "error", auth: { status: "unauthenticated" } }),
        agent("attention", { status: "warning" }),
      ]),
    ).toEqual(["missing", "signedOut", "attention"]);
  });

  it("reads nothing when every agent is ready, off, still being checked or has no driver", () => {
    expect(
      providerInstancesToRecheck([
        agent("ready"),
        agent("off", { enabled: false, installed: false, status: "disabled" }),
        agent("checking", { installed: false, status: "warning", auth: { status: "unknown" } }),
        agent("gone", {
          availability: "unavailable",
          installed: false,
          status: "error",
          auth: { status: "unknown" },
        }),
      ]),
    ).toEqual([]);
    expect(providerInstancesToRecheck([])).toEqual([]);
  });

  it("reads a machine at most once every 10 seconds", () => {
    expect(shouldRecheckProviders(1_000, undefined)).toBe(true);
    expect(shouldRecheckProviders(10_999, 1_000)).toBe(false);
    expect(shouldRecheckProviders(11_000, 1_000)).toBe(true);
  });
});
