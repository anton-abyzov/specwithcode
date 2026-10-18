import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { EnvironmentId, type MachineHandoffBundle } from "@specweave-studio/contracts";
import * as ServerSettings from "../serverSettings.ts";
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

/** A bundle that continues in the destination's own, already configured project. */
const projectFolderBundle = (prepared: MachineHandoffBundle, older = false) => {
  const importedBundle = imported(prepared);
  const { runtimeMode: _runtimeMode, ...olderContext } = importedBundle.context;
  const { digest: _, ...value } = {
    ...importedBundle,
    context: older ? olderContext : importedBundle.context,
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
  return { ...value, digest: MachineHandoff.machineHandoffDigest(value) };
};
const projectFolderPreview = {
  ...preview,
  destination: {
    ...preview.destination,
    executionMode: "project-folder" as const,
    coordinatorThreadId: threadId,
  },
};

it.effect("moves the joined project's existing coordinator to the carried access", () => {
  const h = makeHarness({ coordinatorRuntimeMode: "full-access" });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const prepared = yield* service.prepare(projectFolderPreview);
    expect(prepared.bundle.context.runtimeMode).toBe("full-access");
    const bundle = projectFolderBundle(prepared.bundle);
    yield* service.receive({ projectId, operationId: id, bundle, mode: "start" });
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
    expect(settings.projectSettingsOverrides[projectId]?.defaultRuntimeMode).toBe("full-access");
    // The same save a person's project access change makes: the coordinator follows it.
    expect(h.state.runtimeModeSets).toEqual([{ threadId, runtimeMode: "full-access" }]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("leaves the joined project's chats alone for a bundle without a mode", () => {
  const h = makeHarness({
    coordinatorRuntimeMode: "full-access",
    defaultRuntimeMode: "approval-required",
  });
  return Effect.gen(function* () {
    const service = yield* MachineHandoff.MachineHandoff;
    const prepared = yield* service.prepare(projectFolderPreview);
    const bundle = projectFolderBundle(prepared.bundle, true);
    expect(bundle.context).not.toHaveProperty("runtimeMode");
    yield* service.receive({ projectId, operationId: id, bundle, mode: "start" });
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
    expect(settings.projectSettingsOverrides[projectId]?.defaultRuntimeMode).toBe(
      "approval-required",
    );
    expect(h.state.runtimeModeSets).toEqual([]);
  }).pipe(Effect.provide(h.layer));
});

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
