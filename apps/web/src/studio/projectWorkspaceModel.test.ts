import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectId, ThreadId } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import {
  createProjectSendReceipt,
  prepareProjectMarkdown,
  hostDisconnectedLabel,
  projectAdmissionReason,
  projectThreadGroup,
  remoteOrchestratorOfflineLabel,
  projectThreadReference,
  projectThreads,
  threadAttentionNote,
  threadHeldQueue,
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
    ).toBe("Resolved");
  });
  it.each(["usage_limit", "provider_error"])(
    "resolves historical %s failures until reopened",
    (lastErrorClass) => {
      const failed = thread({
        runtime: { status: "failed", lastErrorClass } as EnvironmentThreadShell["runtime"],
      });
      expect(projectThreadGroup(failed)).toBe("Idle");
      expect(projectThreadGroup({ ...failed, settledOverride: "settled" })).toBe("Resolved");
      expect(projectThreadGroup({ ...failed, settledOverride: "active" })).toBe("Idle");
    },
  );
  it("waits on the user while a quiet thread holds queued messages", () => {
    const held = thread({ heldQueuedCount: 13, settledOverride: "settled" });
    expect(projectThreadGroup(held)).toBe("Waiting on you");
    expect(threadHeldQueue(held)).toBe("13 queued messages held");
    expect(threadAttentionNote(held)).toBe(
      "13 queued messages held. Open the thread to resume or discard them.",
    );
    expect(threadHeldQueue(thread({ heldQueuedCount: 1 }))).toBe("1 queued message held");
    // A running thread is working; the hold shows once it stops.
    const working = thread({
      heldQueuedCount: 2,
      runtime: { status: "running" } as EnvironmentThreadShell["runtime"],
    });
    expect(projectThreadGroup(working)).toBe("Working");
    expect(threadHeldQueue(working)).toBeNull();
    expect(threadHeldQueue(thread())).toBeNull();
  });
  it("suppresses legacy flags after resolution but preserves current actions", () => {
    expect(
      projectThreadGroup(thread({ settledOverride: "settled", hasPendingApprovals: true })),
    ).toBe("Resolved");
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
  it("keeps existing accepted identity after strict overflow then ordinary send and acknowledgement", () => {
    let saved: string | null = null;
    const storage = {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
      removeItem: () => {
        saved = null;
      },
    };
    const scope = { storage, key: "strict-overflow-then-ordinary" };
    const receipt = createProjectSendReceipt(scope);
    const fingerprints = Array.from({ length: 67 }, (_, i) =>
      JSON.stringify([
        "coordinator-retry",
        [`failed-${i}`, `message-${i}`],
        ["project", "x".repeat(30_000), null, []],
      ]),
    );
    for (let i = 0; i < 66; i++) receipt.forPrompt(fingerprints[i]!, () => `accepted-${i}`, true);
    const before = storage.getItem()!;
    expect(before.length).toBeLessThanOrEqual(2_000_000);
    expect(() => receipt.forPrompt(fingerprints[66]!, () => "never-dispatched", true)).toThrow(
      /history is full/,
    );
    expect(
      storage.getItem() === before,
      `Retained ${before.length} chars; saved ${storage.getItem()?.length ?? 0}`,
    ).toBe(true);
    const ordinaryRpc = vi.fn();
    const ordinary = receipt.forPrompt("ordinary-new-message", () => "ordinary-command");
    ordinaryRpc(ordinary);
    receipt.acknowledge(ordinary);
    expect(ordinaryRpc).toHaveBeenCalledExactlyOnceWith("ordinary-command");
    expect(
      storage.getItem() === before,
      `Retained ${before.length} chars; saved ${storage.getItem()?.length ?? 0}`,
    ).toBe(true);
    const allocate = vi.fn(() => "duplicate-command");
    const reloaded = createProjectSendReceipt(scope);
    expect(reloaded.forPrompt(fingerprints[0]!, allocate, true)).toBe("accepted-0");
    expect(allocate).not.toHaveBeenCalled();
    expect(
      storage.getItem() === before,
      `Retained ${before.length} chars; saved ${storage.getItem()?.length ?? 0}`,
    ).toBe(true);
  });

  it.each(["oversized", "corrupt", "read-failure"])(
    "keeps unsafe raw history through ordinary send, acknowledgement and reload: %s",
    (kind) => {
      const oldFingerprint = kind === "oversized" ? `${"x".repeat(30_000)}:0` : "old-request";
      const raw =
        kind === "oversized"
          ? JSON.stringify({
              version: 1,
              pending: Array.from({ length: 67 }, (_, i) => [
                `${"x".repeat(30_000)}:${i}`,
                `accepted-${i}`,
              ]),
            })
          : kind === "corrupt"
            ? "{retained-but-unreadable"
            : JSON.stringify({ version: 1, pending: [[oldFingerprint, "accepted-command"]] });
      let saved: string | null = raw;
      let readUnavailable = kind === "read-failure";
      const storage = {
        getItem: () => {
          if (readUnavailable) throw new Error("read unavailable");
          return saved;
        },
        setItem: vi.fn((_key: string, value: string) => {
          saved = value;
        }),
        removeItem: vi.fn(() => {
          saved = null;
        }),
      };
      const scope = { storage, key: "unsafe-retained-history" };
      const receipt = createProjectSendReceipt(scope);
      const ordinaryRpc = vi.fn();
      const ordinary = receipt.forPrompt("ordinary-request", () => "ordinary-command");
      ordinaryRpc(ordinary);
      receipt.acknowledge(ordinary);
      expect(ordinaryRpc).toHaveBeenCalledExactlyOnceWith("ordinary-command");
      expect(saved).toBe(raw);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
      const reloaded = createProjectSendReceipt(scope);
      const allocate = vi.fn(() => "duplicate-command");
      const retryRpc = vi.fn();
      expect(() => retryRpc(reloaded.forPrompt(oldFingerprint, allocate, true))).toThrow(
        /restored safely/,
      );
      expect(allocate).not.toHaveBeenCalled();
      expect(retryRpc).not.toHaveBeenCalled();
      expect(saved).toBe(raw);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
      if (kind === "read-failure") {
        readUnavailable = false;
        expect(createProjectSendReceipt(scope).forPrompt(oldFingerprint, allocate, true)).toBe(
          "accepted-command",
        );
        expect(allocate).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects a strict receipt above the reload bound without replacing earlier uncertain commands", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const receipt = createProjectSendReceipt({ storage, key: "bounded-retry" });
    const prompt = "x".repeat(30_000);
    for (let i = 0; i < 66; i++) receipt.forPrompt(`${prompt}:${i}`, () => `uncertain-${i}`, true);
    const before = values.get("bounded-retry")!;
    expect(before.length).toBeLessThanOrEqual(2_000_000);
    const allocate = vi.fn(() => "new-retry-command");
    const rpc = vi.fn();
    const retry = () => rpc(receipt.forPrompt(`${prompt}:66`, allocate, true));
    expect(retry).toThrow(/history.*full|restore.*limit/);
    expect(rpc).not.toHaveBeenCalled();
    expect(values.get("bounded-retry")).toBe(before);
    expect(storage.setItem.mock.calls.every(([, value]) => value.length <= 2_000_000)).toBe(true);
    const reloaded = createProjectSendReceipt({ storage, key: "bounded-retry" });
    expect(reloaded.forPrompt(`${prompt}:0`, () => "duplicate", true)).toBe("uncertain-0");
    receipt.acknowledge("uncertain-0");
    retry();
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("new-retry-command");
    expect(
      createProjectSendReceipt({ storage, key: "bounded-retry" }).forPrompt(
        `${prompt}:66`,
        () => "duplicate",
        true,
      ),
    ).toBe("new-retry-command");
  });

  it.each([
    " ".repeat(2_000_001),
    "{broken",
    JSON.stringify({ version: 2, pending: [["retry", "accepted-command"]] }),
    JSON.stringify({ version: 1, pending: [["retry", "unreadable command id"]] }),
  ])("preserves an unreadable existing receipt and blocks strict dispatch", (raw) => {
    let saved = raw;
    const storage = {
      getItem: () => saved,
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
      removeItem: vi.fn(),
    };
    const receipt = createProjectSendReceipt({ storage, key: "unreadable-retry" });
    const allocate = vi.fn(() => "replacement-command");
    const rpc = vi.fn();
    expect(() => rpc(receipt.forPrompt("retry", allocate, true))).toThrow(/restored safely/);
    expect(allocate).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(saved).toBe(raw);
    expect(receipt.forPrompt("ordinary", () => "ordinary-command")).toBe("ordinary-command");
  });

  it("does not overwrite an accepted command after a transient initialization read failure", () => {
    const original = JSON.stringify({ version: 1, pending: [["retry", "accepted-command"]] });
    let saved = original;
    const storage = {
      getItem: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("read unavailable");
        })
        .mockImplementation(() => saved),
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
      removeItem: vi.fn(),
    };
    const receipt = createProjectSendReceipt({ storage, key: "temporarily-unreadable" });
    const allocate = vi.fn(() => "replacement-command");
    expect(() => receipt.forPrompt("retry", allocate, true)).toThrow(/restored safely/);
    expect(allocate).not.toHaveBeenCalled();
    expect(saved).toBe(original);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(
      createProjectSendReceipt({ storage, key: "temporarily-unreadable" }).forPrompt(
        "retry",
        allocate,
        true,
      ),
    ).toBe("accepted-command");
    expect(allocate).not.toHaveBeenCalled();
  });

  it("blocks retry RPC when only command storage fails, then durably reuses its cached ID", () => {
    const values = new Map<string, string>();
    let commandStorageAvailable = false;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === "command-scope" && !commandStorageAvailable) throw new Error("command quota");
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    storage.setItem("recovery-metadata", "valid pending attachment IDs");
    const receipt = createProjectSendReceipt({ storage, key: "command-scope" });
    const allocate = vi.fn(() => "durable-retry-command");
    const rpc = vi.fn();
    const retry = () => rpc(receipt.forPrompt("retry-fingerprint", allocate, true));
    expect(retry).toThrow(/session storage/);
    expect(rpc).not.toHaveBeenCalled();
    expect(values.has("recovery-metadata")).toBe(true);
    commandStorageAvailable = true;
    retry();
    expect(allocate).toHaveBeenCalledTimes(1);
    const reloaded = createProjectSendReceipt({ storage, key: "command-scope" });
    expect(reloaded.forPrompt("retry-fingerprint", () => "duplicate", true)).toBe(
      "durable-retry-command",
    );
    expect(rpc).toHaveBeenCalledExactlyOnceWith("durable-retry-command");
  });

  it("requires a connected authorized active project", () => {
    const settings = { paused: false, archived: false };
    expect(projectAdmissionReason(settings, true, true)).toBeNull();
    expect(projectAdmissionReason(settings, false, true)).toMatch(/unreachable/);
    expect(
      projectAdmissionReason(settings, false, true, null, {
        isThisDevice: false,
        graceElapsed: true,
        machineLabel: "Minis",
      }),
    ).toBe(
      "Minis is unreachable, so its coordinator cannot take messages. Nothing is sent to another machine.",
    );
    expect(
      projectAdmissionReason(settings, false, true, {
        phase: "error",
        blockedReason: "authentication",
      }),
    ).toMatch(/signed out of this host/);
    expect(projectAdmissionReason(settings, false, true, { phase: "reconnecting" })).toMatch(
      /Reconnecting to this host/,
    );
    expect(projectAdmissionReason(settings, false, true, { phase: "offline" })).toMatch(/offline/);
    expect(hostDisconnectedLabel({ phase: "error", blockedReason: "authentication" })).toBe(
      "Signed out",
    );
    expect(hostDisconnectedLabel({ phase: "reconnecting" })).toBe("Reconnecting");
    expect(hostDisconnectedLabel({ phase: "connecting" })).toBe("Connecting");
    expect(projectAdmissionReason(settings, false, true, { phase: "connecting" })).toMatch(
      /Connecting to this host/,
    );
    expect(hostDisconnectedLabel({ phase: "error", blockedReason: "configuration" })).toBe(
      "Disconnected",
    );
    expect(hostDisconnectedLabel(undefined)).toBe("Disconnected");
    expect(projectAdmissionReason(settings, true, false)).toMatch(/read-only/);
    expect(projectAdmissionReason(null, true, true)).toMatch(/loading/);
    expect(projectAdmissionReason({ ...settings, paused: true }, true, true)).toMatch(/Resume/);
    expect(projectAdmissionReason({ ...settings, archived: true }, true, true)).toMatch(
      /Unarchive/,
    );
  });
  it("calls this machine busy, never offline, and never suggests reloading it", () => {
    const settings = { paused: false, archived: false };
    const thisDevice = { isThisDevice: true, graceElapsed: true };
    for (const phase of ["connecting", "reconnecting", "offline", "available"]) {
      const reason = projectAdmissionReason(settings, false, true, { phase }, thisDevice);
      // Nothing queues a refused send, so the text must not promise one.
      expect(reason).toBe(
        "SpecWithCode on this Mac is busy. You can send once it catches up; your draft is kept.",
      );
      expect(reason).not.toMatch(/messages send/i);
      expect(hostDisconnectedLabel({ phase }, thisDevice)).toBe("Catching up");
    }
    for (const connection of [
      { phase: "error" },
      { phase: "error", blockedReason: "authentication" },
      { phase: "unsupported" },
      { phase: "reconnecting" },
    ]) {
      const reason = projectAdmissionReason(settings, false, true, connection, thisDevice)!;
      expect(reason).not.toMatch(/reload/i);
      expect(reason).not.toMatch(/offline|Can't reach/);
    }
    expect(hostDisconnectedLabel({ phase: "error" }, thisDevice)).toBe("Connection failed");
    expect(
      projectAdmissionReason(
        settings,
        false,
        true,
        { phase: "reconnecting" },
        {
          isThisDevice: true,
          graceElapsed: false,
        },
      ),
    ).toBe("Catching up…");
  });
  it("keeps today's text for a remote host, before and after the reconnect grace", () => {
    const settings = { paused: false, archived: false };
    for (const graceElapsed of [false, true]) {
      const remote = { isThisDevice: false, graceElapsed };
      expect(projectAdmissionReason(settings, false, true, { phase: "offline" }, remote)).toBe(
        "This device is offline.",
      );
      expect(projectAdmissionReason(settings, false, true, { phase: "reconnecting" }, remote)).toBe(
        "Reconnecting to this host. If this does not clear, reload the page.",
      );
      expect(projectAdmissionReason(settings, false, true, { phase: "connecting" }, remote)).toBe(
        "Connecting to this host.",
      );
      expect(hostDisconnectedLabel({ phase: "reconnecting" }, remote)).toBe("Reconnecting");
      expect(hostDisconnectedLabel({ phase: "offline" }, remote)).toBe("Offline");
    }
  });
  it("refuses a message to a named machine that dropped, saying nothing goes elsewhere", () => {
    const settings = { paused: false, archived: false };
    expect(
      projectAdmissionReason(
        settings,
        false,
        true,
        { phase: "reconnecting" },
        { isThisDevice: false, graceElapsed: true, machineLabel: "Minis" },
      ),
    ).toBe(
      "Minis is unreachable, so its coordinator cannot take messages. Nothing is sent to another machine. Reconnecting…",
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

describe("remoteOrchestratorOfflineLabel", () => {
  const now = Date.UTC(2026, 9, 20, 18, 0);
  it("says how old the synced copy is and that it is read-only", () => {
    expect(remoteOrchestratorOfflineLabel("Minis", now - 12 * 60_000, now)).toBe(
      "Minis unreachable · last synced 12 min ago · read-only",
    );
    expect(remoteOrchestratorOfflineLabel("Minis", now - 3 * 3_600_000, now)).toBe(
      "Minis unreachable · last synced 3 h ago · read-only",
    );
    expect(remoteOrchestratorOfflineLabel("Minis", now, now)).toBe(
      "Minis unreachable · last synced just now · read-only",
    );
  });
  it("says Unknown when nothing records a sync", () => {
    expect(remoteOrchestratorOfflineLabel("Minis", null, now)).toBe(
      "Minis unreachable · last synced: Unknown · read-only",
    );
  });
});

describe("attention project scope", () => {
  it("retains explicit logical-project user roots and excludes independent chats otherwise", async () => {
    const { projectAttentionRoots } = await import("./useProjectAttention");
    const user = thread({ createdBy: "user" });
    const member = {
      environmentId: "host-1",
      projectId: "project-1",
      coordinatorThreadId: "coord",
      freshness: "live" as const,
    };
    expect(projectAttentionRoots([user], [member])).toEqual([]);
    expect(projectAttentionRoots([user], [{ ...member, includeUserRoots: true }])).toEqual([user]);
  });
  it("retains unloaded explicit members without joining similarly named projects", async () => {
    const { expandAttentionProjects } = await import("./useProjectAttention");
    const project = {
      environmentId: "local",
      id: "p",
      workspaceSettings: {
        logicalProject: {
          members: [{ environmentId: "remote", projectId: "q", coordinatorThreadId: "c" }],
        },
      },
    };
    expect(expandAttentionProjects([project]).map((p) => [p.environmentId, p.id])).toEqual([
      ["local", "p"],
      ["remote", "q"],
    ]);
    expect(expandAttentionProjects([{ environmentId: "local", id: "p" }])).toHaveLength(1);
  });
});
