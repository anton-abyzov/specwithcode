// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Reads the files the move wrote.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  DESIGN_SYSTEM_SCHEMA,
  PROJECT_DESIGN_DIR,
  ThreadId,
  type DesignError,
  type DesignOperation,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type * as ServerConfig from "../config.ts";
import * as DesignService from "./DesignService.ts";
import {
  agentIn,
  HERE,
  layerDesignService,
  makeDesignFixture,
  member,
  owner,
  PROJECT_A,
  PROJECT_B,
  SCRATCH,
  scratchAgent,
  type DesignFixture,
} from "./DesignService.testkit.ts";
import * as Store from "./DesignStore.ts";

const withDesigns = <A, E>(
  run: (
    designs: DesignService.DesignService["Service"],
    fixture: DesignFixture,
  ) => Effect.Effect<A, E, ServerConfig.ServerConfig>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(makeDesignFixture),
    (fixture) =>
      Effect.gen(function* () {
        const designs = yield* DesignService.DesignService;
        return yield* run(designs, fixture);
      }).pipe(Effect.provide(layerDesignService(fixture))),
    (fixture) => Effect.sync(fixture.cleanup),
  );

const projectA = { kind: "project", projectId: PROJECT_A } as const;
const playground = { kind: "playground" } as const;
const thread = { environmentId: HERE, threadId: ThreadId.make("thread-scratch") };

/** A Playground design bound to a Scratch thread, with a comment, tight access and a named version. */
const busyDesign = (designs: DesignService.DesignService["Service"], designSystem?: string) =>
  Effect.gen(function* () {
    const created = yield* designs.create(owner, {
      owner: playground,
      kind: "design",
      title: "Connect me",
      thread,
      ...(designSystem === undefined ? {} : { designSystem }),
    });
    const address = { owner: playground, designId: created.document.id } as const;
    const pageId = created.document.pages[0]!.id;
    const comment: DesignOperation = {
      op: "add_comment",
      comment: {
        id: "c_keep",
        pageId,
        nodeId: null,
        x: 4,
        y: 4,
        text: "Keep this note",
        author: { kind: "user" },
        createdAt: "2026-10-23T12:00:00.000Z",
        resolved: false,
      },
    };
    yield* designs.apply(owner, { ...address, expectedRevision: 0, operations: [comment] });
    const result = yield* designs.apply(owner, {
      ...address,
      expectedRevision: 1,
      operations: [{ op: "set_access", members: "comment", agents: "view" }],
    });
    yield* designs.saveVersion(owner, { ...address, name: "Reviewed" });
    return { address, document: result.document };
  });

