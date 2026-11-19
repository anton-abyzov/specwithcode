// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  linkRefusalsForTest as refusalsKept,
  resetLinkRefusalsForTest,
} from "../../studio/linkRefusals";
import { HandoffFolderCopyWatcher } from "./HandoffFolderCopyWatcher";

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (input: unknown) => unknown>,
  toasts: [] as unknown[],
  /** This window's access:write on the source, as the session reports it. */
  sourceAccess: "unknown" as "granted" | "denied" | "unknown",
  /** The link a finished copy-only copy gets; a test replaces it to watch or refuse it. */
  link: null as unknown as (...args: unknown[]) => Promise<unknown>,
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScopeAccess: () => state.sourceAccess,
  readEnvironmentScopeAccess: () => state.sourceAccess,
}));
vi.mock("../../studio/machineHandoff", () => ({
  machineHandoff: new Proxy({}, { get: (_target, name) => name }),
}));
vi.mock("../../studio/projectLink", () => ({
  projectLink: new Proxy({}, { get: (_target, name) => `link:${String(name)}` }),
  linkCopyAsWorkers: (...args: unknown[]) => state.link(...args),
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
  state.link = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ status: "linked" }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  resetLinkRefusalsForTest();
  await act(async () => root.unmount());
  container.remove();
});

// Secrets a window cannot send, and linking a finished copy without the dialog.

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

const KEY = "specwithcode:folder-copy:m4:source";
const saved = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, unknown>;
const withSecret = () => ({
  state: "ready",
  summary: { ...summary, secretFiles: [{ path: ".env", size: 1 }] },
  progress: null,
  error: null,
});

