// @effect-diagnostics nodeBuiltinImport:off - disposable scratch folders only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { isUntrackedSecretConfigPath } from "../../workspace/WorkspaceSensitivePaths.ts";
import { scanFolder } from "./manifest.ts";
import {
  isVendoredPath,
  MAX_CONTENT_PROBES,
  readEnvrc,
  refineClassByContent,
  tokenKind,
} from "./secretContent.ts";
import { findSecretLocations } from "./secretLocations.ts";

// Built at run time so no fixture reads as a real credential to a secret scanner.
const AWS_KEY = `AKIA${"Q".repeat(16)}`;
const GITHUB_TOKEN = `ghp_${"a1".repeat(18)}`;

let base: string;
let root: string;
beforeEach(() => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-content-")));
  root = NodePath.join(base, "project");
  NodeFS.mkdirSync(NodePath.join(base, "home"), { recursive: true });
  NodeFS.mkdirSync(root, { recursive: true });
});
afterEach(() => NodeFS.rmSync(base, { recursive: true, force: true }));

const write = (relative: string, text: string) => {
  const absolute = NodePath.join(root, relative);
  NodeFS.mkdirSync(NodePath.dirname(absolute), { recursive: true });
  NodeFS.writeFileSync(absolute, text);
};
const file = (path: string, fileClass: "secret" | "untracked" | "tracked" = "tracked") => ({
  path,
  type: "file" as const,
  size: NodeFS.statSync(NodePath.join(root, path)).size,
  class: fileClass,
});

describe("stack secret files across ecosystems", () => {
  it.each([
    "serviceAccountKey.json",
    "keys/acme-firebase-adminsdk-x1y2-0a1b2c.json",
    ".yarnrc.yml",
    ".yarnrc",
    "pip.conf",
    ".mvn/settings-security.xml",
    ".terraformrc",
    "terraform.rc",
    ".sentryclirc",
    "site/wp-config.php",
    ".vault_pass",
    "ansible/vault-password.txt",
    "ios/Profiles/App.mobileprovision",
    "ios/Secrets.xcconfig",
    "ios/App.secrets.xcconfig",
    "keys/server.ppk",
    "Passwords.kdbx",
    "vpn/office.ovpn",
    ".bundle/config",
    "api/instance/config.py",
    "mysite/settings/local.py",
    "config/database.yml",
    "config/application.yml",
  ])("treats an untracked %s as a secret", (path) => {
    expect(isUntrackedSecretConfigPath(path)).toBe(true);
  });

  it.each(["config.py", "settings.py", "config/routes.rb", "bundle/config.js", "package.json"])(
    "leaves %s alone",
    (path) => expect(isUntrackedSecretConfigPath(path)).toBe(false),
  );
});

describe("readEnvrc", () => {
  it("finds nothing in a Nix or layout-only .envrc", () => {
    expect(readEnvrc("use flake\n")).toEqual({ holdsValues: false, loads: [] });
    expect(
      readEnvrc(
        "# dev shell\nuse nix\nlayout python3\nPATH_add bin\nexport ROOT=$(pwd)\nsource_up\n",
      ),
    ).toEqual({ holdsValues: false, loads: [] });
  });

  it("names where secrets are loaded from", () => {
    expect(readEnvrc("dotenv .env.local\n").loads).toEqual(["a .env file"]);
    expect(readEnvrc("source_env_if_exists .envrc.private\n").loads).toEqual(["another env file"]);
    expect(readEnvrc("source_env ../.envrc\n").loads).toEqual([]);
    expect(readEnvrc("source_env secrets.sh\n").loads).toEqual(["another env file"]);
    expect(readEnvrc('export OPENAI_API_KEY="$(op read op://dev/openai/key)"\n').loads).toEqual([
      "1Password",
    ]);
    expect(readEnvrc("export GITHUB_TOKEN=$(gh auth token)\n").loads).toEqual(["a command"]);
    expect(readEnvrc('eval "$(doppler secrets download --format env)"\n').loads).toEqual([
      "Doppler",
    ]);
  });

  it("sees a value it holds itself", () => {
    expect(readEnvrc("export STRIPE_SECRET=sk_test_fixture\n").holdsValues).toBe(true);
    expect(readEnvrc(`export AWS_ACCESS_KEY_ID=${AWS_KEY}\n`).holdsValues).toBe(true);
    expect(readEnvrc("export DATABASE_URL=postgres://u:p@localhost/db\n").holdsValues).toBe(true);
    expect(readEnvrc("export API_KEY=$SHARED_KEY\nexport PORT=3000\n").holdsValues).toBe(false);
  });
});

