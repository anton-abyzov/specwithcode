import { describe, expect, it } from "vite-plus/test";
import {
  groupSkillPresences,
  safeSkillLink,
  skillBody,
  skillDescriptionParts,
} from "./SkillDetail.logic";
import { skillCopyDiff } from "./SkillCopyCompare";
describe("skill detail source content", () => {
  it("uses source excerpts without inventing guidance", () => {
    expect(
      skillDescriptionParts("Render `images`.\n\nUse when making assets.\n\nMore instructions.")
        .usage,
    ).toBe("Use when making assets.");
    expect(skillDescriptionParts("A plain description").usage).toBeNull();
    const long = "Detailed ".repeat(50) + "instructions.";
    expect(skillDescriptionParts(long).summary).toBe(long);
  });
  it("rejects executable and relative links", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///tmp/a",
      "/private",
      "//other.test",
    ])
      expect(safeSkillLink(url)).toBe("");
    expect(safeSkillLink("https://example.com/help")).toBe("https://example.com/help");
  });
  it("groups paths once while retaining every agent and scope", () => {
    const rows = [
      { path: "/skills/a", scope: "user", instanceId: "a" },
      { path: "/skills/a", scope: "user", instanceId: "b" },
      { path: "/skills/a", scope: "project", instanceId: "c" },
    ];
    const groups = groupSkillPresences(rows as never);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.presences).toHaveLength(2);
  });
  it("strips only opening frontmatter and computes both sides of changes", () => {
    expect(skillBody("---\nname: a\n---\n# Heading\n---\nBody")).toBe("# Heading\n---\nBody");
    expect(skillCopyDiff("first\nold\nlast", "first\nnew\nlast")).toEqual([
      { kind: "same", text: "first" },
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
      { kind: "same", text: "last" },
    ]);
    expect(skillCopyDiff("a", "b")).toHaveLength(2);
  });
});
