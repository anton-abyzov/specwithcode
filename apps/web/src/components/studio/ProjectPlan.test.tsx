// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  CommandId,
  ProjectId,
  type ProjectPlanSnapshot,
  type ThreadId,
} from "@specweave-studio/contracts";
const state = vi.hoisted(() => ({
  data: null as ProjectPlanSnapshot | null,
  refresh: vi.fn(),
  close: vi.fn(),
  open: vi.fn(),
  execute: vi.fn(),
  terminal: true,
  queryError: null as string | null,
  authority: null as {
    projectId: string;
    revision: number;
    authority: { kind: "specweave"; root: string; incrementId: string };
  } | null,
  replace: vi.fn(),
  configure: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  report: vi.fn(),
  verify: vi.fn(),
  export: vi.fn(),
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    plan: () => "plan",
    planAuthority: () => "authority",
    planReplace: "replace",
    planConfigure: "configure",
    planClaim: "claim",
    planRelease: "release",
    planReport: "report",
    planVerify: "verify",
    planExport: "export",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof state) => state[command],
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string | null) =>
    key === "authority"
      ? { data: state.authority, refresh: state.refresh }
      : key
        ? { data: state.data, error: state.queryError, refresh: state.refresh }
        : { data: null, refresh: state.refresh },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.terminal }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { error: Error }) => result.error,
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogPopup: ({ children }: React.PropsWithChildren) => <main>{children}</main>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h1>{children}</h1>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));
import { ProjectPlan, verificationRequestId } from "./ProjectPlan";
let project = {
  id: "project",
  environmentId: "host",
  title: "Atlas",
  workspaceRoot: "/scratch/atlas",
} as EnvironmentProject;
const makeSnapshot = () =>
  ({
    projectId: project.id,
    revision: 3,
    authority: { kind: "native" },
    native: {
      spec: "Deliver a reliable project workspace",
      criteria: [{ id: "AC-1", text: "Replays are deduplicated" }],
      contentRevision: 2,
      tasks: [
        {
          id: "T-1",
          title: "Verify delivery",
          criterionIds: ["AC-1"],
          verification: { executable: "node", args: ["--test"], timeoutMs: 5000 },
          owner: null,
          status: "planned",
          note: "",
          evidence: [],
        },
      ],
    },
    external: null,
  }) as ProjectPlanSnapshot;
