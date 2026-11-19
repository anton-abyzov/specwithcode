import type { ProviderOptionDescriptor } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";

import { withAcpEffortFallback } from "./AcpEffortFallback.ts";

const MODE: ProviderOptionDescriptor = {
  id: "mode",
  label: "Mode",
  type: "select",
  options: [
    { id: "agent", label: "Agent" },
    { id: "plan", label: "Plan" },
  ],
};

describe("withAcpEffortFallback", () => {
  it("gives a Copilot reasoning model Effort when discovery reported only Mode", () => {
    for (const slug of ["gpt-6.2-astra", "gpt-7-nova", "claude-opus-5.5"]) {
      const descriptors = withAcpEffortFallback("github-copilot-cli", slug, [MODE]);
      expect(descriptors.map((descriptor) => descriptor.id), slug).toEqual([
        "mode",
        "reasoning_effort",
      ]);
      const effort = descriptors[1];
      expect(effort?.type === "select" ? effort.options.map((option) => option.id) : []).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
    }
  });

  it("gives Effort when discovery reported no options at all", () => {
    expect(withAcpEffortFallback("github-copilot-cli", "gpt-6.2-sol", [])[0]?.id).toBe(
      "reasoning_effort",
    );
  });

  it("keeps the agent's own effort option", () => {
    const own: ReadonlyArray<ProviderOptionDescriptor> = [
      MODE,
      {
        id: "reasoning_effort",
        label: "Reasoning Effort",
        type: "select",
        options: [
          { id: "low", label: "low" },
          { id: "max", label: "max" },
        ],
      },
    ];
    expect(withAcpEffortFallback("github-copilot-cli", "gpt-6.2-astra", own)).toBe(own);
  });

  it("adds nothing for a non-reasoning model or an agent without a known effort option", () => {
    const descriptors = [MODE];
    expect(withAcpEffortFallback("github-copilot-cli", "gpt-4.1", descriptors)).toBe(descriptors);
    expect(withAcpEffortFallback("github-copilot-cli", "auto", descriptors)).toBe(descriptors);
    expect(withAcpEffortFallback("devin", "gpt-6.2-astra", descriptors)).toBe(descriptors);
  });
});
