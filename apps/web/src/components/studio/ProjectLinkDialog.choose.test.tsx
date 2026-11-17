// @vitest-environment jsdom
// The dialog's first step: which rows are listed, what is folded away, what is selected
// before the person picks, and what the subtitle says about Main.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { setLocalePreference } from "../../i18n";
import { ProjectLinkDialog } from "./ProjectLinkDialog";

const state = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  problems: {} as Record<string, string | null>,
  fingerprints: {} as Record<string, unknown>,
  calls: [] as string[],
  gate: null as Promise<void> | null,
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  squashAtomCommandFailure: (failure: { error: Error }) => failure.error,
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    (tag: string) => async (request: { environmentId: string; input: { projectId: string } }) => {
      if (tag !== "projects.fingerprint") return { _tag: "Failure", error: new Error(tag) };
      const key = `${request.environmentId}:${request.input.projectId}`;
      state.calls.push(key);
      if (state.gate) await state.gate;
      const fingerprint = state.fingerprints[key];
      return fingerprint
        ? { _tag: "Success", value: { workspaceRoot: "/x", fingerprint } }
        : { _tag: "Failure", error: new Error("unreadable") };
    },
}));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchWorkspaceRootFor: () => null }),
}));
vi.mock("../settings/useReplacedMachineRecords", () => ({
  useRetiredMachineRecords: () => new Map<string, string>(),
}));
vi.mock("./useLinkMachines", () => ({
  useLinkMachines: () => ({
    label: (id: string) => (id === "lx" ? "linux-mini" : id),
    state: (id: string) => (state.problems[id] ? "offline" : "ready"),
    problem: (id: string) => state.problems[id] ?? null,
  }),
}));

const REMOTE = "github.com/team/easychamp";
const project = (environmentId: string, id: string, title: string, remote: string | null) => {
  const workspaceRoot = `/${environmentId}/${id}`;
  return {
    id,
    environmentId,
    title,
    workspaceRoot,
    repositoryIdentity: remote
      ? {
          canonicalKey: remote,
          rootPath: workspaceRoot,
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: remote },
        }
      : null,
    workspaceSettings: { kind: "code" } as Record<string, unknown>,
  };
};
const fingerprint = (root: string, nested: string[]) => ({
  root: "repository" as const,
  repositories: [root, ...nested].map((name, index) => ({
    path: index === 0 ? "" : name,
    originKey: index === 0 ? name : `github.com/team/${name}`,
    worktrees: 0,
  })),
  skippedLinks: 0,
  truncated: false,
});

const here = project("m4", "here", "EasyChamp", REMOTE);
const onM1 = project("m1", "fleet", "EasyChamp", REMOTE);
const onM3 = project("m3", "main", "EasyChamp", REMOTE);
const onLinux = project("lx", "easychamp", "EasyChamp", REMOTE);
const sketchmate = project("m1", "sketchmate", "sketchmate_project", "github.com/team/sketchmate");
const ol = project("m3", "ol", "ol", null);

let root: Root, container: HTMLDivElement;
const text = () => document.body.textContent ?? "";
const rows = () =>
  [...document.querySelectorAll('[data-slot="link-candidate"]')].map(
    (row) => row.querySelector("span.font-medium")?.textContent ?? "",
  );
const picked = () =>
  document
    .querySelector('[role="radio"][aria-checked="true"]')
    ?.closest("label")
    ?.querySelector("span.font-medium")?.textContent ?? null;
const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
    node.textContent?.trim().startsWith(label),
  );
  if (!element) throw new Error(`Missing button ${label}: ${text()}`);
  return element;
};
const radio = (label: string) => {
  const element = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) =>
    node.closest("label")?.textContent?.includes(label),
  );
  if (!element) throw new Error(`Missing choice ${label}: ${text()}`);
  return element;
};
const click = (element: HTMLElement) => act(async () => element.click());
const render = (props: Partial<Parameters<typeof ProjectLinkDialog>[0]> = {}) =>
  act(async () =>
    root.render(
      <ProjectLinkDialog open onOpenChange={() => {}} project={here as never} {...props} />,
    ),
  );
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.projects = [here, onM1, onM3, onLinux, sketchmate, ol];
  state.problems = { lx: "Connect linux-mini first." };
  state.calls = [];
  state.gate = null;
  // m1 scores higher (nothing extra), m3 has more matching repositories.
  state.fingerprints = {
    "m4:here": fingerprint(REMOTE, ["api", "web", "docs", "infra"]),
    "m1:fleet": fingerprint(REMOTE, ["api"]),
    "m3:main": fingerprint(REMOTE, [
      "api",
      "web",
      "docs",
      ...Array.from({ length: 9 }, (_, index) => `extra-${index}`),
    ]),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setLocalePreference("en");
});

it("lists only copies of this project and folds every other project away", async () => {
  await render();
  await settle();
  expect(rows()).toEqual(["EasyChamp on m1", "EasyChamp on m3", "EasyChamp on linux-mini"]);
  expect(text()).toContain("Same root repository; 2 of 2 repositories match");
  // The copy on a machine that is not connected stays listed and says what it needs.
  expect(text()).toContain("Connect linux-mini first.");
  expect(radio("EasyChamp on linux-mini").hasAttribute("data-disabled")).toBe(true);
  expect(text()).not.toContain("sketchmate_project");
  expect(text()).not.toContain("No copy of EasyChamp");
  const fold = button("Other projects (2)");
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  // Only likely copies on connected machines are read.
  expect(state.calls).toEqual(["m4:here", "m1:fleet", "m3:main"]);

  await click(fold);
  expect(button("Other projects (2)").getAttribute("aria-expanded")).toBe("true");
  expect(rows().slice(3)).toEqual(["ol on m3", "sketchmate_project on m1"]);
  expect(text()).toContain("Pick one only if it is a renamed or re-cloned copy.");
  // A renamed or re-cloned copy can still be linked on purpose.
  await click(radio("ol on m3"));
  expect(picked()).toBe("ol on m3");
  expect(button("Review link").disabled).toBe(false);
  // A selected row is never hidden: closing the fold drops the pick inside it.
  await click(button("Other projects (2)"));
  expect(rows()).toHaveLength(3);
  expect(picked()).toBeNull();
  expect(button("Review link").disabled).toBe(true);
});

