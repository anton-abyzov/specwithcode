import { EnvironmentId, type OrchestrationV2ArchivedShellSnapshot } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
} from "./archivedThreads.ts";

it("round-trips environment keys in sorted order", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeArchivedThreadsEnvironmentKey([envB, envA]);

  expect(parseArchivedThreadsEnvironmentKey(key)).toEqual([envA, envB]);
});

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])))).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    failedEnvironmentIds: [environmentId],
    isLoading: false,
  });

  registry.dispose();
});

it("lists every machine whose archive failed, and only those", () => {
  const ok = EnvironmentId.make("env-ok");
  const down = EnvironmentId.make("env-down");
  const other = EnvironmentId.make("env-other");
  const snapshot = { threads: [] } as unknown as OrchestrationV2ArchivedShellSnapshot;
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: (environmentId) =>
      Atom.make(
        environmentId === ok
          ? AsyncResult.success<OrchestrationV2ArchivedShellSnapshot, Error>(snapshot)
          : AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
              Cause.fail(new Error("unreachable")),
            ),
      ),
    labelPrefix: "test:archived-thread-snapshots-failed",
  });
  const registry = AtomRegistry.make();

  const state = registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([ok, other, down])));
  expect(state.snapshots).toEqual([{ environmentId: ok, snapshot }]);
  expect(state.failedEnvironmentIds).toEqual([down, other]);
  expect(state.error).toBe("Failed to load archived threads.");

  registry.dispose();
});
