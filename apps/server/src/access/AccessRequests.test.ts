import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type AccessRequestSubject,
  accessGrantKey,
  type OrchestrationV2ServerCommand,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AccessRequests from "./AccessRequests.ts";

const threadId = ThreadId.make("thread-access");
const otherThreadId = ThreadId.make("thread-other");
const turnItemId = TurnItemId.make("turn-item:access-request:1");

const notes: AccessRequestSubject = {
  kind: "app",
  key: accessGrantKey("app", "Notes"),
  label: "Notes",
  detail: "See and control its windows",
};
const iphone: AccessRequestSubject = {
  kind: "device",
  key: accessGrantKey("device", "local/UDID-1"),
  label: "iPhone 17 Pro",
  detail: "See its screen, tap, type and install apps",
  platform: "ios",
};

interface Options {
  readonly runStatus?: string;
  readonly accessStatus?: string;
  readonly subjects?: ReadonlyArray<AccessRequestSubject>;
  /** How many record dispatches fail before one succeeds. */
  readonly failedRecords?: number;
  /** The agent's wait closes the card just before the answer's record lands. */
  readonly closedFirst?: boolean;
  /** The thread has no card with this id. */
  readonly missing?: boolean;
}

/** A thread with one pending access request card, answered like the orchestrator would. */
const threadsMock = (dispatched: Array<OrchestrationV2ServerCommand>, options: Options = {}) => {
  let accessStatus = options.accessStatus ?? "pending";
  let accessScope: string | undefined;
  let failedRecords = options.failedRecords ?? 0;
  return Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: () =>
      Effect.sync(
        () =>
          ({
            runs: [{ id: "run-1", status: options.runStatus ?? "running" }],
            turnItems: options.missing
              ? []
              : [
                  {
                    id: turnItemId,
                    threadId,
                    runId: "run-1",
                    nodeId: "node-root",
                    type: "access_request",
                    accessTitle: "Use Notes",
                    reason: "To read the shopping list.",
                    subjects: options.subjects ?? [notes],
                    accessStatus,
                    ...(accessScope === undefined ? {} : { accessScope }),
                  },
                ],
          }) as never,
      ),
    dispatch: (command) => {
      if (command.type === "access_request.record" && failedRecords > 0) {
        failedRecords -= 1;
        return Effect.fail(new Error("orchestrator unavailable") as never);
      }
      return Effect.sync(() => {
        dispatched.push(command);
        if (command.type !== "access_request.record") return {} as never;
        // Like the orchestrator, a card that is no longer pending keeps its answer.
        if (options.closedFirst) {
          accessStatus = "cancelled";
        } else if (accessStatus === "pending") {
          accessStatus = command.accessStatus;
          accessScope = command.accessScope;
        }
        return {} as never;
      });
    },
  });
};

/** Builds the service (reading access-grants.json) in the shared temp stateDir. */
const withService = <A, E, R = never>(
  body: (input: {
    readonly service: AccessRequests.AccessRequests["Service"];
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
  }) => Effect.Effect<A, E, R>,
  options: Options = {},
) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    return yield* Effect.gen(function* () {
      const service = yield* AccessRequests.AccessRequests;
      return yield* body({ service, dispatched });
    }).pipe(
      Effect.provide(AccessRequests.layer.pipe(Layer.provide(threadsMock(dispatched, options)))),
    );
  });

const withStateDir = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-access-requests-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const recorded = (dispatched: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  dispatched.filter((command) => command.type === "access_request.record");

it.effect("allow for the thread grants it to this thread only and records allowed", () =>
  withStateDir(
    withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "allow", scope: "thread" },
          });
          assert.isTrue(yield* service.isAllowed(threadId, notes.key));
          assert.isTrue(yield* service.isAllowed(threadId, iphone.key));
          assert.isFalse(yield* service.isAllowed(otherThreadId, notes.key));
          assert.isTrue(yield* service.hasAnyGrant(threadId, "device"));
          assert.isFalse(yield* service.hasAnyGrant(otherThreadId, "device"));
          assert.deepEqual((yield* service.listMachineGrants).grants, []);
          const records = recorded(dispatched);
          assert.equal(records.length, 1);
          assert.include(records[0] as object, {
            type: "access_request.record",
            accessStatus: "allowed",
            accessScope: "thread",
            turnItemId,
            runId: "run-1",
            nodeId: "node-root",
          });
        }),
      { subjects: [notes, iphone, notes] },
    ),
  ),
);

