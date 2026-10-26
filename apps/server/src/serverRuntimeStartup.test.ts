import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { refreshProjectUpstreams } from "./workspace/automaticPullSafety.ts";

import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it.effect("does not issue unused browser credentials for a no-browser web service", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const access = Ref.update(calls, (values) => [
      ...values,
      "issue-startup-pairing",
      "open-browser",
    ]);
    yield* ServerRuntimeStartup.runBrowserStartupAccess({ mode: "web", noBrowser: true }, access);
    assert.deepEqual(yield* Ref.get(calls), []);
  }),
);

it.effect("retains intentional browser access and the desktop startup boundary", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* ServerRuntimeStartup.runBrowserStartupAccess(
      { mode: "web", noBrowser: false },
      Ref.update(calls, (values) => [...values, "intentional-browser-access"]),
    );
    yield* ServerRuntimeStartup.runBrowserStartupAccess(
      { mode: "desktop", noBrowser: true },
      Ref.update(calls, (values) => [...values, "desktop-target"]),
    );
    assert.deepEqual(yield* Ref.get(calls), ["intentional-browser-access", "desktop-target"]);
  }),
);

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    // Delegated recovery reads the runs recovery terminalizes, and settles them
    // before the worker runs restart continuations that would otherwise race it.
    assert.deepEqual(yield* Ref.get(calls), [
      "import",
      "recover",
      "delegated",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect(
  "behind an update install gate, resumes, recovers delegated tasks and starts the worker only after it opens",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (label: string) => Ref.update(calls, (current) => [...current, label]);
        const opened = yield* Deferred.make<void>();
        const workerStarted = yield* Deferred.make<void>();

        const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
          importLegacyShells: record("import"),
          recover: record("recover").pipe(Effect.as({ closedRequests: 1 })),
          recoverDelegatedTasks: record("delegated"),
          startEffectWorker: record("worker").pipe(
            Effect.andThen(Deferred.succeed(workerStarted, undefined)),
          ),
          autoBootstrap: record("bootstrap").pipe(Effect.as({})),
          updateGate: {
            reconcile: record("reconcile").pipe(Effect.as({ closedRequests: 0 })),
            resumeAfterUpdate: record("resume"),
            awaitReleased: Deferred.await(opened),
            onWorkerStartFailure: () => record("worker-failed"),
          },
        });

        // Nothing that writes history runs while the helper is still verifying.
        yield* Effect.yieldNow;
        assert.deepEqual(yield* Ref.get(calls), ["import", "reconcile", "bootstrap"]);
        assert.deepEqual(result.recovery, { closedRequests: 0 });

        yield* Deferred.succeed(opened, undefined);
        yield* Deferred.await(workerStarted);
        // Same order as an ungated start: delegated recovery sees the continuation
        // the resume records, and the worker runs neither before it settles.
        assert.deepEqual(yield* Ref.get(calls), [
          "import",
          "reconcile",
          "bootstrap",
          "resume",
          "delegated",
          "worker",
        ]);
      }),
    ),
);

