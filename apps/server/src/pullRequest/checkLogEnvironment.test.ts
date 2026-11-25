import { describe, expect, it } from "vite-plus/test";

import { checkLogEnvironment } from "./checkLogEnvironment.ts";

describe("checkLogEnvironment", () => {
  it("clears inherited enterprise tokens when the app has no credential for the host", () => {
    const env = checkLogEnvironment("git.corp.example", null);
    expect(env.GH_HOST).toBe("git.corp.example");
    expect(env.GH_ENTERPRISE_TOKEN).toBe("");
    expect(env.GITHUB_ENTERPRISE_TOKEN).toBe("");
    expect(env).not.toHaveProperty("GH_TOKEN");
  });

  it("hands the app's own token to the variable gh reads for the host", () => {
    expect(checkLogEnvironment("git.corp.example", "enterprise-placeholder")).toMatchObject({
      GH_ENTERPRISE_TOKEN: "enterprise-placeholder",
      GITHUB_ENTERPRISE_TOKEN: "",
    });
    expect(checkLogEnvironment("github.com", "dotcom-placeholder")).toMatchObject({
      GH_TOKEN: "dotcom-placeholder",
      GH_ENTERPRISE_TOKEN: "",
      GITHUB_ENTERPRISE_TOKEN: "",
    });
  });
});
