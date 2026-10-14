// @vitest-environment jsdom
import { act, createContext, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { ProviderInstanceId, type ProjectWorkspaceReadResult } from "@specweave-studio/contracts";
const state = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
  write: vi.fn(),
  deleteMemory: vi.fn(),
  close: vi.fn(),
  saved: vi.fn(),
  deleted: vi.fn(),
  refresh: vi.fn(),
  environmentRefresh: vi.fn(),
  prepare: vi.fn(),
  connectionSave: vi.fn(),
  connectionCheck: vi.fn(),
  connectionRevoke: vi.fn(),
  providers: [] as unknown[],
  fleet: null as Record<string, unknown> | null,
  environment: {
    revision: 7,
    workspaceRoot: "/scratch/atlas",
    additionalFolders: ["/scratch/shared"],
    repositories: [
      {
        id: "repo-one",
        url: "https://github.com/example/atlas.git",
        localPath: "/scratch/atlas/code",
        status: "missing",
      },
    ],
  },
  file: {
    name: "MEMORY.md",
    content: "Keep provider choices independent.",
    revision: 3,
    updatedAt: "2026-10-09T00:00:00Z",
    byteLength: 40,
  },
}));
vi.mock("./ProjectIconEditor", () => ({
  useProjectIconEditor: () => ({
    busy: false,
    customized: false,
    blocked: null,
    openFilePicker: () => {},
    reset: () => {},
    iconPicker: (trigger: unknown) => trigger,
    dialogs: null,
  }),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../studio/fleet", () => ({
  useStudioFleet: () => ({ snapshot: state.fleet, loading: false, failed: false, refresh() {} }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    connection: { phase: "connected" },
    serverConfig: { providers: state.providers },
  }),
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { update: "update", delete: "remove" },
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    memoryRead: () => "read",
    memoryWrite: "write",
    memoryDelete: "deleteMemory",
    environmentRead: () => "environment",
    environmentPrepare: "prepare",
    connections: () => "connections",
    nativeConnections: () => "nativeConnections",
    connectionSave: "connectionSave",
    connectionCheck: "connectionCheck",
    connectionRevoke: "connectionRevoke",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof state) => state[command],
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string) => ({
    data:
      key === "nativeConnections"
        ? null
        : key === "environment"
          ? state.environment
          : key === "connections"
            ? { connections: [] }
            : state.file,
    refresh:
      key === "environment" || key === "connections" ? state.environmentRefresh : state.refresh,
    isPending: false,
    error: null,
  }),
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (r: { error: Error }) => r.error,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: React.PropsWithChildren) => <a>{children}</a>,
}));
vi.mock("./ProjectModels", () => ({
  ProjectModels: ({ label, value }: { label: string; value: { model: string } | null }) => (
    <p>
      {label}: {value?.model ?? "Not selected"}
    </p>
  ),
}));
vi.mock("./ProjectUsage", () => ({ ProjectUsage: () => <p>Recorded usage</p> }));
vi.mock("../settings/SettingsScopeContext", () => ({
  SettingsScopeProvider: ({
    search,
    children,
  }: React.PropsWithChildren<{ search: { project?: string } }>) => (
    <div data-settings-project={search.project}>{children}</div>
  ),
}));
vi.mock("../settings/settingsLayout", () => ({
  SettingsSection: ({ title, children }: React.PropsWithChildren<{ title: string }>) => (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  ),
}));
vi.mock("../settings/ProviderLimitSettings", () => ({
  ProviderLimitSettings: () => <p>When a provider runs out</p>,
}));
vi.mock("./ProjectRoutines", () => ({ ProjectRoutines: () => <p>Project routines</p> }));
const CloseContext = createContext<() => void>(() => {});
vi.mock("../ui/dialog", () => ({
  Dialog: ({
    children,
    onOpenChange,
  }: React.PropsWithChildren<{ onOpenChange: (open: boolean) => void }>) => (
    <CloseContext value={() => onOpenChange(false)}>{children}</CloseContext>
  ),
  DialogPopup: ({ children }: React.PropsWithChildren) => {
    const close = useContext(CloseContext);
    return (
      <main>
        <button onClick={close}>Close dialog</button>
        {children}
      </main>
    );
  },
  DialogTitle: ({ children }: React.PropsWithChildren) => <h1>{children}</h1>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));
import { ProjectWorkspaceSettings, type ProjectSettingsTab } from "./ProjectWorkspaceSettings";
let root: Root, container: HTMLDivElement;
const project = {
  id: "project",
  environmentId: "host",
  title: "Atlas",
  workspaceRoot: "/scratch/atlas",
  defaultModelSelection: { instanceId: "codex", model: "codex-worker" },
} as EnvironmentProject;
const snapshot = {
  settings: {
    revision: 7,
    kind: "personal",
    environment: {
      additionalFolders: ["/scratch/shared"],
      repositories: [
        {
          id: "repo-one",
          url: "https://github.com/example/atlas.git",
          localPath: "/scratch/atlas/code",
        },
      ],
    },
    goal: "Build Atlas",
    instructions: "Use native tools",
    coordinatorThreadId: null,
    coordinatorModelSelection: {
      instanceId: ProviderInstanceId.make("claude"),
      model: "claude-coordinator",
    },
    paused: false,
    archived: false,
    autoResume: true,
  },
  memory: {
    files: [{ name: "MEMORY.md", revision: 3, updatedAt: "2026-10-09T00:00:00Z", byteLength: 40 }],
    totalBytes: 40,
  },
} as ProjectWorkspaceReadResult;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  for (const value of Object.values(state)) if (typeof value === "function") value.mockReset();
  state.update.mockResolvedValue({ _tag: "Success", value: {} });
  state.fleet = null;
  delete (project as { workspaceSettings?: unknown }).workspaceSettings;
  state.prepare.mockResolvedValue({
    _tag: "Success",
    value: { ...state.environment, revision: 8 },
  });
  state.remove.mockResolvedValue({ _tag: "Success", value: {} });
  state.write.mockResolvedValue({ _tag: "Success", value: { ...state.file, revision: 4 } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(
  tab: ProjectSettingsTab = "general",
  canOperate = true,
  settingsOverride: Partial<ProjectWorkspaceReadResult["settings"]> = {},
  coordinatorThreadModel: ProjectWorkspaceReadResult["settings"]["coordinatorModelSelection"] = null,
) {
  await act(async () =>
    root.render(
      <ProjectWorkspaceSettings
        project={project}
        coordinatorThreadModel={coordinatorThreadModel}
        projectKey="atlas"
        snapshot={{ ...snapshot, settings: { ...snapshot.settings, ...settingsOverride } }}
        initialTab={tab}
        onClose={state.close}
        onSaved={state.saved}
        onDeleted={state.deleted}
        onOpenThread={() => {}}
        canOperate={canOperate}
      />,
    ),
  );
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function input(selector: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  expect(field).not.toBeNull();
  await act(async () => {
    const prototype =
      field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function setLabel(label: string, value: string) {
  const el = [...container.querySelectorAll("label")]
    .find((node) => node.textContent?.startsWith(label))!
    .querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
describe("project settings and memory", () => {
  it("names the model the coordinator thread runs on, as the project view does", async () => {
    const threadModel = { instanceId: ProviderInstanceId.make("claude"), model: "thread-model" };
    await render("general", true, { coordinatorModelSelection: null }, threadModel);
    expect(container.textContent).toContain("Coordinator model and effort: thread-model");
    expect(container.textContent).toContain("No override saved");
  });
  it("edits this project's usage limit rule from the General tab", async () => {
    await render("general");
    const scoped = container.querySelector("[data-settings-project]");
    expect(scoped?.getAttribute("data-settings-project")).toBe("atlas");
    expect(scoped?.textContent).toContain("Usage limits");
    expect(scoped?.textContent).toContain("When a provider runs out");
  });
  it("falls back to the worker default, then the host default, with no coordinator thread", async () => {
    await render("general", true, { coordinatorModelSelection: null });
    expect(container.textContent).toContain("Coordinator model and effort: codex-worker");
  });
  it("saves the displayed revision and preserves edits after a conflict", async () => {
    state.update.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Revision changed") });
    await render();
    await input("input", "Atlas revised");
    await click("Save changes");
    expect(state.update.mock.calls[0]![0]).toMatchObject({
      environmentId: "host",
      input: {
        projectId: "project",
        title: "Atlas revised",
        workspaceSettings: { expectedRevision: 7 },
        defaultModelSelection: { instanceId: "codex", model: "codex-worker" },
      },
    });
    expect(container.textContent).toContain("Revision changed");
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Atlas revised");
    expect(state.saved).not.toHaveBeenCalled();
  });
  it("sends this project's workers to a machine that allows them, and back here", async () => {
    const workers = {
      status: "allowed",
      access: "auto",
      expiresAt: null,
      renewable: true,
      problem: null,
    };
    state.fleet = {
      configured: true,
      connectPermission: "access:write",
      observedAt: "2026-10-12T00:00:00Z",
      listener: "loopback",
      machines: [
        {
          id: "m1",
          label: "M1",
          environmentId: "env-m1",
          url: "https://m1.fixture.ts.net",
          status: "reachable",
          pairingConfigured: true,
          workers,
        },
        {
          id: "m3",
          label: "M3",
          environmentId: "env-m3",
          url: "https://m3.fixture.ts.net",
          status: "reachable",
          pairingConfigured: true,
          workers: { ...workers, status: "not_allowed", access: null },
        },
      ],
    };
    await render();
    const select = [...container.querySelectorAll("label")]
      .find((node) => node.textContent?.startsWith("Worker machine"))!
      .querySelector("select")!;
    expect([...select.options].map((o) => [o.value, o.disabled])).toEqual([
      ["local", false],
      ["m1", false],
      ["m3", true],
    ]);
    await act(async () => {
      select.value = "m1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Save changes");
    expect(state.update.mock.calls[0]![0].input.workspaceSettings.workerMachine).toEqual({
      machineId: "m1",
      environmentId: "env-m1",
      projectId: null,
    });
    await act(async () => {
      select.value = "local";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Save changes");
    expect(state.update.mock.calls[1]![0].input.workspaceSettings.workerMachine).toBeNull();
  });
  it("shows no worker machine choice without other machines", async () => {
    await render();
    expect(container.textContent).not.toContain("Worker machine");
  });
  it("requires an exact typed title before destructive project deletion", async () => {
    await render();
    const button = () =>
      [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Delete project and threads",
      )!;
    expect(button().disabled).toBe(true);
    await input('[aria-label="Confirm project deletion"]', "atlas");
    expect(button().disabled).toBe(true);
    await input('[aria-label="Confirm project deletion"]', "Atlas");
    await click("Delete project and threads");
    expect(state.remove).toHaveBeenCalledWith({
      environmentId: "host",
      input: { projectId: "project", force: true, confirmationTitle: "Atlas" },
    });
    expect(state.deleted).toHaveBeenCalledOnce();
  });
  it("keeps an edited memory file across tab switches and guards closing", async () => {
    await render("memory");
    await click("MEMORY.md40 bytes · revision 3");
    await input('textarea[aria-label="Content of MEMORY.md"]', "Unsaved decision");
    await click("General");
    await click("Memory");
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Content of MEMORY.md"]')!
        .value,
    ).toBe("Unsaved decision");
    await click("Close dialog");
    expect(state.close).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Project settings or memory have unsaved changes");
  });
  it("retains memory content on concurrent revision rejection and sends CAS", async () => {
    state.write.mockResolvedValueOnce({
      _tag: "Failure",
      error: new Error("Memory revision conflict"),
    });
    await render("memory");
    await click("MEMORY.md40 bytes · revision 3");
    await input('textarea[aria-label="Content of MEMORY.md"]', "New decision");
    await click("Save memory");
    expect(state.write).toHaveBeenCalledWith({
      environmentId: "host",
      input: {
        projectId: "project",
        name: "MEMORY.md",
        content: "New decision",
        expectedRevision: 3,
      },
    });
    expect(container.textContent).toContain("Memory revision conflict");
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Content of MEMORY.md"]')!
        .value,
    ).toBe("New decision");
    await click("Reload file and discard edit");
    expect(state.refresh).toHaveBeenCalledOnce();
  });
  it("keeps folders and repositories together in a revisioned draft", async () => {
    await render("environment");
    expect(container.textContent).toContain("Managed project storage");
    expect(container.textContent).toContain("/scratch/shared");
    expect(container.textContent).toContain("https://github.com/example/atlas.git");
    await input('input[placeholder="Absolute path on this machine"]', "/scratch/research");
    await click("Add folder");
    await input(
      'input[placeholder="https://github.com/organization/repository.git"]',
      "git@github.com:example/research.git",
    );
    await click("Add URL");
    expect(state.prepare).not.toHaveBeenCalled();
    await click("Save changes");
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          workspaceSettings: expect.objectContaining({
            expectedRevision: 7,
            environment: {
              additionalFolders: ["/scratch/shared", "/scratch/research"],
              repositories: [
                expect.objectContaining({ id: "repo-one" }),
                expect.objectContaining({
                  url: "git@github.com:example/research.git",
                  localPath: null,
                }),
              ],
            },
          }),
        }),
      }),
    );
  });
  it("preserves environment edits on conflict and keeps unsaved preparation disabled", async () => {
    state.update.mockResolvedValueOnce({
      _tag: "Failure",
      error: new Error("Environment revision conflict"),
    });
    await render("environment");
    await input(
      'input[aria-label="Checkout path for https://github.com/example/atlas.git"]',
      "/scratch/shared/existing",
    );
    await click("Match existing checkout");
    expect(state.prepare).not.toHaveBeenCalled();
    await click("Save changes");
    expect(container.textContent).toContain("Environment revision conflict");
    await click("General");
    await click("Environment");
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Checkout path for https://github.com/example/atlas.git"]',
      )!.value,
    ).toBe("/scratch/shared/existing");
  });
  it("guards an unadded environment draft on close", async () => {
    await render("environment");
    await input('input[placeholder="Absolute path on this machine"]', "/scratch/unsaved");
    await click("General");
    await click("Close dialog");
    expect(state.close).not.toHaveBeenCalled();
  });
  it("matches an existing checkout only on explicit request with scoped revision and retry id", async () => {
    state.prepare.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Host unavailable") });
    await render("environment");
    await click("Match existing checkout");
    expect(state.prepare.mock.calls[0]![0]).toMatchObject({
      environmentId: "host",
      input: { projectId: "project", repositoryId: "repo-one", expectedRevision: 7, mode: "match" },
    });
    expect(container.textContent).toContain("Host unavailable");
    await click("Match existing checkout");
    expect(state.prepare.mock.calls[1]![0].input.commandId).toBe(
      state.prepare.mock.calls[0]![0].input.commandId,
    );
    expect(state.saved).toHaveBeenCalledOnce();
  });
  it("prepares explicitly and blocks duplicate clicks while a request is pending", async () => {
    let finish!: (result: unknown) => void;
    state.prepare.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render("environment");
    await click("Prepare checkout");
    await click("Prepare checkout");
    expect(state.prepare).toHaveBeenCalledOnce();
    expect(state.prepare.mock.calls[0]![0].input.mode).toBe("clone");
    await act(async () =>
      finish({ _tag: "Success", value: { ...state.environment, revision: 8 } }),
    );
  });
  it("does not mutate or prepare through a read-only connection", async () => {
    await render("environment", false);
    await click("Prepare checkout");
    await click("Match existing checkout");
    expect(state.prepare).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLInputElement>(
        'input[placeholder="Absolute path on this machine"]',
      )!.disabled,
    ).toBe(true);
  });
  it("saves host command configuration without launching it, then explicitly discovers and grants tools", async () => {
    const configured = {
      id: "connection",
      revision: 1,
      name: "Mail tools",
      command: "mail-mcp",
      args: ["--stdio"],
      envKeys: ["MAIL_PROFILE"],
      status: "configured",
      checkedAt: null,
      tools: [],
      allowedTools: [],
    };
    state.connectionSave.mockResolvedValue({ _tag: "Success", value: configured });
    state.connectionCheck.mockResolvedValue({
      _tag: "Success",
      value: {
        ...configured,
        revision: 2,
        status: "ready",
        checkedAt: "2026-10-09T00:00:00Z",
        tools: [{ name: "search_mail", description: "Search the host account", inputSchema: {} }],
      },
    });
    await render("environment");
    const byLabel = (label: string) =>
      [...container.querySelectorAll("label")]
        .find((node) => node.textContent?.startsWith(label))!
        .querySelector("input,textarea")!;
    const set = async (label: string, value: string) => {
      const el = byLabel(label) as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          "value",
        )!.set!.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await set("Connection name", "Mail tools");
    await set("Executable command", "mail-mcp");
    await set("Arguments", "--stdio");
    await set("Host environment variable names", "MAIL_PROFILE");
    expect(state.connectionCheck).not.toHaveBeenCalled();
    await click("Save connection");
    expect(state.connectionSave.mock.calls[0]![0]).toMatchObject({
      environmentId: "host",
      input: {
        projectId: "project",
        expectedRevision: null,
        config: {
          name: "Mail tools",
          command: "mail-mcp",
          args: ["--stdio"],
          envKeys: ["MAIL_PROFILE"],
        },
        allowedTools: [],
      },
    });
    expect(state.connectionCheck).not.toHaveBeenCalled();
    await click("Check and discover tools");
    expect(state.connectionCheck).toHaveBeenCalledWith({
      environmentId: "host",
      input: { projectId: "project", id: "connection", expectedRevision: 1 },
    });
    const tool = [...container.querySelectorAll<HTMLLabelElement>("label")]
      .find((el) => el.textContent?.includes("search_mail"))!
      .querySelector<HTMLInputElement>("input")!;
    await act(async () => tool.click());
    await click("Save connection");
    expect(state.connectionSave.mock.calls[1]![0].input).toMatchObject({
      expectedRevision: 2,
      allowedTools: ["search_mail"],
    });
  });
  it("rejects environment variable values and preserves a connection draft on close", async () => {
    await render("environment");
    const field = [...container.querySelectorAll("label")]
      .find((el) => el.textContent?.startsWith("Host environment variable names"))!
      .querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "TOKEN=value",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Enter environment variable names only");
    await click("Save connection");
    await click("Close dialog");
    expect(state.connectionSave).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
  });
  it("does not add a credential-bearing repository URL", async () => {
    await render("environment");
    await input(
      'input[placeholder="https://github.com/organization/repository.git"]',
      "https://secret@example.com/team/repo.git",
    );
    await click("Add URL");
    expect(container.textContent).toContain("Use a credential-free HTTPS or SSH repository URL");
    expect(container.textContent).not.toContain("https://secret@example.com");
    expect(state.update).not.toHaveBeenCalled();
  });
  it("requires destination inspection before assigning a new preparation id after an unknown outcome", async () => {
    state.prepare.mockResolvedValueOnce({
      _tag: "Failure",
      error: Object.assign(new Error("Outcome unknown"), { code: "outcome_unknown" }),
    });
    await render("environment");
    await click("Prepare checkout");
    const first = state.prepare.mock.calls[0]![0].input.commandId;
    expect(container.textContent).toContain("The previous preparation may have changed files");
    await click("I inspected the destination; allow a new request");
    expect(state.prepare).toHaveBeenCalledOnce();
    await click("Prepare checkout");
    expect(state.prepare.mock.calls[1]![0].input.commandId).not.toBe(first);
  });
  it("restores a revoked connection with no tool grants and requires a fresh explicit check", async () => {
    const configured = {
      id: "tools",
      revision: 1,
      name: "Documents",
      command: "document-mcp",
      args: [],
      envKeys: [],
      status: "configured",
      checkedAt: null,
      tools: [],
      allowedTools: [],
    };
    state.connectionSave.mockResolvedValue({ _tag: "Success", value: configured });
    state.connectionRevoke.mockResolvedValue({
      _tag: "Success",
      value: { ...configured, revision: 2, status: "revoked" },
    });
    await render("environment");
    await setLabel("Connection name", "Documents");
    await setLabel("Executable command", "document-mcp");
    await click("Save connection");
    await click("Revoke connection");
    await click("Check and discover tools");
    expect(state.connectionCheck).not.toHaveBeenCalled();
    await click("Restore configuration");
    expect(state.connectionSave.mock.calls[1]![0].input).toMatchObject({
      id: "tools",
      expectedRevision: 2,
      allowedTools: [],
    });
    expect(state.connectionCheck).not.toHaveBeenCalled();
  });
  it("preserves a connection draft across tabs and blocks deletion while it is unsaved", async () => {
    await render("environment");
    await setLabel("Connection name", "Draft documents");
    await click("General");
    await input('input[aria-label="Confirm project deletion"]', "Atlas");
    await click("Delete project and threads");
    expect(state.remove).not.toHaveBeenCalled();
    await click("Environment");
    expect(
      [...container.querySelectorAll("label")]
        .find((el) => el.textContent?.startsWith("Connection name"))!
        .querySelector("input")!.value,
    ).toBe("Draft documents");
  });
  it.each(["paused", "archived"] as const)(
    "blocks repository and connection execution for %s projects while preserving save and revoke",
    async (flag) => {
      const configured = {
        id: "tools",
        revision: 1,
        name: "Documents",
        command: "document-mcp",
        args: [],
        envKeys: [],
        status: "configured",
        checkedAt: null,
        tools: [],
        allowedTools: [],
      };
      state.connectionSave.mockResolvedValue({ _tag: "Success", value: configured });
      state.connectionRevoke.mockResolvedValue({
        _tag: "Success",
        value: { ...configured, revision: 2, status: "revoked" },
      });
      await render("environment", true, { [flag]: true });
      await click("Prepare checkout");
      await click("Match existing checkout");
      expect(state.prepare).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Resume or restore this project before preparing");
      await setLabel("Connection name", "Documents");
      await setLabel("Executable command", "document-mcp");
      await click("Save connection");
      expect(state.connectionSave).toHaveBeenCalledOnce();
      await click("Check and discover tools");
      expect(state.connectionCheck).not.toHaveBeenCalled();
      await click("Revoke connection");
      expect(state.connectionRevoke).toHaveBeenCalledOnce();
    },
  );
  it.each(["environment", "connection"] as const)(
    "prevents checkout settings navigation with an unsaved %s draft",
    async (kind) => {
      await render("environment");
      const manage = () =>
        [...container.querySelectorAll("a,button")].find(
          (el) => el.textContent === "Manage project icon, checkouts and worktree defaults",
        )!;
      expect(manage().tagName).toBe("A");
      if (kind === "environment")
        await input('input[placeholder="Absolute path on this machine"]', "/scratch/not-yet-added");
      else await setLabel("Connection name", "Unsaved tools");
      expect(manage().tagName).toBe("BUTTON");
      expect((manage() as HTMLButtonElement).disabled).toBe(true);
      expect(container.textContent).toContain(
        "Save or discard your drafts and finish pending operations",
      );
      await click("General");
      await click("Environment");
      expect(manage().tagName).toBe("BUTTON");
      expect(state.close).not.toHaveBeenCalled();
    },
  );
  it("prevents checkout settings navigation while repository preparation is in flight", async () => {
    let finish!: (result: unknown) => void;
    state.prepare.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render("environment");
    await click("Prepare checkout");
    const manage = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (el) => el.textContent === "Manage project icon, checkouts and worktree defaults",
    )!;
    expect(manage.disabled).toBe(true);
    expect(
      [...container.querySelectorAll("a")].some((el) =>
        el.textContent?.includes("Manage project icon"),
      ),
    ).toBe(false);
    await act(async () =>
      finish({ _tag: "Success", value: { ...state.environment, revision: 8 } }),
    );
    expect(
      [...container.querySelectorAll("a")].some((el) =>
        el.textContent?.includes("Manage project icon"),
      ),
    ).toBe(true);
  });
});

