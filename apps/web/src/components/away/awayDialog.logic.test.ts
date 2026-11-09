import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { awayTargetRank, defaultAwayTarget } from "./awayDialog.logic";

const LAPTOP = EnvironmentId.make("env-laptop");
const MINI = EnvironmentId.make("env-ministorm");
const STUDIO = EnvironmentId.make("env-studio");
const OFF = EnvironmentId.make("env-off");

const reachable = (environmentId: EnvironmentId, label: string) => ({
  environmentId,
  label,
  state: "reachable" as const,
});

describe("defaultAwayTarget", () => {
  const destinations = [
    { environmentId: OFF, label: "Off", state: "offline" as const },
    reachable(LAPTOP, "Air"),
    reachable(STUDIO, "Mac Studio"),
    reachable(MINI, "Ministorm"),
  ];

  it("prefers the first ready machine with no battery", () => {
    const facts = new Map([
      [LAPTOP, { machine: "laptop" }],
      [STUDIO, { machine: "mac-studio" }],
      [MINI, { machine: null, os: "linux" }],
    ]);
    expect(defaultAwayTarget(destinations, null, (id) => facts.get(id) ?? null)).toBe(STUDIO);
  });

  it("takes Linux when the shape is unknown, and skips a machine on battery now", () => {
    const facts = new Map([
      [LAPTOP, { machine: null, os: "darwin" }],
      [STUDIO, { machine: "mac-studio", onBattery: true as const }],
      [MINI, { machine: null, os: "linux" }],
    ]);
    expect(defaultAwayTarget(destinations, null, (id) => facts.get(id) ?? null)).toBe(MINI);
  });

  it("falls back to the first ready machine, and keeps a remembered ready one", () => {
    expect(defaultAwayTarget(destinations, null)).toBe(LAPTOP);
    expect(defaultAwayTarget(destinations, MINI, () => ({ machine: "laptop" }))).toBe(MINI);
    expect(defaultAwayTarget(destinations, OFF)).toBe(LAPTOP);
  });

  it("ranks unknown between always-on and laptops", () => {
    expect(awayTargetRank(null)).toBe(1);
    expect(awayTargetRank({ machine: "server" })).toBe(0);
    expect(awayTargetRank({ machine: "laptop" })).toBe(2);
  });
});
