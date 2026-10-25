// @effect-diagnostics nodeBuiltinImport:off - Checks which folders a read leaves behind.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  DESIGN_SYSTEM_SCHEMA,
  ThreadId,
  type DesignOperation,
  type DesignSystem,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as DesignService from "./DesignService.ts";
import * as Store from "./DesignStore.ts";
import {
  agentIn,
  HERE,
  layerDesignService,
  makeDesignFixture,
  member,
  owner,
  PROJECT_A,
  PROJECT_B,
  REMOTE,
  type DesignFixture,
} from "./DesignService.testkit.ts";

const withDesigns = <A, E>(
  run: (
    designs: DesignService.DesignService["Service"],
    fixture: DesignFixture,
  ) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(makeDesignFixture),
    (fixture) =>
      Effect.gen(function* () {
        return yield* run(yield* DesignService.DesignService, fixture);
      }).pipe(Effect.provide(layerDesignService(fixture))),
    (fixture) => Effect.sync(fixture.cleanup),
  );

const projectA = { kind: "project", projectId: PROJECT_A } as const;
const projectB = { kind: "project", projectId: PROJECT_B } as const;
const agentA = agentIn(PROJECT_A);
const ownThread = { environmentId: HERE, threadId: ThreadId.make(`thread-${PROJECT_A}`) };
const otherThread = { environmentId: HERE, threadId: ThreadId.make("thread-someone-else") };

const codeOf = <A, E extends { readonly code: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: () => "ok" }));

describe("DesignService comments (AC-14)", () => {
  it.effect("stamps who wrote a comment and when, whatever the caller sends", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const created = yield* designs.create(owner, {
          owner: projectA,
          kind: "design",
          title: "C",
        });
        yield* designs.apply(owner, {
          owner: projectA,
          designId: created.document.id,
          expectedRevision: 0,
          operations: [{ op: "set_access", agents: "comment" }],
        });
        const forged: DesignOperation = {
          op: "add_comment",
          comment: {
            id: "c_forged",
            pageId: created.document.pages[0]!.id,
            nodeId: null,
            x: 1,
            y: 1,
            text: "Looks good to me",
            author: { kind: "user" },
            createdAt: "2001-01-01T00:00:00.000Z",
            resolved: false,
          },
        };
        const applied = yield* designs.apply(agentA, {
          owner: projectA,
          designId: created.document.id,
          expectedRevision: 1,
          operations: [forged],
        });
        const [comment] = applied.document.comments;
        expect(comment?.author).toEqual(agentA.actor);
        expect(comment?.createdAt).toBe(applied.document.updatedAt);
      }),
    ),
  );
});

describe("DesignService thread binding", () => {
  it.effect("lets the owner bind any thread and an agent only its own", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const created = yield* designs.create(owner, {
          owner: projectA,
          kind: "design",
          title: "T",
        });
        const designId = created.document.id;
        let revision = 0;
        const setThread = (caller: DesignService.DesignCaller, thread: typeof ownThread | null) =>
          designs
            .apply(caller, {
              owner: projectA,
              designId,
              expectedRevision: revision,
              operations: [{ op: "set_thread", thread }],
            })
            .pipe(Effect.tap((result) => Effect.sync(() => (revision = result.document.revision))));

        // A paired device may not rebind; an agent may not bind another thread, or one elsewhere.
        expect(yield* codeOf(setThread(member, ownThread))).toBe("forbidden");
        expect(yield* codeOf(setThread(agentA, otherThread))).toBe("forbidden");
        expect(yield* codeOf(setThread(agentA, { ...ownThread, environmentId: REMOTE }))).toBe(
          "forbidden",
        );
        // The owner binds another thread; the agent can neither clear nor take it over.
        expect(yield* codeOf(setThread(owner, otherThread))).toBe("ok");
        expect(yield* codeOf(setThread(agentA, null))).toBe("forbidden");
        // The agent binds itself, and clears its own binding.
        expect(yield* codeOf(setThread(owner, null))).toBe("ok");
        expect(yield* codeOf(setThread(agentA, ownThread))).toBe("ok");
        expect((yield* designs.get(owner, { owner: projectA, designId })).document.thread).toEqual(
          ownThread,
        );
        expect(yield* codeOf(setThread(agentA, null))).toBe("ok");
      }),
    ),
  );
});

