// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DESIGN_SYSTEM_SCHEMA,
  EnvironmentId,
  ProjectId,
  type DesignActor,
  type DesignOwnerInput,
  type DesignSystem,
} from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { symlinksSupported } from "@specweave-studio/shared/testing/symlinks";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  copySystemForMove,
  designPlaced,
  DESIGN_MOVED_DIR,
  moveDesign,
  readForward,
  removeMovedSource,
  type MoveDesignInput,
} from "./DesignMove.ts";
import * as Store from "./DesignStore.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualFS = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const user: DesignActor = { kind: "user" };
const project: DesignOwnerInput = { kind: "project", projectId: ProjectId.make("project-a") };
const temps: string[] = [];
afterEach(async () => {
  vi.mocked(NodeFSP.rename).mockImplementation(actualFS.rename);
  await Promise.all(
    temps.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

const tempDir = async (prefix: string) => {
  const dir = await NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};

/** A Playground root in an app home, and a project root in a checkout, each in its own tmpdir. */
async function roots() {
  const home = await tempDir("studio-move-home-");
  const checkout = await tempDir("studio-move-checkout-");
  return {
    home,
    checkout,
    playground: (await Store.resolveDesignRoot(home, "design/playground", {
      create: true,
      mode: 0o700,
    }))!,
    target: (await Store.resolveDesignRoot(checkout, ".specweave/design", { create: true }))!,
  };
}

const PNG = Buffer.from("89504e470d0a1a0a0000", "hex");

/** A Playground design at revision 1 with an image, autosave history and a named version. */
async function playgroundDesign(root: string, id = "d_moving") {
  const created = await Store.createDesign(
    root,
    newDesignDocument({
      id,
      kind: "design",
      title: "Landing",
      now: "2026-10-20T10:00:00.000Z",
      createdBy: user,
      random: () => 0.5,
    }),
    user,
  );
  const asset = await Store.putDesignAsset(root, id, PNG, "image/png");
  const updated = await Store.updateDesign(root, id, {
    expectedRevision: created.revision,
    actor: user,
    change: (current) => {
      const outcome = applyDesignOperations(current, [{ op: "set_title", title: "Landing 2" }]);
      if (!outcome.ok) throw new Error(outcome.error.detail);
      return outcome.document;
    },
  });
  await Store.saveDesignVersion(root, id, { name: "Before launch", actor: user });
  return { document: updated, asset };
}

const moveInput = (
  where: Awaited<ReturnType<typeof roots>>,
  expectedRevision: number,
  id = "d_moving",
): MoveDesignInput => ({
  playgroundRoot: where.playground,
  designId: id,
  targetRoot: where.target,
  to: project,
  expectedRevision,
  actor: user,
  movedAt: "2026-10-23T12:00:00.000Z",
});

/** Every file below `dir`, `/` separated and sorted. */
async function filesBelow(dir: string): Promise<string[]> {
  const entries = await NodeFSP.readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      NodePath.relative(dir, NodePath.join(entry.parentPath, entry.name))
        .split(NodePath.sep)
        .join("/"),
    )
    .sort();
}

const problemCode = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof Store.DesignStoreProblem ? error.code : String(error)),
  );

const leftovers = async (root: string) =>
  (await NodeFSP.readdir(root)).filter(
    (name) => name.startsWith(".incoming-") || name.startsWith(".deleted-"),
  );

