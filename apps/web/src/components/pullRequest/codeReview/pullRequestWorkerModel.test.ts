import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestWorkerModel } from "./useStartPullRequestWorker";

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
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select",
            options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({
              id,
              label: id,
              ...(id === "max" ? { isDefault: true } : {}),
            })),
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};
const wonderFull = { instanceId: muse.instanceId, model: "muse-wonder-full-1.0" };

describe("pullRequestWorkerModel", () => {
  it("starts a fix on Wonder Full at Medium, not Muse's Max", () => {
    expect(pullRequestWorkerModel({ verb: "Fix" }, wonderFull, [muse])?.options).toEqual([
      { id: "reasoningEffort", value: "medium" },
    ]);
  });

  it("starts an explicitly chosen review model at Medium without a saved effort", () => {
    expect(
      pullRequestWorkerModel({ verb: "Review", model: wonderFull }, null, [muse])?.options,
    ).toEqual([{ id: "reasoningEffort", value: "medium" }]);
  });

  it("keeps a level the model already names", () => {
    const high = { ...wonderFull, options: [{ id: "reasoningEffort", value: "high" }] };
    expect(pullRequestWorkerModel({ verb: "Review", model: high }, null, [muse])).toBe(high);
  });

  it("is null with no model to start on", () => {
    expect(pullRequestWorkerModel({ verb: "Fix" }, null, [muse])).toBeNull();
  });
});
