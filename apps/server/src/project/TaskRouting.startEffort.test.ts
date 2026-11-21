import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withStartEffort } from "./TaskRouting.ts";

const levels = (ids: ReadonlyArray<string>) => ({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning effort",
      type: "select" as const,
      options: ids.map((level) => ({
        id: level,
        label: level,
        ...(level === "max" ? { isDefault: true } : {}),
      })),
    },
  ],
});
const muse: ServerProvider = {
  instanceId: ProviderInstanceId.make("muse"),
  driver: ProviderDriverKind.make("muse"),
  enabled: true,
  installed: true,
  version: "1.4.23",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-18T09:00:00.000Z",
  models: [
    {
      slug: "muse-wonder-full-1.0",
      name: "Muse Wonder Full 1.0",
      isCustom: false,
      capabilities: levels(["minimal", "low", "medium", "high", "xhigh", "max"]),
    },
    { slug: "muse-spark-1.3", name: "Muse Spark 1.3", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};
const copilot: ServerProvider = {
  ...muse,
  instanceId: ProviderInstanceId.make("acpRegistry_copilot"),
  driver: ProviderDriverKind.make("acpRegistry"),
  models: [{
    slug: "gemini-4-neon",
    name: "Gemini 4 Neon",
    isCustom: false,
    capabilities: levels(["low", "medium", "high"]),
  }],
};
const worker = (
  model: string,
  options?: Array<{ id: string; value: string }>,
  instanceId = muse.instanceId,
) => ({
  modelSelection: {
    instanceId,
    model,
    ...(options === undefined ? {} : { options }),
  },
});

describe("withStartEffort", () => {
  it("starts a new worker on Wonder Full at Medium, not Muse's Max", () => {
    expect(
      withStartEffort(worker("muse-wonder-full-1.0"), [muse], false).modelSelection.options,
    ).toEqual([{ id: "reasoningEffort", value: "medium" }]);
  });

  it("starts Neon reviewers at High and fallback reviewers at Medium", () => {
    expect(
      withStartEffort(worker("muse-wonder-full-1.0"), [muse], true).modelSelection.options,
    ).toEqual([{ id: "reasoningEffort", value: "medium" }]);
    const neon = worker("gemini-4-neon", undefined, copilot.instanceId);
    expect(withStartEffort(neon, [copilot], true).modelSelection.options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
  });

  it("keeps the level the caller named", () => {
    const named = worker("muse-wonder-full-1.0", [{ id: "reasoningEffort", value: "max" }]);
    expect(withStartEffort(named, [muse], true)).toBe(named);
  });

  it("adds nothing for a model without an effort setting", () => {
    const spark = worker("muse-spark-1.3");
    expect(withStartEffort(spark, [muse], false)).toBe(spark);
  });
});
