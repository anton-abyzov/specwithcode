import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  newProjectGitHubRow,
  ProjectMachineChoice,
  projectCreationGroups,
  SPECWEAVE_SETUP_SUMMARY,
} from "./ProjectCreation";
import {
  EXISTING_FOLDER_PUBLISH_NOTE,
  newProjectGitHubRowNote,
  newProjectGitHubUnavailableReason,
  projectMachineUnavailableReason,
} from "../../studio/newProjectAvailability";

const input = () => ({
  kind: "personal" as const,
  busy: false,
  github: { description: "Private repository", checked: true, toggle: vi.fn() },
  specweave: { checked: false, toggle: vi.fn() },
});
describe("project creation choices", () => {
  it("leaves the machine to the row above the form and omits GitHub publishing for Personal", () => {
    const groups = projectCreationGroups(input());
    expect(groups.some((g) => g.value === "new-project-machines")).toBe(false);
    expect(groups.some((g) => g.value === "new-project-options")).toBe(false);
  });
  it("keeps code publishing opt-in and blocks every choice during creation", () => {
    const groups = projectCreationGroups({ ...input(), kind: "code", busy: true });
    expect(groups.some((g) => g.value === "new-project-options")).toBe(true);
    expect(groups.flatMap((g) => g.items).every((i) => i.disabled)).toBe(true);
  });
  it("offers Use SpecWeave for code projects only, even without GitHub, in one sentence", () => {
    const toggle = vi.fn();
    const groups = projectCreationGroups({
      ...input(),
      kind: "code",
      github: null,
      specweave: { checked: true, toggle },
    });
    const option = groups
      .find((g) => g.value === "new-project-options")
      ?.items.find((i) => i.value === "new-project:specweave");
    expect(option?.title).toBe("Use SpecWeave");
    expect(option?.description).toBe(SPECWEAVE_SETUP_SUMMARY);
    if (option?.kind === "action") void option.run();
    expect(toggle).toHaveBeenCalledOnce();
    expect(
      projectCreationGroups(input())
        .flatMap((g) => g.items)
        .some((i) => i.value === "new-project:specweave"),
    ).toBe(false);
  });
  it("never offers project types or a second assistant", () => {
    for (const kind of ["code", "personal"] as const) {
      const groups = projectCreationGroups({ ...input(), kind });
      expect(groups.some((group) => group.label === "Project type")).toBe(false);
      expect(
        groups.flatMap((group) => group.items).some((item) => item.value.includes(":kind:")),
      ).toBe(false);
    }
  });
});

describe("the GitHub option when it cannot be offered", () => {
  const github = (status: string, auth: string) =>
    ({
      sourceControlProviders: [{ kind: "github", status, auth: { status: auth } }],
    }) as never;
  it("names the machine and the fix instead of disappearing", () => {
    expect(
      newProjectGitHubUnavailableReason({
        discovery: github("available", "unauthenticated"),
        pending: false,
        machine: "M1Max",
      }),
    ).toBe("Sign in to GitHub on M1Max: gh auth login");
    expect(
      newProjectGitHubUnavailableReason({
        discovery: github("missing", "unknown"),
        pending: false,
        machine: "M1Max",
      }),
    ).toContain("The GitHub CLI is not installed on M1Max");
    expect(
      newProjectGitHubUnavailableReason({ discovery: null, pending: true, machine: "M1Max" }),
    ).toBe("Checking GitHub on M1Max…");
    expect(
      newProjectGitHubUnavailableReason({
        discovery: github("available", "authenticated"),
        pending: false,
        machine: "M1Max",
      }),
    ).toBeNull();
  });
  it("picks the machine's GitHub state without a target, else the existing-folder note", () => {
    const note = (hasTarget: boolean, usesExistingFolder: boolean) =>
      newProjectGitHubRowNote({
        hasTarget,
        usesExistingFolder,
        discovery: github("available", "unauthenticated"),
        pending: false,
        machine: "M1Max",
      });
    expect(note(false, true)).toBe("Sign in to GitHub on M1Max: gh auth login");
    expect(note(true, true)).toBe(EXISTING_FOLDER_PUBLISH_NOTE);
    expect(note(true, false)).toBeNull();
  });
  it("shows the row disabled with the reason, and never toggles it", () => {
    const toggle = vi.fn();
    for (const row of [
      newProjectGitHubRow({
        target: null,
        pathPreview: null,
        name: "ec",
        unavailable: "Sign in to GitHub on M1Max: gh auth login",
        checked: true,
        toggle,
      }),
      // An existing folder: publishing is for new repositories only.
      newProjectGitHubRow({
        target: { account: "me" },
        pathPreview: "/p/ec",
        name: "ec",
        unavailable: EXISTING_FOLDER_PUBLISH_NOTE,
        checked: true,
        toggle,
      }),
    ]) {
      const option = projectCreationGroups({ ...input(), kind: "code", github: row })
        .flatMap((g) => g.items)
        .find((i) => i.value === "new-project:github");
      expect(option?.disabled).toBe(true);
      expect(option?.description).toBe(row?.unavailable);
      if (option?.kind === "action") void option.run();
    }
    expect(toggle).not.toHaveBeenCalled();
  });
});

describe("machines that cannot be chosen", () => {
  it("says why: offline, read-only, or too old", () => {
    const base = { online: true, status: "Connected", canOperate: true, supportsCreate: true };
    expect(projectMachineUnavailableReason(base)).toBeNull();
    expect(projectMachineUnavailableReason({ ...base, online: false, status: "Offline" })).toBe(
      "Offline: it cannot be used right now.",
    );
    expect(projectMachineUnavailableReason({ ...base, canOperate: false })).toBe(
      "Read-only access: this device may not create projects there.",
    );
    expect(projectMachineUnavailableReason({ ...base, supportsCreate: false })).toBe(
      "Needs a newer SpecWithCode to create projects.",
    );
  });
  it("disables the machine and puts the reason in its description", () => {
    const html = renderToStaticMarkup(
      <ProjectMachineChoice
        machines={[
          { environmentId: "m4", label: "M4", isPrimary: true, isConnected: true, icon: null },
          {
            environmentId: "m1",
            label: "M1",
            isPrimary: false,
            isConnected: false,
            unavailableReason: "Offline: it cannot be used right now.",
            icon: null,
          },
        ]}
        selectedId="m4"
        busy={false}
        onSelect={vi.fn()}
      />,
    );
    expect(html).toContain('data-unavailable="true"');
    expect(html).toMatch(/aria-describedby="[^"]+-1"/);
    expect(html).toContain('class="sr-only">Offline: it cannot be used right now.</span>');
  });
});
