// @vitest-environment jsdom
import {
  PROJECT_SYNC_PATH_UNREAD_DETAIL,
  PROJECT_SYNC_STATE_UNREAD_DETAIL,
  PROJECT_SYNC_UNVERIFIED_DETAIL,
} from "@specweave-studio/contracts";
import type {
  ProjectSyncFetchResult,
  ProjectSyncInventoryResult,
  ProjectSyncRepositoryFacts,
  ProjectSyncStatusResult,
  ProjectSyncStepResult,
} from "@specweave-studio/contracts";
import { act, StrictMode } from "react";
import { flushSync } from "react-dom";
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
const LAPTOP_E = machine("laptopE", "Laptop E");
const RACK_F = machine("rackF", "Rack F");
const SHELF_G = machine("shelfG", "Shelf G");

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
/** A fetch answer from a machine that moves only by the guarded fast-forward. */
const fetched = (...repositories: ProjectSyncRepositoryFacts[]): ProjectSyncFetchResult => ({
  repositories,
  fetchId: "fetch-1",
  guardedFastForward: true,
  scanLimited: false,
});
/** The same answer from a machine on an older version: no fetch id, no guarded move. */
const older = (...repositories: ProjectSyncRepositoryFacts[]): ProjectSyncFetchResult => ({
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

const step = (path: string, extra: Partial<ProjectSyncStepResult> = {}): ProjectSyncStepResult => ({
  path,
  action: "fast-forward",
  reason: "behind",
  branch: "main",
  otherBranch: "main",
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  inUseBy: null,
  remote: null,
  detail: null,
  moved: 1,
  downgraded: false,
  ...extra,
});
const checkout = (path: string, branch: string | null = "main", head = "a".repeat(40)) => ({
  path,
  branch,
  head,
  clean: true,
});

/**
 * An API that answers from the given facts and records every call. After a run each
 * machine's status is what its fetch said, unless the test says what it is then.
 */
function scripted(input: {
  fetch: Record<string, ProjectSyncFetchResult | { cause: unknown }>;
  inventory?: Record<string, ProjectSyncInventoryResult>;
  status?: Record<string, ProjectSyncStatusResult | { cause: unknown }>;
  /** What a machine's run answers, instead of moving each asked checkout 99 commits. */
  run?: Record<string, ProjectSyncStepResult[]>;
}) {
  const calls: string[] = [];
  const api: ProjectSyncApi = {
    status: vi.fn<ProjectSyncApi["status"]>(async (on) => {
      const said = input.status?.[on.label];
      if (said)
        return "cause" in said ? { ok: false, cause: said.cause } : { ok: true, value: said };
      const answer = input.fetch[on.label]!;
      if ("cause" in answer) return { ok: false, cause: answer.cause };
      return {
        ok: true,
        value: {
          scanLimited: answer.scanLimited,
          repositories: answer.repositories.map((item) => ({
            path: item.path,
            branch: item.branch,
            head: item.head,
            clean: item.uncommitted === 0,
          })),
        },
      };
    }),
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
      const said = input.run?.[on.label];
      if (said) return { ok: true as const, value: { repositories: said } };
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
                ? `swc/from-laptop-e/${item.branch}`
                : "swc/from-laptop-e/uncommitted-20261118-141502-a3f9c1",
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

type Handlers = {
  onClose?: () => void;
  onCompare?: (machine: SyncMachine) => void;
  shownBlocked?: SyncTarget["blocked"];
};
const dialog = (api: ProjectSyncApi, targets: SyncTarget[], handlers: Handlers) => (
  <ProjectSyncDialog
    projectTitle="Atlas"
    shown={LAPTOP_E}
    shownBlocked={handlers.shownBlocked ?? null}
    targets={targets}
    onClose={handlers.onClose ?? vi.fn()}
    onCompare={handlers.onCompare ?? vi.fn()}
    api={api}
  />
);
async function render(
  api: ProjectSyncApi,
  targets: SyncTarget[] = [target(RACK_F)],
  handlers: Handlers = {},
) {
  await act(async () => root.render(dialog(api, targets, handlers)));
}
const READ_ONLY = (on: SyncMachine): SyncTarget["blocked"] => ({
  text: "This window can only read {machine}",
  values: { machine: on.label },
});
const extraStates = (side: "a" | "b") =>
  [
    ...document.querySelectorAll(`[data-sync-extra-results="${side}"] [data-sync-extra-result]`),
  ].map((item) => item.getAttribute("data-sync-extra-result"));
const count = (list: readonly (string | null)[], state: string) =>
  list.filter((item) => item === state).length;
/** Repositories with 150 branches only on Laptop E each: 200 go in one call. */
const branches = (...paths: string[]): ProjectSyncInventoryResult => ({
  scanLimited: false,
  repositories: paths.map((path) => ({
    ...WORK.repositories[0]!,
    path,
    notPushed: [],
    onlyHere: Array.from({ length: 150 }, (_, at) => ({
      branch: `try/${at}`,
      head: "c".repeat(40),
      commits: 1,
    })),
    leftOut: [],
    stashes: 0,
  })),
});
const tickAll = async () => {
  for (const box of document.querySelectorAll<HTMLElement>(
    '[data-sync-extra="only-here"] [data-slot="checkbox"]',
  ))
    await act(async () => box.click());
};

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
      "Laptop E": fetched(facts("."), facts("apps/site", { behind: 99 })),
      "Rack F": fetched(facts(".", { uncommitted: 2, inUseBy: "Docs lint" }), facts("apps/site")),
    },
  });
  await render(api);
  expect(stage()).toBe("plan");
  expect(document.querySelector("h2")?.textContent).toBe("Sync Atlas: Laptop E and Rack F");
  expect(calls).toEqual([
    "fetch Laptop E",
    "fetch Rack F",
    "inventory Laptop E",
    "inventory Rack F",
  ]);
  expect(cell("apps/site", "a")).toBe("Laptop EmainMoves forward 99 commits");
  expect(cell("apps/site", "b")).toBe("Rack FmainUp to date");
  // Level with its upstream, with uncommitted files and a thread at work: never bare.
  expect(cell(".", "b")).toBe("Rack FmainUp to date2 uncommitted filesIn use by Docs lint");

  await click("[data-sync-run]");
  expect(stage()).toBe("result");
  // Only the machine with something to move is asked, and only for that.
  expect(calls.slice(4)).toEqual([
    'run Laptop E {"fetchId":"fetch-1","fastForward":[{"path":"apps/site","otherBranch":"main"}],"clone":[]}',
  ]);
  expect(cell("apps/site", "a")).toBe("Laptop EmainMoved forward 99 commits");
  expect(cell(".", "b")).toBe("Rack FmainUp to date2 uncommitted filesIn use by Docs lint");
  // Rack F still has uncommitted files and a thread at work: finished, never "in sync".
  expect(document.querySelector("h2")?.textContent).toBe(
    "Sync finished for Atlas: Laptop E and Rack F",
  );
  // The result is said once in the region that stays, and the title takes the focus.
  expect(document.querySelector("[data-sync-live]")?.textContent).toBe(
    "Sync finished for Atlas: Laptop E and Rack F",
  );
  expect(document.activeElement).toBe(document.querySelector("h2 span"));

  await click("[data-sync-again]");
  expect(calls.slice(5)).toEqual([
    "fetch Laptop E",
    "fetch Rack F",
    "inventory Laptop E",
    "inventory Rack F",
  ]);
});

