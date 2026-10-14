import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { EnvironmentId } from "@specweave-studio/contracts";
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

it.effect(
  "continues in the selected project with no extra registration, preserving retry identity",
  () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const prepared = yield* service.prepare({
        ...preview,
        destination: {
          ...preview.destination,
          executionMode: "project-folder",
          coordinatorThreadId: threadId,
        },
      });
      expect(prepared.bundle.coordinatorBinding?.successor?.projectId).toBe(projectId);
      const importedBundle = imported(prepared.bundle);
      const { digest: _, ...value } = {
        ...importedBundle,
        destination: { ...importedBundle.destination!, executionMode: "project-folder" as const },
        coordinatorBinding: {
          ...importedBundle.coordinatorBinding!,
          successor: {
            environmentId: EnvironmentId.make("source-env"),
            projectId,
            coordinatorThreadId: threadId,
          },
        },
      };
      const bundle = { ...value, digest: MachineHandoff.machineHandoffDigest(value) };
      expect((yield* service.receive(destinationPreview(bundle))).executionMode).toBe(
        "project-folder",
      );
      const input = { projectId, operationId: id, bundle, mode: "start" as const };
      const result = yield* service.receive(input);
      expect(result.workspacePath).toBe("/source/project");
      expect(result.projectId).toBe(projectId);
      expect(h.state.creations).toHaveLength(0);
      expect(h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding?.state).toBe(
        "active",
      );
      expect((yield* service.receive(input)).replayed).toBe(true);
      expect(h.state.materializations).toBe(1);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "rejects an old outgoing acknowledgment after this folder becomes coordinator again",
  () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const inspected = yield* service.prepare(preview);
      const published = yield* service.prepare({
        ...preview,
        publish: true,
        expectedDigest: inspected.bundle.digest,
      });
      const current = h.projects.get(projectId)!;
      h.projects.set(projectId, {
        ...current,
        workspaceSettings: {
          ...current.workspaceSettings!,
          coordinatorBinding: { epoch: 2, state: "active", operationId: "returned-operation" },
        },
      });
      const before = h.projects.get(projectId);
      const successor = published.bundle.coordinatorBinding!.successor!;
      const failure = yield* service
        .prepare({
          ...preview,
          publish: true,
          expectedDigest: published.bundle.digest,
          acknowledgment: {
            operationId: id,
            environmentId: successor.environmentId,
            projectId: successor.projectId,
            coordinatorThreadId: successor.coordinatorThreadId,
            digest: published.bundle.digest,
          },
        })
        .pipe(Effect.flip);
      expect(failure.code).toBe("conflict");
      expect(h.projects.get(projectId)).toBe(before);
    }).pipe(Effect.provide(h.layer));
  },
);
