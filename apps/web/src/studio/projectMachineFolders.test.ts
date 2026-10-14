import { describe, expect, it } from "vite-plus/test";
import { isProjectFolder, groupMachineFolders } from "./projectMachineFolders";
describe("project execution folders", () => {
  it("keeps saved folders while excluding generated transfer and proof checkouts", () => {
    expect(isProjectFolder("/Users/anton/Projects/sw-easychamp")).toBe(true);
    expect(isProjectFolder("/private/workspace", "machine-handoff:operation")).toBe(false);
    expect(
      isProjectFolder(
        "/Users/anton/.specweave-studio/m1/userdata/machine-handoffs/git/uuid/workspace",
      ),
    ).toBe(false);
    expect(
      isProjectFolder(
        "/Users/anton/.local/share/specweave/fleet/handoff-proof-20261013/product-source-checkouts/sw-easychamp",
      ),
    ).toBe(false);
  });
  it("keeps two machines with identical labels distinct and deduplicates folder registrations", () => {
    const items = [
      { key: "a", environmentId: "m1", label: "Mac", folder: "/project" },
      { key: "duplicate", environmentId: "m1", label: "Mac", folder: "/project" },
      { key: "b", environmentId: "m1", label: "Mac", folder: "/second" },
      { key: "c", environmentId: "m3", label: "Mac", folder: "/project" },
    ];
    expect(groupMachineFolders(items).map((m) => [m.key, m.folders.map((f) => f.key)])).toEqual([
      ["m1", ["a", "b"]],
      ["m3", ["c"]],
    ]);
  });
});
