import { describe, expect, it } from "@effect/vitest";

import { MachineNicknames } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

import {
  assignMachineColors,
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

  describe("color and icon", () => {
    const stamp = "2026-11-10T21:00:00.000Z";
    const colored = { ...at("M4", stamp), color: "violet" as const, icon: "laptop" as const };

    it("never drops a color for an entry with the same stamp", () => {
      // A paired machine on an older build decodes the entry without them and sends it back.
      const stripped = at("M4", stamp);
      expect(newerMachineNickname(colored, stripped)).toBe(colored);
      expect(newerMachineNickname(stripped, colored)).toBe(colored);
      expect(mergeMachineNicknames({ m4: colored }, { m4: stripped })).toEqual({ m4: colored });
    });

    it("keeps the color through a newer rename that states none", () => {
      const renamed = at("Desk", "2026-11-10T22:00:00.000Z");
      expect(newerMachineNickname(colored, renamed)).toEqual({
        ...renamed,
        color: "violet",
        icon: "laptop",
      });
      expect(newerMachineNickname(renamed, colored)).toEqual({
        ...renamed,
        color: "violet",
        icon: "laptop",
      });
    });

    it("lets a newer choice replace an older color", () => {
      const recolored = { ...at("M4", "2026-11-10T22:00:00.000Z"), color: "teal" as const };
      expect(newerMachineNickname(colored, recolored)).toEqual({ ...recolored, icon: "laptop" });
    });

    it("settles equal stamps the same way in either order", () => {
      const teal = { ...at("M4", stamp), color: "teal" as const };
      expect(newerMachineNickname(colored, teal)).toEqual(newerMachineNickname(teal, colored));
    });

    it("compares maps by color and icon too", () => {
      expect(sameMachineNicknames({ m4: colored }, { m4: at("M4", stamp) })).toBe(false);
      expect(sameMachineNicknames({ m4: colored }, { m4: { ...colored } })).toBe(true);
    });

    it("decodes a color this build does not know as absent, keeping the name", () => {
      const decoded = Schema.decodeUnknownSync(MachineNicknames)({
        m4: { name: "M4", updatedAt: stamp, color: "ultraviolet", icon: "hologram" },
        m1: { name: "M1", updatedAt: stamp, color: "teal", icon: "mac-mini" },
      });
      expect(decoded.m4).toEqual({ name: "M4", updatedAt: stamp });
      expect(decoded.m1).toEqual({ name: "M1", updatedAt: stamp, color: "teal", icon: "mac-mini" });
    });
  });

  describe("assignMachineColors", () => {
    it("gives every known machine its own color while there are colors left", () => {
      const ids = ["env-m4", "env-m1", "env-m3", "env-mini", "env-mbp", "env-a", "env-b", "env-c"];
      const colors = assignMachineColors(ids, {});
      expect(new Set(colors.values()).size).toBe(8);
      // The same machines get the same colors whichever order a device learns them in.
      expect([...assignMachineColors(ids.toReversed(), {})].toSorted()).toEqual(
        [...colors].toSorted(),
      );
    });

    it("keeps a chosen color and steps the defaults past it", () => {
      const first = assignMachineColors(["a", "b"], {});
      const chosen = first.get("b")!;
      const colors = assignMachineColors(["a", "b"], {
        a: { ...at("A", "2026-11-10T21:00:00.000Z"), color: chosen },
      });
      expect(colors.get("a")).toBe(chosen);
      expect(colors.get("b")).not.toBe(chosen);
    });

    it("includes machines known only by their nickname", () => {
      expect(
        assignMachineColors([], { away: at("Away", "2026-11-10T21:00:00.000Z") }).has("away"),
      ).toBe(true);
    });
  });
});
