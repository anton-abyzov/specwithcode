// @effect-diagnostics nodeBuiltinImport:off globalDate:off
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

  it("lists output files from reports folders, newest first, without following symlinks", async () => {
    const root = await project();
    const write = async (relative: string, at: number) => {
      const file = NodePath.join(root, relative);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(file, "x".repeat(10));
      await NodeFSP.utimes(file, at, at);
    };
    await write(".specweave/reports/threads/summary.md", 1_800_000_000);
    await write(".specweave/increments/1148-shelf/reports/light.png", 1_800_000_300);
    await write(".specweave/increments/1148-shelf/reports/run/dark.png", 1_800_000_200);
    await write(".specweave/increments/1148-shelf/spec.md", 1_800_000_400);
    await write(".specweave/reports/.hidden.md", 1_800_000_500);
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-outside-"));
    roots.push(outside);
    await NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "secret");
    await NodeFSP.symlink(outside, NodePath.join(root, ".specweave/reports/linked"));
    await NodeFSP.symlink(
      NodePath.join(outside, "secret.txt"),
      NodePath.join(root, ".specweave/reports/secret.txt"),
    );

    const library = await readProjectLibrary(root);
    expect(library.outputs).toEqual([
      {
        path: ".specweave/increments/1148-shelf/reports/light.png",
        byteLength: 10,
        modifiedAt: new Date(1_800_000_300_000).toISOString(),
        increment: "1148-shelf",
      },
      {
        path: ".specweave/increments/1148-shelf/reports/run/dark.png",
        byteLength: 10,
        modifiedAt: new Date(1_800_000_200_000).toISOString(),
        increment: "1148-shelf",
      },
      {
        path: ".specweave/reports/threads/summary.md",
        byteLength: 10,
        modifiedAt: new Date(1_800_000_000_000).toISOString(),
        increment: null,
      },
    ]);
  });

  it("finds a new file in an old increment's subfolder past a large reports tree", async () => {
    const root = await project();
    const bulk = NodePath.join(root, ".specweave/reports/bulk");
    await NodeFSP.mkdir(bulk, { recursive: true });
    await Promise.all(
      Array.from({ length: 4100 }, (_, index) =>
        NodeFSP.writeFile(NodePath.join(bulk, `old-${index}.md`), "x"),
      ),
    );
    const old = 1_700_000_000;
    for (const name of await NodeFSP.readdir(bulk)) {
      await NodeFSP.utimes(NodePath.join(bulk, name), old, old);
    }
    await NodeFSP.utimes(bulk, old, old);
    const run = NodePath.join(root, ".specweave/increments/0900-x/reports/run");
    await NodeFSP.mkdir(run, { recursive: true });
    await NodeFSP.utimes(NodePath.join(root, ".specweave/increments/0900-x/reports"), old, old);
    await NodeFSP.writeFile(NodePath.join(run, "new.png"), "png");

    const outputs = (await readProjectLibrary(root)).outputs ?? [];
    expect(outputs).toHaveLength(120);
    expect(outputs[0]?.path).toBe(".specweave/increments/0900-x/reports/run/new.png");
  });

  it("finds a report rewritten in place in an old folder behind 120 newer files", async () => {
    const root = await project();
    const recent = NodePath.join(root, ".specweave/reports");
    await NodeFSP.mkdir(recent, { recursive: true });
    const hourAgo = Date.now() / 1000 - 3600;
    for (let index = 0; index < 130; index += 1) {
      const file = NodePath.join(recent, `recent-${index}.md`);
      await NodeFSP.writeFile(file, "x");
      await NodeFSP.utimes(file, hourAgo, hourAgo);
    }
    const old = NodePath.join(root, ".specweave/increments/1100-x/reports");
    await NodeFSP.mkdir(old, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(old, "report.html"), "v1");
    const week = Date.now() / 1000 - 7 * 86_400;
    await NodeFSP.utimes(old, week, week);
    // Rewritten in place: the file is new, its folder keeps last week's time.
    await NodeFSP.writeFile(NodePath.join(old, "report.html"), "v2");
    await NodeFSP.utimes(old, week, week);

    const outputs = (await readProjectLibrary(root)).outputs ?? [];
    expect(outputs[0]?.path).toBe(".specweave/increments/1100-x/reports/report.html");
  });

  it("lists no outputs through a symlinked .specweave", async () => {
    const real = await project();
    await NodeFSP.mkdir(NodePath.join(real, ".specweave/reports"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(real, ".specweave/reports/a.md"), "a");
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-library-"));
    roots.push(root);
    await NodeFSP.symlink(NodePath.join(real, ".specweave"), NodePath.join(root, ".specweave"));
    expect((await readProjectLibrary(root)).outputs).toEqual([]);
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
