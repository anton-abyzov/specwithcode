// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { addProjectLibraryArtifact, readProjectLibrary } from "./ProjectLibrary.ts";

const roots: string[] = [];
async function project(options: { specweave?: boolean; hub?: unknown } = {}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-library-"));
  roots.push(root);
  if (options.specweave !== false) {
    await NodeFSP.mkdir(NodePath.join(root, ".specweave/project"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, ".specweave/config.json"), "{}");
  }
  if (options.hub !== undefined) {
    await NodeFSP.writeFile(
      NodePath.join(root, ".specweave/project/hub.json"),
      JSON.stringify(options.hub, null, 2),
    );
  }
  return root;
}
const hub = (artifacts: unknown[] = [], revision = 3) => ({
  version: 1,
  revision,
  updatedAt: "2026-09-22T03:46:26.988Z",
  name: "SpecWeave workspace",
  goal: "Ship",
  context: "",
  artifacts,
  routines: [],
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("readProjectLibrary", () => {
  it("lists hub artifacts with their file state and the SpecWeave folders that exist", async () => {
    const root = await project({
      hub: hub([
        {
          id: "a",
          title: "Video analysis",
          location: ".specweave/reports/video.md",
          kind: "file",
          intentId: null,
          createdAt: "2026-09-22T03:46:26.987Z",
        },
        {
          id: "b",
          title: "Gone",
          location: "missing.md",
          kind: "file",
          intentId: null,
          createdAt: "2026-09-22T03:46:26.987Z",
        },
        {
          id: "c",
          title: "Docs site",
          location: "https://spec-weave.com/",
          kind: "link",
          intentId: null,
          createdAt: "2026-09-22T03:46:26.987Z",
        },
      ]),
    });
    await NodeFSP.mkdir(NodePath.join(root, ".specweave/reports"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, ".specweave/reports/video.md"), "# Video\n");

    const library = await readProjectLibrary(root);

    expect(library.specweave).toBe(true);
    expect(library.hub).toEqual({
      name: "SpecWeave workspace",
      revision: 3,
      updatedAt: "2026-09-22T03:46:26.988Z",
    });
    expect(library.artifacts.map((item) => [item.id, item.missing, item.byteLength])).toEqual([
      ["a", false, 8],
      ["b", true, undefined],
      ["c", false, undefined],
    ]);
    expect(library.folders.map((folder) => folder.label)).toEqual(["Reports"]);
  });

  it("reports a corrupt hub instead of failing the Library", async () => {
    const root = await project();
    await NodeFSP.writeFile(NodePath.join(root, ".specweave/project/hub.json"), "{nope");
    const library = await readProjectLibrary(root);
    expect(library.hub).toBeNull();
    expect(library.hubProblem).toMatch(/corrupt/);
  });

  it("treats a folder without SpecWeave as an empty Library", async () => {
    const root = await project({ specweave: false });
    const library = await readProjectLibrary(root);
    expect(library).toMatchObject({ specweave: false, hub: null, artifacts: [], folders: [] });
  });
});

describe("readProjectLibrary safety", () => {
  const link = (id: string, location: string) => ({
    id,
    title: id,
    location,
    kind: "link",
    intentId: null,
    createdAt: "2026-09-22T03:46:26.988Z",
  });

  it("never offers a link that is not plain HTTPS, and lists a repeated id once", async () => {
    const root = await project({
      hub: hub([
        link("00000000-0000-4000-8000-000000000001", "javascript:alert(1)"),
        link("00000000-0000-4000-8000-000000000002", "https://user:pw@example.com/"),
        link("00000000-0000-4000-8000-000000000003", "https://spec-weave.com/"),
        link("00000000-0000-4000-8000-000000000003", "https://spec-weave.com/again"),
      ]),
    });
    const library = await readProjectLibrary(root);
    expect(library.artifacts.map((item) => [item.location, item.missing])).toEqual([
      ["javascript:alert(1)", true],
      ["https://user:pw@example.com/", true],
      ["https://spec-weave.com/", false],
    ]);
  });

  it("refuses a symlinked project folder, as the CLI does", async () => {
    const root = await project({ hub: hub() });
    const elsewhere = await project({ hub: hub([], 9) });
    await NodeFSP.rm(NodePath.join(root, ".specweave/project"), { recursive: true });
    await NodeFSP.symlink(
      NodePath.join(elsewhere, ".specweave/project"),
      NodePath.join(root, ".specweave/project"),
    );
    const library = await readProjectLibrary(root);
    expect(library.hub).toBeNull();
    expect(library.hubProblem).toMatch(/symlink/);
    await expect(
      addProjectLibraryArtifact(root, {
        title: "N",
        location: "https://spec-weave.com/",
        expectedRevision: 9,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("addProjectLibraryArtifact", () => {
  it("appends a file artifact, bumps the revision and keeps the CLI's fields", async () => {
    const root = await project({ hub: hub() });
    await NodeFSP.writeFile(NodePath.join(root, "notes.md"), "notes");

    const library = await addProjectLibraryArtifact(root, {
      title: " Notes ",
      location: "./notes.md",
      expectedRevision: 3,
    });

    expect(library.hub?.revision).toBe(4);
    expect(library.artifacts).toHaveLength(1);
    expect(library.artifacts[0]).toMatchObject({
      title: "Notes",
      location: "notes.md",
      kind: "file",
    });
    const stored = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, ".specweave/project/hub.json"), "utf8"),
    );
    expect(Object.keys(stored)).toEqual([
      "version",
      "revision",
      "updatedAt",
      "name",
      "goal",
      "context",
      "artifacts",
      "routines",
    ]);
    expect(Object.keys(stored.artifacts[0])).toEqual([
      "id",
      "title",
      "location",
      "kind",
      "intentId",
      "createdAt",
    ]);
    await expect(
      NodeFSP.access(NodePath.join(root, ".specweave/project/hub.json.lock")),
    ).rejects.toThrow();
  });

  it("creates the hub on first add and normalizes HTTPS links", async () => {
    const root = await project();
    const library = await addProjectLibraryArtifact(root, {
      title: "Site",
      location: "https://spec-weave.com",
      expectedRevision: 0,
    });
    expect(library.hub?.revision).toBe(1);
    expect(library.artifacts[0]).toMatchObject({
      kind: "link",
      location: "https://spec-weave.com/",
    });
  });

  it("refuses a stale revision, a held lock, paths outside the project and non-SpecWeave folders", async () => {
    const root = await project({ hub: hub() });
    await NodeFSP.writeFile(NodePath.join(root, "notes.md"), "notes");
    await expect(
      addProjectLibraryArtifact(root, { title: "N", location: "notes.md", expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      addProjectLibraryArtifact(root, {
        title: "N",
        location: "../outside.md",
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      addProjectLibraryArtifact(root, {
        title: "N",
        location: "https://user:pw@example.com",
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await NodeFSP.writeFile(NodePath.join(root, ".specweave/project/hub.json.lock"), "{}");
    await expect(
      addProjectLibraryArtifact(root, { title: "N", location: "notes.md", expectedRevision: 3 }),
    ).rejects.toMatchObject({ code: "conflict" });
    // A lock someone else holds is theirs to remove.
    await expect(
      NodeFSP.access(NodePath.join(root, ".specweave/project/hub.json.lock")),
    ).resolves.toBeUndefined();

    const plain = await project({ specweave: false });
    await expect(
      addProjectLibraryArtifact(plain, { title: "N", location: "x", expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: "not_specweave" });
  });

  it("refuses a link the CLI would store past its 2,000-character limit", async () => {
    const root = await project({ hub: hub() });
    // Spaces count once here but grow to %20 once normalized.
    const location = `https://example.com/${"a b".repeat(600)}`;
    expect(location.length).toBeLessThan(2000);
    await expect(
      addProjectLibraryArtifact(root, { title: "Long", location, expectedRevision: 3 }),
    ).rejects.toMatchObject({ code: "invalid" });
    const stored = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, ".specweave/project/hub.json"), "utf8"),
    );
    expect(stored.revision).toBe(3);
    await expect(
      NodeFSP.access(NodePath.join(root, ".specweave/project/hub.json.lock")),
    ).rejects.toThrow();
  });
});
