import { ProviderInstanceId, type ServerProvider } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accountIdentityOf,
  foldAccountSwitches,
  foldMachineAccountSwitches,
  identitiesDiffer,
  type MachineAccountSwitches,
  planLabel,
  type SeenAccount,
} from "./accountSwitches";
import { modelAvailability } from "./modelAvailability";

const now = Date.parse("2026-10-21T15:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MINUTE = 60_000;
const id = ProviderInstanceId.make("claudeAgent");
const KEY_A = `claude:sha256:${"a".repeat(64)}`;
const KEY_B = `claude:sha256:${"b".repeat(64)}`;

const snapshot = (input: {
  readonly status?: "authenticated" | "unknown" | "unauthenticated";
  readonly email?: string;
  readonly key?: string;
  readonly label?: string;
  readonly readAt: number;
  readonly usedPercent?: number;
}): ServerProvider =>
  ({
    instanceId: id,
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    checkedAt: iso(input.readAt),
    auth: {
      status: input.status ?? "authenticated",
      ...(input.email ? { email: input.email } : {}),
      ...(input.label ? { label: input.label } : {}),
    },
    models: [],
    usageLimits: {
      checkedAt: iso(input.readAt),
      ...(input.key ? { subscriptionKey: input.key } : {}),
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: input.usedPercent ?? 40,
          resetsAt: iso(now + 120 * MINUTE),
        },
      ],
    },
  }) as unknown as ServerProvider;

/** Feeds snapshots one batch at a time, as the hook does, and returns the switch map after each. */
function replay(snapshots: ReadonlyArray<ServerProvider>) {
  const seen = new Map<ProviderInstanceId, SeenAccount>();
  let switched: ReadonlyMap<ProviderInstanceId, number> = new Map();
  return snapshots.map((snap) => {
    switched =
      foldAccountSwitches(seen, switched, [{ instanceId: id, snapshot: snap }]) ?? switched;
    return switched.get(id) ?? null;
  });
}

const availabilityAfter = (snaps: ReadonlyArray<ServerProvider>) => {
  const switchedAt = replay(snaps).at(-1) ?? null;
  return modelAvailability({
    provider: snaps.at(-1),
    model: "claude-sonnet-4-6",
    nowMs: now,
    connected: true,
    machineLabel: "M4",
    previousAccountReadAt: switchedAt,
  });
};

