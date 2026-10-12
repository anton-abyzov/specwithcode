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
  selectKind: vi.fn(),
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
  it("names the personal kind Personal assistant and lets assistant or agent find it", () => {
    const item = projectCreationGroups(input())[0]!.items.find(
      (i) => i.value === "new-project:kind:personal",
    )! as CommandPaletteActionItem;
    expect(item.title).toBe("Personal assistant");
    expect(item.searchTerms).toEqual(expect.arrayContaining(["assistant", "agent"]));
  });
  it("exposes Personal selection without silently creating a project", async () => {
    const args = input();
    const item = projectCreationGroups(args)[0]!.items.find(
      (i) => i.value === "new-project:kind:personal",
    )! as CommandPaletteActionItem;
    await item.run();
    expect(args.selectKind).toHaveBeenCalledWith("personal");
    expect(args.github.toggle).not.toHaveBeenCalled();
    expect(args.addExisting).not.toHaveBeenCalled();
  });
});