it.effect("allow on this machine grants every thread, newest first in the list", () =>
  withStateDir(
    Effect.gen(function* () {
      yield* withService(
        ({ service }) =>
          service.answer({ threadId, turnItemId, answer: { type: "allow", scope: "machine" } }),
        { subjects: [notes] },
      );
      yield* withService(
        ({ service }) =>
          Effect.gen(function* () {
            yield* service.answer({
              threadId,
              turnItemId,
              answer: { type: "allow", scope: "machine" },
            });
            assert.isTrue(yield* service.isAllowed(otherThreadId, notes.key));
            assert.isTrue(yield* service.isAllowed(otherThreadId, iphone.key));
            assert.isTrue(yield* service.hasAnyGrant(otherThreadId, "device"));
            const { grants } = yield* service.listMachineGrants;
            assert.deepEqual(
              grants.map((grant) => grant.key),
              [iphone.key, notes.key],
            );
            assert.deepEqual(
              grants.map((grant) => grant.label),
              ["iPhone 17 Pro", "Notes"],
            );
          }),
        // Notes again: an existing grant is not written twice.
        { subjects: [notes, iphone] },
      );
    }),
  ),
);

it.effect("deny records denied and grants nothing", () =>
  withStateDir(
    withService(({ service, dispatched }) =>
      Effect.gen(function* () {
        yield* service.answer({ threadId, turnItemId, answer: { type: "deny" } });
        assert.isFalse(yield* service.isAllowed(threadId, notes.key));
        assert.isFalse(yield* service.hasAnyGrant(threadId, "app"));
        const records = recorded(dispatched);
        assert.equal(records.length, 1);
        assert.include(records[0] as object, { accessStatus: "denied" });
        assert.notProperty(records[0] as object, "accessScope");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        assert.isFalse(
          yield* fs.exists(path.join(config.stateDir, AccessRequests.ACCESS_GRANTS_FILE)),
        );
      }),
    ),
  ),
);

it.effect("refuses a card that is gone", () =>
  withStateDir(
    withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          const error = yield* service
            .answer({ threadId, turnItemId, answer: { type: "allow", scope: "thread" } })
            .pipe(Effect.flip);
          assert.equal(error.reason, "not_found");
          assert.equal(dispatched.length, 0);
          assert.isFalse(yield* service.isAllowed(threadId, notes.key));
        }),
      { missing: true },
    ),
  ),
);

it.effect("refuses a card that was already answered", () =>
  withStateDir(
    withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          const error = yield* service
            .answer({ threadId, turnItemId, answer: { type: "allow", scope: "thread" } })
            .pipe(Effect.flip);
          assert.equal(error.reason, "already_answered");
          assert.equal(dispatched.length, 0);
          assert.isFalse(yield* service.isAllowed(threadId, notes.key));
        }),
      { accessStatus: "denied" },
    ),
  ),
);

it.effect("refuses an answer once the run that asked has ended", () =>
  withStateDir(
    withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          const error = yield* service
            .answer({ threadId, turnItemId, answer: { type: "allow", scope: "machine" } })
            .pipe(Effect.flip);
          assert.equal(error.reason, "agent_stopped");
          assert.equal(dispatched.length, 0);
          assert.deepEqual((yield* service.listMachineGrants).grants, []);
        }),
      { runStatus: "completed" },
    ),
  ),
);

it.effect("takes the grant back when the card cannot be recorded, so Allow can be retried", () =>
  withStateDir(
    withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          const failed = yield* service
            .answer({ threadId, turnItemId, answer: { type: "allow", scope: "machine" } })
            .pipe(Effect.flip);
          assert.equal(failed.reason, "record_failed");
          assert.isFalse(yield* service.isAllowed(threadId, notes.key));
          assert.deepEqual((yield* service.listMachineGrants).grants, []);
          // The card still says pending; a second Allow goes through.
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "allow", scope: "machine" },
          });
          assert.isTrue(yield* service.isAllowed(threadId, notes.key));
          assert.equal(recorded(dispatched).length, 1);
        }),
      { failedRecords: 1 },
    ),
  ),
);

