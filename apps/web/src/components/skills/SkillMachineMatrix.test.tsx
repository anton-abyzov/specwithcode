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

function render(rows: ProjectSkillRow[] = [row("notes", "1.2.0"), row("draw")]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SkillMachineMatrix
        environmentId={"desk" as never}
        userLevel
        current={{
          snapshot: snapshot(rows),
          error: null,
          pending: false,
          connected: true,
          successful: true,
        }}
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
    // The current machine reads like the others: a version, never "On this machine" plus "Added".
    expect(notes[0]!.textContent).toBe("v1.2.0UserUpdate available 1.3.0");
    // Another machine may track a different source or a pin, so it gets no chip.
    expect(notes[1]!.textContent).toBe("v1.1.0User");
    expect(notes[2]!.textContent).toBe("Offline");
    // The reason sits in the cell, not only in a header that scrolls away.
    expect(notes[3]!.textContent).toBe("No project there");

    const draw = cells(view, "draw")!;
    expect(draw[0]!.textContent).toBe("InstalledUser");
    expect(draw[1]!.textContent).toBe("Not on Mini");
    // An unread machine is never "Not on".
    expect(draw[2]!.textContent).toBe("Offline");
    expect(draw[3]!.textContent).toBe("No project there");
    expect(view.textContent).not.toContain("Not checked");
    expect(view.textContent).not.toContain("Added");
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
    // The only control is the search box: nothing here changes a machine.
    expect(view.querySelectorAll("button, [role=switch]")).toHaveLength(0);
    expect(view.querySelectorAll("input")).toHaveLength(1);
    expect(cells(view, "notes")![1]!.textContent).toBe("Reading…");
  });

  it("shows a machine that needs a sign-in as that, not as missing", () => {
    state.results = { mini: { ...idle, error: "Not signed in on this machine" } };
    const view = render();
    expect(view.querySelectorAll("thead th")[2]!.textContent).toBe("MiniNeeds sign-in");
    expect(cells(view, "draw")![1]!.textContent).toBe("Needs sign-in");
  });

  it("searches every skill before paging a long list", () => {
    // 60 skills: three pages of 25, with the only "zebra" on the last one.
    const many = Array.from({ length: 59 }, (_, index) =>
      row(`skill-${String(index + 1).padStart(2, "0")}`),
    );
    const view = render([...many, row("zebra-notes")]);
    const names = () =>
      [...view.querySelectorAll("tbody tr")].map((line) => line.getAttribute("data-skill"));
    expect(names()).toHaveLength(25);
    expect(names()[0]).toBe("skill-01");
    expect(view.querySelector('[data-testid="pager-range"]')!.textContent).toBe("1–25 of 60");
    expect(view.querySelector('[data-testid="matrix-count"]')!.textContent).toBe("60 skills");

    const next = [...view.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith("Next page"),
    )!;
    act(() => next.click());
    expect(names()[0]).toBe("skill-26");
    expect(view.querySelector('[data-testid="pager-range"]')!.textContent).toBe("26–50 of 60");

    // A query finds the skill on page 3 from page 2, and returns to the first page.
    const input = view.querySelector("input")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, "zebra");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(names()).toEqual(["zebra-notes"]);
    expect(view.querySelector('[data-testid="matrix-count"]')!.textContent).toBe(
      "1 of 60 skills match",
    );
    // One page of results needs no pager.
    expect(view.querySelector('[data-testid="skills-pager"]')).toBeNull();
  });
});
