// @effect-diagnostics nodeBuiltinImport:off -- Tests lay out real project folders with node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, assert, it } from "@effect/vitest";

import type { SensitivePathGuard } from "../../workspace/WorkspaceSensitivePaths.ts";
import { readKnowledgeFile, scanKnowledgeFiles } from "./knowledgeSources.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
});

const workspace = (files: Record<string, string>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "knowledge-sources-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, path), content);
  }
  return root;
};

const guard = (
  denied: (path: string) => boolean,
  protectedIdentity = false,
): SensitivePathGuard => ({
  isDenied: denied,
  setProviderHomes: () => undefined,
  setWorktreesDirectories: () => undefined,
  matchesProtectedIdentity: async () => false,
  isProtectedFileIdentity: async () => protectedIdentity,
  isInsideDeniedFolder: () => false,
});

it("leaves out protected files by name and refuses one by the identity of the opened file", async () => {
  const root = workspace({
    ".specweave/docs/a.md": "plain notes",
    ".specweave/docs/secret.md": "protected",
  });
  const { files, complete } = await scanKnowledgeFiles(
    root,
    guard((path) => path.endsWith("secret.md")),
  );
  assert.isTrue(complete, "a refused file is an answer, not a failed read");
  assert.deepEqual(
    files.map((file) => file.location),
    [".specweave/docs/a.md"],
  );
  assert.deepEqual(
    await readKnowledgeFile(
      files[0]!,
      guard(() => false, true),
    ),
    {
      type: "skipped",
      reason: "unreadable",
    },
  );
  assert.deepEqual(
    await readKnowledgeFile(
      files[0]!,
      guard(() => false),
    ),
    {
      type: "text",
      content: "plain notes",
    },
  );
  assert.deepEqual(
    await readKnowledgeFile(
      files[0]!,
      guard((path) => path.endsWith("a.md")),
    ),
    { type: "skipped", reason: "unreadable" },
    "a path protected since the scan is refused at read time",
  );
});

it("keeps docs ahead of reports and increments, and archived increments last", async () => {
  const root = workspace({
    ".specweave/increments/_archive/0001-old/spec.md": "archived",
    ".specweave/increments/0002-new/spec.md": "current",
    ".specweave/reports/r.md": "report",
    ".specweave/docs/d.md": "doc",
    ".specweave/memory/m.md": "memory",
  });
  // The archived increment is the newest file, and still goes last.
  const now = 1_790_000_000;
  for (const [index, path] of [
    ".specweave/docs/d.md",
    ".specweave/memory/m.md",
    ".specweave/reports/r.md",
    ".specweave/increments/0002-new/spec.md",
    ".specweave/increments/_archive/0001-old/spec.md",
  ].entries())
    NodeFS.utimesSync(NodePath.join(root, path), now - 100 + index, now - 100 + index);
  const { files } = await scanKnowledgeFiles(
    root,
    guard(() => false),
  );
  assert.deepEqual(
    files.map((file) => file.location),
    [
      ".specweave/docs/d.md",
      ".specweave/memory/m.md",
      ".specweave/reports/r.md",
      ".specweave/increments/0002-new/spec.md",
      ".specweave/increments/_archive/0001-old/spec.md",
    ],
  );
});

it("says when it could not read the whole project, so missing files are not taken as deleted", async () => {
  const gone = await scanKnowledgeFiles(
    NodePath.join(NodeOS.tmpdir(), "knowledge-sources-missing", "project"),
    guard(() => false),
  );
  assert.deepEqual(gone, { files: [], complete: false }, "an unreachable folder");

  const corrupt = workspace({
    ".specweave/docs/d.md": "doc",
    ".specweave/project/hub.json": "{ not json",
  });
  const hub = await scanKnowledgeFiles(
    corrupt,
    guard(() => false),
  );
  assert.isFalse(hub.complete, "an unreadable hub may still list artifacts");
  assert.deepEqual(
    hub.files.map((file) => file.location),
    [".specweave/docs/d.md"],
  );

  const locked = workspace({
    ".specweave/docs/d.md": "doc",
    ".specweave/reports/sealed/r.md": "report",
  });
  const sealed = NodePath.join(locked, ".specweave/reports/sealed");
  NodeFS.chmodSync(sealed, 0o000);
  try {
    const folder = await scanKnowledgeFiles(
      locked,
      guard(() => false),
    );
    assert.isFalse(folder.complete, "a folder that failed to list");
    assert.deepEqual(
      folder.files.map((file) => file.location),
      [".specweave/docs/d.md"],
    );
  } finally {
    NodeFS.chmodSync(sealed, 0o700);
  }
});
