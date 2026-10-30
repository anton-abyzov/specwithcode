import { ProviderInstanceId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { followedModelUpdates, newestModelInFamily } from "./modelFamilyFollow";

const claude = ProviderInstanceId.make("claudeAgent");
const copilot = ProviderInstanceId.make("copilot_work");
const opus = (version: string, extra: { isUnavailable?: boolean } = {}) => ({
  slug: `claude-opus-${version.replace(".", "-")}`,
  name: `Claude Opus ${version}`,
  ...extra,
});

describe("newestModelInFamily", () => {
  it("picks the highest version of the family and skips unavailable ones", () => {
    const models = [opus("4.8"), opus("5.5"), opus("6", { isUnavailable: true }), opus("5")];
    expect(newestModelInFamily(models, "opus")?.slug).toBe("claude-opus-5-5");
    expect(newestModelInFamily(models, "sonnet")).toBeNull();
  });
});

describe("followedModelUpdates", () => {
  const modelsByInstance = new Map([
    [claude, [opus("5.5"), opus("6")]],
    [copilot, [opus("5.5")]],
  ]);

  it("moves a followed provider to its family's newest version", () => {
    expect(
      followedModelUpdates({
        follow: { [claude]: "opus", [copilot]: "opus" },
        sticky: { [claude]: { model: "claude-opus-5-5" }, [copilot]: { model: "claude-opus-5-5" } },
        modelsByInstance,
      }),
    ).toEqual([{ instanceId: claude, from: "claude-opus-5-5", to: "claude-opus-6" }]);
  });

  it("leaves providers alone when they follow nothing", () => {
    expect(
      followedModelUpdates({
        follow: {},
        sticky: { [claude]: { model: "claude-opus-5-5" } },
        modelsByInstance,
      }),
    ).toEqual([]);
  });

  it("never moves down when the sticky model is newer than what the list shows", () => {
    expect(
      followedModelUpdates({
        follow: { [copilot]: "opus" },
        sticky: { [copilot]: { model: "claude-opus-6" } },
        modelsByInstance: new Map([[copilot, [opus("5.5"), opus("6", { isUnavailable: true })]]]),
      }),
    ).toEqual([]);
  });

  it("keeps a sticky model this machine does not list", () => {
    expect(
      followedModelUpdates({
        follow: { [copilot]: "opus" },
        sticky: { [copilot]: { model: "claude-opus-6" } },
        modelsByInstance,
      }),
    ).toEqual([]);
  });
});
