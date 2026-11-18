// @vitest-environment jsdom
import type { ProjectSkillRow, ProjectSkillsSnapshot } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  queries: [] as Array<{ environmentId: string; input: Record<string, unknown> }>,
  results: {} as Record<string, unknown>,
  phases: {} as Record<string, string>,
}));
const idle = { data: null, error: null, isPending: false, isSuccess: false, refresh: () => {} };

vi.mock("../../state/environments", () => ({
  useEnvironment: (environmentId: string) => ({
    label: environmentId === "desk" ? "Desk" : environmentId,
    connection: { phase: state.phases[environmentId] ?? "connected" },
  }),
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    skills: (query: { environmentId: string; input: Record<string, unknown> }) => {
      state.queries.push(query);
      return { machine: query.environmentId };
    },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { machine: string } | null) =>
    atom === null ? idle : (state.results[atom.machine] ?? idle),
}));
vi.mock("../../studio/fleet", () => ({
  useStudioFleet: () => ({
    snapshot: {
      machines: [
        { id: "m-desk", environmentId: "desk", label: "Desk", status: "reachable" },
        { id: "m-mini", environmentId: "mini", label: "Mini", status: "reachable" },
        { id: "m-travel", environmentId: "travel", label: "Travel", status: "unreachable" },
        { id: "m-bare", environmentId: "bare", label: "Bare", status: "reachable" },
      ],
    },
    loading: false,
    failed: false,
  }),
}));
vi.mock("../../studio/machineNickname", () => {
  const resolve = (_id: string, fallback?: string | null) => fallback ?? "?";
  return { useMachineNicknames: () => resolve };
});
vi.mock("../settings/ProjectSkillControls", () => ({ useSkillControls: vi.fn() }));

import { SkillMachineMatrix } from "./SkillMachineMatrix";

const row = (name: string, version?: string) =>
  ({
    name,
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        label: "Codex",
        path: `/h/.agents/skills/${name}/SKILL.md`,
        scope: "user",
        enabled: true,
        ...(version ? { fileVersion: version } : {}),
      },
    ],
    lock: null,
    divergent: false,
  }) as unknown as ProjectSkillRow;
const snapshot = (rows: ProjectSkillRow[]) =>
  ({
    checkedAt: "2026-11-18T10:00:00.000Z",
    rows,
    providers: [{ instanceId: "codex", state: "ok" }],
  }) as unknown as ProjectSkillsSnapshot;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  state.queries = [];
  state.results = {};
  state.phases = {};
});
const projectIdFor = (environmentId: string) =>
  environmentId === "bare" ? null : (`project-${environmentId}` as never);

function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SkillMachineMatrix
        environmentId={"desk" as never}
        userLevel
        current={{ snapshot: snapshot([row("notes", "1.2.0"), row("draw")]), error: null, pending: false }}
        projectIdFor={projectIdFor as never}
        latest={new Map([["notes", "1.3.0"]])}
      />,
    ),
  );
  return host;
}
const cells = (view: HTMLElement, name: string) =>
  [...view.querySelectorAll("tbody tr")]
    .find((line) => line.querySelector("th")?.textContent?.startsWith(name))
    ?.querySelectorAll("td");

describe("SkillMachineMatrix", () => {
  it("shows one column per machine, with versions, chips and read times", () => {
    state.phases = { travel: "idle" };
    state.results = {
      mini: { ...idle, isSuccess: true, data: snapshot([row("notes", "1.1.0")]) },
    };
    const view = render();
    const headers = [...view.querySelectorAll("thead th")].map((cell) => cell.textContent);
    expect(headers[0]).toBe("Skill");
    expect(headers[1]).toMatch(/^DeskRead /);
    expect(headers[2]).toMatch(/^MiniRead /);
    expect(headers[3]).toBe("TravelOffline, not read");
    expect(headers[4]).toBe("BareNo project there, not read");

    const notes = cells(view, "notes")!;
    expect(notes[0]!.textContent).toBe("On this machinev1.2.0Update available 1.3.0");
    expect(notes[1]!.textContent).toBe("v1.1.0Update available 1.3.0");
    expect(notes[2]!.textContent).toBe("Offline");
    expect(notes[3]!.textContent).toBe("Not checked");

    const draw = cells(view, "draw")!;
    expect(draw[0]!.textContent).toBe("On this machine");
    expect(draw[1]!.textContent).toBe("Not on Mini");
    // An unread machine is never "Not on".
    expect(draw[2]!.textContent).toBe("Offline");
    expect(draw[3]!.textContent).toBe("Not checked");
  });

  it("reads each other machine once, with the query Available on uses, and writes nothing", () => {
    const view = render();
    // This machine's column comes from the page; offline and unlinked machines are not asked.
    expect([...new Set(state.queries.map((query) => query.environmentId))]).toEqual(["mini"]);
    expect(state.queries[0]?.input).toEqual({
      projectId: "project-mini",
      refresh: true,
      userLevel: true,
    });
    expect(view.querySelectorAll("button, input, [role=switch]")).toHaveLength(0);
    expect(cells(view, "notes")![1]!.textContent).toBe("Not checked");
  });

  it("shows a machine that needs a sign-in as that, not as missing", () => {
    state.results = { mini: { ...idle, error: "Not signed in on this machine" } };
    const view = render();
    expect(view.querySelectorAll("thead th")[2]!.textContent).toBe("MiniNeeds sign-in");
    expect(cells(view, "draw")![1]!.textContent).toBe("Needs sign-in");
  });
});