it("keeps the full folder path in a disclosure separate from project identity", async () => {
  await render("environment", true, { kind: "code" });
  const heading = container.querySelector(".project-settings-heading")!;
  expect(heading.querySelector("p")?.textContent).toBe(project.title);
  const location = heading.querySelector("details")!;
  expect(location.hasAttribute("open")).toBe(false);
  expect(location.querySelector("summary")?.getAttribute("aria-label")).toBe(
    `Folder location: ${project.workspaceRoot}`,
  );
  expect(location.querySelector("code")?.textContent).toBe(project.workspaceRoot);
  expect(location.querySelector("code")?.tabIndex).toBe(0);
});

it("keeps folder removal reversible and saves only the remaining environment draft", async () => {
  await render("environment", true, { kind: "code" });
  const removeEntries = async () => {
    for (const label of [
      "Remove folder /scratch/shared",
      "Remove repository https://github.com/example/atlas.git",
    ]) {
      await act(async () =>
        container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(),
      );
    }
  };
  await removeEntries();
  expect(container.textContent).toContain("No additional folders approved.");
  expect(state.update).not.toHaveBeenCalled();
  await click("Discard");
  expect(container.querySelector('[aria-label="Remove folder /scratch/shared"]')).not.toBeNull();
  expect(
    container.querySelector(
      '[aria-label="Remove repository https://github.com/example/atlas.git"]',
    ),
  ).not.toBeNull();
  await removeEntries();
  await click("Save changes");
  expect(state.update).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        workspaceSettings: expect.objectContaining({
          expectedRevision: 7,
          environment: { additionalFolders: [], repositories: [] },
        }),
      }),
    }),
  );
});

