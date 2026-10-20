// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProjectMachinesSettings } from "./ProjectMachinesSettings";

const state = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  problems: {} as Record<string, string | null>,
  calls: [] as Array<{ tag: string; environmentId: string; input: Record<string, any> }>,
  dialog: null as Record<string, unknown> | null,
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@specweave-studio/client-runtime/state/runtime")>()),
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  squashAtomCommandFailure: (failure: { error: Error }) => failure.error,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    (tag: string) => async (request: { environmentId: string; input: Record<string, any> }) => {
      state.calls.push({ tag, ...request });
      if (tag === "projectLink.preview")
        return {
          _tag: "Success",
          value: {
            notes:
              request.environmentId === "m3"
                ? [{ name: "plan.md", revision: 1, content: "kept" }]
                : [],
          },
        };
      return { _tag: "Success", value: {} };
    },
}));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "m4",
}));
vi.mock("./useLinkMachines", () => ({
  useLinkMachines: () => ({
    label: (id: string) => ({ m4: "M4", m3: "M3" })[id] ?? "Machine",
    state: (id: string) => (state.problems[id] ? "offline" : "ready"),
    problem: (id: string) => state.problems[id] ?? null,
  }),
}));
vi.mock("./ProjectLinkDialog", () => ({
  ProjectLinkDialog: (props: Record<string, unknown>) => {
    state.dialog = props;
    return null;
  },
}));
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => "7307ab55-fc59-4e07-abeb-de54be69215f",
}));

const ref = (environmentId: string, projectId: string) => ({
  environmentId,
  projectId,
  coordinatorThreadId: `project-coordinator:${projectId}`,
});
const identity = (id: string, members: ReturnType<typeof ref>[]) => ({
  id,
  title: "EasyChamp",
  coordinatorId: `coordinator:${id}`,
  members,
});
const copy = (
  environmentId: string,
  id: string,
  logicalProject: ReturnType<typeof identity> | undefined,
  state?: "active" | "transferred",
) => ({
  environmentId,
  id,
  title: "EasyChamp",
  workspaceRoot: `/${environmentId}/EasyChamp`,
  workspaceSettings: {
    kind: "code",
    ...(logicalProject ? { logicalProject } : {}),
    ...(state ? { coordinatorBinding: { epoch: 0, state } } : {}),
  },
});
const shared = identity("logical:1", [ref("m3", "kept"), ref("m4", "joined")]);
const kept = copy("m3", "kept", shared, "active");
const joined = copy("m4", "joined", shared, "transferred");

let root: Root, container: HTMLDivElement;
const text = () => document.body.textContent ?? "";
const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button ${label}: ${text()}`);
  return element;
};
const click = (element: HTMLElement) => act(async () => element.click());
const render = (members: Array<Record<string, unknown>>) =>
  act(async () => root.render(<ProjectMachinesSettings members={members as never} />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.projects = [kept, joined];
  state.problems = {};
  state.calls = [];
  state.dialog = null;
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("lists each machine's copy with its role and links a project that has none", async () => {
  const single = copy("m4", "solo", undefined);
  await render([single]);
  expect(text()).toContain("Link with a project on another machine");
  expect(document.querySelectorAll("[data-project-copy]")).toHaveLength(0);
  await click(button("Link…"));
  expect(state.dialog).toMatchObject({ project: single, initialCandidate: null });

  await render([kept, joined]);
  const rows = [...document.querySelectorAll("[data-project-copy]")];
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("Coordinator. Plans the work"),
    expect.stringContaining("Runs workers. Its own coordinator is read-only history."),
  ]);
});

it("unlinks on the member first, with the kept notes, then removes it from the coordinator", async () => {
  await render([kept, joined]);
  await click(button("Unlink"));
  expect(text()).toContain("Unlink the copy on M4?");
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (node) => node.textContent?.trim() === "Unlink",
  )!;
  await click(confirm);
  const writes = state.calls.filter((call) => call.tag === "projectLink.unlink");
  expect(writes.map((call) => [call.environmentId, call.input.side])).toEqual([
    ["m4", "member"],
    ["m3", "coordinator"],
  ]);
  expect(writes[0]!.input.notes).toEqual([
    { name: "plan.md", content: "kept", expectedRevision: null },
  ]);
  expect(writes[1]!.input.member).toEqual(ref("m4", "joined"));
  expect(writes[0]!.input.operationId).toBe(writes[1]!.input.operationId);
  expect(text()).toContain("M4 has its own coordinator again");
});

it("unlinks while the coordinator is away and offers to remove the departed copy later", async () => {
  state.problems = { m3: "Connect M3 first." };
  await render([kept, joined]);
  await click(button("Unlink"));
  await click(
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (node) => node.textContent?.trim() === "Unlink",
    )!,
  );
  expect(state.calls.map((call) => [call.tag, call.environmentId])).toEqual([
    ["projectLink.unlink", "m4"],
  ]);
  expect(text()).toContain("Connect M3 and remove the copy there.");

  state.problems = {};
  const left = copy("m4", "joined", identity("logical:2", [ref("m4", "joined")]), "active");
  state.projects = [kept, left];
  await render([kept]);
  expect(text()).toContain("This copy was unlinked on M4.");
  await click(button("Remove"));
  expect(state.calls.at(-1)).toMatchObject({
    tag: "projectLink.unlink",
    environmentId: "m3",
    input: { side: "coordinator", projectId: "kept", member: ref("m4", "joined") },
  });
});

it("finishes a link whose coordinator did not list the joined copy", async () => {
  const lonely = copy("m3", "kept", identity("logical:1", [ref("m3", "kept")]), "active");
  await render([lonely, joined]);
  expect(text()).toContain("Joined, but M3 does not list it yet.");
  await click(button("Finish linking"));
  expect(state.dialog).toMatchObject({
    project: lonely,
    initialCandidate: { environmentId: "m4", projectId: "joined" },
    initialKept: "here",
    autoReview: true,
  });
});
