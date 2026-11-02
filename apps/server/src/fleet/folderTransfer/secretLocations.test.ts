// @effect-diagnostics nodeBuiltinImport:off - disposable scratch folders only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  isHomeSecretPathRefused,
  isUntrackedSecretConfigPath,
} from "../../workspace/WorkspaceSensitivePaths.ts";
import { classifyFile } from "./classify.ts";
import {
  cleanSecretPatterns,
  findSecretLocations,
  homeSecretRelative,
  isDotnetUserSecretsFile,
  platformHomePath,
  secretPatternMatcher,
  secretPatternProblem,
} from "./secretLocations.ts";

let base: string;
let root: string;
let home: string;
beforeEach(() => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-locations-")));
  root = NodePath.join(base, "project");
  home = NodePath.join(base, "home");
  NodeFS.mkdirSync(root, { recursive: true });
  NodeFS.mkdirSync(home, { recursive: true });
});
afterEach(() => NodeFS.rmSync(base, { recursive: true, force: true }));

const write = (folder: string, relative: string, text: string) => {
  const absolute = NodePath.join(folder, relative);
  NodeFS.mkdirSync(NodePath.dirname(absolute), { recursive: true });
  NodeFS.writeFileSync(absolute, text);
};
const file = (path: string, size = 10, fileClass: "secret" | "untracked" = "untracked") => ({
  path,
  type: "file" as const,
  size,
  class: fileClass,
});

describe("stack secret files", () => {
  it.each([
    "local.settings.json",
    "app/gradle.properties",
    "android/app/google-services.json",
    "ios/GoogleService-Info.plist",
    "web/local_settings.py",
    "config/prod.secret.exs",
    ".Renviron",
    ".rbenv-vars",
  ])("treats an untracked %s as a secret", (path) => {
    expect(isUntrackedSecretConfigPath(path)).toBe(true);
    expect(classifyFile({ relative: path, insideGitData: false, gitState: "untracked" })).toBe(
      "secret",
    );
  });

  it("keeps tracked stack files as ordinary work", () => {
    expect(
      classifyFile({ relative: "gradle.properties", insideGitData: false, gitState: "tracked" }),
    ).toBe("tracked");
  });
});

describe("Secret files patterns", () => {
  const matches = secretPatternMatcher([
    "*.local.json",
    "config/keys/",
    "/deploy/token.txt",
    "**/vault/*.yml",
    "~/.config/acme/token.json",
  ]);

  it("matches names at any depth, anchored paths and folders", () => {
    expect(matches("settings.local.json")).toBe(true);
    expect(matches("svc/a/settings.local.json")).toBe(true);
    expect(matches("config/keys/prod.key.txt")).toBe(true);
    expect(matches("config/keys")).toBe(false);
    expect(matches("deploy/token.txt")).toBe(true);
    expect(matches("svc/deploy/token.txt")).toBe(false);
    expect(matches("ops/vault/prod.yml")).toBe(true);
    expect(matches("vault/prod.yml")).toBe(true);
    expect(matches("README.md")).toBe(false);
  });

  it("marks a matching untracked file secret, never a tracked one", () => {
    const relative = "svc/settings.local.json";
    expect(
      classifyFile({ relative, insideGitData: false, gitState: "ignored", secretPattern: matches }),
    ).toBe("secret");
    expect(
      classifyFile({ relative, insideGitData: false, gitState: "tracked", secretPattern: matches }),
    ).toBe("tracked");
  });

  it("explains entries it cannot use and drops them", () => {
    expect(secretPatternProblem("C:\\keys\\a.pem")).toMatch(/inside the project folder/);
    expect(secretPatternProblem("~other/a.pem")).toMatch(/inside the project folder/);
    expect(secretPatternProblem("../outside.txt")).toMatch(/cannot leave/);
    expect(secretPatternProblem("~/.ssh/id_ed25519")).toMatch(/sign-ins/);
    expect(secretPatternProblem("~/.zshrc")).toMatch(/sign-ins/);
    expect(secretPatternProblem("~/.config/acme/token.json")).toBeNull();
    expect(cleanSecretPatterns([" a.txt ", "a.txt", "", "C:/abs", "~/.aws/credentials"])).toEqual([
      "a.txt",
    ]);
  });
});

