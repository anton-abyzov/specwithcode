import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  EnvironmentId,
  ProjectId,
  type MachineHandoffBundle,
  type MachineHandoffPrepareInput,
} from "@specweave-studio/contracts";
import * as MachineHandoff from "./MachineHandoff.ts";
import {
  makeHarness,
  imported,
  preview,
  destinationPreview,
  id,
  projectId,
  threadId,
} from "./MachineHandoff.test-fixtures.ts";
import { takeProjectMoved } from "./repositorySync.ts";
import { HandoffGitError } from "./handoffGitTypes.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

const gitSyncPreview = {
  ...preview,
  destination: {
    ...preview.destination,
    executionMode: "project-folder" as const,
    coordinatorThreadId: threadId,
    transport: "git-sync" as const,
  },
} satisfies MachineHandoffPrepareInput;

const gitSyncBundle = (prepared: MachineHandoffBundle): MachineHandoffBundle => {
  const importedBundle = imported(prepared);
  const { digest: _, ...value } = {
    ...importedBundle,
    destination: {
      ...importedBundle.destination!,
      executionMode: "project-folder" as const,
      transport: "git-sync" as const,
    },
    coordinatorBinding: {
      ...importedBundle.coordinatorBinding!,
      successor: {
        environmentId: EnvironmentId.make("source-env"),
        projectId,
        coordinatorThreadId: threadId,
      },
    },
  };
  return { ...value, digest: MachineHandoff.machineHandoffDigest(value) };
};

it.effect("publishes the source heads for the copy there, without requiring a clean source", () => {
  const h = makeHarness();
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const first = yield* service.prepare(gitSyncPreview);
    expect(h.state.inspects.at(-1)?.allowChanges).toBe(true);
    const published = yield* service.prepare({
      ...gitSyncPreview,
      publish: true,
      expectedDigest: first.bundle.digest,
    });
    expect(published.publication).toBe("published");
    expect(h.state.pushes).toBe(1);
    // Published after the fence, like any Git move.
    expect(h.state.publicationFenceStates).toEqual(["transferring"]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("still moves when the source cannot publish; the destination says why", () => {
  const h = makeHarness();
  h.state.publicationFailure = true;
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const first = yield* service.prepare(gitSyncPreview);
    const published = yield* service.prepare({
      ...gitSyncPreview,
      publish: true,
      expectedDigest: first.bundle.digest,
    });
    expect(published.publication).toBe("published");
  }).pipe(Effect.provide(h.layer));
});

it.effect("refuses Git sync outside the destination's project folder", () => {
  const h = makeHarness();
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const result = yield* Effect.result(
      service.prepare({
        ...gitSyncPreview,
        destination: { ...preview.destination, transport: "git-sync" },
      }),
    );
    expect(Result.isFailure(result) && result.failure.code).toBe("invalid");
  }).pipe(Effect.provide(h.layer));
});

it.effect("marks the project moved, so the coordinator's first turn there syncs", () => {
  const h = makeHarness();
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const prepared = yield* service.prepare(gitSyncPreview);
    const bundle = gitSyncBundle(prepared.bundle);
    yield* service.receive(destinationPreview(bundle));
    expect(h.state.starts).toHaveLength(0);
    const started = yield* service.receive({
      projectId,
      operationId: id,
      bundle,
      mode: "start",
    });
    expect(started.phase).toBe("started");
    expect(h.state.starts).toHaveLength(1);
    expect(h.state.starts[0]!.prompt).toContain("This move went through Git");
    expect(
      (yield* service.receive({ projectId, operationId: id, bundle, mode: "start" })).replayed,
    ).toBe(true);
    expect(takeProjectMoved(projectId)).toBe(true);
    expect(takeProjectMoved(projectId)).toBe(false);
  }).pipe(Effect.provide(h.layer));
});

