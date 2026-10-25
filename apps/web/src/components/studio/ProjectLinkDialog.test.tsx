// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProjectLinkDialog } from "./ProjectLinkDialog";

const state = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  problems: {} as Record<string, string | null>,
  calls: [] as Array<{ tag: string; environmentId: string; input: Record<string, unknown> }>,
  handlers: {} as Record<string, (request: { environmentId: string; input: any }) => unknown>,
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  squashAtomCommandFailure: (failure: { error: Error }) => failure.error,
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    (tag: string) => async (request: { environmentId: string; input: Record<string, unknown> }) => {
      state.calls.push({ tag, ...request });
      try {
        return { _tag: "Success", value: await state.handlers[tag]!(request) };
      } catch (error) {
        return { _tag: "Failure", error };
      }
    },
}));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchWorkspaceRootFor: (id: string) => (id === "m1" ? "/Users/b/.scratch" : null),
  }),
}));
vi.mock("./useLinkMachines", () => ({
  useLinkMachines: () => ({
    label: (id: string) => ({ m4: "M4", m3: "M3", m1: "M1" })[id] ?? "Machine",
    state: (id: string) => (state.problems[id] ? "offline" : "ready"),
    problem: (id: string) => state.problems[id] ?? null,
  }),
}));
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => "7307ab55-fc59-4e07-abeb-de54be69215f",
}));

const operationId = "7307ab55-fc59-4e07-abeb-de54be69215f";
const identity = {
  canonicalKey: "github.com/team/umbrella",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
};
const here = {
  id: "here",
  environmentId: "m4",
  title: "EasyChamp",
  workspaceRoot: "/Users/a/EasyChamp",
  repositoryIdentity: identity,
  workspaceSettings: { kind: "code" },
};
const there = { ...here, id: "there", environmentId: "m3", workspaceRoot: "/Users/b/EasyChamp" };
const unrelated = {
  ...here,
  id: "other",
  environmentId: "m1",
  title: "Notes",
  workspaceRoot: "/Users/b/Notes",
  repositoryIdentity: null,
};
const entry = (path: string, originKey: string) => ({ path, originKey, worktrees: 0 });
const umbrella = {
  root: "repository" as const,
  repositories: [entry("", "github.com/team/umbrella"), entry("api", "github.com/team/api")],
  skippedLinks: 0,
  truncated: false,
};
const member = (environmentId: string, projectId: string) => ({
  environmentId,
  projectId,
  coordinatorThreadId: `project-coordinator:${projectId}`,
});
const previewOf = (project: typeof here, overrides: Record<string, unknown> = {}) => ({
  member: member(project.environmentId, project.id),
  title: project.title,
  workspaceRoot: project.workspaceRoot,
  logicalProject: null,
  coordinatorBinding: null,
  fingerprint: umbrella,
  goal: "",
  instructions: "",
  notes: [],
  notesTruncated: false,
  lastCoordinatorActivityAt: null,
  keepRefusal: null,
  joinRefusal: null,
  ...overrides,
});
const logicalProject = {
  id: "logical:1",
  title: "EasyChamp",
  coordinatorId: "coordinator:logical:1",
  members: [member("m3", "there")],
};

