import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
} from "~/composerDraftStore";
import {
  draftHasMachineBoundContent,
  draftMachineUnavailableReason,
  MACHINE_ATTACHMENT_BLOCK_REASON,
  selectDraftMachineTarget,
} from "./draftMachineSelection";

const m4 = EnvironmentId.make("m4"),
  m1 = EnvironmentId.make("m1");
const projectId = ProjectId.make("project-m4"),
  destinationId = ProjectId.make("project-m1");
const draftId = DraftId.make("draft-machines");
const target = { environmentId: m1, projectId: destinationId };
beforeEach(() => {
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  const store = useComposerDraftStore.getState();
  store.setLogicalProjectDraftThreadId("source", scopeProjectRef(m4, projectId), draftId, {
    threadId: ThreadId.make("draft-thread"),
    branch: "my-branch",
    worktreePath: "/m4/worktree",
    envMode: "worktree",
    startFromOrigin: true,
    runtimeMode: "full-access",
    interactionMode: "plan",
    environmentSelection: "auto",
    loadBalancedEnvironmentId: m4,
  });
  store.setPrompt(draftId, "Keep my unfinished prompt");
  store.setModelSelection(
    draftId,
    createModelSelection(ProviderInstanceId.make("codex"), "gpt-6.1-sol", [
      { id: "reasoningEffort", value: "high" },
    ]),
    { explicit: true },
  );
});

function setup() {
  const commit = vi.fn(() =>
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId("destination", scopeProjectRef(m1, destinationId), draftId, {
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
      }),
  );
  return {
    target,
    readDraft: () => useComposerDraftStore.getState().getDraftSession(draftId),
    readComposer: () => useComposerDraftStore.getState().getComposerDraft(draftId),
    isBlocked: () => false,
    isCurrentRequest: () => true,
    unavailableReason: (): string | null => null,
    resolveProject: vi.fn(() => Promise.resolve(target)),
    commit,
  };
}