it("says in sync only when nothing is left on either machine", async () => {
  const { api } = scripted({
    fetch: { "Laptop E": fetched(facts(".", { behind: 3 })), "Rack F": fetched(facts(".")) },
  });
  await render(api);
  await click("[data-sync-run]");
  expect(document.querySelector("h2")?.textContent).toBe("Atlas is in sync on Laptop E and Rack F");
  // The repositories are a table: a cell is heard with its machine's column.
  expect(document.querySelector('[role="table"]')?.getAttribute("aria-label")).toBe("Repositories");
  expect(
    [...document.querySelectorAll('[role="columnheader"]')].map((item) => item.textContent),
  ).toEqual(["Repository", "Laptop E", "Rack F"]);
});

it("keeps the weaker title while work is listed under a machine", async () => {
  const { api } = scripted({
    fetch: { "Laptop E": fetched(facts(".", { behind: 3 })), "Rack F": fetched(facts(".")) },
    inventory: { "Laptop E": WORK },
  });
  await render(api);
  await click("[data-sync-run]");
  expect(document.querySelector("h2")?.textContent).toBe(
    "Sync finished for Atlas: Laptop E and Rack F",
  );
});

it("ends its check under StrictMode, which mounts every effect twice", async () => {
  const { api } = scripted({
    fetch: { "Laptop E": fetched(facts(".")), "Rack F": fetched(facts(".")) },
  });
  await act(async () =>
    root.render(
      <StrictMode>
        <ProjectSyncDialog
          projectTitle="Atlas"
          shown={LAPTOP_E}
          targets={[target(RACK_F)]}
          onClose={vi.fn()}
          onCompare={vi.fn()}
          api={api}
        />
      </StrictMode>,
    ),
  );
  expect(stage()).toBe("plan");
});

it("keeps apart what a receipt confirms, what was sent with no answer, and what never left", async () => {
  const paths = [".", "apps/site", "tools/cli"];
  const { api } = scripted({
    fetch: {
      "Laptop E": fetched(...paths.map((path) => facts(path))),
      "Rack F": fetched(...paths.map((path) => facts(path))),
    },
    inventory: { "Laptop E": branches(...paths) },
  });
  const send = api.sendExtras;
  let sends = 0;
  api.sendExtras = vi.fn<ProjectSyncApi["sendExtras"]>(async (...args) => {
    sends += 1;
    return sends === 1
      ? send(...args)
      : { ok: false as const, cause: { _tag: "SchemaError", message: "Expected one of…" } };
  });
  await render(api);
  await tickAll();
  await click("[data-sync-run]");
  // 450 branches: 200 answered, 200 sent with an answer that could not be read, 50 never asked.
  expect(sends).toBe(2);
  const states = extraStates("a");
  expect([count(states, "sent"), count(states, "unknown"), count(states, "not-sent")]).toEqual([
    200, 200, 50,
  ]);
  const results = document.querySelector('[data-sync-extra-results="a"]')!;
  const text = results.textContent ?? "";
  expect(results.querySelector("[data-sync-extras-outcome]")?.textContent).toBe(
    "Laptop E sent extras and no answer came back. They may have arrived: check Rack F before sending again.",
  );
  expect(text).not.toContain("were not sent");
  expect(text).toContain("Laptop E answered in a way this version does not read.");
  expect(text).not.toContain("Expected one of");
  // Each line keeps its branch, so the person knows which to look for on Rack F.
  const unknown = results.querySelector('[data-sync-extra-result="unknown"]')?.textContent ?? "";
  expect(unknown).toMatch(/^try\/\d+ · /);
  expect(unknown).toContain(
    "No answer came back. It may have arrived on Rack F: check Rack F before sending again.",
  );
  expect(results.querySelector('[data-sync-extra-result="not-sent"]')?.textContent).toContain(
    "Not sent.",
  );
  expect(document.querySelector("h2")?.textContent).toBe("Sync Atlas: Laptop E and Rack F");
  expect(document.querySelector("[data-sync-live]")?.textContent).toBe(
    "Sync ended, and not every answer came back. Each line says what to check.",
  );
});

