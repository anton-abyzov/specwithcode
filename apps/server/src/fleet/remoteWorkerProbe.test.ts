import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelBillingFlags, readProviders } from "./remoteWorkerProbe.ts";

const provider = (authType: string, models: ReadonlyArray<Record<string, unknown>>) =>
  ({
    instanceId: ProviderInstanceId.make("pi"),
    driver: ProviderDriverKind.make("pi"),
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated", type: authType },
    checkedAt: "2026-11-18T00:00:00.000Z",
    models: models.map((model) => ({
      name: model.slug,
      isCustom: false,
      capabilities: null,
      ...model,
    })),
    slashCommands: [],
    skills: [],
  }) as unknown as ServerProvider;

describe("modelBillingFlags", () => {
  it("holds back a model billed per use, and one whose billing nothing establishes", () => {
    const plan = provider("max", [
      { slug: "plan-model" },
      { slug: "anthropic/claude", billing: "unknown" },
      { slug: "openrouter/claude", billing: "paid-router" },
    ]);
    expect(modelBillingFlags(plan, "plan-model")).toEqual({});
    // It may be a plan login or an API key: not proven paid, still never started unasked.
    expect(modelBillingFlags(plan, "anthropic/claude")).toEqual({ held: true });
    expect(modelBillingFlags(plan, "openrouter/claude")).toEqual({ paid: true, held: true });
    expect(modelBillingFlags(provider("apiKey", [{ slug: "plan-model" }]), "plan-model")).toEqual({
      paid: true,
      held: true,
    });
  });

  it("reaches the asking machine as two lists, and an older machine sends neither", () => {
    const read = (models: ReadonlyArray<unknown>) =>
      readProviders({
        providers: [{ providerInstanceId: "pi", driverKind: "pi", models, constraints: [] }],
      })[0];
    expect(
      read([
        { id: "a", paid: true, held: true },
        { id: "b", held: true },
        { id: "c", held: "yes" },
      ]),
    ).toMatchObject({ models: ["a", "b", "c"], paidModels: ["a"], heldModels: ["a", "b"] });
    const older = read([{ id: "a" }]);
    expect(older).not.toHaveProperty("paidModels");
    expect(older).not.toHaveProperty("heldModels");
  });
});