it.each([
  { how: "a one-click copy", extra: { auto: true }, plan: () => previewed([row()]) },
  {
    how: "a Replace all left running",
    extra: { replaceAll: true },
    plan: () =>
      previewed([row({ status: "diverged", choices: ["take-theirs"], decision: "take-theirs" })]),
  },
])(
  "never approves $how without secrets when its form said they are included",
  async ({ extra, plan }) => {
    vi.useFakeTimers();
    try {
      // The source's session loaded after the copy started: this window may not send secrets.
      state.sourceAccess = "denied";
      pointer({ ...extra, secrets: { included: true, out: [] } });
      state.handlers.copyStatus = plan;
      state.handlers.copySourceStatus = withSecret;
      const calls: string[] = [];
      state.handlers.copySecrets = () => {
        calls.push("copySecrets");
        return { state: "ready" };
      };
      state.handlers.copyApprove = () => {
        calls.push("copyApprove");
        return copyStatus("approved");
      };
      await renderWatcher();
      await act(async () => vi.advanceTimersByTimeAsync(2000));
      await act(async () => vi.advanceTimersByTimeAsync(2000));
      expect(calls).toEqual([]);
      // The person decides at the review, which says why secrets stay.
      expect(state.toasts).toHaveLength(1);
      expect((state.toasts[0] as { title: string }).title).toMatch(/review\.$/);
      expect(saved().replaceAll).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  },
);

it("approves a one-click copy without secrets when its form said this window cannot send them", async () => {
  vi.useFakeTimers();
  try {
    state.sourceAccess = "denied";
    pointer({ auto: true, secrets: { included: true, out: [] }, secretsStay: true });
    state.handlers.copyStatus = () => previewed([row()]);
    state.handlers.copySourceStatus = withSecret;
    const inputs: unknown[] = [];
    state.handlers.copyApprove = (request) => {
      inputs.push((request as { input: unknown }).input);
      return copyStatus("approved");
    };
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(inputs).toEqual([{ operationId: expect.any(String), withoutSecrets: true }]);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  {
    access: "denied" as const,
    who: "only the source's own window can send",
    text: "1 secret-like file (.env and similar) stayed on M4. This window can't send them: only SpecWithCode on M4 can. Start the copy again there with Secrets ticked.",
  },
  {
    // An unanswered session may turn out denied: no promise that this window can.
    access: "unknown" as const,
    who: "the source's window sends, while this window's access is unconfirmed,",
    text: "1 secret-like file (.env and similar) stayed on M4. To send them, start the copy again in SpecWithCode on M4 with Secrets ticked.",
  },
  {
    access: "granted" as const,
    who: "this window can send",
    text: "1 secret-like file (.env and similar) stayed on M4. To send them, copy again with Secrets ticked.",
  },
])("says $who the secrets that stayed", async ({ access, text }) => {
  vi.useFakeTimers();
  try {
    state.sourceAccess = access;
    pointer();
    state.handlers.copyStatus = () => copyStatus("applied");
    state.handlers.copySourceStatus = withSecret;
    await act(async () =>
      root.render(
        <HandoffFolderCopyWatcher
          environmentId={"m4" as never}
          projectId="source"
          projectName="Project"
          machineLabel={() => "M3"}
          sourceLabel="M4"
        />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect((state.toasts[0] as { description: string }).description).toBe(text);
  } finally {
    vi.useRealTimers();
  }
});

it("links a finished copy-only copy without the dialog and records it", async () => {
  vi.useFakeTimers();
  try {
    pointer();
    state.handlers.copyStatus = () => copyStatus("applied");
    await act(async () =>
      root.render(
        <HandoffFolderCopyWatcher
          environmentId={"m4" as never}
          projectId="source"
          projectName="Project"
          machineLabel={() => "M3"}
          sourceLabel="M4"
        />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.link).toHaveBeenCalledOnce();
    expect(state.link).toHaveBeenCalledWith(
      {
        preview: expect.any(Function),
        prepare: expect.any(Function),
        accept: expect.any(Function),
        commit: expect.any(Function),
      },
      {
        kept: { environmentId: "m4", projectId: "source" },
        joining: { environmentId: "m3", projectId: "copied" },
        keptLabel: "M4",
        joiningLabel: "M3",
        newOperationId: expect.any(Function),
      },
    );
    // A reopened dialog shows it linked and does not link it again.
    expect(saved().linked).toBe(true);
    expect(state.toasts).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it("links a copy found finished after a restart, without announcing it again", async () => {
  vi.useFakeTimers();
  try {
    pointer();
    state.handlers.copyStatus = () => copyStatus("applied");
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
    expect(state.link).toHaveBeenCalledOnce();
    expect(saved().linked).toBe(true);
    expect(state.toasts).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("waits for the machine to connect after a restart, then links the finished copy", async () => {
  vi.useFakeTimers();
  try {
    pointer();
    let connected = false;
    state.handlers.copyStatus = () => {
      if (!connected) throw new Error("M3 is still connecting.");
      return copyStatus("applied");
    };
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
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(state.link).not.toHaveBeenCalled();
    connected = true;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.link).toHaveBeenCalledOnce();
    expect(saved().linked).toBe(true);
    // Still quiet: a copy that finished before the restart is not announced again.
    expect(state.toasts).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("stops waiting for a machine that stays unreachable after a restart", async () => {
  vi.useFakeTimers();
  try {
    pointer();
    let checks = 0;
    state.handlers.copyStatus = () => {
      checks += 1;
      throw new Error("M3 is offline.");
    };
    const onDone = vi.fn();
    await act(async () =>
      root.render(
        <HandoffFolderCopyWatcher
          environmentId={"m4" as never}
          projectId="source"
          machineLabel={() => "M3"}
          restored
          onDone={onDone}
        />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(checks).toBe(31);
    expect(onDone).toHaveBeenCalledOnce();
    expect(state.link).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  {
    how: "it needs review",
    link: async () => ({
      status: "review",
      reason: "Notes differ.",
      words: { text: "Notes differ.", verbatim: true },
    }),
  },
  {
    how: "a machine did not answer",
    link: async () => {
      throw new Error("offline");
    },
  },
])("leaves the link to the dialog when $how", async ({ how, link }) => {
  vi.useFakeTimers();
  try {
    state.link = vi.fn<(...args: unknown[]) => Promise<unknown>>(link);
    pointer();
    state.handlers.copyStatus = () => copyStatus("applied");
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.link).toHaveBeenCalledOnce();
    expect(saved().linked).toBeUndefined();
    // Kept for the machine menu either way: what was returned, or what the failure said.
    expect(refusalsKept()).toEqual([
      { text: how === "it needs review" ? "Notes differ." : "offline", verbatim: true },
    ]);
    // The copy is still announced as done.
    expect(state.toasts).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  { how: "a copy already linked", extra: { linked: true }, status: () => copyStatus("applied") },
  {
    how: "a move, whose coordinator carries the project identity",
    extra: { mode: "copy-and-move" },
    status: () => copyStatus("applied", "copy-and-move"),
  },
  {
    how: "a copy not registered as a project yet",
    extra: {},
    status: () => ({ ...copyStatus("applied"), projectId: null }),
  },
  { how: "a failed copy", extra: {}, status: () => copyStatus("failed") },
])("does not link $how", async ({ extra, status }) => {
  vi.useFakeTimers();
  try {
    pointer(extra);
    state.handlers.copyStatus = status;
    await renderWatcher();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.link).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