describe("DesignService create-time binding", () => {
  it.effect("holds a binding on creation to the set_thread rule", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const create = (caller: DesignService.DesignCaller, thread: typeof ownThread) =>
          designs.create(caller, { owner: projectA, kind: "design", title: "B", thread });
        // A member and an agent naming another thread are refused, and nothing is written.
        expect(yield* codeOf(create(member, ownThread))).toBe("forbidden");
        expect(yield* codeOf(create(agentA, otherThread))).toBe("forbidden");
        expect((yield* designs.list(owner, { filter: { kind: "all" } })).designs).toEqual([]);
        // The owner binds any thread; an agent binds its own.
        expect((yield* create(owner, otherThread)).document.thread).toEqual(otherThread);
        expect((yield* create(agentA, ownThread)).document.thread).toEqual(ownThread);
      }),
    ),
  );
});

describe("DesignService versions and assets", () => {
  it.effect("refuses a version or an image once access is view-only", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const created = yield* designs.create(owner, {
          owner: projectA,
          kind: "design",
          title: "V",
        });
        const address = { owner: projectA, designId: created.document.id };
        yield* designs.apply(owner, {
          ...address,
          expectedRevision: 0,
          operations: [{ op: "set_access", members: "view" }],
        });
        expect(yield* codeOf(designs.saveVersion(member, { ...address, name: "Mine" }))).toBe(
          "forbidden",
        );
        expect(
          yield* codeOf(
            designs.putAsset(member, { ...address, mimeType: "image/png", data: "iVBORw0K" }),
          ),
        ).toBe("forbidden");
        const { entries } = yield* designs.history(owner, address);
        expect(entries.filter((entry) => entry.kind === "version")).toEqual([]);
      }),
    ),
  );
});