it("says not sent only for a call the machine refused before sending anything", async () => {
  const { api } = scripted({
    fetch: { "Laptop E": fetched(facts(".")), "Rack F": fetched(facts(".")) },
    inventory: { "Laptop E": WORK },
  });
  api.sendExtras = vi.fn<ProjectSyncApi["sendExtras"]>(async () => ({
    ok: false as const,
    cause: { _tag: "ProjectSyncError", code: "not_found", message: "Rack F is not linked." },
  }));
  await render(api);
  await tick("not-pushed");
  await click("[data-sync-run]");
  expect(extraStates("a")).toEqual(["not-sent"]);
  expect(document.querySelector("[data-sync-extras-outcome]")?.textContent).toBe(
    "The extras from Laptop E were not sent.",
  );
});

it("drops the plan and its ticks when a machine can no longer sync", async () => {
  const { api, calls } = scripted({
    fetch: { "Laptop E": fetched(facts(".", { behind: 3 })), "Rack F": fetched(facts(".")) },
    inventory: { "Laptop E": WORK },
  });
  await render(api);
  await tick("not-pushed");
  expect(button("[data-sync-run]").disabled).toBe(false);

  // The grant on the other machine changes while the plan is on screen.
  await render(api, [target(RACK_F, READ_ONLY(RACK_F))]);
  expect(stage()).toBe("failed");
  expect(document.querySelector('[data-sync-failure="blocked"]')?.textContent).toBe(
    "This window can only read Rack F",
  );
  expect(document.querySelector("[data-sync-run]")).toBeNull();
  expect(api.run).not.toHaveBeenCalled();

  // Allowed again: nothing comes back by itself, and a new check starts with nothing ticked.
  await render(api);
  expect(stage()).toBe("failed");
  await click("[data-sync-again]");
  expect(stage()).toBe("plan");
  expect(calls.filter((item) => item === "fetch Rack F")).toHaveLength(2);
  expect(document.querySelectorAll('[data-slot="checkbox"][data-checked]')).toHaveLength(0);
});

it("drops the plan when the machine shown can no longer sync", async () => {
  const { api } = scripted({
    fetch: { "Laptop E": fetched(facts(".", { behind: 3 })), "Rack F": fetched(facts(".")) },
  });
  await render(api);
  expect(stage()).toBe("plan");
  await render(api, [target(RACK_F)], { shownBlocked: READ_ONLY(LAPTOP_E) });
  expect(stage()).toBe("failed");
  expect(document.querySelector('[data-sync-failure="blocked"]')?.textContent).toBe(
    "This window can only read Laptop E",
  );
  expect(api.run).not.toHaveBeenCalled();
});

it("stops between two calls when a grant changes during the run", async () => {
  const paths = [".", "apps/site"];
  const { api } = scripted({
    fetch: {
      "Laptop E": fetched(...paths.map((path) => facts(path))),
      "Rack F": fetched(...paths.map((path) => facts(path))),
    },
    inventory: { "Laptop E": branches(...paths) },
  });
  const send = api.sendExtras;
  api.sendExtras = vi.fn<ProjectSyncApi["sendExtras"]>(async (...args) => {
    const answer = await send(...args);
    // The first call is answered, then the window loses its grant on Rack F.
    flushSync(() => root.render(dialog(api, [target(RACK_F, READ_ONLY(RACK_F))], {})));
    return answer;
  });
  await render(api);
  await tickAll();
  await click("[data-sync-run]");
  expect(api.sendExtras).toHaveBeenCalledTimes(1);
  const states = extraStates("a");
  expect([count(states, "sent"), count(states, "not-sent")]).toEqual([200, 100]);
  const results = document.querySelector('[data-sync-extra-results="a"]')?.textContent ?? "";
  expect(results).toContain("The rest of the extras from Laptop E were not sent.");
  expect(results).toContain("This window can only read Rack F");
});

/** Two repositories of branches on each machine, and a first send that waits to be let go. */
async function midRun() {
  const paths = [".", "apps/site"];
  const { api } = scripted({
    fetch: {
      "Laptop E": fetched(...paths.map((path) => facts(path))),
      "Rack F": fetched(...paths.map((path) => facts(path))),
    },
    inventory: { "Laptop E": branches(...paths), "Rack F": branches(...paths) },
  });
  const send = api.sendExtras;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  api.sendExtras = vi.fn<ProjectSyncApi["sendExtras"]>(async (...args) => {
    const wait = first;
    first = false;
    if (wait) await held;
    return send(...args);
  });
  await render(api);
  await tickAll();
  // Not awaited to its end: the first send is outstanding.
  await act(async () => button("[data-sync-run]").click());
  expect(api.sendExtras).toHaveBeenCalledTimes(1);
  return { api, release: () => act(async () => release()) };
}

