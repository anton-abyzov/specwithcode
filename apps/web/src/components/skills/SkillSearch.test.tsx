// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
  scopes: new Set<string>(),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: { fn: unknown }) => atom.fn,
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: { skillsSearch: { fn: mocks.search }, skillsUpdate: { fn: mocks.update } },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: { fn: mocks.refresh } },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_environmentId: unknown, scope: string) => mocks.scopes.has(scope),
}));
vi.mock("../../studio/machineNickname", () => ({ useMachineNickname: () => "M4" }));
import { SkillSearch } from "./SkillSearch";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const COMMIT = "2".repeat(40);

const found = {
  query: "report",
  installed: [
    {
      name: "html-report",
      description: "Write polished reports",
      version: "1.1.0",
      agents: ["Codex", "Claude"],
    },
  ],
  available: [
    {
      repo: "anton-abyzov/vskill",
      visibility: "public",
      skill: {
        name: "report-builder",
        path: "skills/report-builder/SKILL.md",
        plugin: null,
        version: "0.4.0",
        description: "Build a weekly report",
        commit: COMMIT,
        contentHash: "b".repeat(64),
      },
    },
  ],
  notes: [
    {
      title: "Report skills",
      path: "Resources/Report skills.md",
      vault: "personal-docs",
      snippet: "How the html-report skill is used.",
    },
  ],
  notesState: "ok",
};
const success = (value: unknown) => ({ _tag: "Success", value });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.scopes.clear();
  for (const scope of ["filesystem:read", "filesystem:write", "terminal:operate"])
    mocks.scopes.add(scope);
  mocks.search.mockResolvedValue(success(found));
  mocks.refresh.mockResolvedValue(success({}));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
});

const render = () =>
  act(async () =>
    root.render(
      <SkillSearch environmentId={environmentId} projectId={projectId} cwd="/work/app" />,
    ),
  );
const type = async (text: string) => {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
};
const button = (text: string) => {
  const node = [...host.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes(text),
  );
  if (!node) throw new Error(`Missing button ${text}`);
  return node;
};
const group = (name: string) => host.querySelector<HTMLElement>(`[data-group="${name}"]`)!;

describe("skill search", () => {
  it("shows installed skills, skills in connected repos and notes as three groups", async () => {
    await render();
    await type("report");
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search.mock.calls[0]?.[0]).toEqual({
      environmentId,
      input: { projectId, cwd: "/work/app", operation: "search", query: "report" },
    });
    expect(group("installed").textContent).toContain("Installed on M4");
    expect(group("installed").textContent).toContain("html-report");
    expect(group("installed").textContent).toContain("1.1.0");
    expect(group("available").textContent).toContain("Available in a connected repo");
    expect(group("available").textContent).toContain("report-builder");
    expect(group("available").textContent).toContain("0.4.0 · 2222222");
    expect(group("available").textContent).toContain("anton-abyzov/vskill");
    expect(group("notes").textContent).toContain("Report skills");
    expect(group("notes").textContent).toContain("How the html-report skill is used.");
    // Searching installs nothing.
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("asks nothing for fewer than two characters", async () => {
    await render();
    await type("r");
    expect(mocks.search).not.toHaveBeenCalled();
    expect(host.querySelector("[data-group]")).toBeNull();
  });

  it("installs only when Install is pressed, then shows what the lock records", async () => {
    mocks.update.mockResolvedValue(
      success({
        checkedAt: "2026-11-18T00:00:00.000Z",
        statuses: [],
        outcomes: [
          {
            skill: "report-builder",
            outcome: "installed",
            before: null,
            after: { version: "0.4.0", commit: COMMIT, contentHash: "b".repeat(64) },
            readiness: [
              {
                instanceId: "codex",
                driver: "codex",
                label: "Codex",
                readiness: "loaded-now",
                detail: "Codex lists it.",
              },
              {
                instanceId: "claudeAgent",
                driver: "claudeAgent",
                label: "Claude",
                readiness: "next-session",
                detail: "Claude reads skills when a session starts.",
              },
            ],
          },
        ],
      }),
    );
    await render();
    await type("report");
    await act(async () => button("Install").click());
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0]?.[0]).toEqual({
      environmentId,
      input: {
        projectId,
        cwd: "/work/app",
        operation: "install",
        install: { repo: "anton-abyzov/vskill", skill: "report-builder" },
      },
    });
    expect(host.textContent).toContain("Installed report-builder 0.4.0 · 2222222");
    expect(host.textContent).toContain("Codex: Loaded now");
    expect(host.textContent).toContain("Claude: Next session");
    // The composer of this folder offers the skill without a restart.
    expect(mocks.refresh.mock.calls.map((call) => call[0])).toEqual([
      { environmentId, input: { instanceId: "codex", cwd: "/work/app", fresh: true } },
      { environmentId, input: { instanceId: "claudeAgent", cwd: "/work/app", fresh: true } },
    ]);
  });

  it("says why an install failed and keeps the result", async () => {
    mocks.update.mockResolvedValue({
      _tag: "Failure",
      cause: { message: "vskill is not installed on this machine." },
    });
    await render();
    await type("report");
    await act(async () => button("Install").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(group("available").textContent).toContain("report-builder");
  });

  it("offers no install without permission to change files and run vskill", async () => {
    mocks.scopes.delete("terminal:operate");
    await render();
    await type("report");
    expect(button("Install").disabled).toBe(true);
    expect(host.textContent).toContain("Needs permission to change files and run vskill here.");
  });

  it("opens a note in Obsidian on the machine", async () => {
    await render();
    await type("report");
    mocks.search.mockResolvedValueOnce(success({ ...found, opened: true }));
    await act(async () => button("Open in Obsidian").click());
    expect(mocks.search.mock.calls[1]?.[0].input).toEqual({
      projectId,
      cwd: "/work/app",
      operation: "open-note",
      note: "Resources/Report skills.md",
    });
  });

  it("says when the machine has no vault or the note search stopped early", async () => {
    mocks.search.mockResolvedValue(success({ ...found, notes: [], notesState: "none" }));
    await render();
    await type("report");
    expect(group("notes").textContent).toContain("No Obsidian vault on M4.");
    mocks.search.mockResolvedValue(success({ ...found, notesState: "partial" }));
    await type("reports");
    expect(group("notes").textContent).toContain("More notes may match. Narrow the search.");
  });

  it("drops an older answer that arrives while a newer query waits", async () => {
    let resolveOld: (value: unknown) => void = () => {};
    mocks.search.mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)));
    await render();
    await type("old");
    expect(mocks.search).toHaveBeenCalledTimes(1);
    // A new query is typed; its request has not been sent yet when the old one answers.
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "report");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => resolveOld(success({ ...found, query: "old" })));
    expect(host.querySelector("[data-group]")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(group("available").textContent).toContain("report-builder");
  });

  it("dims the last answer and offers no install while a new query is pending", async () => {
    await render();
    await type("report");
    mocks.search.mockImplementation(() => new Promise(() => {}));
    await type("reports");
    expect(host.querySelector("[data-stale]")).not.toBeNull();
    expect(button("Install").disabled).toBe(true);
  });
});
