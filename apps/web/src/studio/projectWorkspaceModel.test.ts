import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectId, ThreadId } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import {
  createProjectSendReceipt,
  prepareProjectMarkdown,
  projectAdmissionReason,
  projectThreadGroup,
  projectThreadReference,
  projectThreads,
} from "./projectWorkspaceModel";
import { linkedThreadIds } from "./projectThreadMentions";
import { formatStudioThreadHref, formatStudioThreadLink } from "./studioThreadLinks";
import { routeProjectComposerSend, type ProjectMessageRouting } from "./projectMessageRouting";

function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: "worker-1",
    environmentId: "host-1",
    projectId: "project-1",
    title: "Worker",
    createdBy: "agent",
    lineage: { relationshipToParent: null },
    forkedFrom: null,
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    updatedAt: "2026-10-09T00:00:00Z",
    ...overrides,
  } as EnvironmentThreadShell;
}
const projectId = ProjectId.make("project-1");
const coordinator = ThreadId.make("coordinator");
describe("Project thread lifecycle", () => {
  it("retains idle and resolved workers for later routing", () => {
    expect(projectThreadGroup(thread())).toBe("Idle");
    expect(projectThreadGroup(thread({ settledOverride: "settled" }))).toBe("Resolved");
    expect(
      projectThreadGroup(
        thread({ archivedAt: "2026-10-09T00:00:00Z", settledOverride: "settled" }),
      ),
    ).toBe("Archived");
  });
  it("prioritizes real attention above resolution and runtime", () => {
    expect(
      projectThreadGroup(thread({ settledOverride: "settled", hasPendingApprovals: true })),
    ).toBe("Waiting on you");
    expect(projectThreadGroup(thread({ hasPendingUserInput: true }))).toBe("Waiting on you");
    expect(projectThreadGroup(thread({ hasActionableProposedPlan: true }))).toBe("Waiting on you");
    expect(
      projectThreadGroup(
        thread({ runtime: { status: "running" } as EnvironmentThreadShell["runtime"] }),
      ),
    ).toBe("Working");
  });
  it("includes archived history but never another project, host, deleted worker or coordinator", () => {
    const rows = projectThreads(
      [
        thread(),
        thread({ id: coordinator }),
        thread({ id: ThreadId.make("other-project"), projectId: ProjectId.make("other") }),
        thread({ id: ThreadId.make("deleted"), deletedAt: "2026-10-09T00:00:00Z" }),
        thread({ id: ThreadId.make("archive"), archivedAt: "2026-10-09T00:00:00Z" }),
        thread({
          id: ThreadId.make("other-host"),
          environmentId: "other" as EnvironmentThreadShell["environmentId"],
        }),
      ],
      "host-1",
      projectId,
      coordinator,
    );
    expect(rows.map((t) => t.id)).toEqual(["worker-1", "archive"]);
  });
  it("lists no coordinator, the previous one or the one not yet saved in the settings", () => {
    const rows = (current: ThreadId | null) =>
      projectThreads(
        [
          thread(),
          thread({ id: ThreadId.make("project-coordinator:project-1") }),
          thread({ id: coordinator }),
        ],
        "host-1",
        projectId,
        current,
      ).map((t) => t.id);
    expect(rows(coordinator)).toEqual(["worker-1"]);
    // Before the settings load, only the id the host gives a new coordinator is held back.
    expect([...rows(null)].sort()).toEqual(["coordinator", "worker-1"]);
  });
});
describe("Scoped worker references", () => {
  const workers = [thread()];
  it("links known worker IDs without guessing from titles", () => {
    expect(projectThreadReference("studio://thread/worker-1", workers)).toBe("worker-1");
    expect(prepareProjectMarkdown("See [Fix runtime](studio://thread/worker-1).", workers)).toBe(
      "See [Fix runtime](studio://thread/worker-1).",
    );
    expect(prepareProjectMarkdown("Worker says to delete everything", workers)).toBe(
      "Worker says to delete everything",
    );
  });
  it("opens a link whose target is a worker's exact title, and keeps links it cannot open", () => {
    const worker = thread({ title: "Write tip.py CLI" });
    expect(
      prepareProjectMarkdown("[Write tip.py CLI](studio://thread/Write tip.py CLI) on Codex", [
        worker,
      ]),
    ).toBe("[Write tip.py CLI](studio://thread/worker-1) on Codex");
    // Another project's thread, or one that is gone, still renders as a chip that says so.
    expect(prepareProjectMarkdown("[Other](studio://thread/Missing worker)", [worker])).toBe(
      "[Other](studio://thread/Missing%20worker)",
    );
    expect(prepareProjectMarkdown("[Other](studio://thread/elsewhere)", [worker])).toBe(
      "[Other](studio://thread/elsewhere)",
    );
    expect(
      prepareProjectMarkdown("[Same](studio://thread/Same)", [
        thread({ title: "Same" }),
        thread({ id: ThreadId.make("worker-2"), title: "Same" }),
      ]),
    ).toBe("[Same](studio://thread/Same)");
  });
  it("keeps a link to another project's thread when a worker here shares its label", () => {
    const worker = thread({ title: "Fix the login" });
    const environment = [
      worker,
      thread({ id: ThreadId.make("other-project"), title: "Fix the login" }),
      thread({ id: ThreadId.make("gone"), title: "Gone", deletedAt: "2026-10-11T00:00:00Z" }),
    ];
    for (const target of ["other-project", "gone"])
      expect(
        prepareProjectMarkdown(`[Fix the login](studio://thread/${target})`, [worker], environment),
      ).toBe(`[Fix the login](studio://thread/${target})`);
  });
  it("opens a worker whose ID holds a ) through the server-built link", () => {
    const id = "thread:delegated-task:command%3Amcp%3Aa1%3Adelegate-task%3Areview%2520round)2";
    const worker = thread({ id: ThreadId.make(id), title: "Review" });
    const prepared = prepareProjectMarkdown(`Started ${formatStudioThreadLink(id, "Review")}.`, [
      worker,
    ]);
    expect(prepared).toBe(`Started [Review](${formatStudioThreadHref(id)}).`);
    expect(linkedThreadIds(prepared)).toEqual([id]);
  });
  it("replaces internal delegated-task IDs with a link to the worker", () => {
    const id = "thread:delegated-task:command%3Amcp-1";
    const worker = thread({ id: ThreadId.make(id), title: "Write tip.py" });
    const link = `[Write tip.py](studio://thread/${encodeURIComponent(id)})`;
    expect(
      prepareProjectMarkdown(
        "Task `node:delegated-task:command%3Amcp-1` and thread:delegated-task:command%3Amcp-1.",
        [worker],
      ),
    ).toBe(`Task ${link} and ${link}.`);
    expect(prepareProjectMarkdown("node:delegated-task:unknown", [worker])).toBe(
      "node:delegated-task:unknown",
    );
  });
  it.each(["native:thread:42", "thread with space", "日本語", "literal%20id"])(
    "opens an exact encoded native ID %s within this project's scope",
    (value) => {
      const local = thread({ id: ThreadId.make(value) });
      const href = `studio://thread/${encodeURIComponent(value)}`;
      expect(projectThreadReference(href, [local])).toBe(value);
      expect(projectThreadReference(href, workers)).toBeNull();
      expect(prepareProjectMarkdown(`[Thread](${href})`, [local])).toBe(
        `[Thread](studio://thread/${encodeURIComponent(value)})`,
      );
    },
  );
  describe("a delegated worker whose ID contains %3A", () => {
    const id = "thread:delegated-task:command%3Amcp%3Ad859%3Adelegate-task%3Acoord-format-alpha";
    const worker = thread({
      id: ThreadId.make(id),
      title: "Coordinator formatting and Alpha label",
    });
    const canonical = `[Coordinator formatting](studio://thread/${encodeURIComponent(id)})`;
    it.each([
      ["the raw ID an agent pastes", `studio://thread/${id}`],
      ["the ID encoded once (%253A)", `studio://thread/${encodeURIComponent(id)}`],
      ["the worker's title", "studio://thread/Coordinator%20formatting%20and%20Alpha%20label"],
    ])("rewrites %s to the canonical href", (_name, href) => {
      expect(prepareProjectMarkdown(`[Coordinator formatting](${href})`, [worker])).toBe(canonical);
      expect(projectThreadReference(formatStudioThreadHref(id), [worker])).toBe(id);
    });
    it("rewrites a bare ID in prose to the canonical link", () => {
      expect(prepareProjectMarkdown(`Done: ${id}.`, [worker])).toBe(
        `Done: [Coordinator formatting and Alpha label](studio://thread/${encodeURIComponent(id)}).`,
      );
    });
    it("rewrites the link once, never the ID inside its href", () => {
      const prepared = prepareProjectMarkdown(`[Coordinator formatting](studio://thread/${id})`, [
        worker,
      ]);
      expect(prepareProjectMarkdown(prepared, [worker])).toBe(prepared);
      expect(linkedThreadIds(prepared)).toEqual([id]);
    });
  });
  it("accepts a literal native colon ID without interpreting it as another scheme", () => {
    expect(
      projectThreadReference("studio://thread/native:42", [
        thread({ id: ThreadId.make("native:42") }),
      ]),
    ).toBe("native:42");
  });
  it.each([
    "studio://thread/foreign",
    "studio://thread/worker-1?project=other",
    "studio://thread/worker-1#run",
    "https://thread/worker-1",
    "studio://thread/../worker-1",
    "studio://user@thread/worker-1",
    "studio://thread/%ZZ",
    "studio://thread/%2e%2e",
    "studio://thread/worker%2F1",
    "studio://thread/worker%5C1",
    "studio://thread/worker%001",
    "studio://thread/worker%0A1",
    "studio://thread:42/worker-1",
  ])("rejects unsafe or foreign reference %s", (href) => {
    expect(projectThreadReference(href, workers)).toBeNull();
  });
});
describe("Project admission and retry", () => {
  it("requires a connected authorized active project", () => {
    const settings = { paused: false, archived: false };
    expect(projectAdmissionReason(settings, true, true)).toBeNull();
    expect(projectAdmissionReason(settings, false, true)).toMatch(/Reconnect/);
    expect(projectAdmissionReason(settings, true, false)).toMatch(/read-only/);
    expect(projectAdmissionReason(null, true, true)).toMatch(/loading/);
    expect(projectAdmissionReason({ ...settings, paused: true }, true, true)).toMatch(/Resume/);
    expect(projectAdmissionReason({ ...settings, archived: true }, true, true)).toMatch(
      /Unarchive/,
    );
  });
  it("retains unresolved receipts across reloads, isolated by scope, and removes acknowledgements", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const scope = { storage, key: "host/project" };
    const first = createProjectSendReceipt(scope);
    expect(first.forPrompt("worker:fix", () => "request-1")).toBe("request-1");
    const reloaded = createProjectSendReceipt(scope);
    expect(reloaded.forPrompt("worker:fix", () => "duplicate")).toBe("request-1");
    expect(
      createProjectSendReceipt({ storage, key: "other/project" }).forPrompt(
        "worker:fix",
        () => "other-request",
      ),
    ).toBe("other-request");
    reloaded.acknowledge("request-1");
    expect(createProjectSendReceipt(scope).forPrompt("worker:fix", () => "request-2")).toBe(
      "request-2",
    );
  });
  it("guards malformed and unavailable browser storage", () => {
    const storage = {
      getItem: () => "{corrupt",
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("disabled");
      },
    };
    const receipt = createProjectSendReceipt({ storage, key: "scope" });
    expect(receipt.forPrompt("fix", () => "request-1")).toBe("request-1");
    expect(receipt.forPrompt("fix", () => "duplicate")).toBe("request-1");
    expect(() => receipt.acknowledge("request-1")).not.toThrow();
  });
  it("reuses uncertain delivery identity; next successful send can repeat the same text", () => {
    const receipt = createProjectSendReceipt();
    let n = 0;
    const allocate = () => `id-${++n}`;
    expect(receipt.forPrompt("worker-1:fix", allocate)).toBe("id-1");
    expect(receipt.forPrompt("worker-1:fix", allocate)).toBe("id-1");
    receipt.acknowledge("stale-id");
    expect(receipt.forPrompt("worker-1:fix", allocate)).toBe("id-1");
    receipt.acknowledge("id-1");
    expect(receipt.forPrompt("worker-1:fix", allocate)).toBe("id-2");
    expect(receipt.forPrompt("worker-2:fix", allocate)).toBe("id-3");
    expect(receipt.forPrompt("worker-1:fix", allocate)).toBe("id-2");
  });
});
describe("Worker-pane composer routing", () => {
  function setup() {
    const send = vi.fn(async (_text: string) => {});
    const clear = vi.fn();
    const reportError = vi.fn();
    return {
      routing: {
        coordinatorThreadId: coordinator,
        send,
        openCoordinator: vi.fn(),
        openThread: () => false,
      } satisfies ProjectMessageRouting,
      input: {
        prompt: "Continue this fix",
        hasOtherContent: false,
        nativeInput: false,
        clear,
        reportError,
      },
      send,
      clear,
      reportError,
    };
  }
  it("sends through coordinator and clears only after acknowledgement", async () => {
    const s = setup();
    expect(await routeProjectComposerSend(s.routing, s.input)).toBe(true);
    expect(s.send).toHaveBeenCalledWith("Continue this fix");
    expect(s.clear).toHaveBeenCalledOnce();
    expect(s.reportError).not.toHaveBeenCalled();
  });
  it("preserves the full draft if coordinator rejects or goes offline", async () => {
    const s = setup();
    s.send.mockRejectedValueOnce(new Error("Host disconnected"));
    await routeProjectComposerSend(s.routing, s.input);
    expect(s.clear).not.toHaveBeenCalled();
    expect(s.reportError).toHaveBeenCalledWith("Host disconnected");
  });
  it("never drops attachments or annotations during text-only routing", async () => {
    const s = setup();
    await routeProjectComposerSend(s.routing, { ...s.input, hasOtherContent: true });
    expect(s.send).not.toHaveBeenCalled();
    expect(s.clear).not.toHaveBeenCalled();
    expect(s.reportError).toHaveBeenCalled();
  });
  it("waits for uploads, preserves uncertain drafts, and supports attachment-only replies", async () => {
    const s = setup();
    const attachments = [
      {
        type: "file" as const,
        id: "pending-00000000-0000-4000-8000-000000000001-txt",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      },
    ];
    const prepareAttachments = vi.fn(async () => attachments);
    s.send.mockRejectedValueOnce(new Error("Acknowledgement lost"));
    await routeProjectComposerSend(s.routing, { ...s.input, prompt: "", prepareAttachments });
    expect(prepareAttachments).toHaveBeenCalledOnce();
    expect(s.send).toHaveBeenCalledWith("", attachments);
    expect(s.clear).not.toHaveBeenCalled();
    await routeProjectComposerSend(s.routing, { ...s.input, prompt: "", prepareAttachments });
    expect(s.clear).toHaveBeenCalledOnce();
  });
  it("preserves attachments when upload fails before dispatch", async () => {
    const s = setup();
    await routeProjectComposerSend(s.routing, {
      ...s.input,
      prepareAttachments: async () => {
        throw new Error("Upload failed");
      },
    });
    expect(s.send).not.toHaveBeenCalled();
    expect(s.clear).not.toHaveBeenCalled();
    expect(s.reportError).toHaveBeenCalledWith("Upload failed");
  });
  it("keeps native pending answers and ordinary non-project threads on their original control path", async () => {
    const s = setup();
    expect(await routeProjectComposerSend(s.routing, { ...s.input, nativeInput: true })).toBe(
      false,
    );
    expect(await routeProjectComposerSend(null, s.input)).toBe(false);
    expect(s.send).not.toHaveBeenCalled();
  });
});

it("keeps independent chats out of the project task list while retaining worker forks", () => {
  const user = thread({ id: ThreadId.make("human"), createdBy: "user" });
  const unknown = thread({ id: ThreadId.make("unknown"), createdBy: "system" });
  const worker = thread();
  const fork = thread({
    id: ThreadId.make("fork"),
    createdBy: "user",
    forkedFrom: {
      type: "run",
      threadId: worker.id,
      runId: "run",
    } as EnvironmentThreadShell["forkedFrom"],
  });
  expect(
    projectThreads([user, unknown, worker, fork], "host-1", projectId, coordinator)
      .map((t) => t.id)
      .sort(),
  ).toEqual(["fork", "worker-1"]);
});

it("does not list native subagents of an independent user chat as project work", () => {
  const independent = thread({ id: ThreadId.make("independent"), createdBy: "user" });
  const child = thread({
    id: ThreadId.make("child"),
    createdBy: "agent",
    lineage: {
      parentThreadId: independent.id,
      relationshipToParent: "subagent",
      rootThreadId: independent.id,
    },
  });
  const worker = thread();
  expect(
    projectThreads([independent, child, worker], "host-1", projectId, coordinator).map((t) => t.id),
  ).toEqual(["worker-1"]);
});
