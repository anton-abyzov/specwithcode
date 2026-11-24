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
import { ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { incomingRef } from "./bundleGit.ts";
import { HandoffPeerError } from "./handoffPeers.ts";
import { HANDOFF_CAPABILITIES, HANDOFF_PROTOCOL_VERSION } from "./handoffWire.ts";
import { findIncoming } from "./handoffState.ts";
import {
  destinationProject,
  directory,
  git,
  gitEnv,
  handOff,
  m4,
  minis,
  modelSelection,
  registerCleanup,
  scenario,
  sourceProject,
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
      expect(failure.message).toContain("stays on the machine it was started on");
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
        capabilities: HANDOFF_CAPABILITIES,
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
