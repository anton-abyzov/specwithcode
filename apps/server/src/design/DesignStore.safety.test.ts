// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DESIGN_SYSTEM_SCHEMA,
  type DesignActor,
  type DesignSystem,
} from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { symlinksSupported } from "@specweave-studio/shared/testing/symlinks";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDesign,
  designHistory,
  DesignStoreProblem,
  listDesignSystems,
  putDesignAsset,
  readDesign,
  readDesignAsset,
  readDesignSystem,
  resolveDesignRoot,
  saveDesignVersion,
  updateDesign,
  writeDesignSystem,
} from "./DesignStore.ts";

const user: DesignActor = { kind: "user" };
const temps: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temps.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

const tempDir = async (prefix: string) => {
  const dir = await NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};

async function projectRoot() {
  const checkout = await tempDir("studio-design-safety-");
  const root = await resolveDesignRoot(checkout, ".specweave/design", { create: true });
  return root!;
}

const doc = (id = "d_one") =>
  newDesignDocument({
    id,
    kind: "design",
    title: "Landing",
    now: "2026-10-20T10:00:00.000Z",
    createdBy: user,
    random: () => 0.5,
  });

const system = (id = "s_weave"): DesignSystem => ({
  schema: DESIGN_SYSTEM_SCHEMA,
  id,
  name: "Weave",
  revision: 0,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  modes: [{ id: "light", name: "Light" }],
  tokens: [],
  components: [],
  sources: [],
  copiedFrom: null,
});

const rename = (title: string) => (current: ReturnType<typeof doc>) => {
  const outcome = applyDesignOperations(current, [{ op: "set_title", title }]);
  if (!outcome.ok) throw new Error(outcome.error.detail);
  return outcome.document;
};

const problemCode = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof DesignStoreProblem ? error.code : String(error)),
  );

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("DesignStore links (AC-03)", () => {
  it.skipIf(!symlinksSupported)(
    "never reads or writes design systems through a linked systems folder",
    async () => {
      const root = await projectRoot();
      const outside = await tempDir("studio-design-outside-");
      await NodeFSP.mkdir(NodePath.join(outside, "s_weave"));
      await NodeFSP.writeFile(
        NodePath.join(outside, "s_weave", "system.json"),
        JSON.stringify(system()),
      );
      await NodeFSP.symlink(outside, NodePath.join(root, "systems"));

      expect(
        await problemCode(
          writeDesignSystem(root, system("s_new"), { expectedRevision: null, actor: user }),
        ),
      ).toBe("invalid");
      expect(await problemCode(readDesignSystem(root, "s_weave"))).toBe("invalid");
      expect(
        await problemCode(writeDesignSystem(root, system(), { expectedRevision: 0, actor: user })),
      ).toBe("invalid");
      expect(await problemCode(listDesignSystems(root))).toBe("invalid");
      // Nothing landed outside the checkout.
      expect((await NodeFSP.readdir(outside)).sort()).toEqual(["s_weave"]);
      expect(await NodeFSP.readdir(NodePath.join(outside, "s_weave"))).toEqual(["system.json"]);
    },
  );

  it.skipIf(!symlinksSupported)(
    "refuses linked history, versions and assets folders inside a design",
    async () => {
      for (const folder of [".history", "versions", "assets"]) {
        const root = await projectRoot();
        const outside = await tempDir("studio-design-outside-");
        await createDesign(root, doc(), user);
        const dir = NodePath.join(root, "d_one");
        await NodeFSP.rm(NodePath.join(dir, folder), { recursive: true, force: true });
        await NodeFSP.symlink(outside, NodePath.join(dir, folder));

        const attempts = {
          ".history": () =>
            updateDesign(root, "d_one", { expectedRevision: 0, actor: user, change: rename("x") }),
          versions: () => saveDesignVersion(root, "d_one", { name: "Review", actor: user }),
          assets: () => putDesignAsset(root, "d_one", PNG, "image/png"),
        } as const;
        expect(await problemCode(attempts[folder as keyof typeof attempts]()), folder).toBe(
          "invalid",
        );
        expect(await NodeFSP.readdir(outside), folder).toEqual([]);
      }
    },
  );

  it.skipIf(!symlinksSupported)(
    "does not read an asset through a linked assets folder",
    async () => {
      const root = await projectRoot();
      const outside = await tempDir("studio-design-outside-");
      await createDesign(root, doc(), user);
      const name = `${"a".repeat(64)}.png`;
      await NodeFSP.writeFile(NodePath.join(outside, name), PNG);
      await NodeFSP.symlink(outside, NodePath.join(root, "d_one", "assets"));
      expect(await problemCode(readDesignAsset(root, "d_one", name))).toBe("invalid");
    },
  );

  it.skipIf(!symlinksSupported)(
    "leaves no folders behind for an unknown or linked design id",
    async () => {
      const root = await projectRoot();
      const outside = await tempDir("studio-design-outside-");
      expect(
        await problemCode(
          updateDesign(root, "d_missing", {
            expectedRevision: 0,
            actor: user,
            change: rename("x"),
          }),
        ),
      ).toBe("not_found");
      expect(
        await problemCode(saveDesignVersion(root, "d_missing", { name: "v", actor: user })),
      ).toBe("not_found");
      expect(await problemCode(putDesignAsset(root, "d_missing", PNG, "image/png"))).toBe(
        "not_found",
      );
      expect(await NodeFSP.readdir(root)).toEqual([]);

      await NodeFSP.symlink(outside, NodePath.join(root, "d_link"));
      expect(
        await problemCode(
          updateDesign(root, "d_link", { expectedRevision: 0, actor: user, change: rename("x") }),
        ),
      ).toBe("invalid");
      expect(await problemCode(readDesign(root, "d_link"))).toBe("invalid");
      expect(await NodeFSP.readdir(outside)).toEqual([]);
    },
  );
});

