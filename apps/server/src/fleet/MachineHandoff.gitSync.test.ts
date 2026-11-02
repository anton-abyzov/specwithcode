import { expect, it } from "@effect/vitest";
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

it.effect("moves through Git without pushing the source or requiring it to be clean", () => {
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
    expect(h.state.pushes).toBe(0);
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
