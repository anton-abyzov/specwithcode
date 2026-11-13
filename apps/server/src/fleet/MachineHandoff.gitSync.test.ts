import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  EnvironmentId,
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
});