it("selects the copy with the most matching repositories on a machine that can link", async () => {
  await render();
  await settle();
  // m1 is listed first, m3 matches more repositories.
  expect(rows()[0]).toBe("EasyChamp on m1");
  expect(picked()).toBe("EasyChamp on m3");
  expect(button("Review link").disabled).toBe(false);
  // The person's own pick is kept.
  await click(radio("EasyChamp on m1"));
  await settle();
  expect(picked()).toBe("EasyChamp on m1");
});

it("never selects a copy on a machine that cannot link", async () => {
  state.projects = [here, onLinux, sketchmate];
  await render();
  await settle();
  expect(rows()).toEqual(["EasyChamp on linux-mini"]);
  expect(picked()).toBeNull();
  expect(button("Review link").disabled).toBe(true);
  expect(button("Other projects (1)").getAttribute("aria-expanded")).toBe("false");
});

it("keeps the copy the caller named, whatever matches better", async () => {
  await render({ initialCandidate: { environmentId: "m1", projectId: "fleet" } as never });
  await settle();
  expect(picked()).toBe("EasyChamp on m1");
});

it("says no copy was found and opens Other projects", async () => {
  state.projects = [here, sketchmate, ol];
  await render();
  await settle();
  expect(document.querySelector("[data-link-no-copy]")?.textContent).toBe(
    "No copy of EasyChamp was found on another machine.",
  );
  expect(button("Other projects (2)").getAttribute("aria-expanded")).toBe("true");
  expect(rows()).toEqual(["ol on m3", "sketchmate_project on m1"]);
  expect(picked()).toBeNull();
  expect(button("Review link").disabled).toBe(true);
  // The person can still close it.
  await click(button("Other projects (2)"));
  expect(rows()).toEqual([]);
});

it("waits for the folders before saying no copy was found or selecting one", async () => {
  let release = () => {};
  state.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The same name is worth reading, and turns out to be this project.
  const renamed = project("m3", "renamed", "EasyChamp", null);
  state.projects = [here, renamed, sketchmate];
  state.fingerprints["m3:renamed"] = fingerprint(REMOTE, ["api"]);
  await render();
  await settle();
  expect(text()).toContain("Reading folders…");
  expect(text()).not.toContain("No copy of EasyChamp");
  expect(text()).not.toContain("Other projects");
  expect(picked()).toBeNull();
  await act(async () => release());
  await settle();
  expect(rows()).toEqual(["EasyChamp on m3"]);
  expect(picked()).toBe("EasyChamp on m3");
  expect(button("Other projects (1)").getAttribute("aria-expanded")).toBe("false");
});

it("falls back to the remotes when this folder cannot be read", async () => {
  delete state.fingerprints["m4:here"];
  await render();
  await settle();
  expect(state.calls).toEqual(["m4:here"]);
  expect(rows()).toEqual(["EasyChamp on linux-mini", "EasyChamp on m1", "EasyChamp on m3"]);
  // Nothing was compared, so nothing is selected for the person.
  expect(picked()).toBeNull();
  expect(button("Other projects (2)").getAttribute("aria-expanded")).toBe("false");
});

it("names no Main for a project that is not linked yet", async () => {
  await render();
  await settle();
  expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
    "Pick the copy of EasyChamp on another machine. Each copy keeps its own coordinator, and you can switch Main any time.",
  );
  expect(text()).not.toContain("One coordinator stays");
});

it("names the real Main for a project already linked with another copy", async () => {
  const member = (environmentId: string, projectId: string) => ({
    environmentId,
    projectId,
    coordinatorThreadId: `project-coordinator:${projectId}`,
  });
  const logicalProject = {
    id: "logical:1",
    title: "EasyChamp",
    coordinatorId: "coordinator:logical:1",
    members: [member("m4", "here"), member("m5", "copy")],
  };
  // This copy handed main on: m5 leads the project.
  const linkedHere = {
    ...here,
    workspaceSettings: {
      kind: "code",
      logicalProject,
      coordinatorBinding: { epoch: 2, state: "transferred", successor: member("m5", "copy") },
    },
  };
  const onM5 = {
    ...project("m5", "copy", "EasyChamp", REMOTE),
    workspaceSettings: {
      kind: "code",
      logicalProject,
      coordinatorBinding: { epoch: 2, state: "active" },
    },
  };
  state.projects = [linkedHere, onM5, onM1, sketchmate];
  await render({ project: linkedHere as never });
  await settle();
  expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
    "Pick the copy of EasyChamp on another machine. Each copy keeps its own coordinator; Main stays on m5 and you can switch it any time.",
  );
  // A copy already in this project is not offered again.
  expect(rows()).toEqual(["EasyChamp on m1"]);
});

it("translates the first step", async () => {
  setLocalePreference("ru");
  state.projects = [here, sketchmate];
  await render();
  await settle();
  expect(text()).toContain("Связать с проектом на другой машине");
  expect(text()).toContain("Копия EasyChamp на другой машине не найдена.");
  expect(text()).toContain("sketchmate_project на m1");
  expect(button("Другие проекты (1)")).toBeTruthy();
  expect(button("Проверить связь").disabled).toBe(true);
});
