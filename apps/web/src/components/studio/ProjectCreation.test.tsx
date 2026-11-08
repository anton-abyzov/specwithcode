import { describe, expect, it, vi } from "vite-plus/test";
import { projectCreationGroups, SPECWEAVE_SETUP_SUMMARY } from "./ProjectCreation";

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
