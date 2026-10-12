// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectSkillRow,
  type ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  data: null as unknown,
  error: null as string | null,
  isPending: false,
  copied: [] as string[],
}));

vi.mock("../../studio/projectWorkspace", () => ({ projectWorkspace: { skills: () => ({}) } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    refresh: () => {},
    data: state.data,
    error: state.error,
    isPending: state.isPending,
  }),
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copyToClipboard: (value: string) => state.copied.push(value),
    isCopied: false,
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: (props: { id?: string; title: string; children: unknown }) => (
    <section id={props.id} aria-label={props.title}>
      {props.children as never}
    </section>
  ),
  SettingsPageContainer: (props: { children: unknown }) => <div>{props.children as never}</div>,
}));

import { ProjectSkillsView } from "./ProjectSkillsSettings";

const claude = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  label: "Claude",
};

function row(name: string, extra: Partial<ProjectSkillRow> = {}): ProjectSkillRow {
  const path = `/work/app/.claude/skills/${name}/SKILL.md`;
  return {
    name,
    status: "ok",
    attention: false,
    issues: [],
    path,
    scopes: ["project"],
    providers: [{ ...claude, path, scope: "project", enabled: true }],
    lock: null,
    drift: "unlocked",
    copies: 1,
    divergent: false,
    doctor: [],
    ...extra,
  };
}

const snapshot: ProjectSkillsSnapshot = {
  cwd: "/work/app",
  checkedAt: "2026-10-11T00:00:00.000Z",
  rows: [
    row("deploy", {
      lock: {
        lockPath: "/work/app/vskill.lock",
        lockScope: "project",
        version: "1.2.0",
        tier: "VERIFIED",
        source: "github:acme/deploy",
        sha: "abc",
        installedAt: null,
      },
      drift: "match",
    }),
    row("review", {
      status: "drift",
      attention: true,
      issues: ["SKILL.md changed since vskill installed it."],
    }),
    row("ghost", { status: "missing", attention: true, providers: [], path: null, scopes: [] }),
  ],
  providers: [
    { ...claude, state: "ok", skills: 2 },
    {
      instanceId: ProviderInstanceId.make("cursor"),
      driver: ProviderDriverKind.make("cursor"),
      label: "Cursor",
      state: "error",
      skills: 0,
      message: "Not installed.",
    },
  ],
  locks: [{ path: "/work/app/vskill.lock", scope: "project", skills: 2 }],
  doctor: "unavailable",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.data = snapshot;
  state.error = null;
  state.isPending = false;
  state.copied = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () =>
    root.render(
      <ProjectSkillsView
        environmentId={EnvironmentId.make("host")}
        projectId={ProjectId.make("project")}
        folder="/work/app"
      />,
    ),
  );
}

const bodyRows = () =>
  [...container.querySelectorAll("tbody tr[data-skill]")].map((element) =>
    element.getAttribute("data-skill"),
  );

describe("ProjectSkillsView", () => {
  it("shows a summary line and one row per skill with its lock details", async () => {
    await render();
    expect(container.querySelector("[data-testid=skills-summary]")?.textContent).toBe(
      "3 skills, 2 need attention",
    );
    expect(bodyRows()).toEqual(["deploy", "review", "ghost"]);
    const deploy = container.querySelector("tr[data-skill=deploy]")!;
    const cells = [...deploy.querySelectorAll("td")].map((cell) => cell.textContent);
    expect(cells.slice(0, 7)).toEqual([
      "deploy",
      "Claude",
      "project",
      "1.2.0",
      "VERIFIED",
      "github:acme/deploy",
      "ok",
    ]);
    expect(container.textContent).toContain("Cursor: Not installed.");
    expect(container.textContent).toContain("vskill doctor is not available here");
  });

  it("filters to problems and by search", async () => {
    await render();
    const toggle = container.querySelector<HTMLElement>("[role=switch]")!;
    await act(async () => toggle.click());
    expect(bodyRows()).toEqual(["review", "ghost"]);
    expect(container.querySelector("[data-testid=skills-summary]")?.textContent).toBe(
      "3 skills, 2 need attention · showing 2",
    );

    const input = container.querySelector<HTMLInputElement>("input[aria-label='Search skills']")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "nothing-matches");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(bodyRows()).toEqual([]);
    expect(container.textContent).toContain("No skills match this search.");
  });

  it("copies the SKILL.md path and disables copy when nothing loads the skill", async () => {
    await render();
    const copy = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Copy the SKILL.md path of review']",
    )!;
    await act(async () => copy.click());
    expect(state.copied).toEqual(["/work/app/.claude/skills/review/SKILL.md"]);
    expect(
      container.querySelector<HTMLButtonElement>(
        "button[aria-label='Copy the SKILL.md path of ghost']",
      )?.disabled,
    ).toBe(true);
  });

  it("shows loading, error and empty states", async () => {
    state.data = null;
    state.isPending = true;
    await render();
    expect(container.textContent).toContain("Scanning skill folders and lockfiles");

    state.isPending = false;
    state.error = "Project skills could not be read.";
    await render();
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "Project skills could not be read.",
    );

    state.error = null;
    state.data = { ...snapshot, rows: [] };
    await render();
    expect(container.textContent).toContain("No agent loads any skill in this folder");
  });
});