describe("moveDesign", () => {
  it("moves design.json, assets, autosave history without the lock, and versions", async () => {
    const where = await roots();
    const { document, asset } = await playgroundDesign(where.playground);
    const source = Store.designFolder(where.playground, document.id);
    const before = await filesBelow(source);
    const history = await Store.designHistory(where.playground, document.id);
    // The lock is held while the folder is copied.
    let lockedDuringCopy = false;
    const moved = await moveDesign({
      ...moveInput(where, 1),
      prepare: async () => {
        lockedDuringCopy = (await filesBelow(source)).includes(".history/.lock");
      },
    });
    expect(lockedDuringCopy).toBe(true);
    expect(moved).toEqual(document);
    const target = Store.designFolder(where.target, document.id);
    expect(await filesBelow(target)).toEqual(before);
    expect(before).toEqual(
      expect.arrayContaining([
        "design.json",
        `assets/${asset}`,
        ".history/.gitignore",
        ".history/index.json",
        ".history/000000000.json",
        ".history/000000001.json",
        expect.stringMatching(/^versions\/000000001-before-launch\.json$/),
      ]),
    );
    expect(await Store.readDesign(where.target, document.id)).toEqual(document);
    expect(await Store.designHistory(where.target, document.id)).toEqual(history);
    expect(await Store.readDesign(where.target, document.id, 0)).toMatchObject({
      title: "Landing",
    });
    // The source is gone, nothing is left half way, and the forward record says where it went.
    await expect(NodeFSP.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await leftovers(where.playground)).toEqual([]);
    expect(await leftovers(where.target)).toEqual([]);
    expect(await readForward(where.playground, document.id)).toEqual({
      to: project,
      designId: document.id,
      movedAt: "2026-10-23T12:00:00.000Z",
      actor: user,
    });
    // The moved design takes writes in its new home.
    const next = await Store.updateDesign(where.target, document.id, {
      expectedRevision: 1,
      actor: user,
      change: (current) => current,
    });
    expect(next.revision).toBe(2);
  });

  it.skipIf(!symlinksSupported)(
    "refuses a link anywhere inside the source and leaves everything as it was",
    async () => {
      const where = await roots();
      const { document } = await playgroundDesign(where.playground);
      const source = Store.designFolder(where.playground, document.id);
      const outside = await tempDir("studio-move-outside-");
      await NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "secret");
      await NodeFSP.symlink(
        NodePath.join(outside, "secret.txt"),
        NodePath.join(source, "versions", "linked.json"),
      );
      expect(await problemCode(moveDesign(moveInput(where, 1)))).toBe("invalid");
      await NodeFSP.rm(NodePath.join(source, "versions", "linked.json"));
      await NodeFSP.symlink(outside, NodePath.join(source, "assets", "folder"));
      expect(await problemCode(moveDesign(moveInput(where, 1)))).toBe("invalid");
      expect(await Store.readDesign(where.playground, document.id)).toEqual(document);
      expect(await NodeFSP.readdir(where.target)).toEqual([]);
      expect(await readForward(where.playground, document.id)).toBeNull();
    },
  );

  it("stages inside the target, so a target on another volume never sees a cross-device rename", async () => {
    const where = await roots();
    const { document } = await playgroundDesign(where.playground);
    const sides: Array<[string, string]> = [];
    // Any rename from one tmpdir into the other fails the way it does across volumes.
    vi.mocked(NodeFSP.rename).mockImplementation(async (from, to) => {
      const side = (path: unknown) => String(path).startsWith(where.home);
      sides.push([String(from), String(to)]);
      if (side(from) !== side(to)) {
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), {
          code: "EXDEV",
        });
      }
      return actualFS.rename(from, to);
    });
    expect(await moveDesign(moveInput(where, 1))).toEqual(document);
    expect(await designPlaced(where.target, document.id)).toBe(true);
    expect(sides.some(([from]) => NodePath.basename(from).startsWith(".incoming-"))).toBe(true);
  });

  it("is a conflict when the project holds the id at another revision or as something else", async () => {
    const where = await roots();
    const { document } = await playgroundDesign(where.playground);
    await Store.createDesign(where.target, { ...document, revision: 0 }, user);
    expect(await problemCode(moveDesign(moveInput(where, 1)))).toBe("conflict");
    await Store.deleteDesign(where.target, document.id);
    await NodeFSP.mkdir(Store.designFolder(where.target, document.id));
    expect(await problemCode(moveDesign(moveInput(where, 1)))).toBe("conflict");
    // A stale revision is a conflict that names the current one.
    await expect(moveDesign(moveInput(where, 0))).rejects.toMatchObject({
      code: "conflict",
      currentRevision: 1,
    });
    expect(await Store.readDesign(where.playground, document.id)).toEqual(document);
    expect(await readForward(where.playground, document.id)).toBeNull();
  });

  it("finishes a move that stopped part way when retried, and answers a finished one again", async () => {
    const where = await roots();
    const { document } = await playgroundDesign(where.playground);
    const source = Store.designFolder(where.playground, document.id);
    /** Fails the first rename of a path `when` picks, as a busy folder would. */
    const failRename = (when: (from: string) => boolean) => {
      let failed = false;
      vi.mocked(NodeFSP.rename).mockImplementation(async (from, to) => {
        if (!failed && when(String(from))) {
          failed = true;
          throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
        }
        return actualFS.rename(from, to);
      });
    };
    // Placing fails: the attempt is undone and the source stays the only copy.
    failRename((from) => NodePath.basename(from).startsWith(".incoming-"));
    await expect(moveDesign(moveInput(where, 1))).rejects.toMatchObject({ code: "EBUSY" });
    expect(await readForward(where.playground, document.id)).toBeNull();
    expect(await NodeFSP.readdir(where.target)).toEqual([]);
    expect(await Store.readDesign(where.playground, document.id)).toEqual(document);
    // Removing the source fails: the copy is placed and the record written, so only the copy counts.
    failRename((from) => from === source);
    await expect(moveDesign(moveInput(where, 1))).rejects.toMatchObject({ code: "EBUSY" });
    expect(await designPlaced(where.target, document.id)).toBe(true);
    expect(await readForward(where.playground, document.id)).not.toBeNull();
    expect(await designPlaced(where.playground, document.id)).toBe(true);
    // The retry removes the source and keeps the placed copy.
    expect(await moveDesign(moveInput(where, 1))).toEqual(document);
    expect(await designPlaced(where.playground, document.id)).toBe(false);
    expect(await Store.readDesign(where.target, document.id)).toEqual(document);
    expect(await leftovers(where.playground)).toEqual([]);
    // Asking again after it finished returns the design where it is now.
    expect(await moveDesign(moveInput(where, 1))).toEqual(document);
    expect(
      await problemCode(
        moveDesign({
          ...moveInput(where, 1),
          to: { kind: "project", projectId: ProjectId.make("project-b") },
        }),
      ),
    ).toBe("not_found");
  });

  it("refuses a retry into another project once a copy is placed, and finishes into the first", async () => {
    const where = await roots();
    const otherCheckout = await tempDir("studio-move-other-");
    const otherRoot = (await Store.resolveDesignRoot(otherCheckout, ".specweave/design", {
      create: true,
    }))!;
    const projectB: DesignOwnerInput = { kind: "project", projectId: ProjectId.make("project-b") };
    const { document } = await playgroundDesign(where.playground);
    const source = Store.designFolder(where.playground, document.id);
    let failed = false;
    vi.mocked(NodeFSP.rename).mockImplementation(async (from, to) => {
      if (!failed && String(from) === source) {
        failed = true;
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      }
      return actualFS.rename(from, to);
    });
    await expect(moveDesign(moveInput(where, 1))).rejects.toMatchObject({ code: "EBUSY" });
    // An edit that waited on the lock is refused instead of landing on the copy about to go.
    expect(
      await problemCode(
        Store.updateDesign(where.playground, document.id, {
          expectedRevision: document.revision,
          actor: user,
          change: (current) => current,
        }),
      ),
    ).toBe("conflict");
    // Project A's copy is edited meanwhile, so it is newer than the Playground's.
    const edited = await Store.updateDesign(where.target, document.id, {
      expectedRevision: document.revision,
      actor: user,
      change: (current) => {
        const outcome = applyDesignOperations(current, [{ op: "set_title", title: "Landing 3" }]);
        if (!outcome.ok) throw new Error(outcome.error.detail);
        return outcome.document;
      },
    });
    const toB = { ...moveInput(where, 1), targetRoot: otherRoot, to: projectB };
    // Where the record points was not looked up: refused.
    expect(await problemCode(moveDesign(toB))).toBe("conflict");
    // Looked up, and project A holds it: refused, naming project A.
    await expect(
      moveDesign({ ...toB, elsewhere: { to: project, root: where.target, label: "Project A" } }),
    ).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Project A") });
    // Project A cannot be read right now, say on a disk that is unplugged: refused too.
    await expect(
      moveDesign({ ...toB, elsewhere: { to: project, root: null, label: "Project A" } }),
    ).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("can't read") });
    expect(await NodeFSP.readdir(otherRoot)).toEqual([]);
    // Retrying into project A removes the Playground copy and keeps A's newer one.
    expect(await moveDesign(moveInput(where, 1))).toEqual(edited);
    expect(await designPlaced(where.playground, document.id)).toBe(false);
  });

  it("moves on when the project an earlier move named was removed from this machine", async () => {
    const where = await roots();
    const otherCheckout = await tempDir("studio-move-other-");
    const otherRoot = (await Store.resolveDesignRoot(otherCheckout, ".specweave/design", {
      create: true,
    }))!;
    const projectB: DesignOwnerInput = { kind: "project", projectId: ProjectId.make("project-b") };
    const { document } = await playgroundDesign(where.playground);
    const source = Store.designFolder(where.playground, document.id);
    let failed = false;
    vi.mocked(NodeFSP.rename).mockImplementation(async (from, to) => {
      if (!failed && String(from) === source) {
        failed = true;
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      }
      return actualFS.rename(from, to);
    });
    await expect(moveDesign(moveInput(where, 1))).rejects.toMatchObject({ code: "EBUSY" });
    const gone = { to: project, root: null, label: "another project", gone: true };
    expect(
      await moveDesign({
        ...moveInput(where, 1),
        targetRoot: otherRoot,
        to: projectB,
        elsewhere: gone,
      }),
    ).toEqual(document);
    expect(await designPlaced(otherRoot, document.id)).toBe(true);
    expect(await designPlaced(where.playground, document.id)).toBe(false);
    expect((await readForward(where.playground, document.id))?.to).toEqual(projectB);
  });

  it("removes the Playground copy of a placed move only while the project holds it", async () => {
    const where = await roots();
    const { document } = await playgroundDesign(where.playground);
    const source = Store.designFolder(where.playground, document.id);
    let failed = false;
    vi.mocked(NodeFSP.rename).mockImplementation(async (from, to) => {
      if (!failed && String(from) === source) {
        failed = true;
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      }
      return actualFS.rename(from, to);
    });
    await expect(moveDesign(moveInput(where, 1))).rejects.toMatchObject({ code: "EBUSY" });
    // A root that does not hold it: nothing is removed.
    const empty = await tempDir("studio-move-empty-");
    await removeMovedSource(where.playground, document.id, empty);
    expect(await designPlaced(where.playground, document.id)).toBe(true);
    await removeMovedSource(where.playground, document.id, where.target);
    expect(await designPlaced(where.playground, document.id)).toBe(false);
    expect(await leftovers(where.playground)).toEqual([]);
    // Gone already: nothing to do.
    await removeMovedSource(where.playground, document.id, where.target);
  });

  it("keeps the forward records and staging folders out of listings", async () => {
    const where = await roots();
    const { document } = await playgroundDesign(where.playground);
    await moveDesign(moveInput(where, 1));
    expect((await NodeFSP.readdir(where.playground)).sort()).toEqual([DESIGN_MOVED_DIR]);
    expect(await Store.listDesigns(where.playground)).toEqual({ documents: [], problems: [] });
    // A staging folder a crash left behind is never listed either.
    const stray = NodePath.join(where.target, `.incoming-${document.id}-left`);
    await NodeFSP.cp(Store.designFolder(where.target, document.id), stray, { recursive: true });
    const listed = await Store.listDesigns(where.target);
    expect(listed.documents.map((entry) => entry.id)).toEqual([document.id]);
    expect(listed.problems).toEqual([]);
  });
});

