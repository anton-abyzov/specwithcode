import type { DesignRef, DesignSystemSummary } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "~/providerInstances";

import { designFromCodePrompt, workerModelLabel } from "./designFromCode";

const ref = {
  owner: { kind: "project", environmentId: "host", projectId: "web" },
  designId: "d_1",
  path: ".specweave/design/d_1/design.json",
} as unknown as DesignRef;

describe("designFromCodePrompt", () => {
  it("names the design, the design tools and the system", () => {
    const system = { name: "Weave", ref: { systemId: "weave" } } as unknown as DesignSystemSummary;
    const text = designFromCodePrompt({
      projectTitle: "Web app",
      ref,
      title: "Design from code",
      system,
      brief: "A notifications settings page",
    });
    expect(text).toContain("Design from code in Web app: A notifications settings page");
    expect(text).toContain("id d_1, file .specweave/design/d_1/design.json");
    for (const tool of ["design_get", "design_apply", "design_screenshot", "design_save_version"]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain("Design system: Weave (id weave)");
    expect(text).toContain("design_system_get");
  });

  it("asks the agent to read the code's styles when no system is set, and to ask for a brief", () => {
    const text = designFromCodePrompt({
      projectTitle: "Web app",
      ref,
      title: "Design from code",
      system: null,
      brief: "  ",
    });
    expect(text).toContain("Ask me what the design should show");
    expect(text).toContain("No design system is set");
    expect(text).not.toMatch(/claude|codex|copilot|gemini/i);
  });
});

describe("workerModelLabel", () => {
  const entries = [
    {
      instanceId: "claudeAgent",
      displayName: "Claude",
      models: [{ slug: "claude-opus-5-5", name: "Opus 5.5" }],
    },
  ] as unknown as ProviderInstanceEntry[];

  it("names the provider, model and effort", () => {
    expect(
      workerModelLabel(
        {
          instanceId: "claudeAgent",
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "high" }],
        } as never,
        entries,
      ),
    ).toBe("Claude Opus 5.5, high effort");
    expect(workerModelLabel(null, entries)).toBeNull();
    expect(workerModelLabel({ instanceId: "other", model: "m-1" } as never, entries)).toBe("m-1");
  });
});
