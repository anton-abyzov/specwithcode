import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import {
  localChildOwnership,
  childHandoffDisposition,
  childHandoffInstructions,
} from "./ChildMachineHandoff.ts";
import { acquireLease, emptyThreadRecord, guardSideEffect } from "../handoff/handoffState.ts";
import {
  native,
  PARENT,
  projection,
  rowStatus,
  run,
  thread,
  world,
} from "./SubagentHandoffContinuity.testkit.ts";

const source = EnvironmentId.make("host-source");
const destination = EnvironmentId.make("host-destination");
const childId = ThreadId.make("child-remote");

it.effect("an unreachable owning host stays unknown despite missing local sessions", () =>
  Effect.gen(function* () {
    const parent = projection({
      thread: { ...thread(PARENT), execution: { executionMachineId: source } } as never,
      runs: [run("first", 1, "completed")],
      subagents: [native("remote", "first")],
    });
    const fixture = world([parent], { sessionOpen: false });
    yield* fixture.sweep;
    assert.equal(rowStatus(parent, "remote").status, "running");
    assert.lengthOf(fixture.commits, 0);
    assert.isFalse(localChildOwnership(parent.thread, destination));
    assert.isTrue(localChildOwnership(parent.thread, source));
  }),
);

it.effect("does not settle a local-looking descendant of a remote owner", () =>
  Effect.gen(function* () {
    const owner = projection({
      thread: { ...thread(PARENT), execution: { executionMachineId: source } } as never,
      runs: [run("first", 1, "completed")],
    });
    const descendant = projection({
      thread: thread(childId, PARENT, "provider"),
      subagents: [native("nested-remote", "first")],
    });
    const fixture = world([owner, descendant], { sessionOpen: false });
    yield* fixture.sweep;
    assert.lengthOf(fixture.commits, 0);
    assert.equal(rowStatus(descendant, "nested-remote").status, "running");
  }),
);

it("carries a live app-owned child as one source lease, never a destination launch", () => {
  const child = {
    ...native("delegated", "first", childId).row,
    origin: "app_owned",
    result: null,
  } as never;
  const manifest = childHandoffDisposition({
    child,
    sourceEnvironmentId: source,
    ownerEpoch: 7,
    parentInstructions: "Read only",
  });
  assert.equal(manifest.disposition, "leased");
  assert.equal(manifest.sourceEnvironmentId, source);
  assert.equal(manifest.ownerEpoch, 7);
  const seed = childHandoffInstructions([manifest]);
  assert.include(seed, "Do not start replacements");
  assert.include(seed, "NEVER REPLAY");
  assert.include(seed, "Read only");
  const lease = acquireLease(
    null,
    { environmentId: source, label: "Source", threadId: childId },
    "2026-10-24T12:00:00.000Z",
    6,
  );
  const record = { ...emptyThreadRecord(ProjectId.make("project")), lease };
  const operation = {
    record,
    turnKey: `${childId}/run`,
    kind: "pr-create" as const,
    target: "review",
    epoch: 7,
  };
  assert.equal(guardSideEffect({ ...operation, environmentId: source }).kind, "proceed");
  assert.equal(guardSideEffect({ ...operation, environmentId: destination }).kind, "refuse");
});

it("unknown native work blocks takeover and a completed receipt is carried intact", () => {
  const child = { ...native("native", "first", childId).row, result: null } as Parameters<
    typeof childHandoffDisposition
  >[0]["child"];
  const unknown = childHandoffDisposition({
    child,
    sourceEnvironmentId: source,
    ownerEpoch: 1,
    parentInstructions: "No resend",
    remote: true,
  });
  assert.equal(unknown.disposition, "unknown");
  const completed = childHandoffDisposition({
    child: { ...child, status: "completed", result: "Mail receipt committed" },
    sourceEnvironmentId: source,
    ownerEpoch: 1,
    parentInstructions: "No resend",
  });
  assert.equal(completed.disposition, "settled");
  assert.include(childHandoffInstructions([completed]), "Mail receipt committed");
});

it("fences a late source and repeated takeover at the existing accepted epoch", () => {
  const first = acquireLease(
    null,
    { environmentId: source, label: "Source", threadId: childId },
    "2026-10-24T12:00:00.000Z",
  );
  const next = acquireLease(
    first,
    { environmentId: destination, label: "Destination", threadId: childId },
    "2026-10-24T12:01:00.000Z",
  );
  const record = { ...emptyThreadRecord(ProjectId.make("project")), lease: next };
  const operation = {
    record,
    turnKey: `${childId}/run`,
    kind: "pr-create" as const,
    target: "review",
  };
  assert.equal(
    guardSideEffect({ ...operation, environmentId: source, epoch: first.epoch }).kind,
    "refuse",
  );
  assert.equal(
    guardSideEffect({ ...operation, environmentId: destination, epoch: next.epoch }).kind,
    "proceed",
  );
  assert.equal(
    guardSideEffect({ ...operation, environmentId: destination, epoch: first.epoch }).kind,
    "refuse",
  );
});
