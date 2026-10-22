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
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createDesign,
  deleteDesign,
  deleteDesignSystem,
  designHistory,
  DesignStoreProblem,
  listDesigns,
  listDesignSystems,
  putDesignAsset,
  readDesign,
  readDesignSystem,
  resolveDesignRoot,
  restoreDesign,
  saveDesignVersion,
  updateDesign,
  writeDesignSystem,
} from "./DesignStore.ts";

const user: DesignActor = { kind: "user" };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function projectRoot() {
  const checkout = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-design-store-"));
  roots.push(checkout);
  const root = await resolveDesignRoot(checkout, ".specweave/design", { create: true });
  return { checkout, root: root! };
}

const doc = (id = "d_one", title = "Landing") =>
  newDesignDocument({
    id,
    kind: "design",
    title,
    now: "2026-10-20T10:00:00.000Z",
    createdBy: user,
    random: () => 0.5,
  });

const rename = (title: string) => (current: ReturnType<typeof doc>) => {
  const outcome = applyDesignOperations(current, [{ op: "set_title", title }]);
  if (!outcome.ok) throw new Error(outcome.error.detail);
  return outcome.document;
};

const expectProblem = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(DesignStoreProblem);
  expect((error as DesignStoreProblem).code).toBe(code);
  return error as DesignStoreProblem;
};