it("sends nothing more once the dialog is closed during a send", async () => {
  const { api, release } = await midRun();
  await act(async () => root.render(<div />));
  await release();
  // Batch two of Laptop E and everything of Rack F stay unsent, and nobody is asked where they stand.
  expect(api.sendExtras).toHaveBeenCalledTimes(1);
  expect(api.status).not.toHaveBeenCalled();
});

it("asks for no inventory after a check whose dialog was closed", async () => {
  const { api } = scripted({
    fetch: { "Laptop E": fetched(facts(".")), "Rack F": fetched(facts(".")) },
  });
  const fetchOf = api.fetch;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  api.fetch = vi.fn<ProjectSyncApi["fetch"]>(async (on) => {
    await held;
    return fetchOf(on);
  });
  await render(api);
  expect(stage()).toBe("checking");
  await act(async () => root.render(<div />));
  await act(async () => release());
  expect(api.inventory).not.toHaveBeenCalled();
});

it("does not revive a run when a grant is lost and comes back during a send", async () => {
  const { api, release } = await midRun();
  await render(api, [target(RACK_F, READ_ONLY(RACK_F))]);
  await render(api);
  await release();
  expect(api.sendExtras).toHaveBeenCalledTimes(1);
  expect(api.status).not.toHaveBeenCalled();
  expect(stage()).toBe("result");
  // What was answered is kept; the rest says it was never sent, on both machines.
  const a = extraStates("a");
  expect([count(a, "sent"), count(a, "not-sent")]).toEqual([200, 100]);
  expect(count(extraStates("b"), "not-sent")).toBe(300);
  expect(document.querySelector('[data-sync-extra-results="a"]')?.textContent).toContain(
    "This window can only read Rack F",
  );
  expect(document.querySelector("h2")?.textContent).not.toContain("in sync");
});

it("shows an extra the source could not confirm as one that may have arrived", async () => {
  const { api } = scripted({
    fetch: { "Laptop E": fetched(facts(".")), "Rack F": fetched(facts(".")) },
    inventory: { "Laptop E": WORK },
  });
  const send = api.sendExtras;
  // The call succeeds: the uncommitted files have a receipt, the branch has none from Rack F.
  api.sendExtras = vi.fn<ProjectSyncApi["sendExtras"]>(async (...args) => {
    const answer = await send(...args);
    if (!answer.ok) return answer;
    return {
      ok: true as const,
      value: {
        items: answer.value.items.map((item) =>
          item.kind === "branch"
            ? {
                ...item,
                status: "stays" as const,
                arrivedAs: null,
                landed: null,
                stays: "unreachable" as const,
                detail: "The link closed after 30 s.",
                bytes: 0,
              }
            : item,
        ),
      },
    };
  });
  await render(api);
  await tick("not-pushed");
  await tick("uncommitted");
  await click("[data-sync-run]");
  expect(extraStates("a")).toEqual(["unknown", "sent"]);
  const line = document.querySelector('[data-sync-extra-result="unknown"]')?.textContent ?? "";
  expect(line).toContain(
    "No answer came back. It may have arrived on Rack F: check Rack F before sending again.",
  );
  expect(line).toContain("The link closed after 30 s.");
  expect(line).not.toContain("Stays");
  expect(document.querySelector("[data-sync-live]")?.textContent).toBe(
    "Sync ended, and not every answer came back. Each line says what to check.",
  );
});

it("never says in sync when neither machine read a repository the result shows", async () => {
  const { api } = scripted({
    fetch: {
      "Laptop E": fetched(facts(".", { behind: 3 }), facts("tools/cli")),
      "Rack F": fetched(facts("."), facts("tools/cli")),
    },
    // Afterwards both scans leave the nested repository out.
    status: {
      "Laptop E": { scanLimited: false, repositories: [checkout(".")] },
      "Rack F": { scanLimited: false, repositories: [checkout(".")] },
    },
  });
  await render(api);
  await click("[data-sync-run]");
  expect(stage()).toBe("result");
  expect(document.querySelector('[data-sync-row="tools/cli"]')).not.toBeNull();
  expect(document.querySelector("h2")?.textContent).toBe(
    "Sync finished for Atlas: Laptop E and Rack F",
  );
});

it("says a repository unread after the run could not be read, and leaves the other machine's cell", async () => {
  const unread = { path: "tools/cli", branch: null, head: null, clean: false, unread: true };
  const { api } = scripted({
    fetch: {
      "Laptop E": fetched(facts(".", { behind: 3 }), facts("tools/cli")),
      "Rack F": fetched(facts("."), facts("tools/cli")),
    },
    status: {
      "Laptop E": {
        scanLimited: false,
        repositories: [unread, { ...checkout("."), unread: true }],
      },
      "Rack F": { scanLimited: false, repositories: [checkout("."), checkout("tools/cli")] },
    },
  });
  await render(api);
  expect(cell("tools/cli", "a")).toBe("Laptop EmainUp to date");
  const before = cell("tools/cli", "b");
  await click("[data-sync-run]");
  expect(stage()).toBe("result");
  // Nothing moved there, and the last read says the checkout could not be read.
  expect(cell("tools/cli", "a")).toBe("Laptop ECould not be read. Not moved");
  expect(
    document.querySelector(
      '[data-sync-row="tools/cli"] [data-sync-cell="a"] .text-success-foreground',
    ),
  ).toBeNull();
  expect(cell("tools/cli", "b")).toBe(before);
  // The move the run confirmed stays, marked apart from what is unknown now.
  expect(cell(".", "a")).toContain("Moved forward");
  expect(cell(".", "a")).toContain("Its state could not be read after the run");
  expect(
    document.querySelector('[data-sync-row="."] [data-sync-cell="a"] .text-success-foreground'),
  ).toBeNull();
  // A row left unknown is not a finished sync.
  expect(document.querySelector("h2")?.textContent).toBe("Sync Atlas: Laptop E and Rack F");
});

