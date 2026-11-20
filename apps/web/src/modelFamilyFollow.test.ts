import { ProviderInstanceId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  followedModelUpdates,
  newestModelInFamily,
  replaceFavoriteModel,
  sameBillingSuccessor,
} from "./modelFamilyFollow";

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

  it("follows a manifest successor when the name changes and the billing matches", () => {
    const models = [
      { slug: "claude-opus-5-5", name: "Opus 5.5", billing: "subscription" as const },
      {
        slug: "claude-fable-5-2",
        name: "Fable 5.2",
        billing: "subscription" as const,
        succeeds: "claude-opus-5-5",
      },
    ];
    expect(sameBillingSuccessor(models, "claude-opus-5-5")).toBe("claude-fable-5-2");
  });

  it("does not move a custom model or an unavailable release", () => {
    expect(
      sameBillingSuccessor(
        [
          { slug: "mine", name: "Mine", isCustom: true, billing: "subscription" as const },
          {
            slug: "mine-2",
            name: "Mine 2",
            billing: "subscription" as const,
            succeeds: "mine",
          },
        ],
        "mine",
      ),
    ).toBeUndefined();
    expect(
      sameBillingSuccessor(
        [
          { slug: "claude-opus-5-5", name: "Opus", billing: "subscription" as const },
          {
            slug: "claude-opus-6",
            name: "Opus 6",
            billing: "subscription" as const,
            isUnavailable: true,
          },
        ],
        "claude-opus-5-5",
      ),
    ).toBeUndefined();
  });

  it("does not follow a release whose billing is unknown", () => {
    expect(
      sameBillingSuccessor(
        [
          { slug: "claude-opus-5-5", name: "Opus", billing: "unknown" as const },
          { slug: "claude-opus-6", name: "Opus 6", billing: "unknown" as const },
        ],
        "claude-opus-5-5",
      ),
    ).toBeUndefined();
  });

  it("moves one star and drops the old one when the new model is already starred", () => {
    const favorites = [
      { provider: claude, model: "claude-opus-5-5" },
      { provider: claude, model: "claude-opus-6" },
      { provider: copilot, model: "claude-opus-5-5" },
    ];
    expect(replaceFavoriteModel(favorites, claude, "claude-opus-5-5", "claude-opus-6")).toEqual([
      { provider: claude, model: "claude-opus-6" },
      { provider: copilot, model: "claude-opus-5-5" },
    ]);
    expect(replaceFavoriteModel(favorites, copilot, "claude-opus-5-5", "claude-opus-6")).toEqual([
      { provider: claude, model: "claude-opus-5-5" },
      { provider: claude, model: "claude-opus-6" },
      { provider: copilot, model: "claude-opus-6" },
    ]);
  });

  it("does not follow a newer release that is billed differently", () => {
    const models = [
      { ...opus("5.5"), billing: "subscription" as const },
      { ...opus("6"), billing: "api" as const },
    ];
    expect(sameBillingSuccessor(models, "claude-opus-5-5")).toBeUndefined();
    expect(
      followedModelUpdates({
        follow: { [claude]: "opus" },
        sticky: { [claude]: { model: "claude-opus-5-5" } },
        modelsByInstance: new Map([[claude, models]]),
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
