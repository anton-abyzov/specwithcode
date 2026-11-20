// @effect-diagnostics nodeBuiltinImport:off - a folder that outlives one server life.
/**
 * The stage of the handed-off thread follower tests: the source's folder, the
 * messages its threads keep, its own threads, and the machines it can ask.
 * The other machines answer as a released peer does (releasedPeer.testkit.ts).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { releasedPeer } from "./releasedPeer.testkit.ts";
import * as RemoteWorkerFollower from "./RemoteWorkerFollower.ts";
import * as RemoteWorkerStore from "./RemoteWorkerStore.ts";
import {
  allow,
  type KeptMessage,
  machine,
  makeSignal,
  ROLES,
  setup,
} from "./remoteWorkers.testkit.ts";

const temporary: Array<string> = [];
/** Removes every stage's folder; call from `afterEach`. */
export const removeStages = () => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
};

export const LAUNCHER = "coordinator";
export const THREAD = "handoff:1";
export const ROW = "handoff-follow:1";
/** The one message a handoff sends its launcher, whichever run is its result. */
export const WAKE = `remote-worker-wake:${ROW}`;
export const LIVE = { timeout: 20_000 };

/** The row the source writes before it sends the takeover. */
export const handedOff = (
  overrides: Partial<RemoteWorkerStore.RemoteWorkerRecord> = {},
): RemoteWorkerStore.RemoteWorkerRecord => ({
  id: ROW,
  callerThreadId: LAUNCHER,
  projectId: "local-project",
  machineId: ROLES.target.id,
  environmentId: ROLES.target.environmentId,
  remoteProjectId: null,
  remoteThreadId: THREAD,
  title: "Fix the flaky test",
  launchStartedAt: "2026-10-12T00:00:00.000Z",
  followedRunId: null,
  reportBack: true,
  state: "following",
  lastStatus: null,
  deliveredRunIds: [],
  lostContactNotified: false,
  lastError: null,
  updatedAt: "2026-10-12T00:00:00.000Z",
  handoff: { sourceThreadId: "thread-1", epoch: 2, awaiting: "continuation" },
  ...overrides,
});

/**
 * The source's folder, the messages its threads keep, and the machines it can
 * ask. `boot` is one life of the source's server over them: what the first
 * life wrote is all the next one has.
 */
export const stage = (timings: Partial<RemoteWorkerFollower.RemoteWorkerFollowerTimingsShape> = {}) => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-handoff-follower-"));
  temporary.push(baseDir);
  const target = releasedPeer(ROLES.target.environmentId);
  const onward = releasedPeer(machine("onward").environmentId);
  const kept: Array<KeptMessage> = [];
  const changed = makeSignal();
  /** The source's own threads: a thread handed back to it is one of them. */
  const here = releasedPeer(ROLES.self);
  const boot = (options: { readonly knowsOnward?: boolean } = {}) =>
    setup(target.tools, timings, {
      roles: {
        ...ROLES,
        more: options.knowsOnward === false ? [] : [{ target: machine("onward"), tools: onward.tools }],
      },
      baseDir,
      kept,
      changed,
      here,
    });
  return { target, onward, here, kept, changed, boot };
};

export const seed = (row: RemoteWorkerStore.RemoteWorkerRecord) =>
  Effect.flatMap(RemoteWorkerStore.RemoteWorkerStore, (store) => store.modify(row.id, () => row));

export const follow = (row: RemoteWorkerStore.RemoteWorkerRecord) =>
  Effect.gen(function* () {
    yield* allow("auto", ROLES.target.id);
    yield* seed(row);
    const follower = yield* RemoteWorkerFollower.RemoteWorkerFollower;
    yield* follower.follow(row.id);
  });

export const keptCount = (kept: ReadonlyArray<KeptMessage>) => Effect.sync(() => kept.length);

