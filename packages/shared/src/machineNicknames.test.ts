import { describe, expect, it } from "@effect/vitest";

import {
  mergeMachineNicknames,
  newerMachineNickname,
  nextMachineNicknameStamp,
  normalizeMachineNickname,
  sameMachineNicknames,
} from "./machineNicknames.ts";

const at = (name: string, updatedAt: string) => ({ name, updatedAt });

describe("machine nicknames", () => {
  it("normalizes a typed name to at most 16 characters", () => {
    expect(normalizeMachineNickname("  Mac   mini  ")).toBe("Mac mini");
    expect(normalizeMachineNickname("A very long machine name")).toBe("A very long mach");
    expect(normalizeMachineNickname("abcdefghijklmno pq")).toBe("abcdefghijklmno");
  });

  it("keeps the newest entry and breaks equal stamps by name", () => {
    const older = at("Older", "2026-10-20T21:00:00.000Z");
    const newer = at("Newer", "2026-10-20T21:05:00.000Z");
    expect(newerMachineNickname(older, newer)).toBe(newer);
    expect(newerMachineNickname(newer, older)).toBe(newer);
    expect(newerMachineNickname(undefined, older)).toBe(older);
    const a = at("Alpha", "2026-10-20T21:00:00.000Z");
    const b = at("Beta", "2026-10-20T21:00:00.000Z");
    expect(newerMachineNickname(a, b)).toBe(b);
    expect(newerMachineNickname(b, a)).toBe(b);
  });

  it("merges per machine and returns the same map when nothing changes", () => {
    const current = { m4: at("Desk", "2026-10-20T21:00:00.000Z") };
    expect(mergeMachineNicknames(current, { m4: at("Old", "2026-10-19T00:00:00.000Z") })).toBe(
      current,
    );
    expect(mergeMachineNicknames(current, undefined)).toBe(current);
    const merged = mergeMachineNicknames(current, {
      mini: at("Mini 1", "2026-10-20T21:01:00.000Z"),
      m4: at("", "2026-10-20T21:02:00.000Z"),
    });
    expect(merged).toEqual({
      m4: at("", "2026-10-20T21:02:00.000Z"),
      mini: at("Mini 1", "2026-10-20T21:01:00.000Z"),
    });
    expect(current).toEqual({ m4: at("Desk", "2026-10-20T21:00:00.000Z") });
  });

  it("compares maps by name and stamp", () => {
    const a = { m4: at("Desk", "2026-10-20T21:00:00.000Z") };
    expect(sameMachineNicknames(a, { m4: at("Desk", "2026-10-20T21:00:00.000Z") })).toBe(true);
    expect(sameMachineNicknames(a, { m4: at("Desk", "2026-10-20T21:00:01.000Z") })).toBe(false);
    expect(sameMachineNicknames(a, {})).toBe(false);
  });

  it("stamps a rename after the entry it replaces even when this clock runs behind", () => {
    const now = Date.parse("2026-10-20T21:00:00.000Z");
    expect(nextMachineNicknameStamp(undefined, now)).toBe("2026-10-20T21:00:00.000Z");
    expect(nextMachineNicknameStamp(at("x", "2026-10-20T22:00:00.000Z"), now)).toBe(
      "2026-10-20T22:00:00.001Z",
    );
  });
});