it("preserves an edited instruction and recovery choice when closing is canceled", async () => {
  await render();
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await click("Memory");
  await input('textarea[aria-label="Project instructions"]', "Keep the exact project folder.");
  await click("Close dialog");
  await click("Keep editing");
  expect(state.close).not.toHaveBeenCalled();
  expect(
    container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project instructions"]')!
      .value,
  ).toBe("Keep the exact project folder.");
  await click("Save changes");
  expect(state.update).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        workspaceSettings: expect.objectContaining({
          instructions: "Keep the exact project folder.",
          autoResume: false,
        }),
      }),
    }),
  );
});

it.each([
  ["Pause", "paused"],
  ["Archive", "archived"],
] as const)("keeps %s scoped to this project and saved revision", async (label, key) => {
  await render();
  await click(label);
  expect(state.update).toHaveBeenCalledWith({
    environmentId: "host",
    input: { projectId: "project", workspaceSettings: { expectedRevision: 7, [key]: true } },
  });
  expect(state.saved).toHaveBeenCalledOnce();
  expect(state.remove).not.toHaveBeenCalled();
});

describe("canonical project name in workspace settings", () => {
  function bindName(state: "active" | "transferred") {
    Object.assign(project, {
      workspaceSettings: {
        logicalProject: { id: "easychamp", title: "EasyChamp", coordinatorId: "one", members: [] },
        coordinatorBinding: { epoch: 1, state },
      },
    });
  }
  it("displays and discards to the canonical name while deletion still requires the physical project name", async () => {
    bindName("active");
    await render();
    expect(container.querySelector<HTMLInputElement>("#project-settings-name")?.value).toBe(
      "EasyChamp",
    );
    expect(container.querySelector(".project-settings-heading p")?.textContent).toBe("EasyChamp");
    expect(container.textContent).toContain("Type Atlas to confirm");
    await input("#project-settings-name", "Changed draft");
    await click("Discard");
    expect(container.querySelector<HTMLInputElement>("#project-settings-name")?.value).toBe(
      "EasyChamp",
    );
    await input('[aria-label="Confirm project deletion"]', "EasyChamp");
    const deletion = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Delete project and threads",
    )!;
    expect(deletion.disabled).toBe(true);
    await input('[aria-label="Confirm project deletion"]', "Atlas");
    await click("Delete project and threads");
    expect(state.remove).toHaveBeenCalledWith({
      environmentId: "host",
      input: { projectId: "project", force: true, confirmationTitle: "Atlas" },
    });
  });
  it("rejects a predecessor name edit and keeps its draft without reporting success", async () => {
    bindName("transferred");
    await render();
    await input("#project-settings-name", "New EasyChamp");
    await click("Save changes");
    expect(container.textContent).toContain("Open the active coordinator to rename this project");
    expect(state.update).not.toHaveBeenCalled();
    expect(state.saved).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>("#project-settings-name")?.value).toBe(
      "New EasyChamp",
    );
  });
  it("does not rename a physical predecessor implicitly when saving its other settings", async () => {
    bindName("transferred");
    await render();
    await setLabel("Goal", "Preserved source goal");
    await click("Save changes");
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0].input).not.toHaveProperty("title");
    expect(state.update.mock.calls[0]?.[0].input.workspaceSettings.goal).toBe(
      "Preserved source goal",
    );
  });
});