describe("DesignService copy", () => {
  it.effect("keeps the design system on a copy to an owner that copied the system", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const { root } = yield* designs.ownerRoot(owner, projectA);
        const system: DesignSystem = {
          schema: DESIGN_SYSTEM_SCHEMA,
          id: "s_brand",
          name: "Brand",
          revision: 0,
          createdAt: "2026-10-20T10:00:00.000Z",
          updatedAt: "2026-10-20T10:00:00.000Z",
          modes: [{ id: "light", name: "Light" }],
          tokens: [],
          components: [],
          sources: [],
          copiedFrom: null,
        };
        yield* Effect.promise(() =>
          Store.writeDesignSystem(root, system, {
            expectedRevision: null,
            actor: { kind: "user" },
          }),
        );
        const created = yield* designs.create(owner, {
          owner: projectA,
          kind: "design",
          title: "Branded",
          designSystem: "s_brand",
        });
        // Without the system in project B, the copy has none.
        const bare = yield* designs.copy(owner, {
          owner: projectA,
          designId: created.document.id,
          to: projectB,
        });
        expect(bare.document.designSystem).toBeNull();
        const copiedSystem = yield* designs.systemCopy(owner, {
          owner: projectA,
          systemId: "s_brand",
          to: projectB,
        });
        expect(copiedSystem.system.id).not.toBe("s_brand");
        const copy = yield* designs.copy(owner, {
          owner: projectA,
          designId: created.document.id,
          to: projectB,
        });
        expect(copy.document.designSystem).toBe(copiedSystem.system.id);
        // Within the same owner the system id stays.
        const same = yield* designs.copy(owner, {
          owner: projectA,
          designId: created.document.id,
          to: projectA,
        });
        expect(same.document.designSystem).toBe("s_brand");
      }),
    ),
  );

  it.effect("returns the existing copy and numbers a copy whose name is taken", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const a = yield* designs.ownerRoot(owner, projectA);
        const b = yield* designs.ownerRoot(owner, projectB);
        yield* Effect.promise(() =>
          Store.writeDesignSystem(a.root, brand("s_brand"), {
            expectedRevision: null,
            actor: { kind: "user" },
          }),
        );
        // Project B already holds an unrelated system called Brand.
        yield* Effect.promise(() =>
          Store.writeDesignSystem(b.root, brand("s_local"), {
            expectedRevision: null,
            actor: { kind: "user" },
          }),
        );
        const first = yield* designs.systemCopy(owner, {
          owner: projectA,
          systemId: "s_brand",
          to: projectB,
        });
        expect(first.system.name).toBe("Brand 2");
        const again = yield* designs.systemCopy(owner, {
          owner: projectA,
          systemId: "s_brand",
          to: projectB,
        });
        expect(again.system.id).toBe(first.system.id);
        const listed = yield* designs.systemList(owner, { filter: { kind: "all" } });
        const inB = listed.systems.filter(
          (system) =>
            system.ref.owner.kind === "project" && system.ref.owner.projectId === PROJECT_B,
        );
        expect(inB.map((system) => system.name).toSorted()).toEqual(["Brand", "Brand 2"]);
        expect(inB.find((system) => system.name === "Brand 2")?.copiedFrom?.id).toBe("s_brand");
      }),
    ),
  );

  it.effect("duplicates a system into its own owner every time", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const a = yield* designs.ownerRoot(owner, projectA);
        yield* Effect.promise(() =>
          Store.writeDesignSystem(a.root, brand("s_brand"), {
            expectedRevision: null,
            actor: { kind: "user" },
          }),
        );
        const address = { owner: projectA, systemId: "s_brand", to: projectA } as const;
        const first = yield* designs.systemCopy(owner, address);
        const second = yield* designs.systemCopy(owner, address);
        expect(new Set(["s_brand", first.system.id, second.system.id]).size).toBe(3);
        expect([first.system.name, second.system.name]).toEqual(["Brand 2", "Brand 3"]);
      }),
    ),
  );

  it.effect("copies again only when asked and the newest copy predates the source", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const a = yield* designs.ownerRoot(owner, projectA);
        yield* Effect.promise(() =>
          Store.writeDesignSystem(a.root, brand("s_brand"), {
            expectedRevision: null,
            actor: { kind: "user" },
          }),
        );
        const address = { owner: projectA, systemId: "s_brand", to: projectB } as const;
        const first = yield* designs.systemCopy(owner, address);
        // A fresh copy of a source that has not changed is the copy already made.
        expect((yield* designs.systemCopy(owner, { ...address, fresh: true })).system.id).toBe(
          first.system.id,
        );
        yield* Effect.promise(() =>
          Store.updateDesignSystem(a.root, "s_brand", {
            expectedRevision: 0,
            actor: { kind: "user" },
            change: (current) => ({ ...current, name: "Brand, revised" }),
          }),
        );
        // Without `fresh`, the older copy still comes back.
        expect((yield* designs.systemCopy(owner, address)).system.id).toBe(first.system.id);
        const fresh = yield* designs.systemCopy(owner, { ...address, fresh: true });
        expect(fresh.system.id).not.toBe(first.system.id);
        expect(fresh.system.copiedFrom).toMatchObject({ id: "s_brand", revision: 1 });
        // A retry, fresh or not, gets that newest copy instead of a third.
        expect((yield* designs.systemCopy(owner, { ...address, fresh: true })).system.id).toBe(
          fresh.system.id,
        );
        expect((yield* designs.systemCopy(owner, address)).system.id).toBe(fresh.system.id);
        const inB = (yield* designs.systemList(owner, { filter: { kind: "all" } })).systems.filter(
          (system) =>
            system.ref.owner.kind === "project" && system.ref.owner.projectId === PROJECT_B,
        );
        expect(inB).toHaveLength(2);
        // A design copied into B afterwards uses the newest copy too.
        const created = yield* designs.create(owner, {
          owner: projectA,
          kind: "design",
          title: "Branded",
          designSystem: "s_brand",
        });
        const copied = yield* designs.copy(owner, {
          owner: projectA,
          designId: created.document.id,
          to: projectB,
        });
        expect(copied.document.designSystem).toBe(fresh.system.id);
      }),
    ),
  );

  it("numbers names past the ones taken", () => {
    expect(DesignService.freeSystemName("ec-uikit", [])).toBe("ec-uikit");
    expect(DesignService.freeSystemName("ec-uikit", ["EC-UIKIT", "ec-uikit 2"])).toBe("ec-uikit 3");
  });
});