describe("DesignService.move (1046 AC-02)", () => {
  it.effect(
    "moves a Playground design into a project with its revision, comments, thread and access",
    () =>
      withDesigns((designs, fixture) =>
        Effect.gen(function* () {
          const { address, document } = yield* busyDesign(designs);
          const history = yield* designs.history(owner, address);
          const moved = yield* designs.move(owner, {
            ...address,
            to: projectA,
            expectedRevision: 2,
          });
          expect(moved.ref).toEqual({
            owner: { kind: "project", environmentId: HERE, projectId: PROJECT_A },
            designId: document.id,
            path: `${PROJECT_DESIGN_DIR}/${document.id}/design.json`,
          });
          expect(moved.document).toEqual(document);
          expect(moved.document).toMatchObject({
            revision: 2,
            thread,
            access: { members: "comment", agents: "view" },
            comments: [expect.objectContaining({ id: "c_keep" })],
          });
          expect(NodeFS.existsSync(NodePath.join(fixture.roots[PROJECT_A]!, moved.ref.path))).toBe(
            true,
          );
          const there = { owner: projectA, designId: document.id } as const;
          expect((yield* designs.get(owner, there)).document).toEqual(document);
          expect(yield* designs.history(owner, there)).toEqual(history);
          // The Playground no longer lists it; the project does.
          const listed = yield* designs.list(owner, { filter: { kind: "all" } });
          expect(listed.designs.map((design) => [design.ownerLabel, design.ref.designId])).toEqual([
            ["Alpha", document.id],
          ]);
          expect(listed.problems).toEqual([]);
          // A retry after the move finished answers with the design where it is now.
          expect(
            (yield* designs.move(owner, { ...address, to: projectA, expectedRevision: 2 }))
              .document,
          ).toEqual(document);
        }),
      ),
  );

  it.effect("copies the design system the project lacks under the same id", () =>
    withDesigns((designs, fixture) =>
      Effect.gen(function* () {
        const { root } = yield* designs.ownerRoot(owner, playground);
        yield* Effect.promise(() =>
          Store.writeDesignSystem(
            root,
            {
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
            },
            { expectedRevision: null, actor: { kind: "user" } },
          ),
        );
        const files = NodePath.join(root, "systems", "s_brand", "files");
        NodeFS.mkdirSync(files, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(files, "README.md"), "# Brand\n");
        const { address } = yield* busyDesign(designs, "s_brand");
        const moved = yield* designs.move(owner, { ...address, to: projectA, expectedRevision: 2 });
        expect(moved.document.designSystem).toBe("s_brand");
        const system = yield* designs.systemGet(owner, { owner: projectA, systemId: "s_brand" });
        expect(system.system).toMatchObject({
          id: "s_brand",
          name: "Brand",
          copiedFrom: { owner: { kind: "playground", environmentId: HERE }, id: "s_brand" },
        });
        expect(
          NodeFS.readFileSync(
            NodePath.join(
              fixture.roots[PROJECT_A]!,
              PROJECT_DESIGN_DIR,
              "systems",
              "s_brand",
              "files",
              "README.md",
            ),
            "utf8",
          ),
        ).toBe("# Brand\n");
        // The Playground keeps its own system.
        expect(
          (yield* designs.systemGet(owner, { owner: playground, systemId: "s_brand" })).system,
        ).toMatchObject({ copiedFrom: null });
      }),
    ),
  );

  it.effect("refuses agents, members, a stale revision and owners a move cannot use", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const { address, document } = yield* busyDesign(designs);
        const to = { ...address, to: projectA, expectedRevision: 2 };
        for (const caller of [member, agentIn(PROJECT_A), scratchAgent]) {
          expect(yield* Effect.flip(designs.move(caller, to))).toMatchObject({ code: "forbidden" });
        }
        for (const target of [playground, { kind: "project", projectId: SCRATCH } as const]) {
          expect(yield* Effect.flip(designs.move(owner, { ...to, to: target }))).toMatchObject({
            code: "invalid",
          });
        }
        const inProject = yield* designs.create(owner, {
          owner: projectA,
          kind: "design",
          title: "Already here",
        });
        expect(
          yield* Effect.flip(
            designs.move(owner, {
              owner: projectA,
              designId: inProject.document.id,
              to: { kind: "project", projectId: PROJECT_B },
              expectedRevision: 0,
            }),
          ),
        ).toMatchObject({ code: "invalid" });
        expect(
          yield* Effect.flip(designs.move(owner, { ...to, expectedRevision: 1 })),
        ).toMatchObject({ code: "conflict", currentRevision: 2 });
        expect((yield* designs.get(owner, address)).document).toEqual(document);
      }),
    ),
  );

  it.effect("answers the old address with movedTo, for callers that may open it there", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const { address } = yield* busyDesign(designs);
        yield* designs.move(owner, { ...address, to: projectA, expectedRevision: 2 });
        const movedTo = { owner: projectA, designId: address.designId };
        const attempts = (caller: DesignService.DesignCaller) =>
          [
            designs.get(caller, address),
            designs.apply(caller, {
              ...address,
              expectedRevision: 2,
              operations: [{ op: "set_title", title: "Stale" }],
            }),
            designs.history(caller, address),
            designs.export(caller, { ...address, pageId: "p_any", format: "html" }),
          ] as ReadonlyArray<Effect.Effect<object, DesignError>>;
        // The owner, a member, and an agent of the project it moved into (an old brief) are told where.
        for (const caller of [owner, member, agentIn(PROJECT_A)]) {
          for (const attempt of attempts(caller)) {
            expect(yield* Effect.flip(attempt)).toMatchObject({
              code: "not_found",
              detail: "Moved to Alpha.",
              movedTo,
            });
          }
        }
        // A Scratch thread, which may use the Playground, only learns that it moved.
        const fromScratch = yield* Effect.flip(designs.get(scratchAgent, address));
        expect(fromScratch).toMatchObject({ code: "not_found" });
        expect(fromScratch.movedTo).toBeUndefined();
        // A thread that may use neither owner is refused as before the move.
        const outsider = yield* Effect.flip(designs.get(agentIn(PROJECT_B), address));
        expect(outsider.code).toBe("forbidden");
        expect(outsider.movedTo).toBeUndefined();
      }),
    ),
  );

  it.effect("hides a Playground copy left behind by a move that stopped before removing it", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const { address, document } = yield* busyDesign(designs);
        const { root } = yield* designs.ownerRoot(owner, playground);
        const source = Store.designFolder(root, document.id);
        const kept = `${source}-kept`;
        NodeFS.cpSync(source, kept, { recursive: true });
        yield* designs.move(owner, { ...address, to: projectA, expectedRevision: 2 });
        // Put the old folder back, as if removing it had failed.
        NodeFS.renameSync(kept, source);
        expect(
          yield* Effect.flip(
            designs.apply(owner, {
              ...address,
              expectedRevision: 2,
              operations: [{ op: "set_title", title: "Second copy" }],
            }),
          ),
        ).toMatchObject({ code: "not_found", movedTo: { owner: projectA } });
        // Moving again finishes the job.
        yield* designs.move(owner, { ...address, to: projectA, expectedRevision: 2 });
        expect(NodeFS.existsSync(source)).toBe(false);
      }),
    ),
  );
});

describe("DesignService.watch on a moved design", () => {
  it.live("ends the watch with movedTo", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const { address } = yield* busyDesign(designs);
        const fiber = yield* designs
          .watch(owner, address)
          .pipe(Stream.runCollect, Effect.flip, Effect.forkChild);
        yield* Effect.sleep("150 millis");
        yield* designs.move(owner, { ...address, to: projectA, expectedRevision: 2 });
        const error = yield* Fiber.join(fiber).pipe(Effect.timeout("8 seconds"));
        expect(error).toMatchObject({
          code: "not_found",
          detail: "Moved to Alpha.",
          movedTo: { owner: projectA, designId: address.designId },
        });
        // A new watch on the old address fails the same way straight away.
        expect(
          yield* designs.watch(owner, address).pipe(Stream.runCollect, Effect.flip),
        ).toMatchObject({ movedTo: { owner: projectA } });
      }),
    ),
  );
});