describe("an existing copy that cannot reach the source heads (1326)", () => {
  const start = (bundle: MachineHandoffBundle, staleCopy?: "refuse" | "accept") => ({
    projectId,
    operationId: id,
    bundle,
    mode: "start" as const,
    ...(staleCopy ? { staleCopy } : {}),
  });
  const localCommits = new HandoffGitError({
    stage: "materialize",
    reason: "diverged-repository",
    repository: ".",
  });

  it.effect("updates the copy through materialize before the coordinator starts there", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = gitSyncBundle((yield* service.prepare(gitSyncPreview)).bundle);
      const checked = yield* service.receive(destinationPreview(bundle));
      expect(checked.updateSkipped).toBeUndefined();
      expect(h.state.existingCopyChecks).toBe(1);
      expect(h.state.existingCopyMaterializations).toBe(0);
      const started = yield* service.receive(start(bundle, "refuse"));
      expect(started.phase).toBe("started");
      expect(started.updateSkipped).toBeUndefined();
      expect(h.state.existingCopyMaterializations).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("says on the preview why the copy will not be updated", () => {
    const h = makeHarness();
    h.state.existingCopyRefusal = new HandoffGitError({
      stage: "preflight",
      reason: "unsafe-git-config",
      repository: ".",
      unsafeConfig: ["core.sshcommand"],
    });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = gitSyncBundle((yield* service.prepare(gitSyncPreview)).bundle);
      const checked = yield* service.receive(destinationPreview(bundle));
      expect(checked.phase).toBe("ready");
      expect(checked.updateSkipped).toMatchObject({
        reason: "unsafe-git-config",
        unsafeConfig: ["core.sshcommand"],
      });
      expect(checked.updateSkipped?.message).toContain("core.sshcommand");
      expect(h.state.existingCopyMaterializations).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("stops a refusing move before the coordinator moves, then moves anyway", () => {
    const h = makeHarness();
    h.state.existingCopyRefusal = localCommits;
    takeProjectMoved(projectId);
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = gitSyncBundle((yield* service.prepare(gitSyncPreview)).bundle);
      const refused = yield* Effect.result(service.receive(start(bundle, "refuse")));
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) {
        expect(refused.failure.code).toBe("diverged");
        expect(refused.failure.updateSkipped?.reason).toBe("local-commits");
        expect(refused.failure.message).toContain("commits this machine does not have");
      }
      expect(h.state.starts).toHaveLength(0);
      expect(takeProjectMoved(projectId)).toBe(false);
      // "Move anyway on the old copy": the same operation goes on and says why.
      const moved = yield* service.receive(start(bundle, "accept"));
      expect(moved.phase).toBe("started");
      expect(moved.updateSkipped?.reason).toBe("local-commits");
      expect(h.state.starts).toHaveLength(1);
      const replayed = yield* service.receive(start(bundle, "accept"));
      expect(replayed.replayed).toBe(true);
      expect(replayed.updateSkipped?.reason).toBe("local-commits");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("keeps an older client's move going and reports the skipped update", () => {
    const h = makeHarness();
    h.state.existingCopyRefusal = new HandoffGitError({
      stage: "materialize",
      reason: "remote-ref-mismatch",
    });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = gitSyncBundle((yield* service.prepare(gitSyncPreview)).bundle);
      const moved = yield* service.receive(start(bundle));
      expect(moved.phase).toBe("started");
      expect(moved.updateSkipped?.reason).toBe("not-published");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("never moves past an unsafe path", () => {
    const h = makeHarness();
    h.state.existingCopyRefusal = new HandoffGitError({
      stage: "materialize",
      reason: "unsafe-path",
    });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = gitSyncBundle((yield* service.prepare(gitSyncPreview)).bundle);
      const refused = yield* Effect.result(service.receive(start(bundle, "accept")));
      expect(Result.isFailure(refused) && refused.failure.code).toBe("unsafe_path");
      expect(h.state.starts).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("holds every overlapping project's admission lock while the copy updates", () => {
    const h = makeHarness();
    const nested = ProjectId.make("nested-project");
    h.projects.set(nested, {
      ...h.projects.get(projectId)!,
      id: nested,
      workspaceRoot: `${h.projects.get(projectId)!.workspaceRoot}/packages/app`,
    });
    const elsewhere = ProjectId.make("elsewhere-project");
    h.projects.set(elsewhere, {
      ...h.projects.get(projectId)!,
      id: elsewhere,
      workspaceRoot: "/elsewhere/project",
    });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const admission = yield* ProjectAdmission.ProjectAdmission;
      const admitted: Record<string, boolean> = {};
      // Work starting in another project, from another fiber, while the copy updates.
      // The test clock never advances, so the probe yields, polls, then interrupts.
      const tryAdmit = (id: ProjectId) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(admission.withLock(id, Effect.void));
          for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
          admitted[id] = fiber.pollUnsafe() !== undefined;
          yield* Fiber.interrupt(fiber);
        });
      h.state.duringExistingCopyUpdate = Effect.gen(function* () {
        yield* tryAdmit(projectId);
        yield* tryAdmit(nested);
        yield* tryAdmit(elsewhere);
      });
      const bundle = gitSyncBundle((yield* service.prepare(gitSyncPreview)).bundle);
      expect((yield* service.receive(start(bundle, "refuse"))).phase).toBe("started");
      expect(admitted).toEqual({ [projectId]: false, [nested]: false, [elsewhere]: true });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("also holds the lock of a project working in a linked worktree of the copy", () => {
    const h = makeHarness();
    const root = h.projects.get(projectId)!;
    // A project registered on a linked worktree of the copy's repository, outside its folder.
    const rooted = ProjectId.make("worktree-project");
    h.projects.set(rooted, { ...root, id: rooted, workspaceRoot: "/worktrees/app-feature" });
    // A project elsewhere, with one thread working in another linked worktree of it.
    const threaded = ProjectId.make("thread-project");
    h.projects.set(threaded, { ...root, id: threaded, workspaceRoot: "/elsewhere/threaded" });
    h.state.threadWorktrees = [
      {
        projectId: threaded,
        workspaceRoot: "/elsewhere/threaded",
        worktreePath: "/worktrees/app-review/packages",
      },
    ];
    const unrelated = ProjectId.make("unrelated-project");
    h.projects.set(unrelated, { ...root, id: unrelated, workspaceRoot: "/elsewhere/unrelated" });
    h.state.existingCopyFolders = [
      root.workspaceRoot,
      "/worktrees/app-feature",
      "/worktrees/app-review",
    ];
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const admission = yield* ProjectAdmission.ProjectAdmission;
      const admitted: Record<string, boolean> = {};
      h.state.duringExistingCopyUpdate = Effect.forEach(
        [rooted, threaded, unrelated],
        (id) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(admission.withLock(id, Effect.void));
            for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
            admitted[id] = fiber.pollUnsafe() !== undefined;
            yield* Fiber.interrupt(fiber);
          }),
        { discard: true },
      );
      const bundle = gitSyncBundle((yield* service.prepare(gitSyncPreview)).bundle);
      expect((yield* service.receive(start(bundle, "refuse"))).phase).toBe("started");
      expect(admitted).toEqual({ [rooted]: false, [threaded]: false, [unrelated]: true });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("locks a project that starts using the folder while the locks are taken", () => {
    const h = makeHarness();
    const root = h.projects.get(projectId)!;
    const late = ProjectId.make("late-project");
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const admission = yield* ProjectAdmission.ProjectAdmission;
      const bundle = gitSyncBundle((yield* service.prepare(gitSyncPreview)).bundle);
      // The receive waits for the project's lock; meanwhile a project is added inside its folder.
      const gate = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(admission.withLock(projectId, Deferred.await(gate)));
      for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
      const receiving = yield* Effect.forkChild(service.receive(start(bundle, "refuse")));
      for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow;
      h.projects.set(late, { ...root, id: late, workspaceRoot: `${root.workspaceRoot}/late` });
      let lateAdmitted: boolean | null = null;
      h.state.duringExistingCopyUpdate = Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(admission.withLock(late, Effect.void));
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
        lateAdmitted = fiber.pollUnsafe() !== undefined;
        yield* Fiber.interrupt(fiber);
      });
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(holder);
      expect((yield* Fiber.join(receiving)).phase).toBe("started");
      expect(lateAdmitted).toBe(false);
      expect(h.state.existingCopyMaterializations).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("retries a refused move once the copy can update, without a second launch", () => {
    const h = makeHarness();
    h.state.existingCopyRefusal = new HandoffGitError({
      stage: "materialize",
      reason: "in-use",
      repository: "repositories/nested",
    });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = gitSyncBundle((yield* service.prepare(gitSyncPreview)).bundle);
      const refused = yield* Effect.result(service.receive(start(bundle, "refuse")));
      expect(Result.isFailure(refused) && refused.failure.code).toBe("busy");
      expect(Result.isFailure(refused) && refused.failure.updateSkipped?.repository).toBe(
        "repositories/nested",
      );
      expect(h.state.starts).toHaveLength(0);
      // The thread there finished: the same operation is sent again and updates the copy.
      h.state.existingCopyRefusal = null;
      const moved = yield* service.receive(start(bundle, "refuse"));
      expect(moved.phase).toBe("started");
      expect(moved.updateSkipped).toBeUndefined();
      expect(h.state.existingCopyMaterializations).toBe(2);
      const replayed = yield* service.receive(start(bundle, "refuse"));
      expect(replayed.replayed).toBe(true);
      expect(h.state.starts).toHaveLength(1);
      expect(h.state.existingCopyMaterializations).toBe(2);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect.each(["lfs-failed", "external-git-storage"] as const)(
    "%s before the coordinator moves refuses; after it, the saved reason replays",
    (reason) => {
      const h = makeHarness();
      h.state.existingCopyRefusal = new HandoffGitError({ stage: "materialize", reason });
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        const first = yield* service.prepare(gitSyncPreview);
        const published = yield* service.prepare({
          ...gitSyncPreview,
          publish: true,
          expectedDigest: first.bundle.digest,
        });
        const bundle = gitSyncBundle(published.bundle);
        const binding = () => h.projects.get(projectId)!.workspaceSettings!.coordinatorBinding!;
        const skipped = reason === "lfs-failed" ? "lfs-failed" : "external-storage";
        // Before the coordinator moves: nothing changes hands, the source stays fenced.
        const refused = yield* Effect.result(service.receive(start(bundle, "refuse")));
        expect(Result.isFailure(refused) && refused.failure.updateSkipped?.reason).toBe(skipped);
        expect(binding().state).toBe("transferring");
        expect(h.state.starts).toHaveLength(0);
        const moved = yield* service.receive(start(bundle, "accept"));
        expect(moved.updateSkipped?.reason).toBe(skipped);
        expect(binding().state).toBe("active");
        // After it moved: the copy is never updated again, and the saved reason is what a
        // lost reply's retry reads, whatever the copy looks like by then.
        h.state.existingCopyRefusal = null;
        const replayed = yield* service.receive(start(bundle, "refuse"));
        expect(replayed.replayed).toBe(true);
        expect(replayed.updateSkipped?.reason).toBe(skipped);
        expect(h.state.existingCopyMaterializations).toBe(2);
        expect(h.state.starts).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("cancels a refused move after the source fenced, and moves with accept", () => {
    const h = makeHarness();
    h.state.existingCopyRefusal = localCommits;
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const first = yield* service.prepare(gitSyncPreview);
      const published = yield* service.prepare({
        ...gitSyncPreview,
        publish: true,
        expectedDigest: first.bundle.digest,
      });
      const binding = () => h.projects.get(projectId)!.workspaceSettings!.coordinatorBinding!;
      expect(binding().state).toBe("transferring");
      const bundle = gitSyncBundle(published.bundle);
      const refused = yield* Effect.result(service.receive(start(bundle, "refuse")));
      expect(Result.isFailure(refused) && refused.failure.updateSkipped?.reason).toBe(
        "local-commits",
      );
      expect(binding().state).toBe("transferring");
      // "Cancel": the source releases its fence and keeps its coordinator.
      const released = yield* service.copyRelease({
        projectId,
        operationId: id,
        reason: "The copy there has its own commits.",
      });
      expect(released.released).toBe(true);
      expect(binding().state).toBe("active");
      expect(h.state.starts).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("moves the coordinator with accept: active there at the next epoch", () => {
    const h = makeHarness();
    h.state.existingCopyRefusal = localCommits;
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const first = yield* service.prepare(gitSyncPreview);
      const published = yield* service.prepare({
        ...gitSyncPreview,
        publish: true,
        expectedDigest: first.bundle.digest,
      });
      const bundle = gitSyncBundle(published.bundle);
      const moved = yield* service.receive(start(bundle, "accept"));
      expect(moved.updateSkipped?.reason).toBe("local-commits");
      const binding = h.projects.get(projectId)!.workspaceSettings!.coordinatorBinding!;
      expect(binding.state).toBe("active");
      expect(binding.epoch).toBe(bundle.coordinatorBinding!.epoch + 1);
      expect(h.state.starts).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
});
