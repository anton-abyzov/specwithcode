import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { AwayAccessRequestInput, AwayPlan, AwayPreflightInput } from "./away.ts";

const gap = {
  kind: "routines",
  machineEnvironmentId: "env-ministorm",
  machineLabel: "Ministorm",
  detail: "Ministorm does not let M4's coordinator manage routines.",
  fix: "On Ministorm, turn on Routines for M4.",
};

describe("away contracts", () => {
  it("decodes a plan with rows and missing grants", () => {
    const plan = Schema.decodeUnknownSync(AwayPlan)({
      targetEnvironmentId: "env-ministorm",
      targetLabel: "Ministorm",
      items: [
        { kind: "routine", id: "r1", title: "Instagram", action: "pause", reason: "Webhook." },
        {
          kind: "thread",
          id: "t1",
          title: "Fix",
          projectId: "p1",
          action: "move",
          reason: "Moves.",
        },
      ],
      missingGrants: [gap],
      ready: false,
      checkedAt: "2026-11-09T10:00:00.000Z",
    });
    expect(plan.items).toHaveLength(2);
  });

  it("refuses an unknown action or missing kind", () => {
    expect(() =>
      Schema.decodeUnknownSync(AwayPlan)({
        targetEnvironmentId: "env-ministorm",
        targetLabel: "Ministorm",
        items: [{ kind: "thread", id: "t1", title: "x", action: "stop", reason: "" }],
        missingGrants: [],
        ready: true,
        checkedAt: "2026-11-09T10:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AwayAccessRequestInput)({
        targetEnvironmentId: "env-ministorm",
        missing: [{ ...gap, kind: "everything" }],
      }),
    ).toThrow();
  });

  it("needs at least one missing item in a request; the scope is optional", () => {
    expect(() =>
      Schema.decodeUnknownSync(AwayAccessRequestInput)({
        targetEnvironmentId: "env-ministorm",
        missing: [],
      }),
    ).toThrow();
    expect(Schema.decodeUnknownSync(AwayPreflightInput)({ targetEnvironmentId: "env-m" })).toEqual({
      targetEnvironmentId: "env-m",
    });
  });
});
