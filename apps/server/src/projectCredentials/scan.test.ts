// @effect-diagnostics nodeBuiltinImport:off - a temp project folder with marker files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { readManifest, writeManifest } from "./manifest.ts";
import { credentialRows, remoteHost, remoteUsesSsh, scanProjectCredentials } from "./scan.ts";

let base: string;
let root: string;

const put = async (relative: string, text: string) => {
  const path = NodePath.join(root, relative);
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, text);
  return path;
};

// Built from parts, so no scanner reads this file as holding a credential.
const TOKEN = `${"gh"}p_${"t".repeat(36)}`;

beforeEach(async () => {
  base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "credentials-scan-")),
  );
  root = NodePath.join(base, "project");
  await NodeFSP.mkdir(root);
});
afterEach(async () => {
  await NodeFSP.rm(base, { recursive: true, force: true });
});

const fixture = async () => {
  await put(
    "infra/main.tf",
    `terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm" }
    hcloud  = { source = "hetznercloud/hcloud" }
  }
}
provider "azurerm" { features {} }
`,
  );
  await put("platform/wrangler.jsonc", `{ "name": "site" }`);
  await put(
    ".git/config",
    `[remote "origin"]\n\turl = https://someone:${TOKEN}@github.com/acme/app.git\n`,
  );
  const npmrc = await put(".npmrc", `//registry.npmjs.org/:_authToken=${TOKEN}\n`);
  // Unreadable on purpose: the scan must list npm from the name alone.
  await NodeFSP.chmod(npmrc, 0o000);
  await put("scripts/deploy.sh", `export KUBECONFIG=~/.kube/prod.yaml\nkubectl apply -f k8s/\n`);
  await put(".env", `HCLOUD_TOKEN=${TOKEN}\naws s3 ls\n`);
  await put("node_modules/dep/main.tf", `provider "aws" {}\n`);
  await put(".repos/upstream/deploy.sh", `gcloud auth login\n`);
};

describe("scanProjectCredentials", () => {
  it("finds each credential from names and markers, with the file that showed it", async () => {
    await fixture();
    const scan = await scanProjectCredentials(root);
    expect(Object.fromEntries(scan.found)).toEqual({
      azure: ["infra/main.tf"],
      "hetzner-cloud": ["infra/main.tf"],
      cloudflare: ["platform/wrangler.jsonc"],
      github: ["."],
      npm: [".npmrc"],
      kubernetes: ["scripts/deploy.sh"],
    });
    expect(scan.truncated).toBe(false);
  });

  it("says the project has an .npmrc, from its name alone, on the npm row only", async () => {
    await fixture();
    // The fixture's .npmrc cannot be opened: the name is all that is used.
    const scan = await scanProjectCredentials(root);
    expect(scan.registryFile).toBe(true);
    const rows = credentialRows(scan, null);
    expect(rows.find((row) => row.id === "npm")?.registryFile).toBe(true);
    for (const row of rows) if (row.id !== "npm") expect(row).not.toHaveProperty("registryFile");
  });

  it("returns no content, URL user info or absolute path", async () => {
    await fixture();
    const scan = await scanProjectCredentials(root);
    const wire = JSON.stringify(credentialRows(scan, null));
    expect(wire).not.toContain(TOKEN);
    expect(wire).not.toContain("someone");
    expect(wire).not.toContain(base);
    expect(wire).not.toContain("prod.yaml");
  });

  it("never opens a secret-classed file and skips vendored folders", async () => {
    await fixture();
    const scan = await scanProjectCredentials(root);
    // `.env` names aws and Hetzner, node_modules names aws, .repos names gcloud.
    expect(scan.found.has("aws")).toBe(false);
    expect(scan.found.has("google-cloud")).toBe(false);
    expect(scan.found.get("hetzner-cloud")).toEqual(["infra/main.tf"]);
  });

  it("does not follow a linked marker file out of the project", async () => {
    const outside = NodePath.join(base, "outside.sh");
    await NodeFSP.writeFile(outside, "aws s3 sync . s3://bucket\n");
    await NodeFSP.mkdir(NodePath.join(root, "scripts"));
    await NodeFSP.symlink(outside, NodePath.join(root, "scripts", "sync.sh"));
    expect((await scanProjectCredentials(root)).found.size).toBe(0);
  });

  it("reads workflows, a Makefile and package.json scripts", async () => {
    await put(".github/workflows/release.yml", "steps:\n  - run: npm publish\n");
    await put("Makefile", "deploy:\n\tdocker push registry.example.com/app\n");
    await put("package.json", `{ "scripts": { "ship": "wrangler deploy" } }`);
    await put("ops/hosts.sh", "ssh root@203.0.113.7 uptime\n");
    const scan = await scanProjectCredentials(root);
    expect([...scan.found.keys()].sort()).toEqual(["cloudflare", "docker", "npm", "ssh"]);
  });
});

