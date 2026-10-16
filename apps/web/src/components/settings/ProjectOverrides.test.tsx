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
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: (environments: readonly { environmentId: string }[]) =>
    new Set(environments.map((environment) => environment.environmentId)),
}));
vi.mock("./useScopedSettings", () => ({ useRunScopedPlan: () => state.run }));
vi.mock("../ui/button", () => ({ Button: "button" }));
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
  }: {
    title: string;
    description: string;
    control: React.ReactNode;
  }) => (
    <div>
      <strong>{title}</strong>
      <span>{description}</span>
      {control}
    </div>
  ),
}));

import { ProjectOverrides } from "./ProjectOverrides";

const m4 = EnvironmentId.make("m4");
const project = ProjectId.make("p1");
const environment = (overrides: ServerSettings["projectSettingsOverrides"]) => ({
  environmentId: m4,
  label: "MacBook",
  connection: { phase: "connected" },
  serverConfig: {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      defaultRuntimeMode: "full-access",
      projectSettingsOverrides: overrides,
    } as ServerSettings,
  },
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.run.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ProjectOverrides", () => {
  it("shows nothing when the project follows the app settings", async () => {
    state.environments = [environment({})];
    await act(async () =>
      root.render(<ProjectOverrides checkouts={[{ environmentId: m4, id: project }]} />),
    );
    expect(container.innerHTML).toBe("");
  });

  it("lists an override and resets it to the app setting", async () => {
    state.environments = [environment({ [project]: { defaultRuntimeMode: "approval-required" } })];
    await act(async () =>
      root.render(<ProjectOverrides checkouts={[{ environmentId: m4, id: project }]} />),
    );
    expect(container.textContent).toContain("Overrides");
    expect(container.textContent).toContain("Permissions for new threads");
    expect(container.textContent).toContain("Ask for approval for this project");
    expect(container.textContent).toContain("App setting (General): Full access.");
    await act(async () => container.querySelector("button")!.click());
    expect(state.run).toHaveBeenCalledTimes(1);
    const plan = state.run.mock.calls[0]![0] as {
      serverWrites: { environmentId: string; patch: unknown }[];
    };
    expect(plan.serverWrites[0]).toMatchObject({
      environmentId: "m4",
      patch: { projectSettingsOverrides: { p1: null } },
    });
  });
});
