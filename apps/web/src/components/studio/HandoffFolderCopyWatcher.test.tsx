// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { currentCopyActivities, resetCopyActivityForTests } from "../../studio/folderCopyActivity";
import { HandoffFolderCopyWatcher } from "./HandoffFolderCopyWatcher";

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (input: unknown) => unknown>,
  toasts: [] as unknown[],
  /** This window's access:write on the source, as the session reports it. */
  sourceAccess: "unknown" as "granted" | "denied" | "unknown",
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScopeAccess: () => state.sourceAccess,
  readEnvironmentScopeAccess: () => state.sourceAccess,
}));
vi.mock("../../studio/machineHandoff", () => ({
  machineHandoff: new Proxy({}, { get: (_target, name) => name }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: string) => async (request: unknown) => {
    try {
      return { _tag: "Success", value: await state.handlers[name]!(request) };
    } catch (error) {
      return { _tag: "Failure", error };
    }
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: (toast: unknown) => state.toasts.push(toast), close: () => {} },
}));

const total = (files: number, bytes: number) => ({ files, bytes });
const summary = {
  totals: {
    repository: total(1, 10),
    tracked: total(1, 10),
    untracked: total(1, 10),
    ignoredData: total(1, 10),
    rebuildable: total(1, 10),
    secret: total(0, 0),
  },
  repositories: [],
  secretFiles: [],
  linksOutside: 0,
  warnings: [],
};
const notFound = () => {
  throw Object.assign(new Error("gone"), { _tag: "FolderCopyError", code: "not_found" });
};
const scanning = () => ({ state: "scanning", summary: null, progress: null, error: null });
const copyStatus = (state: string, mode = "copy-only") => ({
  state,
  mode,
  committed: state === "applied",
  projectId: state === "applied" ? "copied" : null,
  rows: [],
  checks: [],
  unstable: [],
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  state.toasts = [];
  state.handlers = {};
  state.sourceAccess = "unknown";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("tells a person who closed the dialog when measuring or the copy is ready", async () => {
  vi.useFakeTimers();
  try {
    const key = "specwithcode:folder-copy:m4:source";
    localStorage.setItem(
      key,
      JSON.stringify({
        operationId: "00000000-0000-4000-8000-000000000009",
        environmentId: "m3",
        mode: "copy-only",
        targetFolder: "/target",
        projectId: null,
      }),
    );
    state.handlers.copyStatus = notFound;
    let measured = false;
    state.handlers.copySourceStatus = () =>
      measured ? { state: "scanned", summary, progress: null, error: null } : scanning();
    const watcher = (
      <HandoffFolderCopyWatcher
        environmentId={"m4" as never}
        projectId="source"
        projectName="Project"
        machineLabel={(id) => (id === "m3" ? "M3" : "Machine")}
      />
    );
    await act(async () => root.render(watcher));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.toasts).toEqual([]);
    measured = true;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.toasts).toEqual([
      {
        type: "success",
        title: "Folder measured. Open Move Project to choose what to copy.",
      },
    ]);
    // It stops after telling once.
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(state.toasts).toHaveLength(1);

    await act(async () => root.render(<></>));
    state.toasts = [];
    let copied = false;
    state.handlers.copyStatus = () => (copied ? copyStatus("previewed") : copyStatus("scanning"));
    await act(async () => root.render(watcher));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.toasts).toEqual([]);
    copied = true;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.toasts).toEqual([{ type: "success", title: "Copy to M3 is ready to review." }]);
  } finally {
    vi.useRealTimers();
  }
});

const pointer = (extra: Record<string, unknown> = {}) =>
  localStorage.setItem(
    "specwithcode:folder-copy:m4:source",
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-only",
      targetFolder: "/target",
      projectId: null,
      ...extra,
    }),
  );
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "repo:app",
  kind: "repository",
  path: "app",
  status: "new",
  choices: [],
  decision: null,
  needsDecision: false,
  conflicts: [],
  moreConflicts: 0,
  cloneAvailable: false,
  clone: false,
  ...overrides,
});
const previewed = (rows: unknown[], decisionsNeeded = 0) => ({
  ...copyStatus("previewed"),
  rows,
  disk: null,
  totals: { filesToMove: 1, bytesToMove: 1, bytesPresent: 0, decisionsNeeded },
});
const renderWatcher = () =>
  act(async () =>
    root.render(
      <HandoffFolderCopyWatcher
        environmentId={"m4" as never}
        projectId="source"
        projectName="Project"
        machineLabel={() => "M3"}
      />,
    ),
  );

