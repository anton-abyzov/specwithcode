// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Reads the files the store wrote.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "@effect/vitest";
import {
  PROJECT_DESIGN_DIR,
  type DesignError,
  type DesignOperation,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DesignService from "./DesignService.ts";
import {
  agentIn,
  HERE,
  LINKED,
  layerDesignService,
  makeDesignFixture,
  member,
  owner,
  PROJECT_A,
  PROJECT_B,
  REMOTE,
  REMOTE_PROJECT,
  scratchAgent,
  TEST_BROWSER_ENV,
  type DesignFixture,
} from "./DesignService.testkit.ts";

const withDesigns = <A, E>(
  run: (
    designs: DesignService.DesignService["Service"],
    fixture: DesignFixture,
  ) => Effect.Effect<A, E, ServerConfig.ServerConfig>,
  executable?: string,
) =>
  Effect.acquireUseRelease(
    Effect.sync(makeDesignFixture),
    (fixture) =>
      Effect.gen(function* () {
        const designs = yield* DesignService.DesignService;
        return yield* run(designs, fixture);
      }).pipe(Effect.provide(layerDesignService(fixture, executable))),
    (fixture) => Effect.sync(fixture.cleanup),
  );

const projectA = { kind: "project", projectId: PROJECT_A } as const;
const projectB = { kind: "project", projectId: PROJECT_B } as const;
const playground = { kind: "playground" } as const;

const rect = (id: string, x = 10): DesignOperation => ({
  op: "add_node",
  pageId: "",
  node: { id, parentId: null, type: "rect", x, y: 10, width: 40, height: 40, fill: "#e33" },
});
const onPage = (pageId: string, operation: DesignOperation): DesignOperation =>
  "pageId" in operation ? ({ ...operation, pageId } as DesignOperation) : operation;

describe("DesignService ownership", () => {
  it.effect("stores project designs in the checkout and Playground designs in the app home", () =>
    withDesigns((designs, fixture) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const created = yield* designs.create(owner, {
          owner: projectA,
          kind: "design",
          title: "Home",
        });
        expect(created.ref).toMatchObject({
          owner: { kind: "project", environmentId: HERE, projectId: PROJECT_A },
          path: `${PROJECT_DESIGN_DIR}/${created.document.id}/design.json`,
        });
        expect(NodeFS.existsSync(NodePath.join(fixture.roots[PROJECT_A]!, created.ref.path))).toBe(
          true,
        );
        const mine = yield* designs.create(owner, {
          owner: playground,
          kind: "slides",
          title: "Deck",
        });
        expect(mine.ref.owner).toEqual({ kind: "playground", environmentId: HERE });
        expect(
          NodeFS.existsSync(
            NodePath.join(config.stateDir, "design/playground", mine.document.id, "design.json"),
          ),
        ).toBe(true);
        const listed = yield* designs.list(owner, { filter: { kind: "all" } });
        expect(listed.designs.map((design) => [design.ownerLabel, design.kind])).toEqual(
          expect.arrayContaining([
            ["Alpha", "design"],
            ["Playground", "slides"],
          ]),
        );
        const onlyPlayground = yield* designs.list(owner, { filter: { kind: "playground" } });
        expect(onlyPlayground.designs.map((design) => design.title)).toEqual(["Deck"]);
      }),
    ),
  );

  it.effect("keeps a project thread out of other projects and the Playground (AC-07)", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const inB = yield* designs.create(owner, { owner: projectB, kind: "design", title: "B" });
        const inPlayground = yield* designs.create(owner, {
          owner: playground,
          kind: "design",
          title: "P",
        });
        const agentA = agentIn(PROJECT_A);
        for (const attempt of [
          designs.get(agentA, { owner: projectB, designId: inB.document.id }),
          designs.apply(agentA, {
            owner: projectB,
            designId: inB.document.id,
            expectedRevision: 0,
            operations: [{ op: "set_title", title: "Taken" }],
          }),
          designs.get(agentA, { owner: playground, designId: inPlayground.document.id }),
          designs.create(agentA, { owner: playground, kind: "design", title: "No" }),
          designs
            .systemList(agentA, { filter: { kind: "all" } })
            .pipe(
              Effect.flatMap(() => designs.systemGet(agentA, { owner: projectB, systemId: "s_x" })),
            ),
          designs.get(scratchAgent, { owner: projectB, designId: inB.document.id }),
        ] as ReadonlyArray<Effect.Effect<object, DesignError>>) {
          expect(yield* Effect.flip(attempt)).toMatchObject({ code: "forbidden" });
        }
        // Listing everything still shows only the thread's own owner.
        const own = yield* designs.create(agentA, { owner: projectA, kind: "design", title: "A" });
        const seen = yield* designs.list(agentA, { filter: { kind: "all" } });
        expect(seen.designs.map((design) => design.ref.designId)).toEqual([own.document.id]);
        expect(own.document.createdBy).toMatchObject({ kind: "agent", model: "claude-opus-5-5" });
        const scratch = yield* designs.list(scratchAgent, { filter: { kind: "all" } });
        expect(scratch.designs.map((design) => design.ref.designId)).toEqual([
          inPlayground.document.id,
        ]);
        expect(
          (yield* designs.get(owner, { owner: projectB, designId: inB.document.id })).document
            .title,
        ).toBe("B");
      }),
    ),
  );

  it.effect(
    "applies operations under compare-and-set and returns the current revision on conflict",
    () =>
      withDesigns((designs) =>
        Effect.gen(function* () {
          const created = yield* designs.create(owner, {
            owner: projectA,
            kind: "design",
            title: "CAS",
          });
          const pageId = created.document.pages[0]!.id;
          const applied = yield* designs.apply(owner, {
            owner: projectA,
            designId: created.document.id,
            expectedRevision: 0,
            operations: [onPage(pageId, rect("n_one"))],
          });
          expect(applied.document.revision).toBe(1);
          const conflict = yield* Effect.flip(
            designs.apply(owner, {
              owner: projectA,
              designId: created.document.id,
              expectedRevision: 0,
              operations: [onPage(pageId, rect("n_two"))],
            }),
          );
          expect(conflict).toMatchObject({ code: "conflict", currentRevision: 1 });
          const missing = yield* Effect.flip(
            designs.apply(owner, {
              owner: projectA,
              designId: created.document.id,
              expectedRevision: 1,
              operations: [{ op: "delete_node", pageId, id: "n_nope" }],
            }),
          );
          expect(missing).toMatchObject({ code: "not_found" });
          const foreignSystem = yield* Effect.flip(
            designs.apply(owner, {
              owner: projectA,
              designId: created.document.id,
              expectedRevision: 1,
              operations: [{ op: "set_design_system", systemId: "s_elsewhere" }],
            }),
          );
          expect(foreignSystem).toMatchObject({ code: "invalid" });
        }),
      ),
  );

  it.effect(
    "copies between owners with provenance and never moves or links the source (AC-06)",
    () =>
      withDesigns((designs, fixture) =>
        Effect.gen(function* () {
          const created = yield* designs.create(owner, {
            owner: projectA,
            kind: "design",
            title: "Hero",
          });
          const asset = yield* designs.putAsset(owner, {
            owner: projectA,
            designId: created.document.id,
            mimeType: "image/svg+xml",
            data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64"),
          });
          const pageId = created.document.pages[0]!.id;
          const withImage = yield* designs.apply(owner, {
            owner: projectA,
            designId: created.document.id,
            expectedRevision: 0,
            operations: [
              {
                op: "add_node",
                pageId,
                node: {
                  id: "n_img",
                  parentId: null,
                  type: "image",
                  asset: asset.asset,
                  x: 0,
                  y: 0,
                  width: 10,
                  height: 10,
                },
              },
              { op: "set_access", agents: "view" },
            ],
          });
          const copy = yield* designs.copy(owner, {
            owner: projectA,
            designId: created.document.id,
            to: playground,
          });
          expect(copy.document.id).not.toBe(created.document.id);
          expect(copy.document.revision).toBe(0);
          expect(copy.document.copiedFrom).toMatchObject({
            owner: { kind: "project", projectId: PROJECT_A },
            id: created.document.id,
            revision: withImage.document.revision,
          });
          expect(copy.document.access).toBeUndefined();
          expect(copy.ref.owner.kind).toBe("playground");
          const config = yield* ServerConfig.ServerConfig;
          expect(
            NodeFS.existsSync(
              NodePath.join(
                config.stateDir,
                "design/playground",
                copy.document.id,
                "assets",
                asset.asset,
              ),
            ),
          ).toBe(true);
          // The source is untouched.
          const source = yield* designs.get(owner, {
            owner: projectA,
            designId: created.document.id,
          });
          expect(source.document.revision).toBe(withImage.document.revision);
          expect(
            NodeFS.readdirSync(NodePath.join(fixture.roots[PROJECT_A]!, PROJECT_DESIGN_DIR)),
          ).toEqual([created.document.id]);
          expect(
            yield* Effect.flip(
              designs.copy(agentIn(PROJECT_A), {
                owner: projectA,
                designId: created.document.id,
                to: projectA,
              }),
            ),
          ).toMatchObject({ code: "forbidden" });
        }),
      ),
  );
});

