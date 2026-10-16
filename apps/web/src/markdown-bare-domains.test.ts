import { describe, expect, it } from "vite-plus/test";

import { bareDomainSegments } from "./markdown-bare-domains";

const links = (text: string) =>
  bareDomainSegments(text)
    .filter((segment) => segment.type === "link")
    .map((segment) => segment.value);

describe("bareDomainSegments", () => {
  it("links bare domains and paths, without trailing punctuation", () => {
    expect(links("spec-weave.com/pricing sells Pro, see verified-skill.com.")).toEqual([
      "spec-weave.com/pricing",
      "verified-skill.com",
    ]);
    expect(links("X @PaulRBerg, github.com/PaulRBerg")).toEqual(["github.com/PaulRBerg"]);
  });

  it("leaves file names, versions, emails and URLs alone", () => {
    expect(
      links("Node.js, index.ts, v1.2.3, me@example.com, https://a.com and www.b.com, e.g. this"),
    ).toEqual([]);
  });
});
