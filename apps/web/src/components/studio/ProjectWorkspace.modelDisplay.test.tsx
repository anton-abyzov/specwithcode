// @vitest-environment jsdom
import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
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
      expect(container.querySelector("[data-model-fallback-hint]")?.textContent).toBe(
        "Codex after reset",
      );

      state.providers = [provider("codex", "codex", 20), provider("copilot", "copilot")];
      await render();
      expect(modelButton()?.getAttribute("aria-label")).toContain("running on");
      expect(modelButton()?.textContent).toContain("Copilot");
      expect(modelButton()?.textContent).toContain("GPT-6 Astra");
      expect(container.querySelector("[data-model-fallback]")).toBeNull();
      expect(container.querySelector("[data-model-fallback-hint]")).toBeNull();
      expect(modelButton()?.getAttribute("aria-label")).not.toContain("after reset");
      expect(state.coordinatorModel).toEqual(saved);
      expect(state.send).not.toHaveBeenCalled();

      state.runs = state.runs.map((run) => ({ ...run, status: "completed" }));
      await render();
      expect(modelButton()?.textContent).toContain("Codex");
      expect(modelButton()?.textContent).toContain("GPT-6.1 Sol");
      expect(modelButton()?.getAttribute("aria-label")).not.toContain("running on");
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
      expect(container.querySelector("[data-model-fallback-hint]")).toBeNull();
      expect(modelButton()?.getAttribute("aria-label")).not.toContain("after reset");
      expect(state.coordinatorModel).toEqual(preference);
      expect(state.send).not.toHaveBeenCalled();
    } finally {
      Object.assign(state.project, { workspaceSettings: undefined });
    }
  });
});