describe("DesignService access levels (AC-14)", () => {
  it.effect(
    "holds members and agents to their levels and keeps access changes with the owner",
    () =>
      withDesigns((designs) =>
        Effect.gen(function* () {
          const created = yield* designs.create(owner, {
            owner: projectA,
            kind: "design",
            title: "Gate",
          });
          const designId = created.document.id;
          const pageId = created.document.pages[0]!.id;
          const at = (revision: number, operations: DesignOperation[], caller = member) =>
            designs.apply(caller, {
              owner: projectA,
              designId,
              expectedRevision: revision,
              operations,
            });
          // A member may not change access, even when allowed to edit.
          expect(yield* Effect.flip(at(0, [{ op: "set_access", agents: "edit" }]))).toMatchObject({
            code: "forbidden",
          });
          // Default access: members and agents edit.
          yield* at(0, [onPage(pageId, rect("n_member"))]);
          yield* at(1, [onPage(pageId, rect("n_agent"))], agentIn(PROJECT_A));
          yield* at(2, [{ op: "set_access", members: "comment", agents: "view" }], owner);
          const comment: DesignOperation = {
            op: "add_comment",
            comment: {
              id: "c_one",
              pageId,
              nodeId: null,
              x: 0,
              y: 0,
              text: "Tighter spacing?",
              author: { kind: "user" },
              createdAt: "2026-10-20T12:00:00.000Z",
              resolved: false,
            },
          };
          expect(yield* Effect.flip(at(3, [onPage(pageId, rect("n_late"))]))).toMatchObject({
            code: "forbidden",
            detail: expect.stringContaining("only comments"),
          });
          expect((yield* at(3, [comment])).document.comments).toHaveLength(1);
          expect(
            yield* Effect.flip(
              at(
                4,
                [{ op: "resolve_comment", commentId: "c_one", resolved: true }],
                agentIn(PROJECT_A),
              ),
            ),
          ).toMatchObject({ code: "forbidden", detail: expect.stringContaining("view-only") });
          const address = { owner: projectA, designId } as const;
          for (const attempt of [
            designs.restore(member, { ...address, revision: 0, expectedRevision: 4 }),
            designs.remove(member, address),
            designs.copy(member, { ...address, to: playground }),
            designs.saveVersion(agentIn(PROJECT_A), { ...address, name: "Mine" }),
            designs.putAsset(member, { ...address, mimeType: "image/png", data: "AAAA" }),
          ] as ReadonlyArray<Effect.Effect<object, DesignError>>) {
            expect(yield* Effect.flip(attempt)).toMatchObject({ code: "forbidden" });
          }
          // Reads stay open, and the owner always edits.
          expect((yield* designs.get(agentIn(PROJECT_A), address)).document.access).toEqual({
            members: "comment",
            agents: "view",
          });
          const restored = yield* designs.restore(owner, {
            ...address,
            revision: 0,
            expectedRevision: 4,
          });
          expect(restored.document.revision).toBe(5);
          // Restoring content never rolls access back.
          expect(restored.document.access).toEqual({ members: "comment", agents: "view" });
          expect((yield* designs.remove(owner, address)).deleted).toBe(true);
        }),
      ),
  );

  it.effect("records the bound thread and access in the listing (AC-16)", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const thread = { environmentId: HERE, threadId: "thread-project-a" as never };
        const created = yield* designs.create(agentIn(PROJECT_A), {
          owner: projectA,
          kind: "design",
          title: "Bound",
          thread,
        });
        expect(created.document.thread).toEqual(thread);
        yield* designs.apply(owner, {
          owner: projectA,
          designId: created.document.id,
          expectedRevision: 0,
          operations: [{ op: "set_access", members: "view" }],
        });
        const [summary] = (yield* designs.list(owner, {
          filter: { kind: "project", projectId: PROJECT_A },
        })).designs;
        expect(summary).toMatchObject({
          thread,
          access: { members: "view", agents: "edit" },
        });
      }),
    ),
  );
});