describe("home secret paths", () => {
  it("refuses sign-ins, start-up files, provider homes and app homes", () => {
    for (const path of [
      ".ssh/config",
      ".SSH/config",
      ".NETRC",
      ".Claude.json",
      "Library/launchagents/x.plist",
      ".aws/credentials",
      ".zshrc",
      ".claude/settings.json",
      ".codex/auth.json",
      ".specwithcode/userdata/x",
      "Library/LaunchAgents/x.plist",
      ".local/bin/specwithcode",
      "work/.git/config",
      "a/../b",
    ])
      expect(isHomeSecretPathRefused(path), path).toBe(true);
    expect(isHomeSecretPathRefused(".microsoft/usersecrets/abc/secrets.json")).toBe(false);
    expect(isDotnetUserSecretsFile(".microsoft/usersecrets/abc/secrets.json")).toBe(true);
    expect(isDotnetUserSecretsFile(".microsoft/usersecrets/../.zshrc")).toBe(false);
    expect(isDotnetUserSecretsFile(".config/systemd/user/x.service")).toBe(false);
    expect(homeSecretRelative("~/.config/acme/token.json")).toBe(".config/acme/token.json");
    expect(homeSecretRelative("~/.ssh/id_rsa")).toBeNull();
    expect(homeSecretRelative(".env")).toBeNull();
  });

  it("keeps .NET user secrets under AppData on Windows", () => {
    expect(platformHomePath(".microsoft/usersecrets/abc/secrets.json", "win32")).toBe(
      "AppData/Roaming/Microsoft/UserSecrets/abc/secrets.json",
    );
    expect(platformHomePath(".microsoft/usersecrets/abc/secrets.json", "linux")).toBe(
      ".microsoft/usersecrets/abc/secrets.json",
    );
    expect(platformHomePath(".config/a.json", "win32")).toBe(".config/a.json");
  });
});

describe("findSecretLocations", () => {
  it("lists .NET user secrets, home Secret files and vault hints", async () => {
    write(
      root,
      "src/Api/Api.csproj",
      "<Project><PropertyGroup><UserSecretsId>api-1234</UserSecretsId></PropertyGroup></Project>",
    );
    write(
      root,
      "src/Worker/Worker.csproj",
      "<Project><PropertyGroup><UserSecretsId>worker-9</UserSecretsId></PropertyGroup></Project>",
    );
    write(home, ".microsoft/usersecrets/api-1234/secrets.json", '{"Db":"fixture"}');
    write(home, ".config/acme/token.json", "fixture-token");
    write(home, ".config/acme-dir/a.txt", "a");
    write(home, ".config/acme-dir/nested/b.txt", "bb");
    write(root, ".env", "DB=op://vault/db/password\n");
    write(root, "doppler.yaml", "setup: {}\n");
    write(root, ".sops.yaml", "creation_rules: []\n");
    const found = await findSecretLocations({
      root,
      home,
      platform: "linux",
      patterns: ["~/.config/acme/token.json", "~/.config/acme-dir/", "~/.ssh/id_rsa"],
      entries: [
        file("src/Api/Api.csproj", 90),
        file("src/Worker/Worker.csproj", 90),
        file(".env", 26, "secret"),
        file("doppler.yaml"),
        file(".sops.yaml"),
      ],
    });
    // Only .NET user secrets are copied into a home folder; other home files are listed.
    expect(found.homeFiles).toEqual([
      { path: "~/.microsoft/usersecrets/api-1234/secrets.json", size: 16 },
    ]);
    expect(found.hints.map((hint) => [hint.path, hint.source])).toEqual([
      ["~/.config/acme/token.json", "Home folder"],
      ["~/.config/acme-dir/a.txt", "Home folder"],
      ["~/.config/acme-dir/nested/b.txt", "Home folder"],
      ["src/Worker/Worker.csproj", ".NET user secrets"],
      [".env", "1Password"],
      ["doppler.yaml", "Doppler"],
      [".sops.yaml", "SOPS"],
    ]);
    expect(found.hints.find((hint) => hint.source === ".NET user secrets")?.hint).toContain(
      "worker-9",
    );
  });

  it("never follows a link out of the home folder", async () => {
    const outside = NodePath.join(base, "outside");
    write(outside, "token.json", "x");
    NodeFS.mkdirSync(NodePath.join(home, ".config"), { recursive: true });
    NodeFS.symlinkSync(outside, NodePath.join(home, ".config", "linked"));
    const found = await findSecretLocations({
      root,
      home,
      platform: "linux",
      patterns: ["~/.config/linked/token.json"],
      entries: [],
    });
    expect(found.homeFiles).toEqual([]);
  });
});