it.effect("an Allow that loses to the card closing takes its grant back", () =>
  withStateDir(
    withService(
      ({ service }) =>
        Effect.gen(function* () {
          const error = yield* service
            .answer({ threadId, turnItemId, answer: { type: "allow", scope: "thread" } })
            .pipe(Effect.flip);
          assert.equal(error.reason, "agent_stopped");
          assert.isFalse(yield* service.isAllowed(threadId, notes.key));
        }),
      { closedFirst: true },
    ),
  ),
);

it.effect("revoking a machine grant removes it from every thread", () =>
  withStateDir(
    withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "allow", scope: "machine" },
          });
          const after = yield* service.revokeMachineGrant(notes.key);
          assert.deepEqual(
            after.grants.map((grant) => grant.key),
            [iphone.key],
          );
          assert.isFalse(yield* service.isAllowed(otherThreadId, notes.key));
          assert.isTrue(yield* service.isAllowed(otherThreadId, iphone.key));
        }),
      { subjects: [notes, iphone] },
    ),
  ),
);

it.effect("grants survive a restart, read back from access-grants.json", () =>
  withStateDir(
    Effect.gen(function* () {
      yield* withService(
        ({ service }) =>
          service.answer({ threadId, turnItemId, answer: { type: "allow", scope: "machine" } }),
        { subjects: [iphone] },
      );
      yield* withService(
        ({ service }) =>
          service.answer({ threadId, turnItemId, answer: { type: "allow", scope: "thread" } }),
        { subjects: [notes] },
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const stored = JSON.parse(
        yield* fs.readFileString(path.join(config.stateDir, AccessRequests.ACCESS_GRANTS_FILE)),
      );
      assert.equal(stored.version, 1);
      // A fresh service, as after a restart, reads the same grants.
      yield* withService(({ service }) =>
        Effect.gen(function* () {
          assert.isTrue(yield* service.isAllowed(threadId, notes.key));
          assert.isFalse(yield* service.isAllowed(otherThreadId, notes.key));
          assert.isTrue(yield* service.isAllowed(otherThreadId, iphone.key));
          assert.deepEqual(
            (yield* service.listMachineGrants).grants.map((grant) => grant.key),
            [iphone.key],
          );
        }),
      );
    }),
  ),
);

it.effect("starts with no grants when access-grants.json is unreadable", () =>
  withStateDir(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(config.stateDir, AccessRequests.ACCESS_GRANTS_FILE),
        "{not json",
      );
      yield* withService(({ service }) =>
        Effect.gen(function* () {
          assert.deepEqual((yield* service.listMachineGrants).grants, []);
          assert.isFalse(yield* service.isAllowed(threadId, notes.key));
        }),
      );
    }),
  ),
);

it.effect("two Allows on one card at once: one grants, the other finds it answered", () =>
  withStateDir(
    withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          const results = yield* Effect.all(
            [
              service
                .answer({ threadId, turnItemId, answer: { type: "allow", scope: "machine" } })
                .pipe(Effect.result),
              service
                .answer({ threadId, turnItemId, answer: { type: "allow", scope: "thread" } })
                .pipe(Effect.result),
            ],
            { concurrency: "unbounded" },
          );
          const failures = results.filter((result) => result._tag === "Failure");
          assert.equal(failures.length, 1);
          assert.equal(
            failures[0]!._tag === "Failure" ? failures[0]!.failure.reason : undefined,
            "already_answered",
          );
          assert.equal(recorded(dispatched).length, 1);
          // Only the first answer's grant exists.
          assert.deepEqual(
            (yield* service.listMachineGrants).grants.map((grant) => grant.key),
            [notes.key],
          );
          assert.isFalse(yield* service.isAllowed(otherThreadId, iphone.key));
        }),
      { subjects: [notes] },
    ),
  ),
);