it("never says in sync when one machine lists a repository twice", async () => {
  const { api } = scripted({
    fetch: {
      "Laptop E": fetched(facts(".", { behind: 3 }), facts("tools/cli")),
      "Rack F": fetched(facts("."), facts("tools/cli")),
    },
    status: {
      "Laptop E": { scanLimited: false, repositories: [checkout("."), checkout(".")] },
      "Rack F": { scanLimited: false, repositories: [checkout("."), checkout("tools/cli")] },
    },
  });
  await render(api);
  await click("[data-sync-run]");
  expect(document.querySelector("h2")?.textContent).toBe(
    "Sync finished for Atlas: Laptop E and Rack F",
  );
});

it("leaves no Sync to press once the pair is blocked, and a late press moves nothing", async () => {
  const { api } = scripted({
    fetch: { "Laptop E": fetched(facts(".", { behind: 3 })), "Rack F": fetched(facts(".")) },
  });
  await render(api);
  const run = button("[data-sync-run]");
  // The press arrives after the block: the button it was aimed at is gone.
  await act(async () => {
    flushSync(() => root.render(dialog(api, [target(RACK_F, READ_ONLY(RACK_F))], {})));
    run.click();
  });
  expect(api.run).not.toHaveBeenCalled();
  expect(stage()).toBe("failed");
  expect(document.querySelector("[data-sync-run]")).toBeNull();
});

it("never says in sync for a clone that landed on another branch", async () => {
  const { api } = scripted({
    fetch: {
      "Laptop E": fetched(
        facts("."),
        facts("tools/cli", { branch: "release", head: "b".repeat(40) }),
      ),
      "Rack F": fetched(facts(".")),
    },
    status: {
      "Laptop E": {
        scanLimited: false,
        repositories: [checkout("."), checkout("tools/cli", "release", "b".repeat(40))],
      },
      // The clone checked out the remote's default branch.
      "Rack F": {
        scanLimited: false,
        repositories: [checkout("."), checkout("tools/cli", "main", "c".repeat(40))],
      },
    },
  });
  api.run = vi.fn<ProjectSyncApi["run"]>(async (_on, plan) => ({
    ok: true as const,
    value: {
      repositories: plan.clone.map((item) =>
        step(item.path, { action: "clone", reason: "missing", moved: 0 }),
      ),
    },
  }));
  await render(api);
  await click("[data-sync-run]");
  expect(stage()).toBe("result");
  expect(cell("tools/cli", "b")).toContain("main");
  expect(document.querySelector("h2")?.textContent).toBe(
    "Sync finished for Atlas: Laptop E and Rack F",
  );
});

it("never says in sync for two machines that moved forward on different upstreams", async () => {
  const { api } = scripted({
    fetch: {
      "Laptop E": fetched(facts(".", { behind: 2, upstream: "origin/main" })),
      "Rack F": fetched(facts(".", { behind: 4, upstream: "fork/main" })),
    },
    status: {
      "Laptop E": { scanLimited: false, repositories: [checkout(".", "main", "d".repeat(40))] },
      "Rack F": { scanLimited: false, repositories: [checkout(".", "main", "e".repeat(40))] },
    },
  });
  await render(api);
  await click("[data-sync-run]");
  expect(stage()).toBe("result");
  expect(document.querySelector("h2")?.textContent).toBe(
    "Sync finished for Atlas: Laptop E and Rack F",
  );
});

it("never says in sync when a machine did not say where it is after the run", async () => {
  const { api } = scripted({
    fetch: { "Laptop E": fetched(facts(".", { behind: 3 })), "Rack F": fetched(facts(".")) },
    status: { "Rack F": { cause: new Error("socket closed") } },
  });
  await render(api);
  await click("[data-sync-run]");
  expect(document.querySelector("h2")?.textContent).toBe(
    "Sync finished for Atlas: Laptop E and Rack F",
  );
});

it("shows the branch the answer names, also when it names none", async () => {
  const { api } = scripted({
    fetch: {
      "Laptop E": fetched(facts(".", { behind: 3 }), facts("tools/cli")),
      "Rack F": fetched(facts(".")),
    },
  });
  api.run = vi.fn<ProjectSyncApi["run"]>(async (on) =>
    on.label === "Laptop E"
      ? {
          ok: true as const,
          // Detached between the plan and the run: the machine is on no branch.
          value: {
            repositories: [
              step(".", { action: "none", reason: "detached", branch: null, moved: 0 }),
            ],
          },
        }
      : { ok: false as const, cause: new Error("socket closed") },
  );
  await render(api);
  expect(cell(".", "a")).toContain("main");
  await click("[data-sync-run]");
  expect(cell(".", "a")).not.toContain("main");
  // A clone was asked for and no answer came: nobody knows whether it is there.
  expect(
    document.querySelector('[data-sync-row="tools/cli"] [data-sync-cell="b"] [data-sync-missing]'),
  ).toBeNull();
});

