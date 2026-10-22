// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
import { CoordinatorAccessPicker, CoordinatorComposerControls } from "./CoordinatorAccessPicker";
const mocks = vi.hoisted(() => ({ allowed: true, save: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => mocks.allowed }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.save }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.allowed = true;
  mocks.save.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const mount = () =>
  act(async () =>
    root.render(
      <CoordinatorAccessPicker environmentId={"host" as never} projectId={"project" as never} />,
    ),
  );
const choose = () =>
  act(async () => {
    const select = container.querySelector("select")!;
    select.value = "full-access";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
it("writes the project permission setting without changing models or global defaults", async () => {
  await mount();
  await choose();
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
    environmentId: "host",
    input: {
      patch: { projectSettingsOverrides: { project: { defaultRuntimeMode: "full-access" } } },
    },
  });
});
it("retries the attempted choice after a failed save, even when settings stayed old", async () => {
  mocks.save.mockResolvedValueOnce({ _tag: "Failure" });
  await mount();
  await choose();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => container.querySelector("button")!.click());
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.save.mock.calls[1]).toEqual(mocks.save.mock.calls[0]);
});
it("shows the mode the coordinator runs in, not only the saved default", async () => {
  await act(async () =>
    root.render(
      <CoordinatorAccessPicker
        environmentId={"host" as never}
        projectId={"project" as never}
        coordinatorRuntimeMode="full-access"
      />,
    ),
  );
  expect(DEFAULT_SERVER_SETTINGS.defaultRuntimeMode).toBe("approval-required");
  expect(container.querySelector("select")!.value).toBe("full-access");
  await act(async () =>
    root.render(
      <CoordinatorAccessPicker
        environmentId={"host" as never}
        projectId={"project" as never}
        coordinatorRuntimeMode="approval-required"
      />,
    ),
  );
  expect(container.querySelector("select")!.value).toBe("approval-required");
});
it("requires settings write scope", async () => {
  mocks.allowed = false;
  await mount();
  expect(container.querySelector("select")!.disabled).toBe(true);
  await choose();
  expect(mocks.save).not.toHaveBeenCalled();
});

it("keeps access in the controls row, right after the model and effort", async () => {
  await act(async () =>
    root.render(
      <div className="sws-composer-foot">
        <span className="sws-composer-meta">meta</span>
        <CoordinatorComposerControls
          project={{ environmentId: "host" as never, id: "project" as never }}
          fallback={null}
        >
          <span data-coordinator-model-controls="">model and effort</span>
        </CoordinatorComposerControls>
      </div>,
    ),
  );
  const row = container.querySelector("[data-coordinator-composer-controls]")!;
  expect(row.parentElement?.className).toBe("sws-composer-foot");
  const [model, access] = row.children;
  expect(row.children).toHaveLength(2);
  expect(model?.textContent).toBe("model and effort");
  expect(access?.querySelector("select")?.getAttribute("aria-label")).toBe("Project permissions");
});

it("names the provider in use now, or says the fallback is out of usage too", async () => {
  const label = (provider: string, model: string) => ({
    provider,
    model,
    full: `${provider} · ${model}`,
  });
  const render = (spent: boolean) =>
    act(async () =>
      root.render(
        <CoordinatorComposerControls
          project={{ environmentId: "host" as never, id: "project" as never }}
          fallback={{
            saved: label("Codex", "GPT-6.1-Sol"),
            now: label(spent ? "Copilot" : "Claude Code", spent ? "GPT-6.1-Sol" : "Opus 5.5"),
            reason: "weekly limit reached, resets in 5d 8h",
            spent,
          }}
        >
          <span />
        </CoordinatorComposerControls>,
      ),
    );
  await render(false);
  const line = () => container.querySelector("[data-model-fallback]")!;
  expect(line().querySelector("strong")?.textContent).toBe("Switched to Claude Code");
  expect(line().textContent).toContain("Codex weekly limit reached, resets in 5d 8h.");
  await render(true);
  expect(line().querySelector("strong")?.textContent).toBe("Copilot is out of usage too");
  expect(line().textContent).not.toContain("Switched to");
});
