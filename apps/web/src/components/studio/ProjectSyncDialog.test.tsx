// @vitest-environment jsdom
import type {
  ProjectSyncFetchResult,
  ProjectSyncInventoryResult,
  ProjectSyncRepositoryFacts,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { ProjectSyncApi, SyncMachine } from "../../studio/projectSync";

vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  runAtomCommand: vi.fn(),
  squashAtomCommandFailure: vi.fn(),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

import { ProjectSyncDialog, type SyncTarget } from "./ProjectSyncDialog";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const machine = (id: string, label: string): SyncMachine => ({
  environmentId: id as never,
  projectId: `${id}-p` as never,
  label,
});
const M4 = machine("m4", "M4");
const M5 = machine("m5", "M5");
const MINI = machine("mini", "Mini");

const facts = (
  path: string,
  extra: Partial<ProjectSyncRepositoryFacts> = {},
): ProjectSyncRepositoryFacts => ({
  path,
  branch: "main",
  head: "a".repeat(40),
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  inUseBy: null,
  remote: `git@example.com:acme/${path === "." ? "atlas" : path}.git`,
  fetch: "ok",
  fetchError: null,
  ...extra,
});
const fetched = (...repositories: ProjectSyncRepositoryFacts[]): ProjectSyncFetchResult => ({
  repositories,
  scanLimited: false,
});
const EMPTY: ProjectSyncInventoryResult = { repositories: [], scanLimited: false };
const WORK: ProjectSyncInventoryResult = {
  scanLimited: false,
  repositories: [
    {
      path: ".",
      notPushed: [{ branch: "fix/menu", head: "b".repeat(40), commits: 10 }],
      onlyHere: [],
      branchesNotListed: 0,
      changedFiles: 3,
      untrackedFiles: 1,
      stashes: 1,
      leftOut: [
        { path: ".env.local", reason: "name", kind: null, modifiedAtMs: 1 },
        { path: "notes/keys.txt", reason: "content", kind: "GitHub token", modifiedAtMs: 2 },
      ],
      leftOutNotListed: 0,
    },
  ],
};

/** An API that answers from the given facts and records every call. */
function scripted(input: {
  fetch: Record<string, ProjectSyncFetchResult | { cause: unknown }>;
  inventory?: Record<string, ProjectSyncInventoryResult>;
}) {
  const calls: string[] = [];
  const api: ProjectSyncApi = {
    status: vi.fn(),
    fetch: vi.fn<ProjectSyncApi["fetch"]>(async (on) => {
      calls.push(`fetch ${on.label}`);
      const answer = input.fetch[on.label]!;
      return "cause" in answer
        ? { ok: false as const, cause: answer.cause }
        : { ok: true as const, value: answer };
    }),
    inventory: vi.fn<ProjectSyncApi["inventory"]>(async (on) => {
      calls.push(`inventory ${on.label}`);
      return { ok: true as const, value: input.inventory?.[on.label] ?? EMPTY };
    }),
    run: vi.fn<ProjectSyncApi["run"]>(async (on, plan) => {
      calls.push(`run ${on.label} ${JSON.stringify(plan)}`);
      return {
        ok: true as const,
        value: {
          repositories: [
            ...plan.fastForward.map((item) => ({
              path: item.path,
              action: "fast-forward" as const,
              reason: "behind" as const,
              branch: "main",
              otherBranch: item.otherBranch,
              ahead: 0,
              behind: 0,
              uncommitted: 0,
              inUseBy: null,
              remote: null,
              detail: null,
              moved: 99,
              downgraded: false,
            })),
          ],
        },
      };
    }),
    sendExtras: vi.fn<ProjectSyncApi["sendExtras"]>(async (source, target, sent) => {
      calls.push(`extras ${source.label} to ${target.label} ${JSON.stringify(sent.items)}`);
      return {
        ok: true as const,
        value: {
          items: sent.items.map((item) => ({
            kind: item.kind,
            path: item.path,
            branch: item.kind === "branch" ? item.branch : null,
            status: "sent" as const,
            arrivedAs:
              item.kind === "branch"
                ? `swc/from-M4/${item.branch}`
                : "swc/from-M4/uncommitted-20261118-141502-a3f9c1",
            landed: "created" as const,
            stays: null,
            detail: null,
            bytes: 2048,
            includedCommits: 0,
            includedBranch: null,
            leftOut: [],
            leftOutNotListed: 0,
          })),
        },
      };
    }),
  };
  return { api, calls };
}

const target = (on: SyncMachine, blocked: SyncTarget["blocked"] = null): SyncTarget => ({
  machine: on,
  blocked,
});

async function render(
  api: ProjectSyncApi,
  targets: SyncTarget[] = [target(M5)],
  handlers: { onClose?: () => void; onCompare?: (machine: SyncMachine) => void } = {},
) {
  await act(async () =>
    root.render(
      <ProjectSyncDialog
        projectTitle="Atlas"
        shown={M4}
        targets={targets}
        onClose={handlers.onClose ?? vi.fn()}
        onCompare={handlers.onCompare ?? vi.fn()}
        api={api}
      />,
    ),
  );
}

const stage = () =>
  document.querySelector("[data-project-sync]")?.getAttribute("data-project-sync");
const cell = (path: string, side: "a" | "b") =>
  document.querySelector(`[data-sync-row="${path}"] [data-sync-cell="${side}"]`)?.textContent ?? "";
const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!;
const click = async (selector: string) => act(async () => button(selector).click());
const tick = async (kind: string) =>
  act(async () =>
    document
      .querySelector<HTMLElement>(`[data-sync-extra="${kind}"] [data-slot="checkbox"]`)!
      .click(),
  );

it("fetches on both machines, shows what Sync does per repository, then runs it", async () => {
  const { api, calls } = scripted({
    fetch: {
      M4: fetched(facts("."), facts("apps/site", { behind: 99 })),
      M5: fetched(facts(".", { uncommitted: 2, inUseBy: "Docs lint" }), facts("apps/site")),
    },
  });
  await render(api);
  expect(stage()).toBe("plan");
  expect(document.querySelector("h2")?.textContent).toBe("Sync Atlas: M4 and M5");
  expect(calls).toEqual(["fetch M4", "fetch M5", "inventory M4", "inventory M5"]);
  expect(cell("apps/site", "a")).toBe("M4mainMoves forward 99 commits");
  expect(cell("apps/site", "b")).toBe("M5mainUp to date");
  // Level with its upstream, with uncommitted files and a thread at work: never bare.
  expect(cell(".", "b")).toBe("M5mainUp to date2 uncommitted filesIn use by Docs lint");

  await click("[data-sync-run]");
  expect(stage()).toBe("result");
  // Only the machine with something to move is asked, and only for that.
  expect(calls.slice(4)).toEqual([
    'run M4 {"fastForward":[{"path":"apps/site","otherBranch":"main"}],"clone":[]}',
  ]);
  expect(cell("apps/site", "a")).toBe("M4mainMoved forward 99 commits");
  expect(cell(".", "b")).toBe("M5mainUp to date2 uncommitted filesIn use by Docs lint");
  expect(document.querySelector("h2")?.textContent).toBe("Atlas is in sync on M4 and M5");

  await click("[data-sync-again]");
  expect(calls.slice(5)).toEqual(["fetch M4", "fetch M5", "inventory M4", "inventory M5"]);
});

it("lists extras unticked and sends only what is ticked, from the machine that has it", async () => {
  const { api, calls } = scripted({
    fetch: { M4: fetched(facts(".")), M5: fetched(facts(".")) },
    inventory: { M4: WORK },
  });
  await render(api);
  expect(document.querySelectorAll('[data-slot="checkbox"][data-checked]')).toHaveLength(0);
  expect(document.querySelector('[data-sync-extras="a"]')?.textContent).toContain(
    "Only on M4 · Git does not carry these",
  );
  expect(document.querySelector('[data-sync-extras="b"]')).toBeNull();
  // Nothing to move and nothing ticked: Sync has nothing to do.
  expect(button("[data-sync-run]").disabled).toBe(true);
  // Stashes stay: their line cannot be ticked.
  expect(
    document
      .querySelector('[data-sync-extra="stashes"] [data-slot="checkbox"]')
      ?.hasAttribute("data-disabled"),
  ).toBe(true);
  // A secret by its name has no "Send anyway"; a finding has one, off until its files are ticked.
  expect(document.querySelector('[data-sync-left-out="name"] [data-sync-send-anyway]')).toBeNull();
  const anyway = '[data-sync-left-out="content"] [data-sync-send-anyway]';
  expect(button(anyway).disabled).toBe(true);

  await tick("not-pushed");
  await tick("uncommitted");
  expect(button(anyway).disabled).toBe(false);
  await click(anyway);
  await click("[data-sync-run]");
  expect(stage()).toBe("result");
  expect(calls.slice(4)).toEqual([
    'extras M4 to M5 [{"kind":"branch","path":".","branch":"fix/menu"},{"kind":"uncommitted","path":".","sendAnyway":["notes/keys.txt"]}]',
  ]);
  const results = document.querySelector('[data-sync-extra-results="a"]')?.textContent ?? "";
  expect(results).toContain(
    "On M5 as branch swc/from-M4/fix/menu. To use it there, check it out or merge it.",
  );
  expect(results).toContain("Uncommitted files in Atlas");
});

it("starts with a machine picker when several machines have the project", async () => {
  const { api, calls } = scripted({
    fetch: { M4: fetched(facts(".")), Mini: fetched(facts(".")) },
  });
  await render(api, [
    target(M5, { text: "{machine} offline", values: { machine: "M5" } }),
    target(MINI),
  ]);
  expect(stage()).toBe("pick");
  expect(calls).toEqual([]);
  expect(document.querySelector("h2")?.textContent).toBe("Sync Atlas");
  expect(button('[data-sync-target="m5:m5-p"]').disabled).toBe(true);
  expect(button('[data-sync-target="m5:m5-p"]').textContent).toBe("M5M5 offline");
  await click('[data-sync-target="mini:mini-p"]');
  expect(stage()).toBe("plan");
  expect(document.querySelector("h2")?.textContent).toBe("Sync Atlas: M4 and Mini");
});

it("says why a machine could not take part, changes nothing, and offers the slow path", async () => {
  const onCompare = vi.fn<(machine: SyncMachine) => void>();
  const onClose = vi.fn<() => void>();
  const { api } = scripted({
    fetch: {
      M4: fetched(facts(".")),
      M5: { cause: "Unknown request tag: projectSync.fetch" },
    },
  });
  await render(api, [target(M5)], { onCompare, onClose });
  expect(stage()).toBe("failed");
  expect(document.querySelector('[data-sync-failure="needs-update"]')?.textContent).toBe(
    'Update SpecWithCode on M5 to sync with Git. "Compare all files…" works now.',
  );
  expect(api.run).not.toHaveBeenCalled();
  await click("[data-sync-compare]");
  expect(onCompare).toHaveBeenCalledWith(M5);
  expect(onClose).toHaveBeenCalledTimes(1);
});
