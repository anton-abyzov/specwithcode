import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  LogicalProjectMember,
  NonNegativeInt,
  ProjectCoordinatorBinding,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { LINKED_SYNC_PEER_MAX_BYTES } from "./handoffWire.ts";
import {
  LINKED_SYNC_PROTOCOL_VERSION,
  LinkedDigestResponse,
  LinkedMembersRequest,
  LinkedSupersedeResponse,
} from "./linkedSyncWire.ts";

const member = (n: number) => ({
  environmentId: EnvironmentId.make(`machine-${n}`),
  projectId: ProjectId.make(`project-${n}`),
  coordinatorThreadId: ThreadId.make(`project-coordinator:project-${n}`),
});

const digest = {
  protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
  member: member(1),
  binding: { epoch: 0, state: "active" as const },
  coordinatorDigest: "0".repeat(64),
  replica: null,
  memoryDigest: null,
  planDigest: null,
};

/** The shapes a machine from before member sync decodes with. */
const OldDigest = Schema.Struct({
  protocolVersion: NonNegativeInt,
  member: LogicalProjectMember,
  binding: Schema.NullOr(ProjectCoordinatorBinding),
  coordinatorDigest: Schema.String,
  replica: Schema.Null,
  memoryDigest: Schema.NullOr(Schema.String),
  planDigest: Schema.NullOr(Schema.String),
});
const OldSupersede = Schema.Struct({
  coordinatorBinding: ProjectCoordinatorBinding,
  replayed: Schema.Boolean,
});

describe("linked sync wire: member lists", () => {
  it("decodes a digest from an older machine, without members", () => {
    const decoded = Schema.decodeUnknownOption(LinkedDigestResponse)(digest);
    expect(Option.isSome(decoded)).toBe(true);
    expect(Option.getOrThrow(decoded).members).toBeUndefined();
  });

  it("lets an older machine decode a digest and a supersede answer that carry members", () => {
    const members = [member(1), member(2), member(3)];
    expect(Option.isSome(Schema.decodeUnknownOption(OldDigest)({ ...digest, members }))).toBe(true);
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(OldSupersede)({
          coordinatorBinding: { epoch: 1, state: "transferred" },
          replayed: false,
          members,
        }),
      ),
    ).toBe(true);
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(LinkedSupersedeResponse)({
          coordinatorBinding: { epoch: 1, state: "transferred" },
          replayed: false,
          members,
        }),
      ),
    ).toBe(true);
  });

  it("fits the longest member list in a linked-members body", () => {
    const members = Array.from({ length: 256 }, (_, index) => ({
      ...member(index),
      workspaceRoot: `/${"x".repeat(4095)}`,
    }));
    const request = Schema.encodeSync(LinkedMembersRequest)({
      protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
      logicalProjectId: "logical:1",
      projectId: ProjectId.make("project-1"),
      from: member(0),
      fromEpoch: 0,
      members,
    });
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(LINKED_SYNC_PEER_MAX_BYTES);
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(LinkedMembersRequest)({
          ...request,
          members: [...members, member(999)],
        }),
      ),
    ).toBe(true);
  });
});