describe("tokenKind", () => {
  it("knows well-known token formats and nothing else", () => {
    expect(tokenKind(`{"key":"${AWS_KEY}"}`)).toBe("AWS access key");
    expect(tokenKind(`token: ${GITHUB_TOKEN}`)).toBe("GitHub token");
    expect(tokenKind("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe("private key");
    expect(tokenKind('{"name":"app","version":"1.0.0","sha":"0123456789abcdef"}')).toBeNull();
  });
});

describe("isVendoredPath", () => {
  it("covers vendored folders and submodules, not the project itself", () => {
    expect(isVendoredPath(".repos/effect-smol/.envrc")).toBe(true);
    expect(isVendoredPath("web/node_modules/pkg/.envrc")).toBe(true);
    expect(isVendoredPath("vendor/bundle/ruby/doppler.yaml")).toBe(true);
    expect(isVendoredPath("libs/upstream/.envrc", ["libs/upstream"])).toBe(true);
    expect(isVendoredPath(".envrc", ["."])).toBe(false);
    expect(isVendoredPath("apps/api/.envrc")).toBe(false);
  });
});

describe("refineClassByContent", () => {
  const refine = (relative: string, fileClass: "secret" | "untracked" | "ignoredData") =>
    refineClassByContent({
      absolute: NodePath.join(root, relative),
      relative,
      size: NodeFS.statSync(NodePath.join(root, relative)).size,
      fileClass,
      gitState: fileClass === "ignoredData" ? "ignored" : "untracked",
      budget: { probes: 0 },
    });

  it("copies a plain .envrc as an ordinary file and keeps one with values a secret", async () => {
    write(".envrc", "use flake\n");
    write("api/.envrc", "export API_TOKEN=fixture-value\n");
    expect(await refine(".envrc", "secret")).toBe("untracked");
    expect(await refine("api/.envrc", "secret")).toBe("secret");
  });

  it("makes a config file with a token a secret", async () => {
    write("deploy/settings.json", `{"aws":"${AWS_KEY}"}`);
    write("deploy/plain.json", '{"region":"us-east-1"}');
    write("notes.md", `key ${AWS_KEY}`);
    expect(await refine("deploy/settings.json", "ignoredData")).toBe("secret");
    expect(await refine("deploy/plain.json", "ignoredData")).toBe("ignoredData");
    // Only config-like names are read.
    expect(await refine("notes.md", "untracked")).toBe("untracked");
  });

  it("stops reading once the budget is spent", async () => {
    write("a.json", `{"aws":"${AWS_KEY}"}`);
    const result = await refineClassByContent({
      absolute: NodePath.join(root, "a.json"),
      relative: "a.json",
      size: 40,
      fileClass: "untracked",
      gitState: "untracked",
      budget: { probes: MAX_CONTENT_PROBES },
    });
    expect(result).toBe("untracked");
  });
});

describe("scanFolder content classes", () => {
  it("classes .envrc files by what they hold and finds tokens in untracked config", async () => {
    write(".envrc", "use flake\n");
    write("svc/.envrc", "export SLACK_TOKEN=fixture-value\n");
    write("config/local.json", `{"token":"${GITHUB_TOKEN}"}`);
    const scan = await scanFolder(root);
    const classOf = (path: string) => scan.entries.find((entry) => entry.path === path)?.class;
    expect(classOf(".envrc")).toBe("untracked");
    expect(classOf("svc/.envrc")).toBe("secret");
    expect(classOf("config/local.json")).toBe("secret");
  });
});

describe("findSecretLocations and direnv", () => {
  const locate = (entries: ReturnType<typeof file>[], submodules?: string[]) =>
    findSecretLocations({
      root,
      home: NodePath.join(base, "home"),
      platform: "linux",
      entries,
      ...(submodules ? { submodules } : {}),
    });

  it("says nothing about vendored checkouts and submodules", async () => {
    write(".repos/effect-smol/.envrc", "use flake\n");
    write(".repos/effect-smol/doppler.yaml", "setup: {}\n");
    write("libs/upstream/.envrc", 'eval "$(doppler secrets download)"\n');
    const found = await locate(
      [
        file(".repos/effect-smol/.envrc"),
        file(".repos/effect-smol/doppler.yaml"),
        file("libs/upstream/.envrc"),
      ],
      ["libs/upstream"],
    );
    expect(found.hints).toEqual([]);
    expect(found.notes).toEqual([]);
  });

  it("lists only an .envrc that loads secrets from a vault or command, and notes direnv allow", async () => {
    write(".envrc", "use flake\ndotenv\n");
    write("api/.envrc", "export OPENAI_API_KEY=$(op read op://dev/openai/key)\n");
    write("web/.envrc", "export GH_TOKEN=$(gh auth token)\n");
    const found = await locate([
      file(".envrc", "untracked"),
      file("api/.envrc", "untracked"),
      file("web/.envrc", "untracked"),
    ]);
    expect(found.hints.map((hint) => [hint.path, hint.source, hint.hint])).toEqual([
      [
        "api/.envrc",
        "direnv",
        "Loads secrets from 1Password. The values stay there; set them up on the other machine, then run direnv allow.",
      ],
      [
        "web/.envrc",
        "direnv",
        "Loads secrets from a command. The values stay there; set them up on the other machine, then run direnv allow.",
      ],
    ]);
    expect(found.notes).toEqual(["direnv: run direnv allow on the other machine in ., api, web."]);
  });
});
