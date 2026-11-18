// @vitest-environment jsdom
import {
  EnvironmentId,
  ProjectId,
  type ProjectSkillRow,
  type ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  data: null as unknown,
  search: {} as Record<string, unknown>,
  canWrite: true,
  phase: "connected",
}));

vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    skills: () => ({ kind: "skills" }),
    skillVersions: () => ({ kind: "versions" }),
    skillCopies: { label: "skill-copies" },
    skillAction: { label: "skill-action" },
    skillFleetPush: { label: "skill-fleet-push" },
    skillStudioLink: { label: "skill-studio-link" },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind?: string } | null) => ({
    refresh: () => {},
    data: atom?.kind === "skills" ? state.data : null,
    error: null,
    isPending: false,
    isSuccess: atom?.kind === "skills",
  }),
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => state.canWrite,
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: () => ({ label: "Desk", connection: { phase: state.phase } }) as never,
}));
vi.mock("../../studio/fleet", () => ({
  useStudioFleet: () => ({ snapshot: null, loading: false, failed: false, refresh: () => {} }),
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNickname: () => "Desk",
  useMachineNicknames: () => () => "Desk",
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => state.search,
  useNavigate: () => () => Promise.resolve(),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: { _tag: "read", copies: [] } }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: (props: { children: unknown; headerAction?: unknown }) => (
    <section>
      {props.headerAction as never}
      {props.children as never}
    </section>
  ),
  SettingsPageContainer: (props: { children: unknown }) => <div>{props.children as never}</div>,
}));

import { ProjectSkillsView } from "./ProjectSkillsSettings";

const agent = (driver: string, label: string, scope: string, path: string) => ({
  instanceId: driver,
  driver,
  label,
  path,
  scope,
  enabled: true,
});
const row = (name: string, presence: ReturnType<typeof agent>) =>
  ({
    name,
    status: "ok",
    attention: false,
    issues: [],
    path: presence.path,
    scopes: [presence.scope],
    providers: [presence],
    lock: null,
    drift: "unlocked",
    copies: 1,
    divergent: false,
    doctor: [],
  }) as unknown as ProjectSkillRow;
const snapshotOf = (rows: ProjectSkillRow[], counts: Record<string, number>) =>
  ({
    cwd: "~",
    checkedAt: "2026-11-18T10:00:00.000Z",
    rows,
    providers: Object.entries(counts).map(([label, skills]) => ({
      instanceId: label.toLowerCase(),
      driver: label.toLowerCase(),
      label,
      state: "ok",
      skills,
    })),
    locks: [],
    doctor: "ok",
  }) as unknown as ProjectSkillsSnapshot;

const synced = (name: string) =>
  row(
    `anthropic-skills:${name}`,
    agent("claudeAgent", "Claude", "claude.ai", `/h/.claude/skills/synced/a_b/${name}/SKILL.md`),
  );
const system = row(
  "plan",
  agent("codex", "Codex", "system", "/h/.codex/skills/.system/plan/SKILL.md"),
);
const mine = row("notes", agent("codex", "Codex", "user", "/h/.agents/skills/notes/SKILL.md"));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
async function render(data: ProjectSkillsSnapshot) {
  state.data = data;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ProjectSkillsView
        environmentId={EnvironmentId.make("desk")}
        projectId={ProjectId.make("p1")}
        folder="~"
        userLevel
      />,
    );
  });
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  state.search = {};
  state.canWrite = true;
  state.phase = "connected";
});
const builtIn = (view: HTMLElement) =>
  [...view.querySelectorAll('[data-testid="skills-built-in"] [data-skill]')].map(
    (item) => item.textContent,
  );