describe("copySystemForMove", () => {
  const playgroundOwner = {
    kind: "playground",
    environmentId: EnvironmentId.make("env-here"),
  } as const;
  const system = (id: string): DesignSystem => ({
    schema: DESIGN_SYSTEM_SCHEMA,
    id,
    name: "Brand",
    revision: 0,
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    modes: [{ id: "light", name: "Light" }],
    tokens: [],
    components: [],
    sources: [],
    copiedFrom: null,
  });

  it("copies the system under the same id with its files, once", async () => {
    const where = await roots();
    await Store.writeDesignSystem(where.playground, system("s_brand"), {
      expectedRevision: null,
      actor: user,
    });
    await Store.writeDesignSystem(where.playground, system("s_brand"), {
      expectedRevision: 0,
      actor: user,
    });
    const files = NodePath.join(where.playground, "systems", "s_brand", "files");
    await NodeFSP.mkdir(NodePath.join(files, "fonts"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(files, "README.md"), "# Brand\n");
    await NodeFSP.writeFile(NodePath.join(files, "fonts", "Inter.woff2"), "font");
    const copy = {
      from: { root: where.playground, owner: playgroundOwner },
      targetRoot: where.target,
      systemId: "s_brand",
      actor: user,
      now: "2026-10-23T12:00:00.000Z",
    };
    await copySystemForMove(copy);
    expect(await Store.readDesignSystem(where.target, "s_brand")).toMatchObject({
      id: "s_brand",
      revision: 0,
      copiedFrom: { owner: playgroundOwner, id: "s_brand", revision: 1 },
    });
    const copied = NodePath.join(where.target, "systems", "s_brand", "files");
    expect(await filesBelow(copied)).toEqual(["README.md", "fonts/Inter.woff2"]);
    // Again: nothing changes, and a missing system is left as a dangling reference.
    await copySystemForMove(copy);
    expect((await Store.readDesignSystem(where.target, "s_brand")).revision).toBe(0);
    await copySystemForMove({ ...copy, systemId: "s_gone" });
    expect((await Store.listDesignSystems(where.target)).systems.map((entry) => entry.id)).toEqual([
      "s_brand",
    ]);
  });

  it.skipIf(!symlinksSupported)("refuses a link among the system's files", async () => {
    const where = await roots();
    await Store.writeDesignSystem(where.playground, system("s_brand"), {
      expectedRevision: null,
      actor: user,
    });
    const files = NodePath.join(where.playground, "systems", "s_brand", "files");
    await NodeFSP.mkdir(files, { recursive: true });
    await NodeFSP.symlink("/etc/hosts", NodePath.join(files, "hosts"));
    expect(
      await problemCode(
        copySystemForMove({
          from: { root: where.playground, owner: playgroundOwner },
          targetRoot: where.target,
          systemId: "s_brand",
          actor: user,
          now: "2026-10-23T12:00:00.000Z",
        }),
      ),
    ).toBe("invalid");
    const system_ = NodePath.join(where.target, "systems", "s_brand");
    expect((await NodeFSP.readdir(system_)).filter((name) => name !== ".history")).toEqual([
      "system.json",
    ]);
  });
});
