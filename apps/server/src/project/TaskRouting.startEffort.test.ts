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
const worker = (model: string, options?: Array<{ id: string; value: string }>) => ({
  modelSelection: {
    instanceId: muse.instanceId,
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

  it("starts a Wonder Full reviewer at Extra High", () => {
    expect(
      withStartEffort(worker("muse-wonder-full-1.0"), [muse], true).modelSelection.options,
    ).toEqual([{ id: "reasoningEffort", value: "xhigh" }]);
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