let root: Root, container: HTMLDivElement;
let fixtureId = 0;
beforeEach(() => {
  vi.clearAllMocks();
  project = { ...project, id: ProjectId.make(`plan-fixture-${++fixtureId}`) };
  state.data = makeSnapshot();
  state.terminal = true;
  state.queryError = null;
  state.authority = null;
  sessionStorage.clear();

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(canOperate = true) {
  await act(async () =>
    root.render(
      <ProjectPlan
        project={project}
        canOperate={canOperate}
        onClose={state.close}
        onOpenThread={state.open}
        onExecuteTask={state.execute}
      />,
    ),
  );
}
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((row) => row.textContent?.trim() === text)!;
async function click(text: string) {
  expect(button(text)).toBeDefined();
  await act(async () => button(text).click());
}
async function input(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    const proto =
      field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
describe("project planning", () => {
  it("repairs a broken configured source from metadata without creating a fallback", async () => {
    state.data = null;
    state.queryError = "The configured spec or ledger is unavailable.";
    state.authority = {
      projectId: project.id,
      revision: 9,
      authority: { kind: "specweave", root: "/scratch/atlas", incrementId: "0888-example" },
    };
    state.configure.mockResolvedValue({
      _tag: "Failure",
      error: new Error("The plan changed elsewhere"),
    });
    await render();
    expect(container.textContent).toContain("No fallback plan has been created");
    expect(button("Add a plan")).toBeUndefined();
    expect(state.configure).not.toHaveBeenCalled();
    await click("Use an empty SpecWithCode plan");
    expect(state.configure).toHaveBeenCalledWith({
      environmentId: "host",
      input: {
        projectId: project.id,
        expectedRevision: 9,
        authority: { kind: "native" },
        discardNative: false,
      },
    });
    expect(container.textContent).toContain("The plan changed elsewhere");
    expect(button("Add a plan")).toBeUndefined();
  });

  it("reads without creating or running anything; saves CAS edits and preserves conflicts", async () => {
    await render();
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.verify).not.toHaveBeenCalled();
    await click("Edit plan");
    await input("Plan spec", "My unsaved outcome");
    state.replace.mockResolvedValue({
      _tag: "Failure",
      error: new Error("The plan changed elsewhere"),
    });
    await click("Save plan");
    expect(state.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          projectId: project.id,
          expectedRevision: 3,
          definition: expect.objectContaining({ spec: "My unsaved outcome" }),
        }),
      }),
    );
    expect(container.textContent).toContain("The plan changed elsewhere");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
      "My unsaved outcome",
    );
    await click("Close");
    expect(state.close).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Discard this unsaved plan edit?");
  });
  it("adds structured criteria/tasks and passes literal command arguments without executing on save", async () => {
    await render();
    await click("Edit plan");
    await click("Add criterion");
    await input("AC-2 criterion", "No CLI required");
    await click("Add task");
    await input("T-2 title", "Check native mode");
    const expected = { ...makeSnapshot(), revision: 4 };
    state.replace.mockResolvedValue({ _tag: "Success", value: expected });
    await click("Save plan");
    expect(state.replace.mock.calls[0]![0].input.definition.tasks[1]).toMatchObject({
      id: "T-2",
      title: "Check native mode",
      verification: null,
    });
    expect(state.verify).not.toHaveBeenCalled();
    expect(state.refresh).toHaveBeenCalled();
  });
  it("retains exact verification identity after an uncertain response and requires explicit new attempts", async () => {
    state.verify.mockResolvedValue({ _tag: "Failure", error: new Error("Connection lost") });
    await render();
    await click("Run verification");
    await click("Recheck last request");
    expect(state.verify.mock.calls[0]![0].input.commandId).toBe(
      state.verify.mock.calls[1]![0].input.commandId,
    );
    expect(state.verify.mock.calls[0]![0].input).not.toHaveProperty("actor");
    expect(container.textContent).toContain('"node" "--test"');
    const key = JSON.stringify(["host", project.id, "T-1"]);
    expect(verificationRequestId(key)).toBe(state.verify.mock.calls[0]![0].input.commandId);
    expect(verificationRequestId(key, true)).not.toBe(
      state.verify.mock.calls[0]![0].input.commandId,
    );
  });
  it("keeps an uncertain request when storage reads succeed but writes fail", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    try {
      state.verify.mockResolvedValue({ _tag: "Failure", error: new Error("Connection lost") });
      await render();
      await click("Run verification");
      const first = state.verify.mock.calls[0]![0].input;
      expect(first.recheckOnly).toBe(false);
      await click("Recheck last request");
      expect(state.verify.mock.calls[1]![0].input).toMatchObject({
        commandId: first.commandId,
        recheckOnly: true,
      });
      await click("New verification attempt");
      expect(state.verify.mock.calls[2]![0].input.commandId).not.toBe(first.commandId);
      expect(state.verify.mock.calls[2]![0].input.recheckOnly).toBe(false);
    } finally {
      set.mockRestore();
    }
  });
  it("prefers the latest in-memory attempt when storage retains an older ID", () => {
    const key = "old-storage-request";
    const old = verificationRequestId(key, true);
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    try {
      const latest = verificationRequestId(key, true);
      expect(latest).not.toBe(old);
      expect(verificationRequestId(key)).toBe(latest);
    } finally {
      set.mockRestore();
    }
  });
  it("keeps an uncertain request stable when browser storage is disabled", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    try {
      const id = verificationRequestId("storage-disabled");
      expect(verificationRequestId("storage-disabled")).toBe(id);
      expect(verificationRequestId("storage-disabled", true)).not.toBe(id);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
  it("rechecks a persisted receipt after storage loss without issuing a new command", () => {
    const saved = "fedcba98-7654-4321-8888-000000000001";
    expect(verificationRequestId("after-reload", false, saved)).toBe(saved);
    expect(verificationRequestId("after-reload", true, saved)).not.toBe(saved);
  });
  it("requires terminal permission for verification while still allowing plan edits", async () => {
    state.terminal = false;
    await render();
    expect(button("Run verification").disabled).toBe(true);
    expect(button("Edit plan").disabled).toBe(false);
    await click("Run verification");
    expect(state.verify).not.toHaveBeenCalled();
  });
  it("shows external authority as read-only and never relabels its done assertion verified", async () => {
    state.data = {
      ...makeSnapshot(),
      authority: { kind: "specweave", root: "/scratch/atlas", incrementId: "0888-example" },
      native: null,
      external: {
        sourceRevision: "abcdef",
        spec: "Authoritative spec",
        specPath: "/scratch/atlas/spec.md",
        ledgerPath: "/scratch/atlas/ledger.jsonl",
        readOnly: true,
        tasks: [
          {
            id: "T-1",
            title: "External task",
            owner: "foreign-agent",
            status: "done",
            evidence: "claimed test passed",
            verification: "external_unverified",
          },
        ],
      },
    };
    await render();
    expect(button("Edit plan")).toBeUndefined();
    expect(button("Claim for me")).toBeUndefined();
    expect(button("Run verification")).toBeUndefined();
    expect(container.textContent).toContain("foreign-agent");
    expect(container.textContent).toContain("External, unverified");
    expect(state.configure).not.toHaveBeenCalled();
  });
  it("routes a task request through the coordinator and releases only the displayed owner/revision", async () => {
    state.data = {
      ...state.data!,
      native: {
        ...state.data!.native!,
        tasks: [
          {
            ...state.data!.native!.tasks[0]!,
            owner: { kind: "thread", threadId: "worker" as ThreadId },
          },
        ],
      },
    };
    state.release.mockResolvedValue({ _tag: "Failure", error: new Error("Owner changed") });
    state.execute.mockResolvedValue(undefined);
    await render();
    await click("Release assignment");
    expect(state.release.mock.calls[0]![0].input).toMatchObject({
      expectedRevision: 3,
      taskId: "T-1",
      expectedOwner: { kind: "thread", threadId: "worker" },
    });
    await click("Ask coordinator");
    expect(state.execute).toHaveBeenCalledWith("T-1");
    expect(state.close).toHaveBeenCalled();
  });
});

