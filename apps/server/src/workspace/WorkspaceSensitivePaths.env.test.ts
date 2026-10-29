import { expect, it } from "vite-plus/test";
import { isSecretLikeProjectPath } from "./WorkspaceSensitivePaths.ts";
import { classifyFile } from "../fleet/folderTransfer/classify.ts";
it.each([
  "scripts/.cf-monitor.env",
  "config/service.env",
  "config/service.env.production",
  ".env",
  ".env.local",
  ".envrc",
  "config/APP.ENV.PRODUCTION",
])("requires opt-in for untracked %s", (relative) => {
  expect(isSecretLikeProjectPath(relative)).toBe(true);
  expect(classifyFile({ relative, insideGitData: false, gitState: "untracked" })).toBe("secret");
  expect(classifyFile({ relative, insideGitData: false, gitState: "tracked" })).toBe("tracked");
});
it.each([
  ".env.example",
  ".env.local.sample",
  "service.env.example",
  "service.env.production.template",
  "config/service.environment",
  "config/environment.ts",
  "env.ts",
])("preserves template or ordinary file %s", (relative) => {
  expect(isSecretLikeProjectPath(relative)).toBe(false);
});