const brand = (id: string): DesignSystem => ({
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

describe("DesignService system rename and delete", () => {
  it.effect("renames under compare-and-set, keeping the id; agents are refused", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const { root } = yield* designs.ownerRoot(owner, projectA);
        yield* Effect.promise(() =>
          Store.writeDesignSystem(root, brand("s_brand"), {
            expectedRevision: null,
            actor: { kind: "user" },
          }),
        );
        const address = { owner: projectA, systemId: "s_brand" };
        const renamed = yield* designs.systemRename(member, {
          ...address,
          name: "  Brand 2026 ",
          expectedRevision: 0,
        });
        expect(renamed.system).toMatchObject({ id: "s_brand", name: "Brand 2026", revision: 1 });
        expect(renamed.ref.path).toBe(".specweave/design/systems/s_brand/system.json");
        const stale = yield* designs
          .systemRename(owner, { ...address, name: "Old", expectedRevision: 0 })
          .pipe(Effect.flip);
        expect(stale).toMatchObject({ code: "conflict", currentRevision: 1 });
        expect(
          yield* codeOf(
            designs.systemRename(owner, { ...address, name: "   ", expectedRevision: 1 }),
          ),
        ).toBe("invalid");
        expect(
          yield* codeOf(
            designs.systemRename(agentA, { ...address, name: "Agent", expectedRevision: 1 }),
          ),
        ).toBe("forbidden");
        expect(
          yield* codeOf(designs.systemRemove(agentA, { ...address, expectedRevision: 1 })),
        ).toBe("forbidden");
        expect((yield* designs.systemGet(owner, address)).system.name).toBe("Brand 2026");
      }),
    ),
  );

  it.effect("deletes a system; designs keep its id, still apply, and usage counts them", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const { root } = yield* designs.ownerRoot(owner, projectA);
        yield* Effect.promise(() =>
          Store.writeDesignSystem(root, brand("s_brand"), {
            expectedRevision: null,
            actor: { kind: "user" },
          }),
        );
        const address = { owner: projectA, systemId: "s_brand" };
        const branded = yield* designs.create(owner, {
          owner: projectA,
          kind: "design",
          title: "Branded",
          designSystem: "s_brand",
        });
        yield* designs.create(owner, { owner: projectA, kind: "design", title: "Plain" });
        expect(yield* designs.systemUsage(owner, address)).toEqual({ designs: 1 });
        expect(yield* designs.systemUsage(owner, { owner: projectB, systemId: "s_brand" })).toEqual(
          { designs: 0 },
        );
        expect(
          yield* codeOf(designs.systemRemove(owner, { ...address, expectedRevision: 3 })),
        ).toBe("conflict");
        const removed = yield* designs.systemRemove(owner, { ...address, expectedRevision: 0 });
        expect(removed).toMatchObject({
          deleted: true,
          owner: { kind: "project", projectId: PROJECT_A },
        });
        expect(yield* codeOf(designs.systemGet(owner, address))).toBe("not_found");
        expect((yield* designs.systemList(owner, { filter: { kind: "all" } })).systems).toEqual([]);
        // The design keeps the id, opens and still takes edits without the system.
        const designAddress = { owner: projectA, designId: branded.document.id };
        expect((yield* designs.get(owner, designAddress)).document.designSystem).toBe("s_brand");
        const edited = yield* designs.apply(owner, {
          ...designAddress,
          expectedRevision: 0,
          operations: [{ op: "set_title", title: "Still here" }],
        });
        expect(edited.document).toMatchObject({ title: "Still here", designSystem: "s_brand" });
        expect(yield* designs.systemUsage(owner, address)).toEqual({ designs: 1 });
        expect(
          (yield* designs.systemRemove(owner, { ...address, expectedRevision: 0 })).deleted,
        ).toBe(false);
      }),
    ),
  );
});

describe("DesignService owner roots", () => {
  it.effect("reads, lists and locates without creating .specweave/design; writes create it", () =>
    withDesigns((designs, fixture) =>
      Effect.gen(function* () {
        const checkout = NodeFS.realpathSync(fixture.roots[PROJECT_A]!);
        const designRoot = NodePath.join(checkout, ".specweave", "design");
        const found = yield* designs.findOwnerRoot(agentA, projectA);
        expect(found).toEqual({
          owner: { kind: "project", environmentId: HERE, projectId: PROJECT_A },
          root: designRoot,
          exists: false,
        });
        expect(
          (yield* designs.list(owner, { filter: { kind: "project", projectId: PROJECT_A } }))
            .designs,
        ).toEqual([]);
        expect(
          (yield* designs.systemList(owner, { filter: { kind: "project", projectId: PROJECT_A } }))
            .systems,
        ).toEqual([]);
        expect(yield* codeOf(designs.get(owner, { owner: projectA, designId: "d_none" }))).toBe(
          "not_found",
        );
        // Nothing was made in the checkout, not even .specweave.
        expect(NodeFS.readdirSync(checkout)).toEqual([]);
        // The scope check still applies.
        expect(yield* codeOf(designs.findOwnerRoot(agentA, projectB))).toBe("forbidden");

        expect((yield* designs.ownerRoot(owner, projectA)).root).toBe(designRoot);
        expect((yield* designs.findOwnerRoot(owner, projectA)).exists).toBe(true);
      }),
    ),
  );

  it.effect("refuses a linked design root when locating it too", () =>
    withDesigns((designs, fixture) =>
      Effect.gen(function* () {
        const checkout = fixture.roots[PROJECT_A]!;
        NodeFS.mkdirSync(NodePath.join(checkout, ".specweave"));
        NodeFS.symlinkSync(
          fixture.roots[PROJECT_B]!,
          NodePath.join(checkout, ".specweave", "design"),
        );
        expect(yield* codeOf(designs.findOwnerRoot(owner, projectA))).toBe("invalid");
      }),
    ),
  );
});