describe("DesignStore", () => {
  it("lays a design out under .specweave/design with a git-ignored history", async () => {
    const { checkout, root } = await projectRoot();
    expect(root).toBe(NodePath.join(await NodeFSP.realpath(checkout), ".specweave/design"));
    const created = await createDesign(root, doc(), user);
    expect(created.revision).toBe(0);
    const dir = NodePath.join(root, "d_one");
    expect(JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "design.json"), "utf8")).id).toBe(
      "d_one",
    );
    expect(await NodeFSP.readFile(NodePath.join(dir, ".history/.gitignore"), "utf8")).toBe("*\n");
    expect(await NodeFSP.readdir(NodePath.join(dir, ".history"))).toEqual(
      expect.arrayContaining(["000000000.json", "index.json"]),
    );
    await expectProblem(createDesign(root, doc(), user), "conflict");
    expect((await listDesigns(root)).documents.map((entry) => entry.id)).toEqual(["d_one"]);
  });

  it("refuses a design root reached through a symlink", async () => {
    const { checkout } = await projectRoot();
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-design-out-"));
    roots.push(outside);
    await NodeFSP.mkdir(NodePath.join(checkout, "linked"));
    await NodeFSP.symlink(outside, NodePath.join(checkout, "linked/design"));
    await expectProblem(resolveDesignRoot(checkout, "linked/design", { create: true }), "invalid");
    expect(await resolveDesignRoot(checkout, "missing/design", { create: false })).toBeNull();
  });

  it("rejects ids that could leave the root", async () => {
    const { root } = await projectRoot();
    await expectProblem(readDesign(root, "../escape"), "invalid");
    await expectProblem(readDesign(root, "systems"), "invalid");
  });

  it("compare-and-sets on revision and reports the current one on conflict", async () => {
    const { root } = await projectRoot();
    await createDesign(root, doc(), user);
    const next = await updateDesign(root, "d_one", {
      expectedRevision: 0,
      actor: user,
      change: rename("Second"),
    });
    expect(next.revision).toBe(1);
    expect(next.title).toBe("Second");
    const stale = await expectProblem(
      updateDesign(root, "d_one", { expectedRevision: 0, actor: user, change: rename("Lost") }),
      "conflict",
    );
    expect(stale.currentRevision).toBe(1);
    expect((await readDesign(root, "d_one")).title).toBe("Second");
  });

  it("never loses an edit between parallel writers", async () => {
    const { root } = await projectRoot();
    await createDesign(root, doc(), user);
    // Each writer reads the head and retries on conflict, as an agent would.
    const writer = async (index: number) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const head = await readDesign(root, "d_one");
        try {
          await updateDesign(root, "d_one", {
            expectedRevision: head.revision,
            actor: { kind: "agent", threadId: `thread-${index}` as never },
            change: (current) => {
              const outcome = applyDesignOperations(current, [
                {
                  op: "add_node",
                  pageId: current.pages[0]!.id,
                  node: {
                    id: `n_writer_${index}`,
                    parentId: null,
                    type: "rect",
                    x: index,
                    y: 0,
                    width: 10,
                    height: 10,
                  },
                },
              ]);
              if (!outcome.ok) throw new Error(outcome.error.detail);
              return outcome.document;
            },
          });
          return attempt;
        } catch (error) {
          if (error instanceof DesignStoreProblem && error.code === "conflict") continue;
          throw error;
        }
      }
      throw new Error("writer gave up");
    };
    const conflicts = await Promise.all(Array.from({ length: 12 }, (_, index) => writer(index)));
    const head = await readDesign(root, "d_one");
    expect(head.revision).toBe(12);
    const ids = head.pages[0]!.nodes.map((node) => node.id);
    for (let index = 0; index < 12; index += 1) expect(ids).toContain(`n_writer_${index}`);
    expect(conflicts.some((count) => count > 0)).toBe(true);
  });

  it("serializes blind writers at the same revision: exactly one wins", async () => {
    const { root } = await projectRoot();
    await createDesign(root, doc(), user);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        updateDesign(root, "d_one", {
          expectedRevision: 0,
          actor: user,
          change: rename(`Writer ${index}`),
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((entry) => entry.status === "rejected")) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        code: "conflict",
        currentRevision: 1,
      });
    }
  });

  it("keeps the last 100 autosave revisions and named versions for good", async () => {
    const { root } = await projectRoot();
    await createDesign(root, doc(), user);
    await saveDesignVersion(root, "d_one", {
      name: "First draft",
      actor: user,
      now: "2026-10-20T10:00:01.000Z",
    });
    for (let revision = 0; revision < 105; revision += 1) {
      await updateDesign(root, "d_one", {
        expectedRevision: revision,
        actor: user,
        change: rename(`Title ${revision + 1}`),
        now: new Date(Date.parse("2026-10-20T11:00:00.000Z") + revision * 1000).toISOString(),
      });
    }
    const history = await designHistory(root, "d_one");
    const revisions = history.filter((entry) => entry.kind === "revision");
    expect(revisions).toHaveLength(100);
    expect(revisions[0]!.revision).toBe(105);
    expect(revisions.at(-1)!.revision).toBe(6);
    expect(history.at(-1)).toMatchObject({ kind: "version", name: "First draft", revision: 0 });
    const files = await NodeFSP.readdir(NodePath.join(root, "d_one/.history"));
    expect(files.filter((name) => /^\d{9}\.json$/.test(name))).toHaveLength(100);
    // Version 0 is older than every kept autosave, yet still readable and restorable.
    expect((await readDesign(root, "d_one", 0)).title).toBe("Landing");
    await expectProblem(readDesign(root, "d_one", 3), "not_found");
    const restored = await restoreDesign(root, "d_one", {
      revision: 0,
      expectedRevision: 105,
      actor: user,
    });
    expect(restored).toMatchObject({ revision: 106, title: "Landing", id: "d_one" });
    const restoredAgain = await restoreDesign(root, "d_one", {
      revision: 50,
      expectedRevision: 106,
      actor: user,
    });
    expect(restoredAgain).toMatchObject({ revision: 107, title: "Title 50" });
  });

  it("writes a named version once and lists it with the autosaves, newest first", async () => {
    const { root } = await projectRoot();
    await createDesign(root, doc(), user);
    const input = { name: "Review copy", actor: user, now: "2026-10-20T12:00:00.000Z" };
    await saveDesignVersion(root, "d_one", input);
    await saveDesignVersion(root, "d_one", { ...input, now: "2026-10-20T13:00:00.000Z" });
    const versions = await NodeFSP.readdir(NodePath.join(root, "d_one/versions"));
    expect(versions).toEqual(["000000000-review-copy.json"]);
    const history = await designHistory(root, "d_one");
    expect(history[0]).toMatchObject({ kind: "version", name: "Review copy", revision: 0 });
    expect(history[1]).toMatchObject({ kind: "revision", revision: 0, name: null });
  });

  it("stores assets by content hash and deletes a design whole", async () => {
    const { root } = await projectRoot();
    await createDesign(root, doc(), user);
    const bytes = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const name = await putDesignAsset(root, "d_one", bytes, "image/svg+xml");
    expect(name).toMatch(/^[a-f0-9]{64}\.svg$/);
    expect(await putDesignAsset(root, "d_one", bytes, "image/svg+xml")).toBe(name);
    await expectProblem(
      putDesignAsset(root, "d_one", new Uint8Array(10 * 1024 * 1024 + 1), "image/png"),
      "too_large",
    );
    expect(await deleteDesign(root, "d_one")).toBe(true);
    expect(await deleteDesign(root, "d_one")).toBe(false);
    expect((await listDesigns(root)).documents).toEqual([]);
  });

  it("reports a corrupt design as a problem without hiding the others", async () => {
    const { root } = await projectRoot();
    await createDesign(root, doc("d_good"), user);
    await NodeFSP.mkdir(NodePath.join(root, "d_bad"));
    await NodeFSP.writeFile(NodePath.join(root, "d_bad/design.json"), "{nope");
    const listed = await listDesigns(root);
    expect(listed.documents.map((entry) => entry.id)).toEqual(["d_good"]);
    expect(listed.problems).toEqual([{ id: "d_bad", detail: "design.json is not valid JSON." }]);
  });

  it("stores design systems with the same CAS and history rules", async () => {
    const { root } = await projectRoot();
    const system: DesignSystem = {
      schema: DESIGN_SYSTEM_SCHEMA,
      id: "s_weave",
      name: "Weave",
      revision: 0,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      modes: [{ id: "light", name: "Light" }],
      tokens: [],
      components: [],
      sources: [],
      copiedFrom: null,
    };
    const created = await writeDesignSystem(root, system, { expectedRevision: null, actor: user });
    expect(created.revision).toBe(0);
    await expectProblem(
      writeDesignSystem(root, system, { expectedRevision: null, actor: user }),
      "conflict",
    );
    const next = await writeDesignSystem(
      root,
      { ...created, name: "Weave 2" },
      { expectedRevision: 0, actor: user },
    );
    expect(next).toMatchObject({ revision: 1, name: "Weave 2" });
    const stale = await expectProblem(
      writeDesignSystem(root, created, { expectedRevision: 0, actor: user }),
      "conflict",
    );
    expect(stale.currentRevision).toBe(1);
    await expectProblem(
      writeDesignSystem(root, { ...created, modes: [] }, { expectedRevision: 1, actor: user }),
      "invalid",
    );
    expect((await readDesignSystem(root, "s_weave", 0)).name).toBe("Weave");
    expect((await listDesignSystems(root)).systems.map((entry) => entry.id)).toEqual(["s_weave"]);
    // Systems never show up as designs.
    expect((await listDesigns(root)).documents).toEqual([]);
  });

  it("deletes a design system whole, refusing a stale revision", async () => {
    const { root } = await projectRoot();
    const system: DesignSystem = {
      schema: DESIGN_SYSTEM_SCHEMA,
      id: "s_gone",
      name: "Gone",
      revision: 0,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      modes: [{ id: "light", name: "Light" }],
      tokens: [],
      components: [],
      sources: [],
      copiedFrom: null,
    };
    const created = await writeDesignSystem(root, system, { expectedRevision: null, actor: user });
    await writeDesignSystem(
      root,
      { ...created, name: "Gone 2" },
      { expectedRevision: 0, actor: user },
    );
    await writeDesignSystem(
      root,
      { ...system, id: "s_kept" },
      { expectedRevision: null, actor: user },
    );
    const stale = await expectProblem(deleteDesignSystem(root, "s_gone", 0), "conflict");
    expect(stale.currentRevision).toBe(1);
    expect((await readDesignSystem(root, "s_gone")).name).toBe("Gone 2");

    expect(await deleteDesignSystem(root, "s_gone", 1)).toBe(true);
    await expectProblem(readDesignSystem(root, "s_gone"), "not_found");
    // Folder, history and trash are all gone; the other system stays.
    expect(await NodeFSP.readdir(NodePath.join(root, "systems"))).toEqual(["s_kept"]);
    expect((await listDesignSystems(root)).systems.map((entry) => entry.id)).toEqual(["s_kept"]);
    expect(await deleteDesignSystem(root, "s_gone")).toBe(false);
    await expectProblem(deleteDesignSystem(root, "../d_one"), "invalid");
  });
});
