import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import { describe, expect, it } from "vite-plus/test";

import { accountJoinsToAnnounce } from "./fleetJoinNotice";

const NOW = Date.parse("2026-11-12T22:00:00.000Z");
const machine = (id: string) => ({ id }) as StudioFleetSnapshot["machines"][number];
const join = (id: string, joinedAt: string) => ({ id, label: `Label of ${id}`, joinedAt });

describe("accountJoinsToAnnounce", () => {
  it("is empty for an older server, which lists no joins", () => {
    expect(accountJoinsToAnnounce({ machines: [machine("m5")] }, null, NOW)).toEqual([]);
    expect(accountJoinsToAnnounce(null, null, NOW)).toEqual([]);
  });

  it("announces a recent join once, oldest first", () => {
    const snapshot = {
      machines: [machine("m5"), machine("m3")],
      accountJoins: [
        join("m5", "2026-11-12T21:30:00.000Z"),
        join("m3", "2026-11-12T20:00:00.000Z"),
      ],
    };
    expect(accountJoinsToAnnounce(snapshot, null, NOW).map((entry) => entry.id)).toEqual([
      "m3",
      "m5",
    ]);
    expect(
      accountJoinsToAnnounce(snapshot, "2026-11-12T20:00:00.000Z", NOW).map((entry) => entry.id),
    ).toEqual(["m5"]);
    expect(accountJoinsToAnnounce(snapshot, "2026-11-12T21:30:00.000Z", NOW)).toEqual([]);
  });

  it("leaves out a join from over a day ago and one whose machine was removed", () => {
    const snapshot = {
      machines: [machine("m5")],
      accountJoins: [
        join("m5", "2026-11-11T21:00:00.000Z"),
        join("gone", "2026-11-12T21:00:00.000Z"),
      ],
    };
    expect(accountJoinsToAnnounce(snapshot, null, NOW)).toEqual([]);
  });

  it("announces again when the same machine joins again later", () => {
    const snapshot = {
      machines: [machine("m5")],
      accountJoins: [join("m5", "2026-11-12T21:45:00.000Z")],
    };
    expect(accountJoinsToAnnounce(snapshot, "2026-11-12T21:30:00.000Z", NOW)).toHaveLength(1);
  });
});