describe("account switches", () => {
  it("never calls a failed probe (email gone, key kept) a switch, nor its recovery", () => {
    const sequence = [
      snapshot({ email: "a@example.com", key: KEY_A, readAt: now - 10 * MINUTE }),
      // Probe failed: status unknown, no email, the published limits keep their key.
      snapshot({ status: "unknown", key: KEY_A, readAt: now - 10 * MINUTE }),
      snapshot({ email: "a@example.com", key: KEY_A, readAt: now - 2 * MINUTE }),
    ];
    expect(replay(sequence)).toEqual([null, null, null]);
  });

  it("never calls an authenticated key-only read between email reads a switch", () => {
    const sequence = [
      snapshot({ email: "a@example.com", readAt: now - 10 * MINUTE }),
      snapshot({ key: KEY_A, readAt: now - 5 * MINUTE }),
      snapshot({ email: "a@example.com", readAt: now - 2 * MINUTE }),
    ];
    expect(replay(sequence)).toEqual([null, null, null]);
  });

  it("keeps an exhausted account blocking through a failed probe", () => {
    const state = availabilityAfter([
      snapshot({ email: "a@example.com", key: KEY_A, readAt: now - 10 * MINUTE, usedPercent: 100 }),
      snapshot({ status: "unknown", key: KEY_A, readAt: now - 10 * MINUTE, usedPercent: 100 }),
    ]);
    expect(state.kind).toBe("exhausted");
  });

  it("reports a real switch from one email to another", () => {
    const first = now - 10 * MINUTE;
    const sequence = [
      snapshot({ email: "a@example.com", readAt: first }),
      snapshot({ email: "b@example.com", readAt: now - MINUTE }),
    ];
    expect(replay(sequence)).toEqual([null, first]);
  });

  it("reports a real switch from one key to another, even with the same email", () => {
    const first = now - 10 * MINUTE;
    const sequence = [
      snapshot({ email: "a@example.com", key: KEY_A, readAt: first }),
      snapshot({ email: "a@example.com", key: KEY_B, readAt: now - MINUTE }),
    ];
    expect(replay(sequence)).toEqual([null, first]);
  });

  it("reports a switch once a key-only read is followed by another email", () => {
    const first = now - 10 * MINUTE;
    const sequence = [
      snapshot({ email: "a@example.com", readAt: first }),
      snapshot({ status: "unknown", key: KEY_A, readAt: first }),
      snapshot({ email: "b@example.com", readAt: now - MINUTE }),
    ];
    expect(replay(sequence)).toEqual([null, null, first]);
  });

  it("hides the previous account's read after a switch until the new account reads", () => {
    const state = availabilityAfter([
      snapshot({ email: "a@example.com", readAt: now - 10 * MINUTE }),
      snapshot({ email: "b@example.com", readAt: now - 10 * MINUTE }),
    ]);
    expect(state.kind).toBe("switching");
  });

  it("keeps each machine's history apart, so another machine's account is no switch", () => {
    const seen = new Map<string, Map<ProviderInstanceId, SeenAccount>>();
    let switched: MachineAccountSwitches = new Map();
    const fold = (machine: string, snap: ServerProvider) => {
      switched =
        foldMachineAccountSwitches(seen, switched, machine, [{ instanceId: id, snapshot: snap }]) ??
        switched;
      return switched.get(machine)?.get(id) ?? null;
    };
    // M4 signed in as a@ and M1 as b@, M1's read older than M4's: back and forth.
    expect(fold("env-m4", snapshot({ email: "a@example.com", readAt: now - MINUTE }))).toBeNull();
    const m1 = snapshot({ email: "b@example.com", readAt: now - 2 * MINUTE, usedPercent: 100 });
    expect(fold("env-m1", m1)).toBeNull();
    expect(fold("env-m4", snapshot({ email: "a@example.com", readAt: now - MINUTE }))).toBeNull();
    expect(fold("env-m1", m1)).toBeNull();
    // M1's exhausted account still reads as exhausted, not as a switch.
    const state = modelAvailability({
      provider: m1,
      model: "claude-sonnet-4-6",
      nowMs: now,
      connected: true,
      machineLabel: "M1",
      previousAccountReadAt: switched.get("env-m1")?.get(id) ?? null,
    });
    expect(state.kind).toBe("exhausted");
    // A real switch on one machine is still recorded for that machine only.
    const before = now - MINUTE;
    expect(fold("env-m4", snapshot({ email: "c@example.com", readAt: now }))).toBe(before);
    expect(switched.get("env-m1")?.get(id)).toBeUndefined();
  });

  it("compares keys with keys and emails with emails only", () => {
    expect(identitiesDiffer({ email: "a" }, { key: KEY_A })).toBe(false);
    expect(identitiesDiffer({ key: KEY_A }, { key: KEY_A, email: "b" })).toBe(false);
    expect(identitiesDiffer({ key: KEY_A, email: "a" }, { email: "b" })).toBe(true);
    expect(identitiesDiffer({ key: KEY_A }, { key: KEY_B })).toBe(true);
  });

  it("reads no identity from a probe that is not authenticated", () => {
    expect(accountIdentityOf(snapshot({ status: "unknown", key: KEY_A, readAt: now }))).toBe(
      undefined,
    );
    expect(accountIdentityOf(snapshot({ email: " A@Example.com ", readAt: now }))).toEqual({
      email: "a@example.com",
    });
  });
});

describe("planLabel", () => {
  it("names the plan only for an authenticated subscription label", () => {
    const auth = (status: "authenticated" | "unknown", label: string) =>
      ({ status, label }) as ServerProvider["auth"];
    expect(planLabel(auth("authenticated", "Claude Max Subscription"))).toBe("Claude Max");
    expect(planLabel(auth("authenticated", "ChatGPT Plus Subscription"))).toBe("ChatGPT Plus");
    expect(planLabel(auth("unknown", "Status check did not finish"))).toBe(null);
    expect(planLabel(auth("unknown", "Claude Max Subscription"))).toBe(null);
    expect(planLabel(auth("authenticated", "Subscription authorization unverified"))).toBe(null);
    expect(planLabel(auth("authenticated", "Claude API Key"))).toBe(null);
  });
});
