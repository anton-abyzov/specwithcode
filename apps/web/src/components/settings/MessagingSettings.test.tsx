// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  projects: [] as any[],
  status: null as any,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => runtime.projects,
  useServerConfigs: () =>
    new Map([
      [
        "m4",
        {
          scratchWorkspaceRoot: "/home/x/.specwithcode/m4/scratch",
          environment: { capabilities: { telegramChannel: true } },
        },
      ],
    ]),
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "m4" }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: runtime.status, error: null, refresh: vi.fn() }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { telegramChannelStatus: vi.fn() } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: any) => <div>{children}</div>,
  SettingsSection: ({ children }: any) => <section>{children}</section>,
}));
vi.mock("../ui/select", () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div data-trigger="">{children}</div>,
  SelectValue: ({ children }: any) => (
    <span>{typeof children === "function" ? children() : children}</span>
  ),
  SelectPopup: ({ children }: any) => <div role="listbox">{children}</div>,
  SelectItem: ({ children, disabled }: any) => (
    <div role="option" aria-disabled={disabled ? "true" : undefined}>
      {children}
    </div>
  ),
}));

import { MessagingSettingsPanel } from "./MessagingSettings";

let root: Root, container: HTMLDivElement;
const project = (id: string, title: string, workspaceRoot: string, settings: object = {}) => ({
  environmentId: "m4",
  id,
  title,
  workspaceRoot,
  workspaceSettings: settings,
});
const options = () =>
  [...container.querySelectorAll('[role="option"]')].map((node) => [
    node.textContent,
    node.getAttribute("aria-disabled") === "true",
  ]);
const saveButton = () =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === "Save")!;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  runtime.projects = [
    project("errands", "Errands", "/home/x/.specwithcode/m4/projects/aide", { kind: "personal" }),
    project("app", "App", "/work/app"),
    project("old", "Old", "/work/old", { archived: true }),
    project("check", "Acceptance run", "/home/x/.specwithcode/m4/scratch/run-1/workspace"),
    project("scratch", "No project", "/home/x/.specwithcode/m4/scratch"),
  ];
  runtime.status = { configured: true, enabled: true, paired: false, projectId: "app" };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("offers only the person's own projects for the Telegram channel", async () => {
  await act(async () => root.render(<MessagingSettingsPanel />));
  expect(options()).toEqual([
    ["Errands (personal)", false],
    ["App", false],
  ]);
  expect(saveButton().disabled).toBe(false);
});

it.each([
  ["old", "Old", "Archived project, not available here"],
  ["check", "Acceptance run", "Automated project, not available here"],
])("shows a channel's %s project apart and refuses to save it", async (projectId, title, label) => {
  runtime.status = { ...runtime.status, projectId };
  await act(async () => root.render(<MessagingSettingsPanel />));
  expect(options()).toEqual([
    [`${title}${label}`, true],
    ["Errands (personal)", false],
    ["App", false],
  ]);
  expect(container.textContent).toContain(
    `${label}. Choose another project to save, or turn the channel off.`,
  );
  expect(saveButton().disabled).toBe(true);
});

it("still saves a channel bound to an archived project when it is turned off", async () => {
  runtime.status = { ...runtime.status, projectId: "old", enabled: false };
  await act(async () => root.render(<MessagingSettingsPanel />));
  expect(saveButton().disabled).toBe(false);
});