describe("DesignService references (AC-08, AC-15)", () => {
  it.effect("opens a reference made on a linked machine from this machine's checkout", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const here = yield* designs.create(owner, {
          owner: { kind: "project", projectId: LINKED },
          kind: "design",
          title: "Shared",
        });
        // The other machine's reference names its own project id and environment.
        const remoteRef = {
          owner: { kind: "project", projectId: REMOTE_PROJECT } as const,
          environmentId: REMOTE,
        };
        const opened = yield* designs.get(member, { ...remoteRef, designId: here.document.id });
        expect(opened.document.title).toBe("Shared");
        expect(opened.ref).toMatchObject({
          owner: { kind: "project", environmentId: HERE, projectId: LINKED },
          path: here.ref.path,
        });
        const notPulled = yield* Effect.flip(
          designs.get(member, { ...remoteRef, designId: "d_onlythere" }),
        );
        expect(notPulled).toMatchObject({
          code: "not_on_this_machine",
          member: { environmentId: REMOTE, projectId: REMOTE_PROJECT },
        });
        const unlinked = yield* Effect.flip(
          designs.get(member, {
            owner: { kind: "project", projectId: "project-elsewhere" as never },
            environmentId: REMOTE,
            designId: here.document.id,
          }),
        );
        expect(unlinked).toMatchObject({
          code: "not_on_this_machine",
          member: { environmentId: REMOTE, projectId: "project-elsewhere" },
        });
        // A thread of another project still cannot reach it through the link.
        expect(
          yield* Effect.flip(
            designs.get(agentIn(PROJECT_A), { ...remoteRef, designId: here.document.id }),
          ),
        ).toMatchObject({ code: "forbidden" });
        expect(
          yield* Effect.flip(
            designs.get(owner, { owner: playground, environmentId: REMOTE, designId: "d_x" }),
          ),
        ).toMatchObject({ code: "forbidden" });
      }),
    ),
  );
});

