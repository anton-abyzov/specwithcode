import { describe, expect, it } from "vite-plus/test";
import { nextSkillPatchVersion, skillAuthoringSeedFromMarkdown } from "./skillAuthoringSeed";

describe("skill edit import", () => {
  it("reads quoted code and multiline usage with metadata version", () => {
    expect(
      skillAuthoringSeedFromMarkdown(
        '---\nname: review-code\ndescription: >-\n  Review `changes`\n  before release.\nmetadata:\n  version: "1.2.3"\n---\n\n# Instructions\nKeep $1 literal.',
        "fallback",
      ),
    ).toEqual({
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
  it("does not drop unsupported frontmatter", () => {
    expect(
      skillAuthoringSeedFromMarkdown(
        "---\nname: check\nallowed-tools: Bash\n---\nbody",
        "fallback",
      ),
    ).toHaveProperty("error", expect.stringContaining("allowed-tools"));
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
