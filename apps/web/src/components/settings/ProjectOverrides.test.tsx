// @vitest-environment jsdom
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  run: vi.fn(),
  environments: [] as unknown[],
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNickname: (_id: string, label?: string | null) => label ?? "",
  useMachineNicknames: () => (id: string, label?: string | null) => label ?? id,
  machineNickname: (id: string, label?: string | null) => label ?? id,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: (environments: readonly { environmentId: string }[]) =>
    new Set(environments.map((environment) => environment.environmentId)),
}));
vi.mock("./useScopedSettings", () => ({ useRunScopedPlan: () => state.run }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn(() => "t"), close: vi.fn() } }));
vi.mock("../ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void }>) => (
    <select data-testid="edit" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SelectItem: ({ value, children }: React.PropsWithChildren<{ value: string }>) => (
    <option value={value}>{children}</option>
  ),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: React.PropsWithChildren<{ title: string }>) => (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
    children,
  }: React.PropsWithChildren<{
    title: string;
    description: string;
    control: React.ReactNode;
  }>) => (
    <div>
      <strong>{title}</strong>
      <span>{description}</span>
      {control}
      {children}
    </div>
  ),
}));

import { ProjectOverrides } from "./ProjectOverrides";

const m4 = EnvironmentId.make("m4");
const storm = EnvironmentId.make("storm");
const project = ProjectId.make("p1");
const environment = (
  overrides: ServerSettings["projectSettingsOverrides"],
  environmentId = m4,
  label = "MacBook",
) => ({
  environmentId,
  label,
  connection: { phase: "connected" },
  serverConfig: {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      defaultRuntimeMode: "full-access",
      projectSettingsOverrides: overrides,
    } as ServerSettings,
  },
});

type Plan = { serverWrites: { environmentId: string; patch: unknown }[] };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.run.mockReset();
  state.run.mockImplementation(async (plan: Plan) => ({
    savedEnvironmentIds: new Set(plan.serverWrites.map((write) => write.environmentId)),
    failedLabels: [],
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;

describe("ProjectOverrides", () => {
  it("shows nothing when the project follows the app settings", async () => {
    state.environments = [environment({})];
    await act(async () =>
      root.render(<ProjectOverrides checkouts={[{ environmentId: m4, id: project }]} />),
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows the project value beside the app value in words", async () => {
    state.environments = [environment({ [project]: { defaultRuntimeMode: "approval-required" } })];
    await act(async () =>
      root.render(<ProjectOverrides checkouts={[{ environmentId: m4, id: project }]} />),
    );
    expect(container.textContent).toContain("Overrides");
    expect(container.textContent).toContain("Permissions for new threads");
    expect(container.textContent).toContain("Ask for approval");
    expect(container.textContent).toContain("App: Full access");
    expect(container.textContent).not.toMatch(/approval-required|full-access/);
  });

  it("groups machines with the same value on one line", async () => {
    const overrides = { [project]: { defaultRuntimeMode: "approval-required" as const } };
    state.environments = [
      environment(overrides, m4, "M4MAX"),
      environment(overrides, storm, "Ministorm"),
    ];
    await act(async () =>
      root.render(
        <ProjectOverrides
          checkouts={[
            { environmentId: m4, id: project },
            { environmentId: storm, id: project },
          ]}
        />,
      ),
    );
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(container.querySelector("li")!.textContent).toContain("M4MAX");
    expect(container.querySelector("li")!.textContent).toContain("Ministorm");
  });

  it("uses the app setting, confirms it, keeps the row and undoes it", async () => {
    state.environments = [environment({ [project]: { defaultRuntimeMode: "approval-required" } })];
    await act(async () =>
      root.render(<ProjectOverrides checkouts={[{ environmentId: m4, id: project }]} />),
    );
    await act(async () => button("Use app setting").click());
    expect(state.run).toHaveBeenCalledTimes(1);
    const [plan, feedback] = state.run.mock.calls[0]! as [
      Plan,
      { title: string; description: string; undo: Plan },
    ];
    expect(plan.serverWrites[0]).toMatchObject({
      environmentId: "m4",
      patch: { projectSettingsOverrides: { p1: null } },
    });
    expect(feedback.title).toBe(
      "Permissions for new threads follows the app setting (Full access) on MacBook",
    );
    expect(feedback.description).toBe("Was: Ask for approval.");
    expect(feedback.undo.serverWrites[0]!.environmentId).toBe("m4");

    // The server now reports no override; the row stays with its result and Undo.
    state.environments = [environment({})];
    await act(async () =>
      root.render(<ProjectOverrides checkouts={[{ environmentId: m4, id: project }]} />),
    );
    expect(container.textContent).toContain("Permissions for new threads");
    expect(container.querySelector("[role=status]")!.textContent).toContain(
      "Was: Ask for approval.",
    );
    await act(async () => button("Undo").click());
    expect(state.run).toHaveBeenCalledTimes(2);
    expect(state.run.mock.calls[1]![1]).toEqual({ title: "Change undone" });
  });

  it("edits an enum value in place on every machine of the line", async () => {
    state.environments = [environment({ [project]: { defaultRuntimeMode: "approval-required" } })];
    await act(async () =>
      root.render(<ProjectOverrides checkouts={[{ environmentId: m4, id: project }]} />),
    );
    const select = container.querySelector<HTMLSelectElement>("[data-testid=edit]")!;
    await act(async () => {
      select.value = "auto-accept-edits";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const [, feedback] = state.run.mock.calls[0]! as [Plan, { title: string }];
    expect(feedback.title).toBe("Permissions for new threads changed to Accept edits on MacBook");
  });
  it("disables a line with an offline machine and says why", async () => {
    state.environments = [
      environment({ [project]: { defaultRuntimeMode: "approval-required" } }),
      {
        ...environment(
          { [project]: { defaultRuntimeMode: "approval-required" } },
          storm,
          "Ministorm",
        ),
        connection: { phase: "disconnected" },
      },
    ];
    await act(async () =>
      root.render(
        <ProjectOverrides
          checkouts={[
            { environmentId: m4, id: project },
            { environmentId: storm, id: project },
          ]}
        />,
      ),
    );
    const clear = button("Use app setting");
    expect(clear.disabled).toBe(true);
    expect(clear.parentElement?.title).toBe(
      "Ministorm is offline. Connect to change this setting there.",
    );
  });

  it("names a stored null merge method and offers it back", async () => {
    state.environments = [environment({ [project]: { pullRequestMergeMethod: null } })];
    await act(async () =>
      root.render(<ProjectOverrides checkouts={[{ environmentId: m4, id: project }]} />),
    );
    expect(container.textContent).toContain("Last selected");
    expect(container.textContent).not.toMatch(/\bnull\b/);
    const select = container.querySelector<HTMLSelectElement>('[data-testid="edit"]')!;
    await act(async () => {
      select.value = "squash";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const plan = state.run.mock.calls.at(-1)![0] as Plan;
    expect(JSON.stringify(plan.serverWrites[0]!.patch)).toContain("squash");
  });
});
