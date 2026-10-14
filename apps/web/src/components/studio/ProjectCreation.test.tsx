import { describe, expect, it, vi } from "vite-plus/test";
import { projectCreationGroups } from "./ProjectCreation";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";

const machine: CommandPaletteActionItem = {
  kind: "action",
  value: "host",
  icon: null,
  title: "This machine",
  searchTerms: [],
  run: async () => {},
};
const input = () => ({
  kind: "personal" as const,
  busy: false,
  machines: [{ item: machine, selected: true }],
  github: { description: "Private repository", checked: true, toggle: vi.fn() },
  addExisting: vi.fn(),
});
describe("project creation choices", () => {
  it("keeps a one-machine selector explicit and omits GitHub publishing for Personal", () => {
    const groups = projectCreationGroups(input());
    expect(
      groups.find((g) => g.value === "new-project-machines")?.items.map((i) => i.value),
    ).toEqual(["host"]);
    expect(groups.some((g) => g.value === "new-project-options")).toBe(false);
  });
  it("keeps code publishing opt-in and blocks every choice during creation", () => {
    const groups = projectCreationGroups({ ...input(), kind: "code", busy: true });
    expect(groups.some((g) => g.value === "new-project-options")).toBe(true);
    expect(groups.flatMap((g) => g.items).every((i) => i.disabled)).toBe(true);
  });
  it("never offers project types or a second assistant", () => {
    for (const kind of ["code", "personal"] as const) {
      const groups = projectCreationGroups({ ...input(), kind });
      expect(groups.some((group) => group.label === "Project type")).toBe(false);
      expect(groups.flatMap((group) => group.items).some((item) => item.value.includes(":kind:"))).toBe(false);
    }
  });
});