describe("draft machine selection", () => {
  it("preserves the same draft, prompt, permissions and mode, clears workspace context and pins manually", async () => {
    const input = setup();
    const before = input.readComposer();
    expect(await selectDraftMachineTarget(input)).toEqual({ status: "selected" });
    expect(input.commit).toHaveBeenCalledOnce();
    expect(input.readComposer()).toBe(before);
    expect(input.readComposer()).toMatchObject({
      modelSelectionExplicit: true,
      activeProvider: "codex",
      modelSelectionByProvider: {
        codex: { model: "gpt-6.1-sol", options: [{ id: "reasoningEffort", value: "high" }] },
      },
    });
    expect(input.readDraft()).toMatchObject({
      environmentId: m1,
      projectId: destinationId,
      threadId: "draft-thread",
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      startFromOrigin: true,
      runtimeMode: "full-access",
      interactionMode: "plan",
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });
    expect(
      useComposerDraftStore.getState().getDraftSessionByLogicalProjectKey("source"),
    ).toBeNull();
  });

  it.each(["sending", "superseded", "promoted", "missing"])(
    "refuses %s before resolving a destination",
    async (kind) => {
      const input = setup();
      if (kind === "sending") input.isBlocked = () => true;
      if (kind === "superseded") input.isCurrentRequest = () => false;
      if (kind === "promoted")
        input.readDraft()!.promotedTo = { environmentId: m4, threadId: ThreadId.make("submitted") };
      if (kind === "missing") input.readDraft = () => null;
      expect(await selectDraftMachineTarget(input)).toEqual({ status: "cancelled" });
      expect(input.resolveProject).not.toHaveBeenCalled();
      expect(input.commit).not.toHaveBeenCalled();
    },
  );

  it.each(["sending", "superseded", "promoted", "away-and-back", "new-workspace"])(
    "refuses %s while Scratch resolves",
    async (kind) => {
      const input = setup();
      let finish!: (value: typeof target) => void;
      input.resolveProject = vi.fn(
        () =>
          new Promise<typeof target>((resolve) => {
            finish = resolve;
          }),
      );
      const result = selectDraftMachineTarget(input);
      if (kind === "sending") input.isBlocked = () => true;
      if (kind === "superseded") input.isCurrentRequest = () => false;
      if (kind === "promoted")
        input.readDraft()!.promotedTo = { environmentId: m4, threadId: ThreadId.make("submitted") };
      if (kind === "away-and-back") {
        useComposerDraftStore
          .getState()
          .setDraftThreadContext(draftId, { projectRef: scopeProjectRef(m1, destinationId) });
        useComposerDraftStore
          .getState()
          .setDraftThreadContext(draftId, { projectRef: scopeProjectRef(m4, projectId) });
      }
      if (kind === "new-workspace")
        useComposerDraftStore.getState().setDraftThreadContext(draftId, { branch: "new-choice" });
      finish(target);
      expect(await result).toEqual({ status: "cancelled" });
      expect(input.commit).not.toHaveBeenCalled();
    },
  );

  it.each([
    "images",
    "files",
    "persistedAttachments",
    "terminalContexts",
    "previewAnnotations",
    "reviewComments",
    "threadContexts",
  ] as const)("blocks cross-machine %s without discarding it", async (field) => {
    const input = setup();
    const composer = {
      ...input.readComposer()!,
      [field]: [{ fixture: "preserved" }],
    } as unknown as ComposerThreadDraftState;
    input.readComposer = () => composer;
    expect(draftHasMachineBoundContent(composer)).toBe(true);
    expect(await selectDraftMachineTarget(input)).toEqual({
      status: "blocked",
      reason: MACHINE_ATTACHMENT_BLOCK_REASON,
    });
    expect(input.resolveProject).not.toHaveBeenCalled();
    expect(composer[field]).toHaveLength(1);
  });

  it("rechecks attachments and permissions after destination preparation", async () => {
    for (const reason of ["attachments", "permission"]) {
      const input = setup();
      input.resolveProject = vi.fn(async () => {
        if (reason === "attachments")
          input.readComposer = () =>
            ({
              ...useComposerDraftStore.getState().getComposerDraft(draftId)!,
              files: [{}],
            }) as ComposerThreadDraftState;
        else input.unavailableReason = () => "Permission revoked";
        return target;
      });
      expect(await selectDraftMachineTarget(input)).toMatchObject({ status: "blocked" });
      expect(input.commit).not.toHaveBeenCalled();
    }
  });

  it("keeps text typed during a pending switch", async () => {
    const input = setup();
    input.resolveProject = vi.fn(async () => {
      useComposerDraftStore.getState().setPrompt(draftId, "Newer prompt");
      return target;
    });
    expect(await selectDraftMachineTarget(input)).toEqual({ status: "selected" });
    expect(input.readComposer()?.prompt).toBe("Newer prompt");
  });

  it("refuses a mismatched machine or project response", async () => {
    for (const wrong of [
      { ...target, environmentId: m4 },
      { ...target, projectId },
    ]) {
      const input = setup();
      input.resolveProject = vi.fn(async () => wrong);
      expect(await selectDraftMachineTarget(input)).toMatchObject({ status: "blocked" });
      expect(input.commit).not.toHaveBeenCalled();
    }
  });

  it("keeps connection and permission status distinct", () => {
    expect(draftMachineUnavailableReason("connected", true)).toBeNull();
    expect(draftMachineUnavailableReason("connected", false)).toMatch(/Permission/);
    expect(draftMachineUnavailableReason("connecting", true)).toBe("Connecting…");
    // This machine's server shares the device: a slow answer means it is busy.
    for (const phase of ["connecting", "reconnecting", "offline", "available"] as const)
      expect(draftMachineUnavailableReason(phase, true, true)).toBe("Catching up…");
    expect(draftMachineUnavailableReason("connected", true, true)).toBeNull();
    expect(draftMachineUnavailableReason("error", true, true)).toBe("Not connected");
    expect(draftMachineUnavailableReason("reconnecting", true)).toBe(
      "Can't reach this machine right now",
    );
    for (const phase of ["offline", "available", "error", "unsupported"] as const)
      expect(draftMachineUnavailableReason(phase, true)).toBe("Not connected");
  });
});
