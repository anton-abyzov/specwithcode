import { describe, expect, it } from "vite-plus/test";

import { isVersionAtLeast } from "./SkillUpdate.ts";
import { isGitHubReadUrl, openLinkCommand } from "./SkillUpdateRpc.ts";

describe("anonymous repo reads", () => {
  it("asks only GitHub's API and raw-file hosts, over https", () => {
    expect(isGitHubReadUrl("https://api.github.com/repos/owner/repo")).toBe(true);
    expect(isGitHubReadUrl("https://raw.githubusercontent.com/owner/repo/abc/SKILL.md")).toBe(true);
    for (const url of [
      "https://verified-skill.com/api/v1/skills/owner/repo/skill",
      "https://www.verified-skill.com/",
      "http://api.github.com/repos/owner/repo",
      "https://api.github.com.example.org/repos/owner/repo",
      "https://api.github.com@example.org/repos/owner/repo",
      "https://github.com/owner/repo",
      "file:///etc/passwd",
      "not a url",
    ])
      expect(isGitHubReadUrl(url), url).toBe(false);
  });
});

describe("opening a note", () => {
  it("hands the link to the system opener as one argument, with no shell", () => {
    const url = "obsidian://open?vault=notes&file=A%20%26%20B";
    expect(openLinkCommand("darwin", url)).toEqual({ command: "open", args: [url] });
    expect(openLinkCommand("linux", url)).toEqual({ command: "xdg-open", args: [url] });
    expect(openLinkCommand("win32", url)).toEqual({
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });
});

describe("vskill version gate", () => {
  it("compares release versions by number", () => {
    expect(isVersionAtLeast("1.2.10", "1.2.10")).toBe(true);
    expect(isVersionAtLeast("1.2.14", "1.2.10")).toBe(true);
    expect(isVersionAtLeast("1.10.0", "1.2.10")).toBe(true);
    expect(isVersionAtLeast("1.2.9", "1.2.10")).toBe(false);
    expect(isVersionAtLeast("0.9.99", "1.2.10")).toBe(false);
    expect(isVersionAtLeast("garbage", "1.2.10")).toBe(false);
  });
});
