import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  projectChoiceIneligibleReason,
  projectPickerMembers,
  type PickerProject,
} from "./projectPicker.js";
const environmentId = EnvironmentId.make("machine");
const scratch = () => "/home/person/.specwithcode/m4/scratch";
const project = (
  id: string,
  workspaceRoot: string,
  workspaceSettings?: PickerProject["workspaceSettings"],
): PickerProject => ({ environmentId, id: ProjectId.make(id), workspaceRoot, workspaceSettings });
const cases = [
  [project("active", "/work/app"), null],
  [project("personal", "/work/assistant", { kind: "personal" }), null],
  [project("archive", "/work/old", { archived: true }), "archived"],
  [project("automatic", "/work/demo", { origin: "automated" }), "automated"],
  [project("temporary", "/work/demo", { temporarySessionId: "check" }), "automated"],
  [project("inferred", "/work/acceptance/run"), "automated"],
  [project("scratch", scratch()), "scratch"],
  [project("explicit-user", "/work/fixtures/app", { origin: "user" }), null],
  [{ environmentId, id: ProjectId.make("missing-metadata") }, null],
  [
    {
      environmentId,
      id: ProjectId.make("flag-no-root"),
      workspaceSettings: { origin: "automated" },
    },
    "automated",
  ],
  [
    {
      environmentId,
      id: ProjectId.make("session-no-root"),
      workspaceSettings: { temporarySessionId: "check" },
    },
    "automated",
  ],
] as const;

describe("shared web/mobile project choices", () => {
  it.each(cases)("classifies %o as %s", (entry, reason) => {
    expect(projectChoiceIneligibleReason(entry, scratch)).toBe(reason);
    expect(projectPickerMembers([entry], scratch)).toEqual(reason === null ? [entry] : []);
  });
  it("keeps personal projects only for workflows supporting them", () => {
    const personal = cases[1][0];
    expect(projectPickerMembers([personal], scratch, "design")).toEqual([personal]);
    expect(projectChoiceIneligibleReason(personal, scratch, "code")).toBe("not-code");
  });
  it("rechecks changed classification without changing the catalog", () => {
    const live = project("app", "/work/app");
    expect(projectPickerMembers([live], scratch)).toEqual([live]);
    const archived = { ...live, workspaceSettings: { archived: true } };
    expect(projectPickerMembers([archived], scratch)).toEqual([]);
    expect(projectPickerMembers([live], scratch)).toEqual([live]);
  });
});