it("lists extras unticked and sends only what is ticked, from the machine that has it", async () => {
  const { api, calls } = scripted({
    fetch: { "Laptop E": fetched(facts(".")), "Rack F": fetched(facts(".")) },
    inventory: { "Laptop E": WORK },
  });
  await render(api);
  expect(document.querySelectorAll('[data-slot="checkbox"][data-checked]')).toHaveLength(0);
  expect(document.querySelector('[data-sync-extras="a"]')?.textContent).toContain(
    "Only on Laptop E · Git does not carry these",
  );
  expect(document.querySelector('[data-sync-extras="b"]')).toBeNull();
  // Nothing to move and nothing ticked: Sync has nothing to do.
  expect(button("[data-sync-run]").disabled).toBe(true);
  // Stashes stay: their line has no box to tick, and the others keep theirs.
  expect(document.querySelector('[data-sync-extra="stashes"]')?.textContent).toContain("1 stash");
  expect(document.querySelector('[data-sync-extra="stashes"] [data-slot="checkbox"]')).toBeNull();
  expect(document.querySelector('[data-sync-extra="stashes"] label')).toBeNull();
  expect(
    document.querySelector('[data-sync-extra="uncommitted"] [data-slot="checkbox"]'),
  ).not.toBeNull();
  // A secret by its name has no "Send anyway"; a finding has one, off until its files are ticked.
  expect(document.querySelector('[data-sync-left-out="name"] [data-sync-send-anyway]')).toBeNull();
  const anyway = '[data-sync-left-out="content"] [data-sync-send-anyway]';
  expect(button(anyway).disabled).toBe(true);
  // A button that is off says why, in its title and in the note it points at.
  expect(button(anyway).title).toBe("Tick the uncommitted files of Atlas first.");
  const note = document.querySelector("[data-sync-check-note]")!;
  expect(button(anyway).getAttribute("aria-describedby")).toBe(note.id);
  expect(note.textContent).toContain("Checked by file name, and untracked files by their first");
  expect(note.textContent).toContain(
    "Send anyway only applies once that repository's uncommitted files are ticked.",
  );

  await tick("not-pushed");
  await tick("uncommitted");
  expect(button(anyway).disabled).toBe(false);
  await click(anyway);
  expect(button(anyway).textContent).toBe("Will be sent");
  // Unticking the files takes the promise back: nothing of them is sent.
  await tick("uncommitted");
  expect(button(anyway).textContent).toBe("Send anyway");
  expect(button(anyway).disabled).toBe(true);
  await tick("uncommitted");
  expect(button(anyway).textContent).toBe("Will be sent");
  await click("[data-sync-run]");
  expect(stage()).toBe("result");
  expect(calls.slice(4)).toEqual([
    'extras Laptop E to Rack F [{"kind":"branch","path":".","branch":"fix/menu"},{"kind":"uncommitted","path":".","sendAnyway":["notes/keys.txt"]}]',
  ]);
  const results = document.querySelector('[data-sync-extra-results="a"]')?.textContent ?? "";
  expect(results).toContain(
    "On Rack F as branch swc/from-laptop-e/fix/menu. To use it there, check it out or merge it.",
  );
  expect(results).toContain("Uncommitted files in Atlas");
});

it("starts with a machine picker when several machines have the project", async () => {
  const { api, calls } = scripted({
    fetch: { "Laptop E": fetched(facts(".")), "Shelf G": fetched(facts(".")) },
  });
  await render(api, [
    {
      ...target(RACK_F, { text: "{machine} offline", values: { machine: "Rack F" } }),
      note: { text: "Offline" },
    },
    target(SHELF_G),
    target(machine("deskB", "Desk B"), { text: "Separate project" }),
  ]);
  expect(stage()).toBe("pick");
  expect(calls).toEqual([]);
  expect(document.querySelector("h2")?.textContent).toBe("Sync Atlas");
  expect(button('[data-sync-target="rackF:rackF-p"]').disabled).toBe(true);
  // The row already names the machine: the reason is said without it.
  expect(button('[data-sync-target="rackF:rackF-p"]').textContent).toBe("Rack FOffline");
  expect(button('[data-sync-target="deskB:deskB-p"]').disabled).toBe(true);
  expect(button('[data-sync-target="deskB:deskB-p"]').textContent).toBe("Desk BSeparate project");
  await click('[data-sync-target="shelfG:shelfG-p"]');
  expect(stage()).toBe("plan");
  expect(document.querySelector("h2")?.textContent).toBe("Sync Atlas: Laptop E and Shelf G");
});

it("says why a machine could not take part, changes nothing, and offers the slow path", async () => {
  const onCompare = vi.fn<(machine: SyncMachine) => void>();
  const onClose = vi.fn<() => void>();
  const { api } = scripted({
    fetch: {
      "Laptop E": fetched(facts(".")),
      "Rack F": { cause: "Unknown request tag: projectSync.fetch" },
    },
  });
  await render(api, [target(RACK_F)], { onCompare, onClose });
  expect(stage()).toBe("failed");
  expect(document.querySelector('[data-sync-failure="needs-update"]')?.textContent).toBe(
    'Update SpecWithCode on Rack F to sync with Git. "Compare all files…" works now.',
  );
  expect(api.run).not.toHaveBeenCalled();
  // Laptop E's fetch ran, so the dialog does not say nothing changed: nothing was moved or sent.
  expect(document.querySelector("[data-project-sync]")?.textContent).toContain(
    "Nothing was moved or sent.",
  );
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  expect(document.activeElement).toBe(document.querySelector("h2 span"));
  await click("[data-sync-compare]");
  expect(onCompare).toHaveBeenCalledWith(RACK_F);
  expect(onClose).toHaveBeenCalledTimes(1);
});