let root: Root, container: HTMLDivElement;
const text = () => document.body.textContent ?? "";
const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
    node.textContent?.trim().startsWith(label),
  );
  if (!element) throw new Error(`Missing button ${label}: ${text()}`);
  return element;
};
const click = (element: HTMLElement) => act(async () => element.click());
const radioIn = (container: Element | null, label: string) => {
  const element = [...(container?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])].find(
    (node) => node.closest("label")?.textContent?.includes(label),
  );
  if (!element) throw new Error(`Missing choice ${label}: ${container?.textContent}`);
  return element;
};
const render = (props: Partial<Parameters<typeof ProjectLinkDialog>[0]> = {}) =>
  act(async () =>
    root.render(
      <ProjectLinkDialog open onOpenChange={() => {}} project={here as never} {...props} />,
    ),
  );
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.projects = [here, there, unrelated];
  state.problems = {};
  state.calls = [];
  localStorage.clear();
  state.handlers = {
    "projects.fingerprint": ({ input }) => ({
      workspaceRoot: "/x",
      fingerprint:
        input.projectId === "other"
          ? { ...umbrella, repositories: [entry("", "github.com/x/notes")] }
          : input.projectId === "here"
            ? { ...umbrella, repositories: umbrella.repositories.slice(0, 1) }
            : umbrella,
    }),
    "projectLink.preview": ({ input }) =>
      input.projectId === "here"
        ? previewOf(here, {
            lastCoordinatorActivityAt: "2026-10-18T10:00:00.000Z",
            notes: [
              { name: "plan.md", revision: 1, content: "M4 plan" },
              { name: "only-m4.md", revision: 1, content: "from M4" },
            ],
            goal: "Ship the M4 goal",
          })
        : previewOf(there, {
            lastCoordinatorActivityAt: "2026-10-19T10:00:00.000Z",
            notes: [{ name: "plan.md", revision: 4, content: "M3 plan" }],
            goal: "Ship",
          }),
    "projectLink.prepare": ({ input }) => ({
      operationId: input.operationId,
      kept: member("m3", "there"),
      logicalProject,
      coordinatorBinding: { epoch: 0, state: "active" },
      fingerprint: umbrella,
      adopted: true,
    }),
    "projectLink.accept": ({ input }) => ({
      operationId: input.operationId,
      member: member("m4", "here"),
      logicalProject: {
        ...logicalProject,
        members: [...logicalProject.members, member("m4", "here")],
      },
      coordinatorBinding: { epoch: 0, state: "transferred" },
      replayed: false,
    }),
    "projectLink.commit": ({ input }) => ({
      operationId: input.operationId,
      logicalProject,
      notesWritten: input.notes.length,
      replayed: false,
    }),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("ranks copies by fingerprint, keeps the most recent coordinator and merges notes on a choice", async () => {
  await render();
  await settle();
  const candidates = [...document.querySelectorAll('[data-slot="link-candidate"]')];
  expect(candidates[0]?.textContent).toContain("EasyChamp on M3");
  expect(candidates[0]?.textContent).toContain("Same root repository; 1 of 2 repositories match");
  // A project that looks unrelated is not fingerprinted, but can still be chosen.
  expect(candidates[1]?.textContent).toContain("Notes on M1");
  expect(
    state.calls.filter((call) => call.tag === "projects.fingerprint").map((call) => call.input),
  ).toEqual([{ projectId: "here" }, { projectId: "there" }]);
  expect(button("Review link").disabled).toBe(true);

  await click(radioIn(candidates[0]!, "EasyChamp on M3"));
  await click(button("Review link"));
  // M3's coordinator was active more recently, so it stays by default.
  expect(button("Link, keep coordinator on M3")).toBeTruthy();
  expect(text()).toContain("Copied to M3");
  expect(text()).toContain("Goal on M4");
  const conflict = document.querySelector('[data-slot="note-conflict"]');
  expect(conflict?.textContent).toContain("M3 plan");
  expect(conflict?.textContent).toContain("M4 plan");

  await click(document.querySelector<HTMLElement>('[role="checkbox"]')!);
  expect(button("Link, keep coordinator on M3").disabled).toBe(true);
  await click(radioIn(conflict, "Keep both"));
  await click(button("Link, keep coordinator on M3"));

  expect(state.calls.slice(-3).map((call) => [call.tag, call.environmentId])).toEqual([
    ["projectLink.prepare", "m3"],
    ["projectLink.accept", "m4"],
    ["projectLink.commit", "m3"],
  ]);
  expect(state.calls.at(-3)?.input).toEqual({
    operationId,
    projectId: "there",
    joining: member("m4", "here"),
  });
  expect(state.calls.at(-1)?.input.notes).toEqual([
    { name: "only-m4.md", content: "from M4", expectedRevision: null },
    { name: "plan-m4.md", content: "M4 plan", expectedRevision: null, createOnly: true },
  ]);
  expect(text()).toContain("Projects linked");
  expect(localStorage.length).toBe(0);
});

it("does not offer another machine's No project folder or an archived project", async () => {
  state.projects.push(
    { ...unrelated, id: "scratch", title: "Scratch", workspaceRoot: "/Users/b/.scratch" },
    { ...there, id: "archived", workspaceSettings: { kind: "code", archived: true } },
  );
  await render();
  await settle();
  const candidates = [...document.querySelectorAll('[data-slot="link-candidate"]')];
  expect(candidates.map((candidate) => candidate.textContent?.split(" on ")[0])).toEqual([
    "EasyChamp",
    "Notes",
  ]);
  expect(text()).not.toContain("/Users/b/.scratch");
});

it("retries a link that stopped before its last step with the same operation", async () => {
  let commits = 0;
  const commit = state.handlers["projectLink.commit"]!;
  state.handlers["projectLink.commit"] = (request) => {
    commits += 1;
    if (commits === 1) throw new Error("M3 is not connected.");
    return commit(request);
  };
  await render({ initialCandidate: { environmentId: "m3", projectId: "there" } as never });
  await settle();
  await click(button("Review link"));
  await click(radioIn(document.querySelector('[data-slot="note-conflict"]'), "Keep M3"));
  await click(document.querySelector<HTMLElement>('[role="checkbox"]')!);
  await click(button("Link, keep coordinator on M3"));
  expect(text()).toContain("M3 is not connected.");
  expect(text()).toContain("already defers to M3; retry to finish listing it there.");
  await click(button("Retry link"));
  const operations = state.calls
    .filter((call) => call.tag !== "projects.fingerprint" && call.tag !== "projectLink.preview")
    .map((call) => call.input.operationId);
  expect(new Set(operations)).toEqual(new Set([operationId]));
  expect(operations).toHaveLength(6);
  expect(text()).toContain("Projects linked");
});

it("refuses a copy that is already shared, or folders that do not match at the root", async () => {
  const preview = state.handlers["projectLink.preview"]!;
  state.handlers["projectLink.preview"] = (request) => ({
    ...(preview(request) as object),
    ...(request.input.projectId === "here"
      ? { joinRefusal: "already_shared", lastCoordinatorActivityAt: null }
      : {}),
  });
  await render({ initialCandidate: { environmentId: "m3", projectId: "there" } as never });
  await settle();
  await click(button("Review link"));
  expect(text()).toContain(
    "The copy on M4 is already shared with other machines. Unlink it there first.",
  );
  await click(document.querySelector<HTMLElement>('[role="checkbox"]')!);
  expect(button("Link, keep coordinator on M3").disabled).toBe(true);

  state.handlers["projectLink.preview"] = (request) => ({
    ...(preview(request) as object),
    ...(request.input.projectId === "here"
      ? { fingerprint: { ...umbrella, repositories: [entry("", "github.com/x/other")] } }
      : {}),
  });
  await click(button("Back"));
  await click(button("Review link"));
  expect(text()).toContain("These folders are not copies of one project.");
});

it("names the machine that needs connecting or updating before anything is read", async () => {
  state.problems = { m4: "Update SpecWithCode on M4 to link projects." };
  await render();
  await settle();
  expect(text()).toContain("Update SpecWithCode on M4 to link projects.");
  expect(state.calls).toEqual([]);
});
