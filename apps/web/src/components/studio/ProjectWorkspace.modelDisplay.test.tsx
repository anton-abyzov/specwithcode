// @vitest-environment jsdom
import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
import { act } from "react";
import { describe, expect, it } from "vite-plus/test";
import { container, render, shell, state } from "./ProjectWorkspace.test-fixtures";

const saved = { instanceId: "codex", model: "gpt-6.1-sol" };
const running = { instanceId: "copilot", model: "gpt-6-astra" };
const provider = (instanceId: string, driver: string, usedPercent = 20) => ({
  instanceId,
  driver,
  displayName: instanceId === "copilot" ? "GitHub Copilot" : "Codex",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: [
    { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isCustom: false },
    { slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false },
  ],
  usageLimits: {
    status: "ok",
    checkedAt: new Date().toISOString(),
    windows: [
      {
        id: "session",
        kind: "session",
        label: "Session",
        usedPercent,
        resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
  },
});

function setup(active: typeof saved, preference: typeof saved | null = saved) {
  state.realCoordinatorModelPicker = true;
  state.coordinatorModel = preference;
  Object.assign(state.project, {
    workspaceSettings: { revision: 1, coordinatorModelSelection: preference },
  });
  // Thread metadata and saved settings can already name the next turn; the active
  // run still belongs to its admitted provider/model.
  state.shells = [shell("coord", { modelSelection: saved } as never)];
  state.hostSettings = DEFAULT_SERVER_SETTINGS;
  state.providers = [provider("codex", "codex"), provider("copilot", "copilot")];
  state.runs = [
    {
      id: "active",
      ordinal: 1,
      status: "running",
      requestedAt: new Date().toISOString(),
      providerInstanceId: active.instanceId,
      modelSelection: active,
    },
  ];
}

const modelButton = () =>
  container.querySelector<HTMLButtonElement>(
    '.sws-composer [data-coordinator-model-controls] button[aria-label^="Coordinator model:"]',
  );

describe("ProjectWorkspace actual coordinator picker", () => {
  it("keeps the active provider visible after saved-provider quota recovers, then shows the next selection", async () => {
    setup(running);
    try {
      state.providers = [provider("codex", "codex", 100), provider("copilot", "copilot")];
      await render();
      expect(modelButton()?.getAttribute("aria-label")).toContain("Copilot");
      expect(modelButton()?.getAttribute("aria-label")).toContain("back to Codex after reset");
      // The suffix is the glyph alone; the sentence is for screen readers and the tooltip.
      const suffix = container.querySelector('.sws-model-state[data-model-state="fallback"]');
      expect(suffix?.querySelector("[data-fallback-glyph]")).not.toBeNull();
      expect(suffix?.textContent).toBe(", fallback for Codex · GPT-6.1 Sol (usage limit)");
      // While the limit holds, the chip says it once; no line repeats it.
      expect(container.querySelector("p[data-model-fallback]")).toBeNull();

      // Codex reads as having room again, but the turn still runs on Copilot: the
      // chip keeps naming it, and one line offers the way back.
      state.providers = [provider("codex", "codex", 20), provider("copilot", "copilot")];
      await render();
      expect(modelButton()?.getAttribute("aria-label")).toContain("running on");
      expect(modelButton()?.textContent).toContain("Copilot");
      expect(modelButton()?.textContent).toContain("GPT-6 Astra");
      expect(container.querySelector("p[data-model-fallback]")?.textContent).toContain(
        "Your pick, Codex · GPT-6.1 Sol, has room again.",
      );
      expect(container.querySelector('[data-model-state="fallback"]')).not.toBeNull();
      expect(modelButton()?.getAttribute("aria-label")).not.toContain("after reset");
      expect(state.coordinatorModel).toEqual(saved);
      expect(state.send).not.toHaveBeenCalled();

      state.runs = state.runs.map((run) => ({ ...run, status: "completed" }));
      await render();
      expect(modelButton()?.textContent).toContain("Codex");
      expect(modelButton()?.textContent).toContain("GPT-6.1 Sol");
      expect(modelButton()?.getAttribute("aria-label")).not.toContain("running on");
      expect(container.querySelector("p[data-model-fallback]")).toBeNull();
      expect(container.querySelector('[data-model-state="fallback"]')).toBeNull();
    } finally {
      Object.assign(state.project, { workspaceSettings: undefined });
    }
  });

  it.each([
    {
      description: "a different model on the same provider",
      active: { ...saved, model: "gpt-6-astra" },
      preference: saved,
    },
    { description: "no saved coordinator preference", active: running, preference: null },
  ])("shows the admitted run with $description", async ({ active, preference }) => {
    setup(active, preference);
    try {
      await render();
      expect(modelButton()?.textContent).toContain("GPT-6 Astra");
      expect(modelButton()?.textContent).toContain(
        active.instanceId === "copilot" ? "Copilot" : "Codex",
      );
      // Off the saved pick, the tag says so; with nothing saved there is no pick to be off.
      expect(container.querySelector('[data-model-state="fallback"]') !== null).toBe(
        preference !== null,
      );
      expect(modelButton()?.getAttribute("aria-label")).not.toContain("after reset");
      expect(state.coordinatorModel).toEqual(preference);
      expect(state.send).not.toHaveBeenCalled();
    } finally {
      Object.assign(state.project, { workspaceSettings: undefined });
    }
  });
});

describe("ProjectWorkspace coordinator picker wiring", () => {
  it("passes the limit reason and the way back to the picker while the limit holds", async () => {
    setup(running);
    state.realCoordinatorModelPicker = false;
    try {
      state.providers = [provider("codex", "codex", 100), provider("copilot", "copilot")];
      await render();
      const picker = container.querySelector("[data-coordinator-model]");
      expect(picker?.getAttribute("data-returns-to")).toBe("Codex");
      expect(picker?.getAttribute("data-fallback-reason")).toMatch(/resets in/);
      // The composer line stays hidden while the limit holds, so the picker is the way back.
      expect(container.querySelector("p[data-model-fallback]")).toBeNull();
      const back = container.querySelector<HTMLButtonElement>("[data-coordinator-switch-back]");
      expect(back).not.toBeNull();
      await act(async () => back!.click());
      expect(state.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ threadId: "coord", modelSelection: saved }),
        }),
      );
    } finally {
      Object.assign(state.project, { workspaceSettings: undefined });
    }
  });
});