describe("DesignService watch", () => {
  it.live("streams each new revision, never faster than every 500 ms", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const created = yield* designs.create(owner, {
          owner: projectA,
          kind: "design",
          title: "Watch",
        });
        const address = { owner: projectA, designId: created.document.id } as const;
        const seen: Array<{ revision: number; at: number }> = [];
        const fiber = yield* designs.watch(owner, address).pipe(
          Stream.tap((result) =>
            Effect.map(Clock.currentTimeMillis, (at) =>
              seen.push({ revision: result.document.revision, at }),
            ),
          ),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.sleep("100 millis");
        yield* designs.apply(owner, {
          ...address,
          expectedRevision: 0,
          operations: [{ op: "set_title", title: "One" }],
        });
        yield* designs.apply(owner, {
          ...address,
          expectedRevision: 1,
          operations: [{ op: "set_title", title: "Two" }],
        });
        yield* Effect.sleep("700 millis");
        yield* designs.apply(owner, {
          ...address,
          expectedRevision: 2,
          operations: [{ op: "set_title", title: "Three" }],
        });
        const results = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"));
        expect(results.map((result) => result.document.revision)).toEqual([0, 2, 3]);
        expect(seen[2]!.at - seen[1]!.at).toBeGreaterThanOrEqual(
          DesignService.DESIGN_WATCH_INTERVAL_MS - 20,
        );
      }),
    ),
  );
});

