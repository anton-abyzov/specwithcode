import { describe, expect, it } from "@effect/vitest";
import {
  type AwayAccessRequestRecord,
  type AwayMissingGrant,
  EnvironmentId,
  ProjectId,
  WS_METHODS,
} from "@specweave-studio/contracts";

import {
  addRequest,
  grantChangesFor,
  grantUpdateFor,
  localProjectFor,
  resultOf,
  validateAccessRequest,
} from "./AwayAccessRequest.ts";
import { awayCaller } from "./awayAccessRoute.ts";
import { refusesOwnerOnlyRpc } from "../auth/RpcAuthorization.ts";

const M4 = EnvironmentId.make("env-m4");
const MINI = EnvironmentId.make("env-ministorm");
const OTHER = EnvironmentId.make("env-other");
const P_M4 = ProjectId.make("p-insta-m4");
const P_MINI = ProjectId.make("p-insta-mini");

/** A step on the sender's own machine, about no project. */
const ownStep = (): AwayMissingGrant => ({
  kind: "work-grant",
  machineEnvironmentId: M4,
  machineLabel: "M4",
  detail: "Ministorm does not let M4 run work there yet.",
  fix: "On this machine, choose Allow on Ministorm.",
});

const gap = (overrides: Partial<AwayMissingGrant> = {}): AwayMissingGrant => ({
  kind: "routines",
  machineEnvironmentId: MINI,
  machineLabel: "Ministorm",
  projectId: P_M4,
  detail: "Ministorm does not let M4's coordinator manage routines.",
  fix: "Turn on Routines for M4.",
  ...overrides,
});

const record = (overrides: Partial<AwayAccessRequestRecord> = {}): AwayAccessRequestRecord => ({
  requestId: "req-1",
  fromEnvironmentId: M4,
  fromLabel: "M4",
  missing: [gap()],
  changes: { routines: true },
  status: "pending",
  createdAt: "2026-11-09T10:00:00.000Z",
  decidedAt: null,
  detail: null,
  ...overrides,
});

describe("validateAccessRequest", () => {
  it("keeps items for the target and the sender, once each", () => {
    const own = ownStep();
    const checked = validateAccessRequest({
      self: MINI,
      from: M4,
      missing: [gap(), gap(), own],
    });
    expect(checked).toEqual({ ok: true, missing: [gap(), own] });
  });

  it("refuses a third machine, a request to itself, and one with nothing for the target", () => {
    expect(
      validateAccessRequest({
        self: MINI,
        from: M4,
        missing: [gap({ machineEnvironmentId: OTHER })],
      }),
    ).toMatchObject({ ok: false });
    expect(validateAccessRequest({ self: MINI, from: MINI, missing: [gap()] })).toMatchObject({
      ok: false,
    });
    expect(
      validateAccessRequest({ self: MINI, from: M4, missing: [gap({ machineEnvironmentId: M4 })] }),
    ).toMatchObject({ ok: false, message: "The request has nothing to change on this machine." });
  });
});

describe("grant changes", () => {
  const projects = [
    {
      id: P_MINI,
      deletedAt: null,
      workspaceSettings: {
        logicalProject: {
          id: "lp-insta",
          title: "Insta",
          coordinatorId: "c",
          members: [
            { environmentId: M4, projectId: P_M4, coordinatorThreadId: "t" as never },
            { environmentId: MINI, projectId: P_MINI, coordinatorThreadId: "t2" as never },
          ],
        },
      },
    },
  ] as never;

  it("maps the sender's project to this machine's linked copy", () => {
    expect(localProjectFor(projects, M4, P_M4)).toBe(P_MINI);
    expect(localProjectFor(projects, OTHER, P_M4)).toBeNull();
  });

  it("asks only for routines and project scope; files, sign-ins and links stay manual", () => {
    const changes = grantChangesFor({
      self: MINI,
      missing: [
        gap(),
        gap({ kind: "work-grant" }),
        gap({ kind: "secret-file", detail: "no .env.local" }),
        gap({ kind: "provider", detail: "Codex not signed in" }),
        // A step on the sender's own machine is never applied here.
        ownStep(),
      ],
      localProject: (id) => (id === P_M4 ? P_MINI : null),
    });
    expect(changes).toEqual({ routines: true, addProjectIds: [P_MINI] });
  });

  it("applies routines and adds projects only to a listed grant, and nothing already allowed", () => {
    const changes = { routines: true, addProjectIds: [P_MINI] };
    expect(
      grantUpdateFor(
        M4,
        { routines: false, projects: { kind: "listed", projectIds: [] } },
        changes,
      ),
    ).toEqual({
      coordinatorEnvironmentId: M4,
      routines: true,
      projects: { kind: "listed", projectIds: [P_MINI] },
    });
    expect(grantUpdateFor(M4, { routines: false, projects: { kind: "linked" } }, changes)).toEqual({
      coordinatorEnvironmentId: M4,
      routines: true,
    });
    expect(
      grantUpdateFor(
        M4,
        { routines: true, projects: { kind: "listed", projectIds: [P_MINI] } },
        changes,
      ),
    ).toBeNull();
  });
});

describe("addRequest", () => {
  it("answers already-pending for the same request and replaces a changed one", () => {
    const first = record();
    const again = addRequest([first], record({ requestId: "req-2" }));
    expect(again.result).toMatchObject({ requestId: "req-1", status: "already-pending" });
    expect(again.requests).toEqual([first]);

    const changed = record({ requestId: "req-3", missing: [gap(), gap({ kind: "work-grant" })] });
    const replaced = addRequest([first], changed);
    expect(replaced.result).toMatchObject({ requestId: "req-3", status: "sent" });
    expect(replaced.requests.map((entry) => entry.requestId)).toEqual(["req-3"]);
  });

  it("keeps decided requests from others and drops the oldest decided past the cap", () => {
    const decided = Array.from({ length: 50 }, (_, index) =>
      record({ requestId: `old-${index}`, fromEnvironmentId: OTHER, status: "approved" }),
    );
    const next = addRequest(decided, record({ requestId: "new" }));
    expect(next.requests).toHaveLength(50);
    expect(next.requests[0]?.requestId).toBe("old-1");
    expect(next.requests.at(-1)?.requestId).toBe("new");
  });

  it("reports each state to the sender", () => {
    expect(resultOf(record()).status).toBe("sent");
    expect(resultOf(record({ status: "approved" })).status).toBe("approved");
    expect(resultOf(record({ status: "declined" })).status).toBe("declined");
  });
});

describe("who may ask and who may decide", () => {
  it("knows the caller only from a coordinator credential", () => {
    expect(awayCaller([{ principal: { kind: "coordinator", environmentId: M4 } }])).toBe(M4);
    expect(awayCaller([{ principal: { kind: "device", id: "phone" } }, undefined])).toBeUndefined();
    expect(awayCaller([undefined, { principal: { kind: "coordinator", environmentId: M4 } }])).toBe(
      M4,
    );
  });

  it("never lets another machine's key approve", () => {
    const decide = WS_METHODS.awayDecideAccess;
    expect(refusesOwnerOnlyRpc(decide, { kind: "coordinator", environmentId: M4 })).toBe(true);
    expect(refusesOwnerOnlyRpc(decide, { kind: "device", id: "laptop" })).toBe(false);
    expect(refusesOwnerOnlyRpc(decide, undefined)).toBe(false);
    expect(
      refusesOwnerOnlyRpc(WS_METHODS.awayPreflight, { kind: "coordinator", environmentId: M4 }),
    ).toBe(false);
  });
});