it("asks to reopen the dialog to finish linking a copy-only copy", async () => {
  vi.useFakeTimers();
  try {
    pointer();
    state.handlers.copyStatus = () => copyStatus("applied");
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.toasts).toEqual([
      {
        type: "success",
        title: "Copy to M3 is done. Open Move Project to finish setting it up.",
      },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  [
    "files changed while copying",
    { unstable: ["src/a.ts"], checks: [] },
    "Copy to M3 finished, but some files changed on M4 while copying.",
  ],
  [
    "a failed check",
    { unstable: [], checks: [{ repo: "app", ok: false, problems: ["HEAD does not match."] }] },
    "Copy to M3 finished, but the check of app failed.",
  ],
])("warns, not congratulates, after %s and opens the dialog", async (_case, found, title) => {
  vi.useFakeTimers();
  try {
    pointer();
    state.handlers.copyStatus = () => ({ ...copyStatus("applied"), ...found });
    const onOpenDialog = vi.fn();
    await act(async () =>
      root.render(
        <HandoffFolderCopyWatcher
          environmentId={"m4" as never}
          projectId="source"
          projectName="Project"
          machineLabel={() => "M3"}
          sourceLabel="M4"
          onOpenDialog={onOpenDialog}
        />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.toasts).toHaveLength(1);
    const toast = state.toasts[0] as {
      type: string;
      title: string;
      description: string;
      actionProps: { children: string; onClick: () => void };
    };
    expect(toast).toMatchObject({
      type: "warning",
      title,
      description: "Open it to see what differs and copy again.",
    });
    expect(toast.actionProps.children).toBe("Open");
    toast.actionProps.onClick();
    expect(onOpenDialog).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("carries a one-click copy from measured through approval while the dialog is closed", async () => {
  vi.useFakeTimers();
  try {
    pointer({ auto: true, selection: ["repository", "tracked"] });
    const calls: Array<[string, any]> = [];
    let destination: "missing" | "previewed" | "applied" = "missing";
    state.handlers.copyStatus = () => {
      if (destination === "missing") return notFound();
      return destination === "previewed" ? previewed([row()]) : copyStatus("applied");
    };
    state.handlers.copySourceStatus = () => ({
      state: "scanned",
      summary,
      progress: null,
      error: null,
    });
    state.handlers.copyOffer = (request) => {
      calls.push(["copyOffer", request]);
      return {
        operationId: "00000000-0000-4000-8000-000000000009",
        sourceEnvironmentId: "m4",
        sourceProjectId: "source",
        sourceUrl: "https://m4",
        sourceMachine: "M4",
        token: "fresh",
        title: "Project",
        mode: "copy-only",
        status: { state: "scanned", summary, error: null },
      };
    };
    state.handlers.copyStart = (request) => {
      calls.push(["copyStart", request]);
      destination = "previewed";
      return copyStatus("scanning");
    };
    state.handlers.copyApprove = (request) => {
      calls.push(["copyApprove", request]);
      destination = "applied";
      return copyStatus("approved");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(calls.map(([name]) => name)).toEqual(["copyOffer", "copyStart"]);
    expect(calls[1]![1]).toMatchObject({
      environmentId: "m3",
      input: { token: "fresh", targetFolder: "/target", selection: ["repository", "tracked"] },
    });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(calls.map(([name]) => name)).toEqual(["copyOffer", "copyStart", "copyApprove"]);
    expect(state.toasts).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.toasts).toEqual([
      {
        type: "success",
        title: "Copy to M3 is done. Open Move Project to finish setting it up.",
      },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("never approves a one-click copy that would replace files; it asks for review", async () => {
  vi.useFakeTimers();
  try {
    pointer({ auto: true });
    const conflict = row({
      status: "conflict",
      needsDecision: true,
      conflicts: [
        { id: "c", path: "a.txt", reason: "differs", choices: ["take-theirs"], decision: null },
      ],
    });
    state.handlers.copyStatus = () => previewed([conflict], 1);
    state.handlers.copySourceStatus = () => ({
      state: "ready",
      summary,
      progress: null,
      error: null,
    });
    state.handlers.copyApprove = () => {
      throw new Error("must not approve");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.toasts).toEqual([
      {
        type: "success",
        title: "Copy to M3 would replace 1 file. Open Move Project to review.",
      },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

const readPointer = () =>
  JSON.parse(localStorage.getItem("specwithcode:folder-copy:m4:source") ?? "null");
const renderWatcherFrom = (sourceLabel: string) =>
  act(async () =>
    root.render(
      <HandoffFolderCopyWatcher
        environmentId={"m4" as never}
        projectId="source"
        projectName="Project"
        machineLabel={() => "M3"}
        sourceLabel={sourceLabel}
      />,
    ),
  );

it("approves a Replace all left running once the re-compare has nothing open, and says what stayed", async () => {
  vi.useFakeTimers();
  try {
    pointer({ replaceAll: true });
    const calls: string[] = [];
    let destination: "comparing" | "previewed" | "applied" = "comparing";
    state.handlers.copyStatus = () =>
      destination === "comparing"
        ? copyStatus("scanning")
        : destination === "previewed"
          ? previewed([
              row({ status: "diverged", choices: ["take-theirs"], decision: "take-theirs" }),
            ])
          : copyStatus("applied");
    state.handlers.copySourceStatus = () => ({
      state: "committed",
      summary: {
        ...summary,
        secretFiles: [{ path: ".env", size: 1 }],
        skipped: {
          rebuildableFolders: 0,
          worktrees: ["wt/a", "wt/b"],
          dirtyWorktrees: ["wt/a", "wt/b"],
        },
      },
      progress: null,
      error: null,
    });
    state.handlers.copyApprove = () => {
      calls.push("copyApprove");
      destination = "applied";
      return copyStatus("approved");
    };
    await renderWatcherFrom("M4");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(calls).toEqual([]);
    destination = "previewed";
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(calls).toEqual(["copyApprove"]);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.toasts).toEqual([
      {
        type: "success",
        title: "Copy to M3 is done. Open Move Project to finish setting it up.",
        description:
          "2 worktrees with uncommitted changes stayed on M4. 1 secret-like file (.env and similar) stayed on M4. Copy them yourself, or run the copy again with “Let me choose file types first” to send them.",
      },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("drops a pending Replace all whose re-compare still needs a choice and asks for review", async () => {
  vi.useFakeTimers();
  try {
    pointer({ replaceAll: true });
    state.handlers.copyStatus = () =>
      previewed([row({ status: "diverged", choices: ["take-theirs"], needsDecision: true })], 1);
    state.handlers.copyApprove = () => {
      throw new Error("must not approve");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(readPointer()).not.toHaveProperty("replaceAll");
    expect(state.toasts).toEqual([
      {
        type: "success",
        title: "Copy to M3 would replace 1 repository. Open Move Project to review.",
      },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("approves a one-click copy with secret-like files and keeps watching an approval whose answer was lost", async () => {
  vi.useFakeTimers();
  try {
    pointer({ auto: true, secrets: { included: true, out: [] } });
    let destination: "previewed" | "approved" | "applied" = "previewed";
    state.handlers.copyStatus = () =>
      destination === "previewed" ? previewed([row()]) : copyStatus(destination);
    state.handlers.copySourceStatus = () => ({
      state: "ready",
      summary: { ...summary, secretFiles: [{ path: ".env", size: 1 }] },
      progress: null,
      error: null,
    });
    const sent: unknown[] = [];
    state.handlers.copySecrets = (request) => {
      sent.push((request as { input: { paths: string[] } }).input.paths);
      expect(approvals).toBe(0);
      return { state: "ready" };
    };
    let approvals = 0;
    state.handlers.copyApprove = () => {
      approvals += 1;
      destination = "approved";
      throw new Error("The connection dropped.");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(approvals).toBe(1);
    // What comes along showed the secrets included: they go first, to the source.
    expect(sent).toEqual([[".env"]]);
    expect(state.toasts).toEqual([]);
    destination = "applied";
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(approvals).toBe(1);
    expect(state.toasts).toHaveLength(1);
    expect((state.toasts[0] as { title: string }).title).toBe(
      "Copy to M3 is done. Open Move Project to finish setting it up.",
    );
  } finally {
    vi.useRealTimers();
  }
});

it("keeps secrets on the source for a one-click copy saved before the choice existed", async () => {
  vi.useFakeTimers();
  try {
    // Saved by an older version, which left secrets out unless the person ticked them.
    pointer({ auto: true });
    state.handlers.copyStatus = () => previewed([row()]);
    state.handlers.copySourceStatus = () => ({
      state: "ready",
      summary: { ...summary, secretFiles: [{ path: ".env", size: 1 }] },
      progress: null,
      error: null,
    });
    const sent: unknown[] = [];
    state.handlers.copySecrets = (request) => {
      sent.push((request as { input: { paths: string[] } }).input.paths);
      return { state: "ready" };
    };
    let approvals = 0;
    state.handlers.copyApprove = () => {
      approvals += 1;
      return copyStatus("approved");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(sent).toEqual([[]]);
    expect(approvals).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it("sends an empty secrets list before a one-click approval that left secrets on the source", async () => {
  vi.useFakeTimers();
  try {
    pointer({ auto: true, secrets: { included: false, out: [] } });
    state.handlers.copyStatus = () => previewed([row()]);
    state.handlers.copySourceStatus = () => ({
      state: "ready",
      summary: { ...summary, secretFiles: [{ path: ".env", size: 1 }] },
      progress: null,
      error: null,
    });
    const sent: unknown[] = [];
    state.handlers.copySecrets = (request) => {
      sent.push((request as { input: { paths: string[] } }).input.paths);
      return { state: "ready" };
    };
    let approvals = 0;
    state.handlers.copyApprove = () => {
      approvals += 1;
      return copyStatus("approved");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(sent).toEqual([[]]);
    expect(approvals).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it("puts the current choice back and does not approve when another tab unticks secrets mid-send", async () => {
  vi.useFakeTimers();
  try {
    pointer({ auto: true, secrets: { included: true, out: [] } });
    state.handlers.copyStatus = () => previewed([row()]);
    state.handlers.copySourceStatus = () => ({
      state: "ready",
      summary: { ...summary, secretFiles: [{ path: ".env", size: 1 }] },
      progress: null,
      error: null,
    });
    const sent: unknown[] = [];
    state.handlers.copySecrets = (request) => {
      sent.push((request as { input: { paths: string[] } }).input.paths);
      pointer({ auto: true, secrets: { included: false, out: [] } });
      return { state: "ready" };
    };
    let approvals = 0;
    state.handlers.copyApprove = () => {
      approvals += 1;
      return copyStatus("approved");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(approvals).toBe(0);
    // The other tab may already have approved: its empty list goes back on the source.
    expect(sent).toEqual([[".env"], []]);
  } finally {
    vi.useRealTimers();
  }
});

it("does not approve a Replace all after another tab changes the secrets choice", async () => {
  vi.useFakeTimers();
  try {
    pointer({ replaceAll: true });
    let answer: (value: unknown) => void = () => {};
    state.handlers.copyStatus = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    let approvals = 0;
    state.handlers.copyApprove = () => {
      approvals += 1;
      return copyStatus("approved");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    // The other tab's review unticks secrets: its choice drops the old click's Replace all.
    pointer({ secrets: { included: false, out: [] } });
    await act(async () => {
      answer(
        previewed([row({ status: "diverged", choices: ["take-theirs"], decision: "take-theirs" })]),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(approvals).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("waits for the person when the secrets choice cannot be sent", async () => {
  vi.useFakeTimers();
  try {
    pointer({ auto: true });
    state.handlers.copyStatus = () => previewed([row()]);
    state.handlers.copySourceStatus = () => ({
      state: "ready",
      summary: { ...summary, secretFiles: [{ path: ".env", size: 1 }] },
      progress: null,
      error: null,
    });
    state.handlers.copySecrets = () => {
      throw new Error("The source is offline.");
    };
    let approvals = 0;
    state.handlers.copyApprove = () => {
      approvals += 1;
      return copyStatus("approved");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(approvals).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

for (const staged of [true, false])
  it(`from a window that may not send secrets, ${staged ? "takes staged ones off" : "sends nothing"} before approving`, async () => {
    vi.useFakeTimers();
    try {
      state.sourceAccess = "denied";
      pointer({ auto: true });
      state.handlers.copyStatus = () => previewed([row()]);
      state.handlers.copySourceStatus = () => ({
        state: "ready",
        summary: { ...summary, secretFiles: [{ path: ".env", size: 1 }] },
        progress: null,
        error: null,
        secrets: staged
          ? { files: [{ path: ".env", size: 1 }], approvedAt: 1, destinationLabel: "M3" }
          : null,
      });
      const sent: unknown[] = [];
      state.handlers.copySecrets = (request) => {
        sent.push((request as { input: { paths: string[] } }).input.paths);
        return { state: "ready" };
      };
      let approvals = 0;
      state.handlers.copyApprove = () => {
        approvals += 1;
        return copyStatus("approved");
      };
      await renderWatcher();
      await act(async () => vi.advanceTimersByTimeAsync(2000));
      expect(sent).toEqual(staged ? [[]] : []);
      expect(approvals).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

it("waits for the person when staged secrets cannot be taken off from that window", async () => {
  vi.useFakeTimers();
  try {
    state.sourceAccess = "denied";
    pointer({ auto: true });
    state.handlers.copyStatus = () => previewed([row()]);
    state.handlers.copySourceStatus = () => ({
      state: "ready",
      summary: { ...summary, secretFiles: [{ path: ".env", size: 1 }] },
      progress: null,
      error: null,
      secrets: { files: [{ path: ".env", size: 1 }], approvedAt: 1, destinationLabel: "M3" },
    });
    state.handlers.copySecrets = () => {
      throw new Error("This connection requires access:write.");
    };
    let approvals = 0;
    state.handlers.copyApprove = () => {
      approvals += 1;
      return copyStatus("approved");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(approvals).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("leaves secrets and the approval to a reopened dialog while the source summary is in flight", async () => {
  vi.useFakeTimers();
  try {
    pointer({ auto: true });
    state.handlers.copyStatus = () => previewed([row()]);
    let answer: (value: unknown) => void = () => {};
    state.handlers.copySourceStatus = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const sent: unknown[] = [];
    state.handlers.copySecrets = (request) => {
      sent.push((request as { input: { paths: string[] } }).input.paths);
      return { state: "ready" };
    };
    let approvals = 0;
    state.handlers.copyApprove = () => {
      approvals += 1;
      return copyStatus("approved");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    // The dialog reopens (the watcher unmounts) and the person leaves the secrets on the source.
    await act(async () => root.render(<></>));
    pointer({ auto: true, secrets: { included: false, out: [] } });
    await act(async () => {
      answer({
        state: "ready",
        summary: { ...summary, secretFiles: [{ path: ".env", size: 1 }] },
        progress: null,
        error: null,
      });
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(sent).toEqual([]);
    expect(approvals).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("never approves a one-click copy whose unchanged folder would overwrite files", async () => {
  vi.useFakeTimers();
  try {
    pointer({ auto: true });
    state.handlers.copyStatus = () => ({
      ...previewed([row({ replacing: 0 }), row({ id: "repo:b", status: "same", replacing: 2 })]),
      totals: { filesToMove: 1, bytesToMove: 1, bytesPresent: 0, decisionsNeeded: 0, replacing: 2 },
    });
    state.handlers.copySourceStatus = () => ({
      state: "ready",
      summary,
      progress: null,
      error: null,
    });
    state.handlers.copyApprove = () => {
      throw new Error("must not approve");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.toasts).toEqual([
      {
        type: "success",
        title: "Copy to M3 would replace 2 files. Open Move Project to review.",
      },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a reopened dialog's secrets choice when the clone choice answers after unmount", async () => {
  vi.useFakeTimers();
  try {
    pointer({ auto: true, method: "clone" });
    state.handlers.copyStatus = () => previewed([row({ cloneAvailable: true })]);
    let answer: (value: unknown) => void = () => {};
    state.handlers.copyDecide = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await act(async () => root.render(<></>));
    pointer({ auto: true, method: "clone", secrets: { included: false, out: [] } });
    await act(async () => {
      answer(previewed([row({ cloneAvailable: true, clone: true })]));
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(readPointer()).toMatchObject({ secrets: { included: false, out: [] } });
    expect(readPointer()).not.toHaveProperty("cloneDecided");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the remembered steps when it records the clone choice or drops a Replace all", async () => {
  vi.useFakeTimers();
  try {
    pointer({ auto: true, method: "clone", seen: "review", viewed: "what" });
    const decided: unknown[] = [];
    state.handlers.copyStatus = () => previewed([row({ cloneAvailable: true })]);
    state.handlers.copyDecide = (request) => {
      decided.push(request);
      return previewed([row({ cloneAvailable: true, clone: true })]);
    };
    state.handlers.copyApprove = () => new Promise(() => {});
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(decided).toHaveLength(1);
    expect(readPointer()).toMatchObject({ cloneDecided: true, seen: "review", viewed: "what" });

    await act(async () => root.unmount());
    root = createRoot(container);
    pointer({ replaceAll: true, seen: "review", viewed: "where" });
    state.handlers.copyStatus = () =>
      previewed([row({ status: "diverged", choices: ["take-theirs"], needsDecision: true })], 1);
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(readPointer()).not.toHaveProperty("replaceAll");
    expect(readPointer()).toMatchObject({ seen: "review", viewed: "where" });
  } finally {
    vi.useRealTimers();
  }
});

it("shows a background copy's progress app wide and clears it once the copy is done", async () => {
  vi.useFakeTimers();
  try {
    resetCopyActivityForTests();
    pointer();
    let phase: "copying" | "done" = "copying";
    state.handlers.copyStatus = () =>
      phase === "copying"
        ? {
            ...copyStatus("transferring"),
            progress: {
              phase: "files",
              filesDone: 5,
              filesTotal: 10,
              bytesDone: 250,
              bytesTotal: 1000,
              bytesLocal: 0,
            },
          }
        : copyStatus("applied");
    state.handlers.copySourceStatus = () => ({ state: "committed", summary, error: null });
    let done = 0;
    await act(async () =>
      root.render(
        <HandoffFolderCopyWatcher
          environmentId={"m4" as never}
          projectId="source"
          projectName="Project"
          machineLabel={() => "ministorm"}
          onDone={() => (done += 1)}
        />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(currentCopyActivities().get("m4:source")).toEqual({
      machine: "ministorm",
      label: "Copying files",
      fraction: 0.25,
      waiting: false,
    });
    phase = "done";
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(currentCopyActivities().has("m4:source")).toBe(false);
    expect(done).toBe(1);
    expect(state.toasts).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it("never announces again a copy that finished before a reload", async () => {
  vi.useFakeTimers();
  try {
    resetCopyActivityForTests();
    pointer();
    state.handlers.copyStatus = () => copyStatus("applied");
    let done = 0;
    await act(async () =>
      root.render(
        <HandoffFolderCopyWatcher
          environmentId={"m4" as never}
          projectId="source"
          projectName="Project"
          machineLabel={() => "M3"}
          restored
          onDone={() => (done += 1)}
        />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.toasts).toEqual([]);
    expect(done).toBe(1);
    expect(currentCopyActivities().size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a newer copy another tab saved while a closed copy's status was in flight", async () => {
  vi.useFakeTimers();
  try {
    pointer();
    let answer: (value: unknown) => void = () => {};
    state.handlers.copyStatus = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    pointer({ operationId: "00000000-0000-4000-8000-000000000010" });
    await act(async () => {
      answer(copyStatus("cancelled"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readPointer()).toMatchObject({ operationId: "00000000-0000-4000-8000-000000000010" });
  } finally {
    vi.useRealTimers();
  }
});

it("drops a stale Replace all without undoing a secrets choice another tab saved meanwhile", async () => {
  vi.useFakeTimers();
  try {
    pointer({ replaceAll: true });
    let answer: (value: unknown) => void = () => {};
    state.handlers.copyStatus = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    pointer({ replaceAll: true, secrets: { included: false, out: [] } });
    await act(async () => {
      answer(
        previewed([row({ status: "diverged", choices: ["take-theirs"], needsDecision: true })], 1),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readPointer()).toMatchObject({ secrets: { included: false, out: [] } });
    expect(readPointer()).not.toHaveProperty("replaceAll");
  } finally {
    vi.useRealTimers();
  }
});

it("forgets a copy closed on the machine, so its banner stays gone after a restart", async () => {
  const key = "specwithcode:folder-copy:m4:source";
  localStorage.setItem(
    key,
    JSON.stringify({
      operationId: "op-closed",
      environmentId: "m3",
      mode: "copy-only",
      targetFolder: "/home/anton/umb",
      projectId: null,
    }),
  );
  state.handlers.copyStatus = () => copyStatus("cancelled");
  vi.useFakeTimers();
  try {
    await act(async () =>
      root.render(
        <HandoffFolderCopyWatcher
          environmentId={"m4" as never}
          projectId="source"
          machineLabel={() => "M3"}
          restored
        />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(localStorage.getItem(key)).toBeNull();
    expect(state.toasts).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
