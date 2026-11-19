// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * A handoff between two machines in one process: the source's moves talk to
 * the destination's receiver through a stub peer client, over real Git
 * repositories (a source checkout and a destination clone).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { HANDOFF_LEASE_STALE_MS, ThreadId, threadTurnKey } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { incomingRef } from "./bundleGit.ts";
import * as HandoffMoves from "./HandoffMoves.ts";
import { HandoffPeerError, HandoffPeers } from "./handoffPeers.ts";
import * as HandoffReceiver from "./HandoffReceiver.ts";
import { HANDOFF_PROTOCOL_VERSION } from "./handoffWire.ts";
import { emptyThreadRecord, guardSideEffect, findIncoming, incomingKey } from "./handoffState.ts";
import {
  destinationProject,
  directory,
  git,
  gitEnv,
  handOff,
  m4,
  minis,
  modelSelection,
  probedSource,
  registerCleanup,
  scenario,
  sourceProject,
  staleReplicaOnMinis,
  threadId,
} from "./handoffMove.test.fixture.ts";

registerCleanup();

describe("handoff between two machines", () => {
  it.effect("honors the destination project's project-local override for an actual handoff", () =>
    Effect.gen(function* () {
      const { moves, destination, destinationRoot } = yield* scenario({
        // Backslashes trigger Git's human-readable quoting on Windows. A literal
        // quote exercises the same raw-path boundary on POSIX without illegal Windows names.
        destinationRepositoryName:
          process.platform === "win32" ? "minis-repo" : 'minis-"quoted"-repo',
        destinationSettings: {
          projectSettingsOverrides: { [destinationProject]: { worktreeLocationMode: "project" } },
        },
      });
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      yield* handOff(moves);
      const strategy = destination.launches[0]!.workspaceStrategy as { worktreePath: string };
      expect(
        strategy.worktreePath.startsWith(
          NodePath.join(destinationRoot, ".specwithcode", "worktrees") + NodePath.sep,
        ),
      ).toBe(true);
      const ignoredPath = NodeChildProcess.execFileSync(
        "git",
        ["-C", destinationRoot, "check-ignore", "--stdin", "-z"],
        {
          input: `${strategy.worktreePath}\0`,
          encoding: "utf8",
          env: gitEnv,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      expect(ignoredPath).toBe(`${strategy.worktreePath}\0`);
      expect(NodeFS.readFileSync(NodePath.join(strategy.worktreePath, "app.ts"), "utf8")).toBe(
        "export const a = 2;\n",
      );
    }),
  );
  it.effect("honors the destination project's custom storage override", () =>
    Effect.gen(function* () {
      const custom = NodePath.join(directory(), "custom-worktrees");
      const { moves, destination, destinationRoot } = yield* scenario({
        destinationSettings: {
          projectSettingsOverrides: {
            [destinationProject]: { worktreeLocationMode: "custom", worktreesDirectory: custom },
          },
        },
      });
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      yield* handOff(moves);
      const strategy = destination.launches[0]!.workspaceStrategy as { worktreePath: string };
      expect(strategy.worktreePath.startsWith(custom + NodePath.sep)).toBe(true);
      expect(NodeFS.readFileSync(NodePath.join(strategy.worktreePath, "app.ts"), "utf8")).toBe(
        "export const a = 2;\n",
      );
    }),
  );
  it.effect("lands in the destination's project folder when its Use worktrees switch is off", () =>
    Effect.gen(function* () {
      const { destination, moves, destinationRoot } = yield* scenario({
        destinationUsesWorktrees: false,
      });
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      const base = git(destinationRoot, "rev-parse", "HEAD");
      yield* handOff(moves);
      expect(destination.launches[0]!.workspaceStrategy).toEqual({ type: "root" });
      const read = (file: string) =>
        NodeFS.readFileSync(NodePath.join(destinationRoot, file), "utf8");
      expect(read("app.ts")).toBe("export const a = 2;\n");
      expect(read("notes.md")).toBe("half done\n");
      // The destination's own secret file stays as it was.
      expect(read(".env.local")).toBe("TOKEN=minis\n");
      expect(git(destinationRoot, "rev-parse", "HEAD")).toBe(base);
      expect(
        git(destinationRoot, "worktree", "list", "--porcelain").match(/^worktree /gm),
      ).toHaveLength(1);
    }),
  );

  it.effect("moves a thread stopped by its usage limit and resumes it on the destination", () =>
    Effect.gen(function* () {
      const { source, destination, moves, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      const result = yield* handOff(moves);
      expect(result.machineLabel).toBe("Minis");

      // The destination holds the checkpoint and continued at epoch 2.
      const replica = findIncoming(destination.document, m4, threadId);
      expect(replica?.continuedThreadId).toBe(result.threadId);
      expect(git(destinationRoot, "rev-parse", incomingRef(m4, threadId))).toBe(
        source.document.threads[threadId]!.checkpoint!.commit,
      );
      expect(destination.document.threads[result.threadId]?.lease).toMatchObject({
        holderEnvironmentId: minis,
        epoch: 2,
        state: "active",
      });
      expect(destination.document.threads[result.threadId]?.sideEffects).toHaveLength(1);

      // The worktree sits at the base commit with the source's work as changes.
      const launch = destination.launches[0]!;
      expect(launch.workspaceStrategy.type).toBe("existing_worktree");
      const worktree = (launch.workspaceStrategy as { worktreePath: string }).worktreePath;
      expect(NodeFS.readFileSync(NodePath.join(worktree, "app.ts"), "utf8")).toBe(
        "export const a = 2;\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(worktree, "notes.md"), "utf8")).toBe("half done\n");
      expect(NodeFS.readFileSync(NodePath.join(worktree, ".env.local"), "utf8")).toBe(
        "TOKEN=minis\n",
      );
      expect(git(worktree, "rev-parse", "HEAD")).toBe(git(destinationRoot, "rev-parse", "HEAD"));
      expect(launch.initialMessage?.text).toContain("after its usage limit was reached");
      expect(launch.initialMessage?.text).toContain("pr-create anton-abyzov/app#12");

      // The source is fenced, linked and records where the thread runs now.
      expect(source.document.threads[threadId]?.continuedOn).toMatchObject({
        environmentId: minis,
        threadId: result.threadId,
      });
      expect(source.document.threads[threadId]?.lease).toMatchObject({ epoch: 2, state: "fenced" });
      const types = source.dispatched.map((command) => command.type);
      expect(types).toContain("thread.project-move.record");
      expect(
        source.dispatched.find((command) => command.type === "thread.project-move.record"),
      ).toMatchObject({
        link: { projectId: destinationProject, kind: "handoff", environmentId: minis },
      });
      expect(types).toContain("thread.execution.record");
      expect(destination.dispatched.map((command) => command.type)).toContain(
        "thread.execution.record",
      );

      // A retry returns the first result; it never makes a second thread.
      const again = yield* handOff(moves);
      expect(again.threadId).toBe(result.threadId);
      expect(destination.launches).toHaveLength(1);
    }),
  );

  it.effect("leaves the source untouched when a preflight check fails", () =>
    Effect.gen(function* () {
      const { source, destination, moves, fixture } = yield* scenario({ signedIn: false });
      fixture.activeRunId = "run-1";
      const failure = yield* handOff(moves).pipe(Effect.flip);
      expect(failure.code).toBe("invalid");
      expect(failure.message).toContain("Minis: no .env.local");
      expect(failure.message).toContain("Minis: Claude not signed in");
      expect(source.document.threads[threadId]?.lease).toMatchObject({ epoch: 1, state: "active" });
      expect(source.document.threads[threadId]?.continuedOn).toBeNull();
      expect(source.dispatched).toHaveLength(0);
      expect(fixture.activeRunId).toBe("run-1");
      expect(destination.launches).toHaveLength(0);
    }),
  );

  it.effect("never hands off or replicates a personal assistant's thread", () =>
    Effect.gen(function* () {
      const { moves, destination, fixture } = yield* scenario({ sourcePersonal: true });
      fixture.activeRunId = "run-1";
      const failure = yield* handOff(moves).pipe(Effect.flip);
      expect(failure.code).toBe("invalid");
      expect(failure.message).toContain("private to its machine");
      const machine = yield* moves.handOffMachine({
        destinationEnvironmentId: minis,
        reason: "manual",
      });
      expect(machine.results).toEqual([]);
      expect(destination.document.incoming).toHaveLength(0);
      expect(destination.launches).toHaveLength(0);
    }),
  );

  it.effect("refuses to hand off to a machine on another handoff version", () =>
    Effect.gen(function* () {
      const { source, destination, moves, network, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      network.olderDestination = true;
      const failure = yield* handOff(moves).pipe(Effect.flip);
      expect(failure.message).toContain("Minis runs SpecWithCode an older version");
      expect(failure.message).toContain("Update Minis first.");
      expect(source.document.threads[threadId]?.lease).toMatchObject({ epoch: 1, state: "active" });
      expect(source.dispatched).toHaveLength(0);
      expect(destination.launches).toHaveLength(0);
      // Once both run the same version, the same handoff goes through.
      network.olderDestination = false;
      yield* handOff(moves);
      expect(destination.launches).toHaveLength(1);
    }),
  );

  it.effect("names this machine to update when the destination is newer", () =>
    Effect.gen(function* () {
      const { moves, network, destination } = yield* scenario();
      network.newerDestination = true;
      const failure = yield* handOff(moves).pipe(Effect.flip);
      expect(failure.message).toContain("Minis runs SpecWithCode 9.0.0");
      expect(failure.message).toContain("Update M4 first.");
      expect(failure.message).not.toContain("the source machine");
      expect(destination.launches).toHaveLength(0);
    }),
  );

  it.effect("never continues here a copy from a machine on another handoff version", () =>
    Effect.gen(function* () {
      const { moves, destinationReceiver, destination, destinationRoot, destinationServices } =
        yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
      const key = incomingKey(m4, threadId);
      expect(destination.document.incomingDetails?.[key]?.sourceProtocolVersion).toBe(
        HANDOFF_PROTOCOL_VERSION,
      );
      // A copy sent by a build from before the version check.
      const {
        sourceProtocolVersion: _v,
        sourceAppVersion: _a,
        ...older
      } = destination.document.incomingDetails?.[key]!;
      destination.document = {
        ...destination.document,
        incomingDetails: { ...destination.document.incomingDetails, [key]: older },
      };
      const renewedAt = Date.parse(
        findIncoming(destination.document, m4, threadId)!.lease.renewedAt,
      );
      const minisMoves = yield* HandoffMoves.make.pipe(
        Effect.provideService(HandoffReceiver.HandoffReceiver, destinationReceiver),
        Effect.provideService(HandoffPeers, {} as never),
        Effect.provide(destinationServices),
      );
      yield* TestClock.setTime(renewedAt + HANDOFF_LEASE_STALE_MS + 1_000);
      const refused = yield* minisMoves
        .continueHere({ sourceEnvironmentId: m4, sourceThreadId: threadId })
        .pipe(Effect.flip);
      expect(refused.code).toBe("invalid");
      expect(refused.message).toContain("Update M4 first.");
      expect(destination.launches).toHaveLength(0);
    }),
  );

  it.effect("tells an older source which machine to update, in a check it can read", () =>
    Effect.gen(function* () {
      const { destinationReceiver, asSource } = yield* scenario();
      const request = {
        sourceEnvironmentId: m4,
        threads: [
          { sourceThreadId: threadId, sourceProjectId: sourceProject, sequence: 1, modelSelection },
        ],
      };
      const older = yield* destinationReceiver.preflight(asSource, request);
      expect(older.results[0]?.failures[0]).toMatchObject({ check: "checkpoint" });
      expect(older.results[0]?.failures[0]?.message).toContain("Update the source machine first.");
      const current = yield* destinationReceiver.preflight(asSource, {
        ...request,
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        appVersion: "9.9.9",
      });
      expect(current.protocolVersion).toBe(HANDOFF_PROTOCOL_VERSION);
      expect(current.results[0]?.failures.some((entry) => entry.message.includes("Update"))).toBe(
        false,
      );
    }),
  );

  it.effect("never joins projects that are not explicitly linked", () =>
    Effect.gen(function* () {
      const { moves, destination } = yield* scenario({ linked: false });
      const failure = yield* handOff(moves).pipe(Effect.flip);
      expect(failure.message).toMatch(/^Minis: this project is not linked here\. .*Link…/u);
      expect(destination.document.incoming).toHaveLength(0);
    }),
  );

  it.effect("interrupts a running turn before the destination takes over", () =>
    Effect.gen(function* () {
      const { source, destination, moves, fixture, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      fixture.activeRunId = "run-1";
      const result = yield* handOff(moves);
      expect(source.dispatched[0]).toMatchObject({ type: "run.interrupt", cause: "agent" });
      expect(source.document.threads[threadId]?.fencedBy).toBe("handoff");
      // The second checkpoint, written after the stop, is the one handed over.
      expect(findIncoming(destination.document, m4, threadId)?.checkpoint.sequence).toBe(2);
      expect(findIncoming(destination.document, m4, threadId)?.checkpoint.runEnding).toBe(
        "handoff",
      );
      expect(destination.launches[0]?.initialMessage).toBeDefined();
      expect(result.threadId).toBe(destination.launches[0]?.threadId);
    }),
  );

  it.effect("keeps the note and transcript for an idle continuation's first turn", () =>
    Effect.gen(function* () {
      const { destination, moves, fixture, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      fixture.runEnding = "completed";
      const result = yield* handOff(moves);
      // Nothing to resume: the thread launches without a run.
      expect(destination.launches).toHaveLength(1);
      expect(destination.launches[0]?.initialMessage).toBeUndefined();
      // Its first turn carries the note and the recent transcript instead.
      const seed = destination.document.threads[result.threadId]?.pendingSeed ?? "";
      expect(seed).toContain("Context from the handoff");
      expect(seed).not.toContain("Continue where you left off.");
      expect(seed).toContain("Next: Run the build");
      expect(seed).toContain("User: Fix the build");
    }),
  );

  it.effect("resumes an interrupted turn here when the final checkpoint cannot be sent", () =>
    Effect.gen(function* () {
      const { source, destination, moves, fixture, network, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      fixture.activeRunId = "run-1";
      let sent = 0;
      const original = source.dispatched.push.bind(source.dispatched);
      source.dispatched.push = (...items) => {
        // The network drops right after the running turn is stopped.
        if (items.some((item) => (item as { type?: string }).type === "run.interrupt")) {
          network.down = true;
        }
        sent += items.length;
        return original(...items);
      };
      const failure = yield* handOff(moves).pipe(Effect.flip);
      expect(sent).toBeGreaterThan(0);
      expect(failure.code).toBe("unreachable");
      const record = source.document.threads[threadId];
      expect(record?.lease?.state).toBe("active");
      expect(record?.fencedBy).toBe("handoff");
      expect(record?.lastError).toContain("The turn continues here");
      // The stopped turn starts again here instead of staying stopped.
      expect(source.dispatched.at(-1)).toMatchObject({
        type: "message.dispatch",
        threadId,
        manualContinuationOfRunId: "run-1",
        dispatchMode: { type: "start_immediately" },
      });
      // Handing it off again once the network is back resumes the stopped turn.
      network.down = false;
      const result = yield* handOff(moves);
      expect(destination.launches).toHaveLength(1);
      expect(result.threadId).toBe(destination.launches[0]?.threadId);
      expect(findIncoming(destination.document, m4, threadId)?.checkpoint.runEnding).toBe(
        "handoff",
      );
      expect(destination.launches[0]?.initialMessage).toBeDefined();
    }),
  );

  it.effect(
    "continues a silent source here after its lease went stale; the source fences on rejoin",
    () =>
      Effect.gen(function* () {
        const {
          moves,
          destinationReceiver,
          destination,
          source,
          sourceRoot,
          destinationRoot,
          destinationServices,
        } = yield* scenario();
        NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
        // A turn end replicated checkpoint 1 to Minis; then M4 dropped off the network.
        yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
        const renewedAt = Date.parse(
          findIncoming(destination.document, m4, threadId)!.lease.renewedAt,
        );
        const minisMoves = yield* HandoffMoves.make.pipe(
          Effect.provideService(HandoffReceiver.HandoffReceiver, destinationReceiver),
          Effect.provideService(HandoffPeers, probedSource("silent")),
          Effect.provide(destinationServices),
        );
        yield* TestClock.setTime(renewedAt + 30_000);
        const early = yield* minisMoves
          .continueHere({ sourceEnvironmentId: m4, sourceThreadId: threadId })
          .pipe(Effect.flip);
        expect(early.code).toBe("busy");
        expect(destination.launches).toHaveLength(0);

        yield* TestClock.setTime(renewedAt + HANDOFF_LEASE_STALE_MS + 1_000);
        const continued = yield* minisMoves.continueHere({
          sourceEnvironmentId: m4,
          sourceThreadId: threadId,
        });
        expect(destination.launches).toHaveLength(1);
        expect(destination.document.threads[continued.threadId]?.lease?.epoch).toBe(2);
        // The pull request the source opened is reused, never opened again.
        expect(
          guardSideEffect({
            record: destination.document.threads[continued.threadId],
            environmentId: minis,
            turnKey: threadTurnKey(continued.threadId, "run-9"),
            kind: "pr-create",
            target: "anton-abyzov/app#12",
          }).kind,
        ).toBe("reuse");
        // A repeat is the same continuation.
        const again = yield* minisMoves.continueHere({
          sourceEnvironmentId: m4,
          sourceThreadId: threadId,
        });
        expect(again.threadId).toBe(continued.threadId);
        expect(destination.launches).toHaveLength(1);

        // M4 kept working while it was away, then comes back at the old epoch:
        // its first heartbeat fences its copy and keeps that work on a branch.
        const head = git(sourceRoot, "rev-parse", "HEAD");
        NodeFS.writeFileSync(NodePath.join(sourceRoot, "app.ts"), "export const a = 3;\n");
        yield* moves.tick;
        const kept = source.document.threads[threadId]?.fencedBranch;
        expect(kept).toBe("swc/from-m4/feat/fix-build");
        expect(git(sourceRoot, "show", `${kept}:app.ts`)).toBe("export const a = 3;");
        expect(git(sourceRoot, "rev-parse", "HEAD")).toBe(head);
        expect(git(sourceRoot, "symbolic-ref", "--short", "HEAD")).toBe("feat/fix-build");
        expect(source.document.threads[threadId]?.continuedOn?.threadId).toBe(continued.threadId);
        expect(source.document.threads[threadId]?.lease?.state).toBe("fenced");
        // A late handoff from M4 answers with the continuation; it never starts another.
        const late = yield* handOff(moves);
        expect(late.threadId).toBe(continued.threadId);
        expect(destination.launches).toHaveLength(1);
      }),
  );

  it.effect.each(["awake", "refuses"] as const)(
    "refuses Continue here while the source answers a direct probe (%s)",
    (answer) =>
      Effect.gen(function* () {
        const { continueHere, destination, probes } = yield* staleReplicaOnMinis(answer);
        const refused = yield* continueHere.pipe(Effect.flip);
        expect(refused.code).toBe("busy");
        expect(refused.message).toBe(
          "M4 answered just now and still holds this thread; hand it off from there.",
        );
        expect(probes).toEqual([
          expect.objectContaining({ sourceEnvironmentId: minis, candidates: [] }),
        ]);
        expect(destination.launches).toHaveLength(0);
        expect(findIncoming(destination.document, m4, threadId)?.continuedThreadId).toBeNull();
      }),
  );

  it.effect.each(["silent", "local"] as const)(
    "continues here when the source is unreachable or cannot be probed (%s)",
    (answer) =>
      Effect.gen(function* () {
        const { continueHere, destination, probes } = yield* staleReplicaOnMinis(answer);
        const continued = yield* continueHere;
        expect(probes).toHaveLength(1);
        expect(destination.launches).toHaveLength(1);
        expect(destination.document.threads[continued.threadId]?.lease?.epoch).toBe(2);
      }),
  );

  it.effect("refuses Continue here while this machine's own network is down", () =>
    Effect.gen(function* () {
      const { continueHere, destination, probes } = yield* staleReplicaOnMinis("silent", {
        connect: "offline",
      });
      const refused = yield* continueHere.pipe(Effect.flip);
      expect(refused.code).toBe("busy");
      expect(refused.message).toContain("cannot reach the network");
      expect(probes).toHaveLength(0);
      expect(destination.launches).toHaveLength(0);
    }),
  );

  it.effect.each([
    { connect: "unknown", source: "silent", refusal: "cannot show that its network works" },
    { connect: "online", source: "local", refusal: "could not ask M4" },
  ] as const)(
    "holds an agent to a shown network and a source it asked ($connect, $source)",
    ({ connect, source, refusal }) =>
      Effect.gen(function* () {
        const { minisMoves, destination } = yield* staleReplicaOnMinis(source, { connect });
        const refused = yield* minisMoves
          .continueHere({ sourceEnvironmentId: m4, sourceThreadId: threadId }, { byAgent: true })
          .pipe(Effect.flip);
        expect(refused.code).toBe("busy");
        expect(refused.message).toContain(refusal);
        expect(refused.message).toContain("ask the user");
        expect(destination.launches).toHaveLength(0);
      }),
  );

  it.effect("lets an agent continue once this machine is online and the source is silent", () =>
    Effect.gen(function* () {
      const { minisMoves, destination } = yield* staleReplicaOnMinis("silent", {
        connect: "online",
      });
      yield* minisMoves.continueHere(
        { sourceEnvironmentId: m4, sourceThreadId: threadId },
        { byAgent: true },
      );
      expect(destination.launches).toHaveLength(1);
    }),
  );

  it.effect("reads a slow lease tick as no sleep", () =>
    Effect.gen(function* () {
      // Minis holds a thread of its own with a copy on M4, so its tick heartbeats M4,
      // and M4 takes 90 seconds to answer. M4 also answers the probe, so an attempt
      // that passes the wake check is refused only for that.
      let answered = 0;
      const { minisMoves, destination } = yield* staleReplicaOnMinis("awake", {
        heartbeat: () =>
          Effect.sleep("90 seconds").pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                answered += 1;
              }),
            ),
            Effect.as({ machineLabel: "M4", continued: [] as Array<never> }),
          ),
      });
      const own = ThreadId.make("thread-minis-own");
      destination.document = {
        ...destination.document,
        threads: {
          ...destination.document.threads,
          [own]: {
            ...emptyThreadRecord(destinationProject),
            lease: {
              holderEnvironmentId: minis,
              holderLabel: "Minis",
              holderThreadId: own,
              epoch: 1,
              renewedAt: "2026-10-20T14:00:00.000Z",
              state: "active",
            },
            replicas: [
              {
                environmentId: m4,
                machineLabel: "M4",
                state: "current",
                sequence: 1,
                detail: null,
                updatedAt: "2026-10-20T14:00:00.000Z",
              },
            ],
          },
        },
      };
      const attempt = minisMoves
        .continueHere({ sourceEnvironmentId: m4, sourceThreadId: threadId })
        .pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      const tick = Effect.gen(function* () {
        const fiber = yield* minisMoves.heartbeat.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        return fiber;
      });
      yield* tick;
      yield* TestClock.adjust("90 seconds");
      yield* TestClock.adjust("30 seconds");
      const slow = yield* tick;
      // Eighty seconds into a tick: no idle time, so no wake.
      yield* TestClock.adjust("80 seconds");
      expect(yield* attempt).toContain("answered just now");
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(slow);
      expect(answered).toBe(2);
      // The next tick starts 30 seconds after the slow one ended: still no wake.
      yield* TestClock.adjust("30 seconds");
      yield* tick;
      expect(yield* attempt).toContain("answered just now");
    }),
  );

  it.effect("waits a minute after this machine starts or wakes before continuing here", () =>
    Effect.gen(function* () {
      const { destination, destinationReceiver, destinationServices, minisMoves } =
        yield* staleReplicaOnMinis("silent");
      const attempt = (moves: typeof minisMoves) =>
        moves.continueHere({ sourceEnvironmentId: m4, sourceThreadId: threadId });
      // A server that just started.
      const started = yield* HandoffMoves.make.pipe(
        Effect.provideService(HandoffReceiver.HandoffReceiver, destinationReceiver),
        Effect.provideService(HandoffPeers, probedSource("silent")),
        Effect.provide(destinationServices),
      );
      const fresh = yield* attempt(started).pipe(Effect.flip);
      expect(fresh.code).toBe("busy");
      expect(fresh.message).toContain("just started or woke");
      // A machine whose lease ticks stopped for five minutes slept; before its next tick
      // sees the gap, Continue here already does.
      yield* minisMoves.heartbeat;
      yield* TestClock.adjust("5 minutes");
      expect((yield* attempt(minisMoves).pipe(Effect.flip)).message).toContain(
        "just started or woke",
      );
      yield* minisMoves.heartbeat;
      expect((yield* attempt(minisMoves).pipe(Effect.flip)).code).toBe("busy");
      yield* TestClock.adjust("30 seconds");
      yield* minisMoves.heartbeat;
      expect((yield* attempt(minisMoves).pipe(Effect.flip)).code).toBe("busy");
      expect(destination.launches).toHaveLength(0);
      yield* TestClock.adjust("31 seconds");
      yield* minisMoves.heartbeat;
      yield* attempt(minisMoves);
      expect(destination.launches).toHaveLength(1);
    }),
  );

  it.effect("tells why a thread stayed when the destination's grant refuses it", () =>
    Effect.gen(function* () {
      const { source, destination, moves, fixture, network, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      fixture.activeRunId = "run-1";
      network.failTakeover = new HandoffPeerError({
        code: "needs_grant",
        check: "grant",
        message: "Minis: this machine lets M4 use only these sign-ins: codex.",
        uncertain: false,
      });
      const run = yield* moves.handOffMachine({
        destinationEnvironmentId: minis,
        reason: "manual",
      });
      expect(run.results).toEqual([
        expect.objectContaining({
          threadId,
          outcome: "stayed",
          detail: "Not moved: Minis: this machine lets M4 use only these sign-ins: codex.",
        }),
      ]);
      const record = source.document.threads[threadId]!;
      expect(record.lease?.state).toBe("active");
      expect(record.lastError).toBe(
        "Not moved: Minis: this machine lets M4 use only these sign-ins: codex.",
      );
      expect(source.document.pausedSince).toBeNull();
      expect(destination.launches).toHaveLength(0);
    }),
  );

  it.effect("replicates each checkpoint to the paired machines of the logical project", () =>
    Effect.gen(function* () {
      const { moves, destination, source, destinationRoot } = yield* scenario({
        sourceMembers: true,
      });
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
      const first = findIncoming(destination.document, m4, threadId)?.checkpoint.sequence;
      expect(first).toBe(1);
      // A turn end writes checkpoint 2; the next tick ships it without a handoff.
      yield* moves
        .preflight({ destinationEnvironmentId: m4, threadIds: [threadId] })
        .pipe(Effect.ignore);
      expect(source.document.threads[threadId]?.checkpoint?.sequence).toBe(2);
      yield* moves.tick;
      expect(findIncoming(destination.document, m4, threadId)?.checkpoint.sequence).toBe(2);
      expect(
        source.document.threads[threadId]?.replicas.find(
          (replica) => replica.environmentId === minis,
        ),
      ).toMatchObject({ state: "current", sequence: 2 });
    }),
  );

  it.effect(
    "keeps a re-sent takeover in doubt when the failure never came from the destination",
    () =>
      Effect.gen(function* () {
        const { source, destination, moves, network, destinationRoot } = yield* scenario();
        NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
        network.dropTakeoverRequest = true;
        yield* handOff(moves).pipe(Effect.flip);
        network.dropTakeoverRequest = false;

        // Unreachable, though not marked uncertain: the first takeover may still have landed.
        network.failTakeover = new HandoffPeerError({
          code: "unreachable",
          message: "Minis did not answer.",
          uncertain: false,
        });
        yield* moves.tick;
        expect(source.document.threads[threadId]?.lease?.state).toBe("handing-off");
        expect(source.document.threads[threadId]?.pendingTakeover).not.toBeNull();
        expect(source.document.threads[threadId]?.lastError).toContain("stays paused");

        // A credential or identity failure on this machine is no refusal either.
        network.failTakeover = new HandoffPeerError({
          code: "needs_grant",
          message: "Minis: this machine has no work grant there",
          uncertain: false,
          local: true,
        });
        yield* moves.tick;
        expect(source.document.threads[threadId]?.lease?.state).toBe("handing-off");
        expect(source.document.threads[threadId]?.pendingTakeover).not.toBeNull();

        network.failTakeover = null;
        yield* moves.tick;
        expect(destination.launches).toHaveLength(1);
        expect(source.document.threads[threadId]?.continuedOn?.threadId).toBe(
          destination.launches[0]?.threadId,
        );
      }),
  );

  it.effect("interrupts a turn still running on the source once the destination took over", () =>
    Effect.gen(function* () {
      const { source, destination, moves, network, fixture, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      network.dropTakeoverRequest = true;
      yield* handOff(moves).pipe(Effect.flip);
      network.dropTakeoverRequest = false;
      // A turn runs on the held copy anyway (an interrupt that never landed).
      fixture.activeRunId = "run-late";
      yield* moves.tick;
      expect(destination.launches).toHaveLength(1);
      expect(source.document.threads[threadId]?.continuedOn).not.toBeNull();
      expect(source.dispatched.filter((command) => command.type === "run.interrupt")).toEqual([
        expect.objectContaining({ runId: "run-late", threadId, cause: "agent" }),
      ]);
      expect(fixture.activeRunId).toBeNull();
    }),
  );

  it.effect(
    "interrupts again after the takeover when the first interrupt did not stop the turn",
    () =>
      Effect.gen(function* () {
        const { source, destination, moves, fixture, destinationRoot } = yield* scenario();
        NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
        fixture.activeRunId = "run-1";
        fixture.ignoreInterrupt = true;
        let done = false;
        const fiber = yield* handOff(moves).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              done = true;
            }),
          ),
          Effect.forkChild,
        );
        // The bounded wait for the turn to end runs out. Git work in between is real I/O,
        // so the test clock moves in small steps while the handoff runs.
        for (let step = 0; step < 2_000 && !done; step += 1) {
          yield* TestClock.withLive(Effect.sleep("5 millis"));
          yield* TestClock.adjust("1 second");
        }
        const result = yield* Fiber.join(fiber);
        expect(result.threadId).toBe(destination.launches[0]?.threadId);
        const interrupts = source.dispatched.filter((command) => command.type === "run.interrupt");
        expect(interrupts).toHaveLength(2);
        expect(interrupts[1]).toMatchObject({ runId: "run-1", cause: "agent" });
        expect(String(interrupts[1]?.commandId)).toContain("handoff-fenced-interrupt:run-1");
      }),
  );

  it.effect("backs off a failing replication instead of retrying it on every tick", () =>
    Effect.gen(function* () {
      const { moves, network, source, destinationRoot } = yield* scenario({ sourceMembers: true });
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      // A turn end wrote checkpoint 1, which Minis lacks; Minis does not answer.
      yield* moves
        .preflight({ destinationEnvironmentId: m4, threadIds: [threadId] })
        .pipe(Effect.ignore);
      network.down = true;
      yield* moves.tick;
      expect(network.shipments).toBe(1);
      yield* moves.tick;
      yield* TestClock.adjust("29 seconds");
      yield* moves.tick;
      expect(network.shipments).toBe(1);
      // 30 seconds after the first failure, then 60 after the second.
      yield* TestClock.adjust("1 second");
      yield* moves.tick;
      expect(network.shipments).toBe(2);
      yield* TestClock.adjust("30 seconds");
      yield* moves.tick;
      expect(network.shipments).toBe(2);
      yield* TestClock.adjust("30 seconds");
      yield* moves.tick;
      expect(network.shipments).toBe(3);
      // Once it answers, the next try ships it and the wait resets.
      network.down = false;
      yield* TestClock.adjust("120 seconds");
      yield* moves.tick;
      expect(network.shipments).toBe(4);
      expect(
        source.document.threads[threadId]?.replicas.find(
          (replica) => replica.environmentId === minis,
        ),
      ).toMatchObject({ state: "current", sequence: 1 });
    }),
  );

  it.effect("refuses an unsettled child before it stops the running turn", () =>
    Effect.gen(function* () {
      const children = [
        {
          taskId: "child-1",
          parentThreadId: threadId,
          childThreadId: ThreadId.make("child-thread"),
          sourceEnvironmentId: m4,
          ownerEpoch: 4,
          origin: "app_owned" as const,
          providerThreadId: null,
          status: "running",
          disposition: "unknown" as const,
          context: "Original brief: audit mail receipts.",
        },
      ];
      const { moves, source, destination, fixture, destinationRoot } = yield* scenario({
        children,
      });
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      fixture.activeRunId = "run-1";
      const failure = yield* handOff(moves).pipe(Effect.flip);
      expect(failure.message).toContain("owning process or machine");
      expect(source.dispatched).toEqual([]);
      expect(source.document.threads[threadId]?.lease?.state ?? "active").toBe("active");
      expect(destination.launches).toHaveLength(0);
    }),
  );

  it.effect.each(["leased", "settled", "unknown"] as const)(
    "carries child dispositions across two hosts: %s",
    (disposition) =>
      Effect.gen(function* () {
        const children = [
          {
            taskId: "child-1",
            parentThreadId: threadId,
            childThreadId: ThreadId.make("child-thread"),
            sourceEnvironmentId: m4,
            ownerEpoch: 4,
            origin: "app_owned" as const,
            providerThreadId: null,
            status: disposition === "settled" ? "completed" : "running",
            disposition,
            context:
              "Original brief: audit mail receipts. Never replay sent mail. Result revision: receipt-1.",
          },
        ];
        const { moves, source, destination, destinationRoot } = yield* scenario({ children });
        NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
        if (disposition === "unknown") {
          const failure = yield* handOff(moves).pipe(Effect.flip);
          expect(failure.message).toContain("owning process or machine");
          expect(destination.launches).toHaveLength(0);
          expect(source.document.threads[threadId]?.continuedOn).toBeNull();
          return;
        }
        const moved = yield* handOff(moves);
        expect(destination.launches).toHaveLength(1);
        expect(destination.launches[0]?.initialMessage?.text).toContain("receipt-1");
        expect(destination.launches[0]?.initialMessage?.text).toContain(`owner ${m4}; epoch 4`);
        const again = yield* handOff(moves);
        expect(again.threadId).toBe(moved.threadId);
        expect(destination.launches).toHaveLength(1);
      }),
  );
});