describe("the Skills page on one machine", () => {
  it("lists a home with only claude.ai-synced skills read-only, and names the empty agent", async () => {
    const view = await render(snapshotOf([synced("docx"), synced("pdf")], { Claude: 2, Codex: 0 }));
    expect(builtIn(view)).toEqual([
      "anthropic-skills:docxClaudeSource: claude.aiRead only",
      "anthropic-skills:pdfClaudeSource: claude.aiRead only",
    ]);
    const block = view.querySelector('[data-testid="skills-built-in"]')!;
    expect(block.querySelectorAll('[role="switch"], [data-testid="skill-row-menu"]')).toHaveLength(
      0,
    );
    // Nothing a person installed: no empty table, a plain sentence instead.
    expect(view.querySelector('[data-testid="skills-table"]')).toBeNull();
    expect(view.textContent).toContain("Nothing is installed on Desk yet.");
    expect(view.querySelector('[data-testid="skills-empty-agents"]')!.textContent).toBe(
      "Codex: no skills installed on Desk",
    );
  });

  it("puts Codex system skills in the built-in block on a Codex-only machine", async () => {
    const view = await render(snapshotOf([mine, system], { Claude: 0, Codex: 2 }));
    expect(builtIn(view)).toEqual(["planCodexSource: CodexRead only"]);
    const table = view.querySelector('[data-testid="skills-table"]')!;
    expect(
      [...table.querySelectorAll("tbody tr")].map((line) => line.getAttribute("data-skill")),
    ).toEqual(["notes"]);
    expect(view.querySelector('[data-testid="skills-empty-agents"]')!.textContent).toBe(
      "Claude: no skills installed on Desk",
    );
  });

  it("switches to the read-only Across machines table and back", async () => {
    const view = await render(snapshotOf([mine, system], { Claude: 0, Codex: 2 }));
    expect(view.querySelector('[data-testid="skills-matrix"]')).toBeNull();
    const button = (label: string) =>
      [...view.querySelectorAll("button")].find((item) => item.textContent === label)!;
    expect(button("On Desk").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Across machines").click());
    const matrix = view.querySelector('[data-testid="skills-matrix"]')!;
    expect([...matrix.querySelectorAll("tbody tr th")].map((cell) => cell.textContent)).toEqual([
      "notes",
      "planBuilt into the agent",
    ]);
    expect(matrix.querySelectorAll('button, input, [role="switch"]')).toHaveLength(0);
    expect(view.querySelector('[data-testid="skills-table"]')).toBeNull();
    expect(view.querySelector('[data-testid="skills-built-in"]')).toBeNull();
    await act(async () => button("On Desk").click());
    expect(view.querySelector('[data-testid="skills-table"]')).not.toBeNull();
  });

  it("opens a built-in skill's details without a working switch", async () => {
    const view = await render(snapshotOf([synced("pdf")], { Claude: 1 }));
    await act(async () =>
      view.querySelector<HTMLButtonElement>('[data-testid="skills-built-in"] button')!.click(),
    );
    const sheet = document.querySelector('[data-testid="skill-details"]')!;
    expect(sheet.textContent).toContain("anthropic-skills:pdf");
    for (const control of sheet.querySelectorAll('[role="switch"]'))
      expect(
        control.hasAttribute("disabled") || control.getAttribute("aria-disabled"),
      ).toBeTruthy();
  });

  it("opens a Codex system skill's details without a working switch", async () => {
    const view = await render(snapshotOf([system], { Codex: 1 }));
    await act(async () =>
      view.querySelector<HTMLButtonElement>('[data-testid="skills-built-in"] button')!.click(),
    );
    const controls = document.querySelectorAll('[data-testid="skill-details"] [role="switch"]');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls)
      expect(
        control.hasAttribute("disabled") || control.getAttribute("aria-disabled"),
      ).toBeTruthy();
  });

  it("names every empty agent on a machine with no skills at all", async () => {
    const view = await render(snapshotOf([], { Claude: 0, Codex: 0 }));
    expect(view.querySelector('[data-testid="skills-empty-agents"]')!.textContent).toBe(
      "Claude: no skills installed on DeskCodex: no skills installed on Desk",
    );
  });

  it("shows one card for an offline machine instead of its last skills", async () => {
    state.phase = "idle";
    const view = await render(snapshotOf([mine], { Codex: 1 }));
    expect(view.querySelector('[data-testid="skills-machine-offline"]')!.textContent).toBe(
      "Desk is offline. Its settings show when it reconnects.",
    );
    expect(view.querySelector('[data-testid="skills-table"]')).toBeNull();
    expect(view.querySelector('[data-testid="skills-built-in"]')).toBeNull();
    expect(view.querySelector('[data-testid="skills-view-only"]')).toBeNull();
  });

  it("says once that a view-only sign-in cannot change this machine", async () => {
    const full = await render(snapshotOf([mine], { Codex: 1 }));
    expect(full.querySelector('[data-testid="skills-view-only"]')).toBeNull();
    act(() => root?.unmount());
    state.canWrite = false;
    const view = await render(snapshotOf([mine], { Codex: 1 }));
    expect(view.querySelector('[data-testid="skills-view-only"]')!.textContent).toBe(
      "You can look at Desk's settings from this sign-in, but not change them.",
    );
    // The rows stay, each with its own real state.
    expect(view.querySelector('[data-testid="skills-table"]')).not.toBeNull();
  });
});