// The fetch a run goes by: each machine's own fetch id, and the guarded move only where the
// machine's fetch says it has it.

it("sends each machine's run and inventory with that machine's own fetch id", async () => {
  const { api, calls } = scripted({
    fetch: {
      "Laptop E": { ...fetched(facts("."), facts("apps/site", { behind: 2 })), fetchId: "fetch-e" },
      "Rack F": { ...fetched(facts(".", { behind: 3 }), facts("apps/site")), fetchId: "fetch-f" },
    },
  });
  await render(api);
  expect(vi.mocked(api.inventory).mock.calls.map(([on, id]) => [on.label, id])).toEqual([
    ["Laptop E", "fetch-e"],
    ["Rack F", "fetch-f"],
  ]);
  await click("[data-sync-run]");
  expect(calls.filter((item) => item.startsWith("run "))).toEqual([
    'run Laptop E {"fetchId":"fetch-e","fastForward":[{"path":"apps/site","otherBranch":"main"}],"clone":[]}',
    'run Rack F {"fetchId":"fetch-f","fastForward":[{"path":".","otherBranch":"main"}],"clone":[]}',
  ]);
});

it("only fetches on a machine without the guarded move, and says it needs an update", async () => {
  const { api, calls } = scripted({
    fetch: {
      "Laptop E": older(facts("."), facts("apps/site", { behind: 2 })),
      "Rack F": fetched(facts(".", { behind: 3 }), facts("apps/site")),
    },
  });
  await render(api);
  expect(cell("apps/site", "a")).toBe("Laptop EmainNeeds update: fetched only, not moved forward");
  await click("[data-sync-run]");
  // Laptop E is never asked to move anything; Rack F moves by its own fetch.
  expect(calls.filter((item) => item.startsWith("run "))).toEqual([
    'run Rack F {"fetchId":"fetch-1","fastForward":[{"path":".","otherBranch":"main"}],"clone":[]}',
  ]);
  expect(cell("apps/site", "a")).toBe("Laptop EmainNeeds update: fetched only, not moved forward");
  expect(document.querySelector("h2")?.textContent).toBe("Sync Atlas: Laptop E and Rack F");
});

it("never builds a run without a fetch id, even from a machine that offers the guarded move", async () => {
  const { api, calls } = scripted({
    fetch: {
      "Laptop E": { ...fetched(facts(".", { behind: 2 })), fetchId: undefined },
      "Rack F": fetched(facts(".")),
    },
  });
  await render(api);
  expect(cell(".", "a")).toBe("Laptop EmainNeeds update: fetched only, not moved forward");
  expect(calls.some((item) => item.startsWith("run "))).toBe(false);
});

it("says a move whose outcome could not be read may have happened, never done", async () => {
  const { api } = scripted({
    fetch: { "Laptop E": fetched(facts(".", { behind: 4 })), "Rack F": fetched(facts(".")) },
    run: {
      "Laptop E": [
        step(".", {
          moved: 0,
          movedUnverified: true,
          downgraded: true,
          detail: PROJECT_SYNC_UNVERIFIED_DETAIL,
        }),
      ],
    },
  });
  await render(api);
  await click("[data-sync-run]");
  expect(cell(".", "a")).toBe(
    "Laptop EmainMay have moved forward: the result could not be read. Check it before working in it",
  );
  expect(document.querySelector("h2")?.textContent).toBe("Sync Atlas: Laptop E and Rack F");
});

it("says a checkout that could not be read is not moved, with what the machine said", async () => {
  const { api } = scripted({
    fetch: {
      "Laptop E": fetched(
        facts(".", { behind: 2, unreadDetail: PROJECT_SYNC_PATH_UNREAD_DETAIL }),
        facts("apps/site", { behind: 1, stateUnread: true }),
      ),
      "Rack F": fetched(facts("."), facts("apps/site")),
    },
  });
  await render(api);
  expect(cell(".", "a")).toBe(
    `Laptop EmainCould not be read. Not moved${PROJECT_SYNC_PATH_UNREAD_DETAIL}`,
  );
  // The machine's sentence says the same as the row: it is not shown twice.
  expect(cell("apps/site", "a")).toBe("Laptop EmainNot moved: its state could not be read");
  expect(cell("apps/site", "a")).not.toContain(PROJECT_SYNC_STATE_UNREAD_DETAIL);
});

