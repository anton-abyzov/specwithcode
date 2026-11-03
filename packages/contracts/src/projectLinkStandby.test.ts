import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId } from "./baseSchemas.ts";
import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import { CoordinatorStandbyAfterMinutes, LogicalProjectMember } from "./logicalProject.ts";
import {
  ProjectAcceptStandbyInput,
  ProjectAcceptStandbyResult,
  STANDBY_REARM_MEMBERS_MAX,
  StandbyRearmConsent,
} from "./projectLinkStandby.ts";

/** The accept input as servers before re-arm declare it: `standby` is required. */
const OlderAcceptStandbyInput = Schema.Struct({
  projectId: ProjectId,
  logicalProjectId: Schema.String.check(Schema.isMaxLength(512)),
  standby: Schema.NullOr(
    Schema.Struct({
      coordinator: LogicalProjectMember,
      epoch: NonNegativeInt,
      afterMinutes: CoordinatorStandbyAfterMinutes,
    }),
  ),
});

const member = (machine: string) => ({
  environmentId: `env-${machine}`,
  projectId: `easychamp-${machine}`,
  coordinatorThreadId: `project-coordinator:easychamp-${machine}`,
});
const consent = {
  chainId: "77777777-7777-4777-8777-777777777777",
  members: [member("m1"), member("m3")],
  afterMinutes: 5,
  fromEpoch: 2,
};

describe("standby re-arm consent", () => {
  it("is refused by a server from before re-arm when it comes without a standby", () => {
    const consentOnly = {
      projectId: "easychamp-m3",
      logicalProjectId: "logical:e",
      rearm: consent,
    };
    expect(Schema.decodeUnknownExit(OlderAcceptStandbyInput)(consentOnly)._tag).toBe("Failure");
    expect(Schema.decodeUnknownSync(ProjectAcceptStandbyInput)(consentOnly)).toEqual(consentOnly);
    // The owner's ordinary arm still decodes on both.
    const arm = {
      projectId: "easychamp-m3",
      logicalProjectId: "logical:e",
      standby: { coordinator: member("m4"), epoch: 0, afterMinutes: 15 },
    };
    expect(Schema.decodeUnknownSync(OlderAcceptStandbyInput)(arm)).toEqual(arm);
    expect(Schema.decodeUnknownSync(ProjectAcceptStandbyInput)(arm)).toEqual(arm);
    const disarm = { ...arm, standby: null, belowEpoch: 4 };
    expect(Schema.decodeUnknownSync(ProjectAcceptStandbyInput)(disarm)).toEqual(disarm);
  });

  it("names an owner operation, at least two and at most the cap of machines", () => {
    const decode = Schema.decodeUnknownExit(StandbyRearmConsent);
    expect(decode(consent)._tag).toBe("Success");
    expect(decode({ ...consent, chainId: "not-an-operation" })._tag).toBe("Failure");
    expect(decode({ ...consent, members: [member("m1")] })._tag).toBe("Failure");
    const many = Array.from({ length: STANDBY_REARM_MEMBERS_MAX + 1 }, (_, n) => member(`m${n}`));
    expect(decode({ ...consent, members: many })._tag).toBe("Failure");
    expect(decode({ ...consent, afterMinutes: 7 })._tag).toBe("Failure");
  });

  it("keeps the result and capability readable by older clients", () => {
    const result = { standby: null, replayed: true, rearm: { chainId: consent.chainId } };
    expect(Schema.decodeUnknownSync(ProjectAcceptStandbyResult)(result)).toEqual(result);
    expect(
      Schema.decodeUnknownSync(ProjectAcceptStandbyResult)({ standby: null, replayed: false }),
    ).toEqual({ standby: null, replayed: false });
    expect(
      Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities)({ coordinatorRearm: true }),
    ).toMatchObject({ coordinatorRearm: true });
  });
});
