// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";

import { useWorkspaceMissingRecovery } from "./useWorkspaceMissingRecovery";
import type { WorkspaceMissingRecoveryActions } from "./WorkspaceMissingRecovery";

const commands = vi.hoisted(() => ({
  restore: vi.fn(),
  update: vi.fn(),
  resume: vi.fn(),
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { updateMetadata: "update" },
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { restoreThreadWorkspace: "restore" },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: "update") => commands[command],
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "restore") => commands[command],
}));

const environmentId = EnvironmentId.make("host");
const threadId = ThreadId.make("thread-1041");
const worktreePath = "/w/specweave-studio/fix-1041-design-create-reuse";

type HookInput = Parameters<typeof useWorkspaceMissingRecovery>[0];
const baseInput: HookInput = {
  environmentId,
  threadId,
  failureItemId: "item:1",
  failureCode: "workspace_missing",
  worktreePath,
  branch: "fix/1041-design-create-reuse",
  projectFolder: "/repos/specweave",
  enabled: true,
  canWriteSourceControl: true,
  resolveThread: null,
  resumeHeldQueue: (id) => commands.resume(id),
};

function renderRecovery(input: Partial<HookInput> = {}) {
  let actions: WorkspaceMissingRecoveryActions | undefined;
  function Probe() {
    actions = useWorkspaceMissingRecovery({ ...baseInput, ...input });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return actions;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  commands.resume.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  commands.update.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
});
afterEach(() => vi.clearAllMocks());

it("recreates the folder, then releases the held queue", async () => {
  commands.restore.mockResolvedValue(
    AsyncResult.success({ status: "restored", repository: "/repos/specweave-studio", message: "" }),
  );
  const outcome = await renderRecovery()!.onRecreate!();

  expect(commands.restore).toHaveBeenCalledWith({ environmentId, input: { threadId } });
  expect(commands.resume).toHaveBeenCalledWith(threadId);
  expect(outcome).toEqual({ ok: true, message: "Folder restored. Send your message again." });
});

it("keeps the queue held and says why when its model check refuses", async () => {
  commands.restore.mockResolvedValue(
    AsyncResult.success({ status: "restored", repository: "/repos/specweave-studio", message: "" }),
  );
  commands.resume.mockRejectedValue(new Error("Queued requests use a different model."));
  const outcome = await renderRecovery()!.onRecreate!();

  expect(outcome).toEqual({ ok: false, message: "Queued requests use a different model." });
});

it("shows the server's reason and keeps the queue held when the branch is gone", async () => {
  commands.restore.mockResolvedValue(
    AsyncResult.success({ status: "branch-missing", message: "Branch x no longer exists." }),
  );
  const outcome = await renderRecovery()!.onRecreate!();

  expect(commands.resume).not.toHaveBeenCalled();
  expect(outcome).toEqual({ ok: false, message: "Branch x no longer exists." });
});

it("moves the thread to the project folder only if its folder is unchanged", async () => {
  const outcome = await renderRecovery()!.onUseProjectFolder!();

  expect(commands.update).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, worktreePath: null, expectedWorktreePath: worktreePath },
  });
  expect(commands.resume).toHaveBeenCalledTimes(1);
  expect(outcome.ok).toBe(true);
});

it("offers nothing for other failures and no recreate without source control", () => {
  expect(renderRecovery({ failureCode: "provider_open_failed" })).toBeUndefined();
  expect(renderRecovery({ enabled: false })).toBeUndefined();
  const withoutGit = renderRecovery({ canWriteSourceControl: false })!;
  expect(withoutGit.onRecreate).toBeUndefined();
  expect(withoutGit.onUseProjectFolder).toBeDefined();
  expect(withoutGit.onResolve).toBeUndefined();
});
