import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type Project, ProjectId } from "@specweave-studio/contracts";

import * as Effect from "effect/Effect";

import {
  coordinatorLabels,
  readGrantProjects,
  workGrantProjectChoices,
} from "./workGrantsSnapshot.ts";

const OWN = EnvironmentId.make("env-own");
const M4 = EnvironmentId.make("env-m4");

const project = (
  id: string,
  workspaceRoot: string,
  workspaceSettings?: Record<string, unknown>,
  deletedAt: string | null = null,
): Project =>
  ({
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt,
    ...(workspaceSettings === undefined ? {} : { workspaceSettings }),
  }) as never;

const projects = [
  project("p-web", "/Users/me/code/web", {
    logicalProject: {
      title: "SpecWithCode",
      members: [{ environmentId: M4 }, { environmentId: OWN }],
    },
  }),
  project("p-shelved", "/Users/me/code/shelved", {
    archived: true,
    logicalProject: { title: "Shelved", members: [{ environmentId: M4 }] },
  }),
  project("p-scratch", "/Users/me/.specwithcode/m4/scratch"),
  project("p-old", "/Users/me/code/old", { archived: true }),
  project("p-check", "/Users/me/code/release-verification"),
  project("p-flagged", "/Users/me/code/probe", { origin: "automated" }),
  project("p-mine", "/Users/me/code/acceptance-notes", { origin: "user" }),
  project("p-assistant", "/Users/me/.specwithcode/m4/projects/assistant", { kind: "personal" }),
  project("p-gone", "/Users/me/code/gone", undefined, "2026-10-02T00:00:00.000Z"),
];
const scratchProjectIds = new Set([ProjectId.make("p-scratch")]);

describe("work grant project choices", () => {
  it("offers only the person's own live projects", () => {
    expect(
      workGrantProjectChoices({
        projects,
        ownEnvironmentId: OWN,
        scratchProjectIds,
        chosenProjectIds: new Set(),
      }),
    ).toEqual([
      { id: "p-web", title: "SpecWithCode", linkedTo: [M4] },
      { id: "p-mine", title: "p-mine", linkedTo: [] },
    ]);
  });

  it("keeps a project a grant already names, marked with why it is no longer offered", () => {
    const choices = workGrantProjectChoices({
      projects,
      ownEnvironmentId: OWN,
      scratchProjectIds,
      chosenProjectIds: new Set(
        ["p-scratch", "p-old", "p-check", "p-flagged", "p-gone", "p-assistant"].map((id) =>
          ProjectId.make(id),
        ),
      ),
    });
    expect(choices.map((choice) => [choice.id, choice.unavailable])).toEqual([
      ["p-web", undefined],
      ["p-scratch", "scratch"],
      ["p-old", "archived"],
      ["p-check", "automated"],
      ["p-flagged", "automated"],
      ["p-mine", undefined],
    ]);
    expect(choices.find((choice) => choice.id === "p-web")).not.toHaveProperty("unavailable");
  });

  it("keeps a project linked to a coordinator whose grant is linked, so its summary is whole", () => {
    const choices = workGrantProjectChoices({
      projects,
      ownEnvironmentId: OWN,
      scratchProjectIds,
      chosenProjectIds: new Set(),
      linkedCoordinators: new Set([M4 as string]),
    });
    expect(choices.map((choice) => [choice.id, choice.unavailable])).toEqual([
      ["p-web", undefined],
      ["p-shelved", "archived"],
      ["p-mine", undefined],
    ]);
  });

  it.effect("says when the project read failed, and only then", () =>
    Effect.gen(function* () {
      const read = yield* readGrantProjects(Effect.succeed({ projects }));
      expect(read.projects).toBe(projects);
      expect({ ...read.flag }).toEqual({});
      const failed = yield* readGrantProjects(Effect.fail("database is locked"));
      expect(failed.projects).toEqual([]);
      expect({ ...failed.flag }).toEqual({ projectsUnreadable: true });
    }),
  );
});

describe("coordinatorLabels", () => {
  it("names a coordinator by the fleet list, else its shared nickname, else not at all", () => {
    const labels = coordinatorLabels(
      [
        { environmentId: "env-m3", label: "Mac mini" },
        { environmentId: "env-blank", label: "  " },
      ],
      {
        "env-m3": { name: "M3", updatedAt: "2026-10-01T00:00:00.000Z" },
        "env-m4": { name: "  M4   MAX ", updatedAt: "2026-10-01T00:00:00.000Z" },
        "env-empty": { name: "", updatedAt: "2026-10-01T00:00:00.000Z" },
      },
    );
    expect([...labels].toSorted()).toEqual([
      ["env-m3", "Mac mini"],
      ["env-m4", "M4 MAX"],
    ]);
    expect(coordinatorLabels([], undefined).size).toBe(0);
  });
});