it("rechecks retained evidence after a definition edit without executing again", async () => {
  const oldId = CommandId.make("11111111-2222-4333-8444-555555555555");
  const base = makeSnapshot();
  const task = base.native!.tasks[0]!;
  state.data = {
    ...base,
    revision: 9,
    native: {
      ...base.native!,
      contentRevision: 8,
      tasks: [
        {
          ...task,
          evidence: [
            {
              commandId: oldId,
              taskId: task.id,
              contentRevision: 7,
              taskStateSha256: "0".repeat(64),
              startedAt: "2026-10-09T00:00:00.000Z",
              finishedAt: null,
              outcome: "unknown",
              command: task.verification!,
              workspaceRoot: project.workspaceRoot,
              exitCode: null,
              stdout: "",
              stderr: "",
              outputSha256: "",
              truncated: false,
            },
          ],
        },
      ],
    },
  } as ProjectPlanSnapshot;
  state.verify.mockResolvedValue({ _tag: "Failure", error: new Error("fixture response") });
  await render();
  expect(container.textContent).toContain("Rechecking cannot run it twice");
  await click("Recheck last request");
  expect(state.verify).toHaveBeenCalledTimes(1);
  expect(state.verify.mock.calls[0]![0].input.commandId).toBe(oldId);
  expect(state.verify.mock.calls[0]![0].input.expectedRevision).toBe(9);
});

it("retains evidence and recheck after the saved command is removed", async () => {
  const base = makeSnapshot();
  const task = base.native!.tasks[0]!;
  state.data = {
    ...base,
    native: {
      ...base.native!,
      tasks: [
        {
          ...task,
          verification: null,
          evidence: [
            {
              commandId: CommandId.make("eeeeeeee-2222-4333-8444-555555555555"),
              taskId: task.id,
              contentRevision: 1,
              taskStateSha256: "0".repeat(64),
              startedAt: "2026-10-09T00:00:00.000Z",
              finishedAt: "2026-10-09T00:00:01.000Z",
              outcome: "failed",
              command: task.verification!,
              workspaceRoot: project.workspaceRoot,
              exitCode: 7,
              stdout: "RETAINED VERIFICATION OUTPUT",
              stderr: "",
              outputSha256: "1".repeat(64),
              truncated: false,
            },
          ],
        },
      ],
    },
  } as ProjectPlanSnapshot;
  await render();
  expect(state.data.native!.tasks[0]!.evidence).toHaveLength(1);
  expect(container.querySelector(".project-plan-receipt")).not.toBeNull();
  expect(container.textContent).toContain("RETAINED VERIFICATION OUTPUT");
  expect(container.textContent).toContain("Verification command and evidence");
  expect(button("New verification attempt")).toBeUndefined();
  state.verify.mockResolvedValue({ _tag: "Failure", error: new Error("fixture response") });
  await click("Recheck last request");
  expect(state.verify.mock.calls[0]![0].input.recheckOnly).toBe(true);
});