describe("SSH targets", () => {
  it("lists where scripts and SSH remotes connect, on the ssh row only", async () => {
    await put(
      "ops/deploy.sh",
      'HOSTS=(203.0.113.10)\nfor H in "${HOSTS[@]}"; do\n  ssh "root@${H}" true\ndone\n',
    );
    await put(".git/config", `[remote "origin"]\n\turl = git@github.com:acme/app.git\n`);
    await put("fleet/add-peer.sh", '/usr/bin/ssh "${ssh_opts[@]}" "$target" true\n');
    const scan = await scanProjectCredentials(root);
    expect(scan.found.get("ssh")).toEqual([".", "ops/deploy.sh"]);
    const rows = credentialRows(scan, null);
    expect(rows.find((row) => row.id === "ssh")).toMatchObject({
      sshTargetsMore: false,
      sshTargets: [
        { kind: "git", user: "git", host: "github.com", variable: null, source: "." },
        {
          kind: "server",
          user: "root",
          host: "203.0.113.10",
          variable: "H",
          source: "ops/deploy.sh",
        },
      ],
    });
    expect(rows.find((row) => row.id === "github")).not.toHaveProperty("sshTargets");
  });

  it("has no ssh row for a project whose only match was an array expansion", async () => {
    await put("fleet/add-peer.sh", '/usr/bin/ssh "${ssh_opts[@]}" "$target" true\n');
    await put(".git/config", `[remote "origin"]\n\turl = https://github.com/acme/app.git\n`);
    const scan = await scanProjectCredentials(root);
    expect(scan.found.has("ssh")).toBe(false);
    expect(scan.sshTargets).toEqual([]);
  });

  it("keeps the row, without a place, for a script whose host cannot be read", async () => {
    await put("ops/v6.sh", "ssh root@[2001:db8::1] true\n");
    const scan = await scanProjectCredentials(root);
    expect(scan.found.get("ssh")).toEqual(["ops/v6.sh"]);
    expect(credentialRows(scan, null).find((row) => row.id === "ssh")).toMatchObject({
      sshTargets: [],
      sshTargetsMore: false,
    });
  });

  it("says when the project connects to more places than it lists", async () => {
    for (const name of ["a", "b"])
      await put(
        `ops/${name}.sh`,
        Array.from({ length: 8 }, (_, index) => `ssh root@${name}${index}.example.com true`).join(
          "\n",
        ),
      );
    const scan = await scanProjectCredentials(root);
    expect(scan.sshTargets).toHaveLength(12);
    expect(scan.sshTargetsMore).toBe(true);
  });

  it("drops a target whose file name carries direction marks", async () => {
    await put("ops/\u202Edeploy.sh", "ssh root@203.0.113.10 true\n");
    const scan = await scanProjectCredentials(root);
    expect(scan.sshTargets).toEqual([]);
    expect(scan.found.has("ssh")).toBe(false);
  });
});

describe("tools a project brings itself", () => {
  it("names the folders whose package.json lists a credential's tool, on that row only", async () => {
    await put("wrangler.jsonc", `{ "name": "top" }`);
    await put("package.json", JSON.stringify({ scripts: { ship: "wrangler deploy" } }));
    await put(
      "repositories/acme/platform/package.json",
      JSON.stringify({ devDependencies: { wrangler: "^4.0.0" } }),
    );
    await put("apps/site/package.json", JSON.stringify({ dependencies: { wrangler: "4" } }));
    // A vendored copy says nothing about the project.
    await put(
      "node_modules/wrangler/package.json",
      JSON.stringify({ dependencies: { wrangler: "4" } }),
    );
    const scan = await scanProjectCredentials(root);
    expect([...(scan.packages.get("cloudflare") ?? [])].sort()).toEqual([
      "apps/site",
      "repositories/acme/platform",
    ]);
    const rows = credentialRows(scan, null);
    expect([...(rows.find((row) => row.id === "cloudflare")?.packages ?? [])].sort()).toEqual([
      "apps/site",
      "repositories/acme/platform",
    ]);
    for (const row of rows) if (row.id !== "cloudflare") expect(row).not.toHaveProperty("packages");
  });

  it("says the top folder as a dot, and keeps the list short", async () => {
    await put("package.json", JSON.stringify({ devDependencies: { wrangler: "4" } }));
    for (const name of ["a", "b", "c", "d"])
      await put(`${name}/package.json`, JSON.stringify({ devDependencies: { wrangler: "4" } }));
    const folders = (await scanProjectCredentials(root)).packages.get("cloudflare") ?? [];
    expect(folders).toHaveLength(3);
    expect(folders).toContain(".");
  });

  it("leaves the field out for a project that lists no such tool", async () => {
    await fixture();
    const rows = credentialRows(await scanProjectCredentials(root), null);
    for (const row of rows) expect(row).not.toHaveProperty("packages");
  });
});