describe("DesignStore history index", () => {
  const revisionsOn = async (root: string) =>
    (await NodeFSP.readdir(NodePath.join(root, "d_one", ".history")))
      .filter((name) => /^\d{9}\.json$/.test(name))
      .sort();

  it("never prunes revisions on an unreadable or missing index", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    for (const damage of ["corrupt", "missing"] as const) {
      const root = await projectRoot();
      await createDesign(root, doc(), user);
      for (let revision = 0; revision < 3; revision++) {
        await updateDesign(root, "d_one", {
          expectedRevision: revision,
          actor: user,
          change: rename(`v${revision + 1}`),
        });
      }
      const index = NodePath.join(root, "d_one", ".history", "index.json");
      if (damage === "corrupt") await NodeFSP.writeFile(index, "{ not json");
      else await NodeFSP.rm(index);
      await updateDesign(root, "d_one", { expectedRevision: 3, actor: user, change: rename("v4") });
      await updateDesign(root, "d_one", { expectedRevision: 4, actor: user, change: rename("v5") });
      // Every revision is still on disk, and the head moved on.
      expect(await revisionsOn(root), damage).toEqual(
        [0, 1, 2, 3, 4, 5].map((revision) => `${String(revision).padStart(9, "0")}.json`),
      );
      expect((await readDesign(root, "d_one")).title).toBe("v5");
      expect((await readDesign(root, "d_one", 1)).title).toBe("v1");
    }
    expect(warn).toHaveBeenCalled();
  });
});

describe("DesignStore versions", () => {
  it("keeps two names that slug the same at one revision, and repeats as no-ops", async () => {
    const root = await projectRoot();
    await createDesign(root, doc(), user);
    await saveDesignVersion(root, "d_one", { name: "Final", actor: user });
    await saveDesignVersion(root, "d_one", { name: "final!", actor: user });
    await saveDesignVersion(root, "d_one", { name: "Final", actor: user });
    await saveDesignVersion(root, "d_one", { name: "final!", actor: user });
    const versions = (await designHistory(root, "d_one")).filter(
      (entry) => entry.kind === "version",
    );
    expect(versions.map((entry) => entry.name).sort()).toEqual(["Final", "final!"]);
    expect((await NodeFSP.readdir(NodePath.join(root, "d_one", "versions"))).sort()).toEqual([
      "000000000-final-2.json",
      "000000000-final.json",
    ]);
  });

  it("checks the head under the lock before saving a version or an asset", async () => {
    const root = await projectRoot();
    await createDesign(root, doc(), user);
    const refuse = () => {
      throw new DesignStoreProblem("forbidden", "No.");
    };
    expect(
      await problemCode(
        saveDesignVersion(root, "d_one", { name: "v", actor: user, check: refuse }),
      ),
    ).toBe("forbidden");
    expect(await problemCode(putDesignAsset(root, "d_one", PNG, "image/png", refuse))).toBe(
      "forbidden",
    );
    const dir = NodePath.join(root, "d_one");
    expect(await NodeFSP.readdir(dir)).not.toContain("versions");
    expect(await NodeFSP.readdir(dir)).not.toContain("assets");
    const seen: number[] = [];
    await saveDesignVersion(root, "d_one", {
      name: "v",
      actor: user,
      check: (head) => seen.push(head.revision),
    });
    expect(seen).toEqual([0]);
  });
});

describe("DesignStore lock", () => {
  const lockFile = (root: string) => NodePath.join(root, "d_one", ".history", ".lock");

  it("takes over a stale lock left by a dead writer", async () => {
    const root = await projectRoot();
    await createDesign(root, doc(), user);
    const lock = lockFile(root);
    await NodeFSP.writeFile(lock, JSON.stringify({ pid: 1, at: "x", token: "dead" }));
    const old = new Date(Date.now() - 60_000);
    await NodeFSP.utimes(lock, old, old);
    await updateDesign(root, "d_one", { expectedRevision: 0, actor: user, change: rename("next") });
    expect((await readDesign(root, "d_one")).title).toBe("next");
    await expect(NodeFSP.access(lock)).rejects.toThrow();
  });

  it("releases only its own lock, never one another writer holds now", async () => {
    const root = await projectRoot();
    await createDesign(root, doc(), user);
    const lock = lockFile(root);
    const other = JSON.stringify({ pid: 2, at: "x", token: "someone-else" });
    await updateDesign(root, "d_one", {
      expectedRevision: 0,
      actor: user,
      change: async (current) => {
        // Another process judged this lock stale and took it while the change ran.
        await NodeFSP.rm(lock);
        await NodeFSP.writeFile(lock, other);
        return rename("mine")(current);
      },
    });
    expect(await NodeFSP.readFile(lock, "utf8")).toBe(other);
  });
});
