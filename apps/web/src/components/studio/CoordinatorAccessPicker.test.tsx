// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@specweave-studio/contracts";
import { CoordinatorAccessPicker, CoordinatorComposerControls } from "./CoordinatorAccessPicker";
const mocks = vi.hoisted(() => ({
  allowed: true,
  save: vi.fn(),
  writeMode: "entry" as "per-key" | "entry" | null,
  settings: null as ServerSettings | null,
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => mocks.settings ?? DEFAULT_SERVER_SETTINGS,
  useProjectOverrideWriteMode: () => mocks.writeMode,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => mocks.allowed }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.save }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.allowed = true;
  mocks.writeMode = "entry";
  mocks.settings = null;
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
it("saves only the permission key, keeping the project's other overrides", async () => {
  mocks.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: {
      ["project" as never]: { defaultAutoPull: true, defaultModelSelection: null },
    },
  };
  mocks.writeMode = "per-key";
  await mount();
  await choose();
  expect(mocks.save).toHaveBeenLastCalledWith({
    environmentId: "host",
    input: {
      patch: {
        projectSettingsOverrideChanges: { project: { set: { defaultRuntimeMode: "full-access" } } },
      },
    },
  });
  // An older server replaces whole entries: send the saved entry with the new mode.
  mocks.writeMode = "entry";
  await mount();
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = "approval-required";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(mocks.save).toHaveBeenLastCalledWith({
    environmentId: "host",
    input: {
      patch: {
        projectSettingsOverrides: {
          project: {
            defaultAutoPull: true,
            defaultModelSelection: null,
            defaultRuntimeMode: "approval-required",
          },
        },
      },
    },
  });
});
it("saves nothing until the machine's settings load, so defaults never replace saved overrides", async () => {
  mocks.writeMode = null;
  await mount();
  expect(container.querySelector("select")!.disabled).toBe(true);
  await choose();
  expect(mocks.save).not.toHaveBeenCalled();
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

it("shows only actionable room news or an exhausted coordinator warning", async () => {
  const label = (provider: string, model: string) => ({
    provider,
    model,
    full: `${provider} · ${model}`,
  });
  const onSwitchBack = vi.fn();
  const render = (
    over: { spent?: boolean; onSwitchBack?: (() => void) | null; switching?: boolean } = {},
  ) =>
    act(async () =>
      root.render(
        <CoordinatorComposerControls
          project={{ environmentId: "host" as never, id: "project" as never }}
          fallback={{
            saved: label("Claude Code", "Opus 5.5"),
            now: label("Codex", "GPT-6.1-Sol"),
            reason: "weekly limit reached",
            ...over,
          }}
        >
          <span />
        </CoordinatorComposerControls>,
      ),
    );
  await render();
  expect(container.querySelector("[data-model-fallback]")).toBeNull();
  await render({ onSwitchBack });
  expect(container.querySelector("[data-model-fallback]")?.textContent).toContain(
    "Your pick, Claude Code · Opus 5.5, has room again.",
  );
  const back = container.querySelector<HTMLButtonElement>(".sws-model-fallback-back")!;
  expect(back.textContent).toBe("Switch back to Claude Code");
  await act(async () => back.click());
  expect(onSwitchBack).toHaveBeenCalledOnce();
  await render({ onSwitchBack, switching: true });
  expect(container.querySelector<HTMLButtonElement>(".sws-model-fallback-back")?.disabled).toBe(
    true,
  );
  await render({ spent: true });
  expect(container.querySelector("[data-model-fallback]")?.textContent).toBe(
    "Codex · GPT-6.1-Sol is out of usage too; nothing else can run the coordinator yet.",
  );
  expect(container.textContent).not.toContain("Now on");
  expect(container.textContent).not.toContain("goes back");
});

it("names the model to switch back to when the provider is the same", async () => {
  const label = (provider: string, model: string) => ({
    provider,
    model,
    full: `${provider} · ${model}`,
  });
  await act(async () =>
    root.render(
      <CoordinatorComposerControls
        project={{ environmentId: "host" as never, id: "project" as never }}
        fallback={{
          saved: label("Codex", "GPT-6.1 Sol"),
          now: label("Codex", "GPT-6 Astra"),
          reason: null,
          onSwitchBack: () => {},
        }}
      >
        <span />
      </CoordinatorComposerControls>,
    ),
  );
  expect(container.querySelector(".sws-model-fallback-back")?.textContent).toBe(
    "Switch back to GPT-6.1 Sol",
  );
});

it("names the whole pick to switch back to when harness and model both match", async () => {
  const label = { provider: "Codex", model: "GPT-6.1 Sol", full: "Codex · GPT-6.1 Sol" };
  await act(async () =>
    root.render(
      <CoordinatorComposerControls
        project={{ environmentId: "host" as never, id: "project" as never }}
        // Two Codex accounts on the same model: only the instance differs.
        fallback={{ saved: label, now: label, reason: null, onSwitchBack: () => {} }}
      >
        <span />
      </CoordinatorComposerControls>,
    ),
  );
  expect(container.querySelector(".sws-model-fallback-back")?.textContent).toBe(
    "Switch back to Codex · GPT-6.1 Sol",
  );
});