it("lists extras that could not be read, or branches it could not judge, and never says in sync", async () => {
  const unread: ProjectSyncInventoryResult = {
    scanLimited: false,
    repositories: [
      {
        ...WORK.repositories[0]!,
        notPushed: [],
        changedFiles: 0,
        untrackedFiles: 0,
        stashes: 0,
        leftOut: [],
        unreadDetail: "What this repository has that Git does not carry could not be read.",
      },
      {
        ...WORK.repositories[0]!,
        path: "apps/site",
        notPushed: [],
        changedFiles: 0,
        untrackedFiles: 0,
        stashes: 0,
        leftOut: [],
        onlyHereUnknown: true,
      },
    ],
  };
  const { api } = scripted({
    fetch: {
      "Laptop E": fetched(facts("."), facts("apps/site")),
      "Rack F": fetched(facts("."), facts("apps/site")),
    },
    inventory: { "Laptop E": unread },
  });
  await render(api);
  const text = (kind: string) =>
    document.querySelector(`[data-sync-extras="a"] [data-sync-extra="${kind}"]`)?.textContent;
  expect(text("unread")).toBe(
    "Atlas could not be read: what is only on Laptop E is not knownWhat this repository has that Git does not carry could not be read.",
  );
  expect(text("only-here-unknown")).toBe(
    "Which branches of apps/site are only on Laptop E could not be read",
  );
  // Neither line has a box: nothing unread is sent.
  expect(document.querySelectorAll('[data-sync-extras="a"] [data-slot="checkbox"]').length).toBe(0);
  await click("[data-sync-run]");
  expect(document.querySelector("h2")?.textContent).not.toContain("in sync");
});

/**
 * A fetch that answers only when the test says so, and records the signal it was given
 * (1469). An aborted call answers as an interrupted one would.
 */
function heldFetch(api: ProjectSyncApi) {
  const signals = new Map<string, AbortSignal>();
  const answers = new Map<string, () => void>();
  api.fetch = vi.fn<ProjectSyncApi["fetch"]>(
    (on, signal) =>
      new Promise((resolve) => {
        signals.set(on.label, signal!);
        signal?.addEventListener("abort", () => resolve({ ok: false, cause: "interrupted" }));
        answers.set(on.label, () => resolve({ ok: true, value: fetched(facts(".")) }));
      }),
  );
  return {
    signals,
    answer: (label: string) => act(async () => answers.get(label)!()),
  };
}
const sideLine = (side: "a" | "b") =>
  document.querySelector(`[data-sync-check-side="${side}"]`)?.textContent ?? "";
const sideState = (side: "a" | "b") =>
  document.querySelector(`[data-sync-check-side="${side}"]`)?.getAttribute("data-sync-check-state");

it("shows each machine's check on its own line, and how long a slow one has taken (AC-04)", async () => {
  vi.useFakeTimers();
  try {
    const { api } = scripted({ fetch: {} });
    const held = heldFetch(api);
    await render(api);
    expect(stage()).toBe("checking");
    expect(sideLine("a")).toBe("Laptop E: fetching…");
    expect(sideLine("b")).toBe("Rack F: fetching…");
    await held.answer("Laptop E");
    expect(sideState("a")).toBe("done");
    expect(sideLine("a")).toBe("Laptop E: fetched");
    await act(async () => vi.advanceTimersByTime(12_000));
    expect(sideLine("b")).toBe("Rack F: still fetching after 12 s…");
    // The screen reader hears the stage once, not a ticking count.
    expect(document.querySelector("[data-sync-live]")?.textContent).toBe(
      "Fetching on Laptop E and Rack F…",
    );
    await held.answer("Rack F");
    expect(stage()).toBe("plan");
  } finally {
    vi.useRealTimers();
  }
});

it("says a machine that does not answer within the backstop, stops it, and keeps the other (AC-05)", async () => {
  vi.useFakeTimers();
  try {
    const { api } = scripted({ fetch: {} });
    const held = heldFetch(api);
    await render(api);
    await held.answer("Laptop E");
    await act(async () => vi.advanceTimersByTime(3 * 60_000));
    expect(stage()).toBe("failed");
    expect(held.signals.get("Rack F")?.aborted).toBe(true);
    expect(held.signals.get("Laptop E")?.aborted).toBe(false);
    expect(document.querySelector('[data-sync-failure="no-answer"]')?.textContent).toBe(
      "Rack F did not answer within 3 minutes, so its check was stopped. Check again when it is less busy.",
    );
    expect(sideLine("a")).toBe("Laptop E: fetched");
    expect(sideLine("b")).toBe("Rack F: not answering");
    expect(button("[data-sync-again]")).not.toBeNull();
    expect(api.run).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("stops both machines' calls on Cancel (AC-06)", async () => {
  const onClose = vi.fn<() => void>();
  const { api } = scripted({ fetch: {} });
  const held = heldFetch(api);
  await render(api, [target(RACK_F)], { onClose });
  expect(held.signals.get("Laptop E")?.aborted).toBe(false);
  await click("[data-sync-cancel]");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(held.signals.get("Laptop E")?.aborted).toBe(true);
  expect(held.signals.get("Rack F")?.aborted).toBe(true);
  expect(api.inventory).not.toHaveBeenCalled();
});

it("keeps its check through StrictMode's second mount, and stops it when closed (AC-06)", async () => {
  vi.useFakeTimers();
  try {
    const { api } = scripted({ fetch: {} });
    const held = heldFetch(api);
    await act(async () =>
      root.render(
        <StrictMode>
          <ProjectSyncDialog
            projectTitle="Atlas"
            shown={LAPTOP_E}
            targets={[target(RACK_F)]}
            onClose={vi.fn()}
            onCompare={vi.fn()}
            api={api}
          />
        </StrictMode>,
      ),
    );
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(held.signals.get("Rack F")?.aborted).toBe(false);
    await act(async () => root.render(<></>));
    await act(async () => vi.advanceTimersByTime(1));
    expect(held.signals.get("Laptop E")?.aborted).toBe(true);
    expect(held.signals.get("Rack F")?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
