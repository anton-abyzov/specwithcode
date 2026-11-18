import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerPickSelection } from "./composerModelPick";

const levels = (ids: ReadonlyArray<string>, isDefault: string) => ({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning effort",
      type: "select" as const,
      options: ids.map((id) => ({
        id,
        label: id,
        ...(id === isDefault ? { isDefault: true } : {}),
      })),
    },
  ],
});
const muse = {
  instanceId: ProviderInstanceId.make("muse"),
  driver: ProviderDriverKind.make("muse"),
  enabled: true,
  installed: true,
  version: "1.4.23",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-18T07:40:57.000Z",
  models: [
    // Muse Code reports Max as Wonder Full's own default.
    {
      slug: "muse-wonder-full-1.0",
      name: "Muse Wonder Full 1.0",
      isCustom: false,
      capabilities: levels(["low", "medium", "high", "xhigh", "max"], "max"),
    },
    {
      slug: "muse-wonder-1.0",
      name: "Muse Wonder 1.0",
      isCustom: false,
      capabilities: levels(["high", "max"], "max"),
    },
    { slug: "muse-spark-1.3", name: "Muse Spark 1.3", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;
const pick = (model: string, remembered?: Array<{ id: string; value: string }>) =>
  composerPickSelection({ instanceId: muse.instanceId, model, remembered, providers: [muse] });

describe("composerPickSelection", () => {
  it("starts a fresh pick of Wonder Full at Medium, not the provider's Max", () => {
    expect(pick("muse-wonder-full-1.0").options).toEqual([
      { id: "reasoningEffort", value: "medium" },
    ]);
  });

  it("takes the nearest level a model offers", () => {
    expect(pick("muse-wonder-1.0").options).toEqual([{ id: "reasoningEffort", value: "high" }]);
  });

  it("keeps the level the person last used on that model", () => {
    expect(pick("muse-wonder-full-1.0", [{ id: "reasoningEffort", value: "max" }]).options).toEqual(
      [{ id: "reasoningEffort", value: "max" }],
    );
  });

  it("sends no effort for a model without one", () => {
    expect(pick("muse-spark-1.3")).toEqual({
      instanceId: muse.instanceId,
      model: "muse-spark-1.3",
    });
  });
});
