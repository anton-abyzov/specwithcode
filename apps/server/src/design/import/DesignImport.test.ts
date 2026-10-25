// @effect-diagnostics nodeBuiltinImport:off - Reads the fixture deck and stored assets.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type * as ServerConfig from "../../config.ts";
import * as DesignService from "../DesignService.ts";
import {
  layerDesignService,
  makeDesignFixture,
  owner,
  scratchAgent,
  type DesignFixture,
} from "../DesignService.testkit.ts";
import { importDeck } from "./DesignImport.ts";
import { exportedDeck, minimalDeck } from "./pptxImport.testkit.ts";

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

const playground = { kind: "playground" } as const;

describe("design.importDeck (1051 AC-03)", () => {
  it.effect("imports a deck with as many slides as a slides document holds", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const bytes = minimalDeck({ slides: ["<p:sp/>"], listed: 200 });
        const result = yield* importDeck(designs, owner, {
          owner: playground,
          title: "Two hundred slides",
          designSystem: null,
          data: bytes.toString("base64"),
        });
        const { document } = yield* designs.get(owner, {
          owner: playground,
          designId: result.ref.designId,
        });
        expect(document.pages).toHaveLength(200);
      }),
    ),
  );

  it.effect("imports an exported deck as slides with notes and a stored picture", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const bytes = yield* Effect.promise(exportedDeck);
        const result = yield* importDeck(designs, owner, {
          owner: playground,
          title: "Imported round trip",
          designSystem: null,
          data: Buffer.from(bytes).toString("base64"),
        });
        expect(result.notImported).toEqual([]);
        const { document } = yield* designs.get(owner, {
          owner: playground,
          designId: result.ref.designId,
        });
        expect(document.kind).toBe("slides");
        expect(document.title).toBe("Imported round trip");
        expect(document.pages).toHaveLength(3);
        expect(document.pages.map((page) => page.notes)).toEqual([
          "Open with the date.",
          "Two lines and a picture.",
          "Thank the team.",
        ]);
        expect(document.pages[0]!.nodes[0]).toMatchObject({
          type: "frame",
          width: 1920,
          height: 1080,
          fill: "#0F172B",
        });
        const image = document.pages[1]!.nodes.find((node) => node.type === "image");
        expect(image?.type === "image" ? image.asset : "").toMatch(/^[a-f0-9]{64}\.png$/);
        const file = yield* designs.assetFile(owner, {
          owner: playground,
          designId: result.ref.designId,
          asset: image?.type === "image" ? image.asset : "",
        });
        expect(NodeFS.statSync(file).size).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect("keeps a third-party deck and lists what it could not import", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const bytes = NodeFS.readFileSync(
          NodePath.join(import.meta.dirname, "fixtures", "third-party-6-slides.pptx"),
        );
        const result = yield* importDeck(designs, owner, {
          owner: playground,
          title: "Third party",
          designSystem: null,
          data: bytes.toString("base64"),
        });
        expect(result.notImported.map((entry) => entry.slide)).toEqual([5, 6]);
        const { document } = yield* designs.get(owner, {
          owner: playground,
          designId: result.ref.designId,
        });
        expect(document.pages).toHaveLength(6);
        expect(document.pages.every((page) => (page.notes ?? "").startsWith("Notes"))).toBe(true);
      }),
    ),
  );

  it.effect("refuses agents and bad files without leaving a design behind", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const agent = yield* importDeck(designs, scratchAgent, {
          owner: playground,
          title: "Agent",
          designSystem: null,
          data: Buffer.from("x").toString("base64"),
        }).pipe(Effect.flip);
        expect(agent.code).toBe("forbidden");
        const bad = yield* importDeck(designs, owner, {
          owner: playground,
          title: "Broken",
          designSystem: null,
          data: Buffer.from("not a zip").toString("base64"),
        }).pipe(Effect.flip);
        expect(bad).toMatchObject({
          code: "invalid",
          detail: "The file is not a PowerPoint deck (.pptx).",
        });
        const listed = yield* designs.list(owner, { filter: { kind: "playground" } });
        expect(listed.designs).toEqual([]);
      }),
    ),
  );

  it.effect("removes the half-made design when the import is interrupted while filling", () =>
    withDesigns((designs) =>
      Effect.gen(function* () {
        const bytes = yield* Effect.promise(exportedDeck);
        const applying = yield* Deferred.make<void>();
        // The client goes away while the slides are being written.
        const stalled: typeof designs = {
          ...designs,
          apply: () => Deferred.succeed(applying, undefined).pipe(Effect.andThen(Effect.never)),
        };
        const fiber = yield* importDeck(stalled, owner, {
          owner: playground,
          title: "Interrupted",
          designSystem: null,
          data: Buffer.from(bytes).toString("base64"),
        }).pipe(Effect.forkChild);
        yield* Deferred.await(applying);
        const during = yield* designs.list(owner, { filter: { kind: "playground" } });
        expect(during.designs.map((design) => design.title)).toEqual(["Interrupted"]);
        yield* Fiber.interrupt(fiber);
        const after = yield* designs.list(owner, { filter: { kind: "playground" } });
        expect(after.designs).toEqual([]);
      }),
    ),
  );
});