it.effect("drops thread grants older than 30 days on load and on write; machine grants stay", () =>
  withStateDir(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const file = path.join(config.stateDir, AccessRequests.ACCESS_GRANTS_FILE);
      const finder = accessGrantKey("app", "Finder");
      const stored = (key: string, label: string, grantedAt: string) => ({
        kind: key.startsWith("device:") ? "device" : "app",
        key,
        label,
        grantedAt,
      });
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          version: 1,
          machine: [stored(finder, "Finder", "2025-01-01T00:00:00.000Z")],
          threads: {
            [threadId]: [
              stored(notes.key, "Notes", "2026-09-01T00:00:00.000Z"),
              stored(iphone.key, "iPhone 17 Pro", "2026-10-30T00:00:00.000Z"),
            ],
            [otherThreadId]: [stored(notes.key, "Notes", "2026-08-01T00:00:00.000Z")],
          },
        }),
      );
      yield* TestClock.setTime(Date.parse("2026-11-04T00:00:00.000Z"));
      const read = () => fs.readFileString(file).pipe(Effect.map((text) => JSON.parse(text)));
      yield* withService(
        ({ service }) =>
          Effect.gen(function* () {
            assert.isFalse(yield* service.isAllowed(threadId, notes.key));
            assert.isTrue(yield* service.isAllowed(threadId, iphone.key));
            assert.isFalse(yield* service.isAllowed(otherThreadId, notes.key));
            assert.isTrue(yield* service.isAllowed(otherThreadId, finder));
            // Loading wrote the expired grants away.
            const onDisk = yield* read();
            assert.deepEqual(Object.keys(onDisk.threads), [threadId]);
            assert.deepEqual(
              onDisk.threads[threadId].map((grant: { key: string }) => grant.key),
              [iphone.key],
            );
            // A month later, a new grant's write drops the iPhone grant too.
            yield* TestClock.adjust("31 days");
            yield* service.answer({
              threadId,
              turnItemId,
              answer: { type: "allow", scope: "thread" },
            });
            assert.isTrue(yield* service.isAllowed(threadId, notes.key));
            assert.isFalse(yield* service.isAllowed(threadId, iphone.key));
            assert.isTrue(yield* service.isAllowed(threadId, finder));
            const later = yield* read();
            assert.deepEqual(
              later.threads[threadId].map((grant: { key: string }) => grant.key),
              [notes.key],
            );
            assert.deepEqual(
              later.machine.map((grant: { key: string }) => grant.key),
              [finder],
            );
          }),
        { subjects: [notes] },
      );
    }),
  ),
);

it.effect("a revoke keeps a machine grant written while it waited", () =>
  withStateDir(
    Effect.gen(function* () {
      yield* withService(
        ({ service }) =>
          service.answer({ threadId, turnItemId, answer: { type: "allow", scope: "machine" } }),
        { subjects: [notes] },
      );
      yield* withService(
        ({ service }) =>
          Effect.gen(function* () {
            // The revoke is made first and runs after the grant lands, as when it waits on the lock.
            const revoke = service.revokeMachineGrant(notes.key);
            const [, revoked] = yield* Effect.all(
              [
                service.answer({
                  threadId,
                  turnItemId,
                  answer: { type: "allow", scope: "machine" },
                }),
                revoke,
              ],
              { concurrency: 1 },
            );
            assert.deepEqual(
              revoked.grants.map((grant) => grant.key),
              [iphone.key],
            );
            assert.isTrue(yield* service.isAllowed(otherThreadId, iphone.key));
            assert.isFalse(yield* service.isAllowed(otherThreadId, notes.key));
          }),
        { subjects: [iphone] },
      );
      // And on disk, read back by a fresh service.
      yield* withService(({ service }) =>
        Effect.gen(function* () {
          assert.deepEqual(
            (yield* service.listMachineGrants).grants.map((grant) => grant.key),
            [iphone.key],
          );
        }),
      );
    }),
  ),
);

it.effect("a thread grant stops counting 30 days on, while the server runs", () =>
  withStateDir(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-04T00:00:00.000Z"));
      yield* withService(
        ({ service }) =>
          Effect.gen(function* () {
            yield* service.answer({
              threadId,
              turnItemId,
              answer: { type: "allow", scope: "thread" },
            });
            yield* TestClock.adjust("29 days");
            assert.isTrue(yield* service.isAllowed(threadId, notes.key));
            assert.isTrue(yield* service.hasAnyGrant(threadId, "device"));
            yield* TestClock.adjust("2 days");
            assert.isFalse(yield* service.isAllowed(threadId, notes.key));
            assert.isFalse(yield* service.isAllowed(threadId, iphone.key));
            assert.isFalse(yield* service.hasAnyGrant(threadId, "device"));
            assert.isFalse(yield* service.hasAnyGrant(threadId, "app"));
          }),
        { subjects: [notes, iphone] },
      );
    }),
  ),
);
