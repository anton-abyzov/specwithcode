import type { ProviderOptionDescriptor } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findEffortDescriptor,
  modelSelectionEffortValue,
  resolveEffort,
  withEffortSelection,
} from "./effortLevel.ts";

const select = (id: string, label: string, levels: ReadonlyArray<string>, currentValue?: string) =>
  ({
    id,
    label,
    type: "select",
    options: levels.map((level) => ({ id: level, label: level })),
    ...(currentValue === undefined ? {} : { currentValue }),
  }) as ProviderOptionDescriptor;

const copilot = [
  select("mode", "Mode", ["agent", "plan"]),
  select(
    "reasoning_effort",
    "Reasoning Effort",
    ["low", "medium", "high", "xhigh", "max"],
    "medium",
  ),
];
const claudeNoXhigh = [
  { id: "thinking", label: "Thinking", type: "boolean" } as ProviderOptionDescriptor,
  select("effort", "Reasoning", ["low", "medium", "high", "max", "ultrathink"]),
];
const grok = [select("reasoningEffort", "Reasoning", ["high", "medium", "low"])];

describe("resolveEffort", () => {
  it("maps 'ultracode' to Extra High plus the separate Ultracode toggle", () => {
    const claude = [
      select("effort", "Reasoning", ["low", "medium", "high", "xhigh", "max"]),
      { id: "ultracode", label: "Ultracode", type: "boolean" } as ProviderOptionDescriptor,
    ];
    const resolved = resolveEffort("ultracode", claude);
    expect(resolved).toMatchObject({ ok: true, value: "xhigh", ultracode: true });
    if (!resolved.ok) throw new Error("expected a resolution");
    expect(
      withEffortSelection(
        [
          { id: "effort", value: "low" },
          { id: "ultracode", value: false },
        ],
        resolved,
      ),
    ).toEqual([
      { id: "effort", value: "xhigh" },
      { id: "ultracode", value: true },
    ]);
    expect(resolveEffort("ultracode", claudeNoXhigh).ok).toBe(false);
  });

  it("matches the Copilot option id and phrasing like 'extra high'", () => {
    for (const phrase of ["xhigh", "extra high", "Extra-High", "EXTRA_HIGH", "very high"]) {
      expect(resolveEffort(phrase, copilot)).toEqual({
        ok: true,
        optionId: "reasoning_effort",
        value: "xhigh",
        label: "xhigh",
        exact: true,
      });
    }
  });

  it("falls back to the nearest level, preferring the higher one on a tie", () => {
    expect(resolveEffort("extra high", claudeNoXhigh)).toMatchObject({
      ok: true,
      optionId: "effort",
      value: "max",
      exact: false,
    });
    expect(resolveEffort("max", grok)).toMatchObject({ ok: true, value: "high", exact: false });
    expect(resolveEffort("minimal", grok)).toMatchObject({ ok: true, value: "low" });
  });

  it("accepts an exact provider-specific level", () => {
    expect(resolveEffort("ultrathink", claudeNoXhigh)).toMatchObject({
      ok: true,
      value: "ultrathink",
      exact: true,
    });
  });

  it("rejects unknown levels and models without an effort option", () => {
    expect(resolveEffort("turbo", copilot)).toMatchObject({ ok: false });
    expect(resolveEffort("high", [select("mode", "Mode", ["agent"])])).toMatchObject({ ok: false });
    expect(resolveEffort("high", undefined)).toMatchObject({ ok: false });
  });
});

describe("effort helpers", () => {
  it("finds the effort descriptor, not a boolean thinking toggle", () => {
    expect(findEffortDescriptor(claudeNoXhigh)?.id).toBe("effort");
  });

  it("replaces an earlier value for the same option", () => {
    expect(
      withEffortSelection(
        [
          { id: "reasoning_effort", value: "medium" },
          { id: "mode", value: "agent" },
        ],
        { optionId: "reasoning_effort", value: "xhigh" },
      ),
    ).toEqual([
      { id: "mode", value: "agent" },
      { id: "reasoning_effort", value: "xhigh" },
    ]);
  });

  it("reads a selection's effort value", () => {
    const options = [{ id: "reasoning_effort", value: "xhigh" }];
    expect(modelSelectionEffortValue({ options })).toBe("xhigh");
  });
});