it.effect("behind an update install gate, a failing step skips none of the later ones", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (label: string) => Ref.update(calls, (current) => [...current, label]);
      const handled = yield* Deferred.make<void>();

      yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
        importLegacyShells: Effect.void,
        recover: Effect.succeed({}),
        recoverDelegatedTasks: record("delegated").pipe(Effect.andThen(Effect.fail("delegated"))),
        startEffectWorker: Effect.fail("worker"),
        autoBootstrap: Effect.succeed({}),
        updateGate: {
          reconcile: Effect.succeed({}),
          resumeAfterUpdate: record("resume").pipe(Effect.andThen(Effect.fail("resume"))),
          awaitReleased: Effect.void,
          onWorkerStartFailure: () =>
            record("worker-failed").pipe(Effect.andThen(Deferred.succeed(handled, undefined))),
        },
      });

      yield* Deferred.await(handled);
      assert.deepEqual(yield* Ref.get(calls), ["resume", "delegated", "worker-failed"]);
    }),
  ),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 8319,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("startup refresh reads enabled upstreams without pulling any checkout", () =>
  Effect.gen(function* () {
    const refreshed: string[] = [];
    const pulled: string[] = [];
    const git = {
      statusDetailsRemote: (cwd: string) =>
        Effect.sync(() => {
          refreshed.push(cwd);
          return {
            hasUpstream: true,
            aheadCount: cwd === "/ahead" ? 1 : 0,
            behindCount: cwd === "/current" ? 0 : 1,
          } as never;
        }),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* refreshProjectUpstreams(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(refreshed.toSorted(), [
      "/ahead",
      "/clean",
      "/current",
      "/dirty",
      "/feature",
    ]);
    assert.deepStrictEqual(pulled, []);

    refreshed.length = 0;
    yield* refreshProjectUpstreams(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(refreshed.toSorted(), ["/dirty", "/inherited"]);
    assert.deepStrictEqual(pulled, []);
  }),
);

it.effect("tries a pass that keeps failing further apart each time", () =>
  Effect.gen(function* () {
    const tried = yield* Ref.make<ReadonlyArray<number>>([]);
    const fiber = yield* ServerRuntimeStartup.resumeAfterHoldReleases({
      releaseCount: Effect.succeed(1),
      updateUnderway: Effect.succeed(false),
      installRequestOpen: Effect.succeed(false),
      exclusive: (effect) => effect,
      resumeAfterUpdate: Clock.currentTimeMillis.pipe(
        Effect.flatMap((at) => Ref.update(tried, (times) => [...times, at / 1_000])),
        Effect.andThen(Effect.fail("projection read failed")),
      ),
      pollMs: 1_000,
    }).pipe(Effect.forkChild);
    for (let look = 0; look < 10; look += 1) yield* TestClock.adjust("1 second");
    yield* Fiber.interrupt(fiber);
    // Each try waits twice as many looks as the one before.
    assert.deepEqual(yield* Ref.get(tried), [0, 1, 3, 7]);
  }),
);

it.effect("continues update-stopped turns after a hold ends, once the update is over", () =>
  Effect.gen(function* () {
    const releases = yield* Ref.make(0);
    const underway = yield* Ref.make(false);
    const requestOpen = yield* Ref.make(false);
    const resumed = yield* Ref.make(0);
    const fiber = yield* ServerRuntimeStartup.resumeAfterHoldReleases({
      releaseCount: Ref.get(releases),
      updateUnderway: Ref.get(underway),
      installRequestOpen: Ref.get(requestOpen),
      exclusive: (effect) => effect,
      resumeAfterUpdate: Ref.updateAndGet(resumed, (count) => count + 1).pipe(
        // A failed pass must not end the loop.
        Effect.flatMap((count) =>
          count === 1 ? Effect.fail("projection read failed") : Effect.void,
        ),
      ),
      pollMs: 1_000,
    }).pipe(Effect.forkChild);
    const tick = TestClock.adjust("1 second");
    yield* tick;
    // No hold has ended: nothing to continue.
    assert.equal(yield* Ref.get(resumed), 0);
    // A hold ended while the same update's install request still waits.
    yield* Ref.set(releases, 1);
    yield* Ref.set(requestOpen, true);
    yield* tick;
    assert.equal(yield* Ref.get(resumed), 0);
    yield* Ref.set(requestOpen, false);
    yield* Ref.set(underway, true);
    yield* tick;
    assert.equal(yield* Ref.get(resumed), 0);
    yield* Ref.set(underway, false);
    yield* tick;
    assert.equal(yield* Ref.get(resumed), 1);
    // The pass failed, so the next look runs it again; then it is done.
    yield* tick;
    assert.equal(yield* Ref.get(resumed), 2);
    yield* tick;
    assert.equal(yield* Ref.get(resumed), 2);
    // Two holds that ended between looks need one pass.
    yield* Ref.set(releases, 3);
    yield* tick;
    yield* tick;
    assert.equal(yield* Ref.get(resumed), 3);
    yield* Fiber.interrupt(fiber);
  }),
);