/** Decodes a PNG far enough to prove its pixels are all there: IHDR, then inflated scanlines. */
function decodePng(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect(body[8]).toBe(8);
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[body[9]!]!;
    }
    if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const raw = NodeZlib.inflateSync(Buffer.concat(data));
  expect(raw.length).toBe(height * (1 + width * channels));
  return { width, height };
}

describe("DesignService export", () => {
  it.effect("exports standalone HTML of a frame", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const created = yield* designs.create(owner, {
          owner: projectA,
          kind: "design",
          title: "Landing page",
        });
        const page = created.document.pages[0]!;
        const exported = yield* designs.export(owner, {
          owner: projectA,
          designId: created.document.id,
          pageId: page.id,
          frameId: page.nodes[0]!.id,
          format: "html",
        });
        expect(exported).toMatchObject({
          fileName: "landing-page-frame-1.html",
          mimeType: "text/html",
          width: 1440,
          height: 1024,
        });
        expect(Buffer.from(exported.data, "base64").toString("utf8")).toContain("<!doctype html>");
      }),
    ),
  );

  it.live("exports a decodable PNG and a PDF with one page per slide not skipped", (ctx) =>
    Effect.gen(function* () {
      const executable = (yield* HostProcessEnvironment)[TEST_BROWSER_ENV];
      if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
      yield* withDesigns(
        (designs) =>
          Effect.gen(function* () {
            const created = yield* designs.create(owner, {
              owner: projectA,
              kind: "slides",
              title: "Deck",
            });
            const first = created.document.pages[0]!;
            const frame = (id: string) => ({
              id,
              parentId: null,
              type: "frame" as const,
              x: 0,
              y: 0,
              width: 640,
              height: 360,
              fill: "#123456",
            });
            const page = (id: string, skipped: boolean, frames: string[]) => ({
              op: "add_page" as const,
              page: {
                id,
                name: id,
                nodes: frames.map(frame),
                ...(skipped ? { skipped: true } : {}),
              },
            });
            yield* designs.apply(owner, {
              owner: projectA,
              designId: created.document.id,
              expectedRevision: 0,
              operations: [
                page("p_two", false, ["n_a", "n_b"]),
                page("p_skip", true, ["n_c"]),
                {
                  op: "add_node",
                  pageId: first.id,
                  node: {
                    id: "n_box",
                    parentId: first.nodes[0]!.id,
                    type: "rect",
                    x: 20,
                    y: 20,
                    width: 100,
                    height: 50,
                    fill: "#e33",
                  },
                },
              ],
            });
            const png = yield* designs.export(owner, {
              owner: projectA,
              designId: created.document.id,
              pageId: "p_two",
              frameId: "n_a",
              format: "png",
              scale: 2,
            });
            expect(png).toMatchObject({ mimeType: "image/png", width: 1280, height: 720 });
            expect(decodePng(Buffer.from(png.data, "base64"))).toEqual({
              width: 1280,
              height: 720,
            });
            const pdf = yield* designs.export(owner, {
              owner: projectA,
              designId: created.document.id,
              pageId: first.id,
              format: "pdf",
            });
            const bytes = Buffer.from(pdf.data, "base64");
            expect(bytes.toString("latin1", 0, 5)).toBe("%PDF-");
            // One page per slide (a slide is its page's first frame); the skipped page is left out.
            expect(bytes.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g)).toHaveLength(2);
          }),
        executable,
      );
    }),
  );
});