describe("Git hosts reached over SSH", () => {
  it("names the known hosts a repository fetches from over SSH, on the ssh row", async () => {
    await put(
      ".git/config",
      `[remote "origin"]\n\turl = git@github.com:acme/app.git\n[remote "mirror"]\n\turl = ssh://git@gitlab.com/acme/app.git\n`,
    );
    await put(
      "repositories/acme/tool/.git/config",
      `[remote "origin"]\n\turl = git@git.example.com:acme/tool.git\n`,
    );
    const scan = await scanProjectCredentials(root);
    expect(scan.sshHosts).toEqual(["github.com", "gitlab.com"]);
    // Every SSH remote puts the project on the ssh row; only the known hosts can be checked.
    expect(scan.found.get("ssh")).toEqual([".", "repositories/acme/tool"]);
    const rows = credentialRows(scan, null);
    expect(rows.find((row) => row.id === "ssh")?.sshHosts).toEqual(["github.com", "gitlab.com"]);
    for (const row of rows) if (row.id !== "ssh") expect(row).not.toHaveProperty("sshHosts");
  });

  it("names none for a repository fetched over https", async () => {
    await put(".git/config", `[remote "origin"]\n\turl = https://github.com/acme/app.git\n`);
    const scan = await scanProjectCredentials(root);
    expect(scan.sshHosts).toEqual([]);
    expect(scan.found.has("ssh")).toBe(false);
    expect(scan.registryFile).toBe(false);
    for (const row of credentialRows(scan, null)) {
      expect(row).not.toHaveProperty("sshHosts");
      expect(row).not.toHaveProperty("registryFile");
    }
  });

  it("tells an SSH remote from any other", () => {
    for (const url of [
      "git@github.com:acme/app.git",
      "ssh://git@github.com/acme/app.git",
      "git+ssh://git@github.com/acme/app.git",
    ])
      expect(remoteUsesSsh(url), url).toBe(true);
    for (const url of [
      "https://github.com/acme/app.git",
      "http://github.com/acme/app",
      "git://github.com/acme/app.git",
      "/srv/git/app.git",
      "",
    ])
      expect(remoteUsesSsh(url), url).toBe(false);
  });
});

describe("remoteHost", () => {
  it("keeps the host and drops everything else", () => {
    expect(remoteHost("https://user:secret@github.com/acme/app.git")).toBe("github.com");
    expect(remoteHost("git@github.com:acme/app.git")).toBe("github.com");
    expect(remoteHost("ssh://git@ssh.dev.azure.com:22/v3/acme/app")).toBe("ssh.dev.azure.com");
    expect(remoteHost("/srv/git/app.git")).toBeNull();
    expect(remoteHost("C:/repos/app")).toBeNull();
    expect(remoteHost("../sibling")).toBeNull();
  });
});

describe("credentialRows with a saved manifest", () => {
  it("merges the scan with the saved skips, notes and manifest-only entries", async () => {
    await fixture();
    await writeManifest(root, {
      version: 1,
      credentials: [
        { id: "azure", skip: true },
        { id: "aws", note: "release bucket" },
      ],
    });
    const saved = await readManifest(root);
    if (saved === null || !saved.ok) throw new Error("manifest not read");
    const rows = credentialRows(await scanProjectCredentials(root), saved.manifest);
    expect(rows.map((row) => row.id)).toEqual([
      "github",
      "azure",
      "aws",
      "kubernetes",
      "hetzner-cloud",
      "cloudflare",
      "npm",
    ]);
    expect(rows.find((row) => row.id === "azure")).toMatchObject({
      listed: true,
      skip: true,
      sources: ["infra/main.tf"],
    });
    expect(rows.find((row) => row.id === "aws")).toEqual({
      id: "aws",
      kind: "login",
      sources: [],
      listed: true,
      skip: false,
      note: "release bucket",
      keptIn: [".aws/credentials", ".aws/config"],
    });
    expect(rows.find((row) => row.id === "github")).toMatchObject({ listed: false, skip: false });
  });
});
