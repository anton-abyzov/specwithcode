import { describe, expect, it } from "vite-plus/test";
import {
  nextSkillPatchVersion,
  skillAuthoringSeedFromMarkdown,
  skillAuthoringMarkdown,
} from "./skillAuthoringSeed";

describe("skill edit import", () => {
  it("reads quoted code and multiline usage with metadata version", () => {
    expect(
      skillAuthoringSeedFromMarkdown(
        '---\nname: review-code\ndescription: >-\n  Review `changes`\n  before release.\nmetadata:\n  version: "1.2.3"\n---\n\n# Instructions\nKeep $1 literal.',
        "fallback",
      ),
    ).toMatchObject({
      content: {
        name: "review-code",
        description: "Review `changes` before release.",
        version: "1.2.3",
        instructions: "# Instructions\nKeep $1 literal.",
        prompt: "",
      },
    });
  });
  it("refuses duplicate keys rather than importing ambiguous instructions", () => {
    expect(
      skillAuthoringSeedFromMarkdown("---\nname: first\nname: second\n---\nbody", "fallback"),
    ).toHaveProperty("error");
  });
  it("preserves custom headers and nested metadata through version edits", () => {
    const raw =
      "---\nname: check\ndescription: Check changes\nallowed-tools: [Read, Bash]\nmodel: fast\nmetadata:\n  version: 1.2.3\n  team:\n    owner: example\n    tags: [review, safe]\n---\n# Instructions\nRead everything.";
    const parsed = skillAuthoringSeedFromMarkdown(raw, "fallback");
    if (!("content" in parsed)) throw new Error(parsed.error);
    expect(parsed.content.sourceFrontmatter).toContain("allowed-tools: [Read, Bash]");
    const edited = { ...parsed.content, description: "Updated description", version: "1.2.4" };
    const again = skillAuthoringSeedFromMarkdown(skillAuthoringMarkdown(edited), "fallback");
    expect(again).toMatchObject({
      content: { name: "check", version: "1.2.4", description: "Updated description" },
    });
    if (!("content" in again)) throw new Error(again.error);
    expect(again.content.sourceFrontmatter).toContain("owner: example");
    expect(again.content.sourceFrontmatter).toContain("allowed-tools:");
    expect(again.content.sourceFrontmatter).toContain("model: fast");
  });
  it("refuses unterminated frontmatter", () => {
    expect(skillAuthoringSeedFromMarkdown("---\nname: test", "fallback")).toHaveProperty("error");
  });
  it("keeps plain Markdown for manual import", () => {
    expect(skillAuthoringSeedFromMarkdown("# Use\n\nDo the thing.", "new-skill")).toHaveProperty(
      "content.instructions",
      "# Use\n\nDo the thing.",
    );
  });
  it("suggests a version without automatically changing one", () => {
    expect(nextSkillPatchVersion("1.2.3")).toBe("1.2.4");
    expect(nextSkillPatchVersion("local")).toBeNull();
  });
});
