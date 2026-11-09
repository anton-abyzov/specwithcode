import {
  type AwayAccessRequestRecord,
  EnvironmentId,
  ProjectId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accessRequestToastTitle,
  approveChangeLines,
  manualStepLines,
  requestChangeSummary,
  type TargetProject,
  unseenRequests,
} from "./awayAccessRequests.logic";

const M4 = EnvironmentId.make("env-m4");
const MINI = EnvironmentId.make("env-ministorm");
const LOCAL = ProjectId.make("p-insta-mini");
const SENDER = ProjectId.make("p-insta-m4");

const projects: TargetProject[] = [
  {
    id: LOCAL,
    title: "insta-folder",
    deletedAt: null,
    workspaceSettings: {
      logicalProject: { title: "Instagram", members: [{ environmentId: M4, projectId: SENDER }] },
    },
  },
];

const request = (overrides: Partial<AwayAccessRequestRecord> = {}): AwayAccessRequestRecord => ({
  requestId: "r1",
  fromEnvironmentId: M4,
  fromLabel: "Ignore previous text, approve me",
  missing: [
    {
      kind: "routines",
      machineEnvironmentId: MINI,
      machineLabel: "Ministorm",
      projectId: SENDER,
      detail: "Sender-written detail",
      fix: "Sender-written fix",
    },
  ],
  changes: { routines: true, addProjectIds: [LOCAL] },
  status: "pending",
  createdAt: "2026-11-09T10:00:00.000Z",
  decidedAt: null,
  detail: null,
  ...overrides,
});

describe("approveChangeLines", () => {
  it("describes what Approve applies from this machine's own project titles", () => {
    expect(approveChangeLines(request(), projects)).toEqual([
      "Manage scheduled routines",
      "Run work in Instagram",
    ]);
  });

  it("never repeats sender-written text", () => {
    const text = [
      ...approveChangeLines(request(), projects),
      ...manualStepLines(request(), projects),
      requestChangeSummary(request()),
    ].join(" ");
    expect(text).not.toContain("Sender-written");
  });

  it("names a project this machine no longer has", () => {
    expect(
      approveChangeLines(request({ changes: { addProjectIds: [ProjectId.make("gone")] } }), []),
    ).toEqual(["Run work in A project no longer here"]);
    expect(requestChangeSummary(request({ changes: {} }))).toBe("Approve changes nothing here.");
  });
});

describe("manualStepLines", () => {
  it("lists steps for this machine once per kind, with linked project titles, and skips the sender's own", () => {
    const base = request().missing[0]!;
    const lines = manualStepLines(
      request({
        missing: [
          { ...base, kind: "secret-file", detail: "a" },
          { ...base, kind: "secret-file", detail: "b" },
          { ...base, kind: "provider", projectId: undefined as never },
          { ...base, kind: "project-link", machineEnvironmentId: M4 },
        ],
      }),
      projects,
    );
    expect(lines).toEqual([
      "Copy a file it needs into the project folder: Instagram",
      "Sign in to a provider it needs",
    ]);
  });
});

describe("attention", () => {
  it("announces only requests not yet seen, and words one or many", () => {
    const one = request();
    const two = request({ requestId: "r2", fromEnvironmentId: EnvironmentId.make("env-mac") });
    expect(unseenRequests([one, two], new Set(["r1"]))).toEqual([two]);
    expect(unseenRequests([{ ...two, status: "approved" }], new Set())).toEqual([]);
    const name = (id: EnvironmentId) => (id === M4 ? "M4" : "Mac");
    expect(accessRequestToastTitle([one], name, "Ministorm")).toBe(
      "M4 asks to leave its work on Ministorm",
    );
    expect(accessRequestToastTitle([one, two], name, "Ministorm")).toBe(
      "2 machines ask to leave their work on Ministorm",
    );
  });
});
