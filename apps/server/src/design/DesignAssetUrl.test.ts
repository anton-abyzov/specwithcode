// @effect-diagnostics nodeBuiltinImport:off - Removes an asset file behind a minted URL.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { AssetCreateUrlInput, type AssetResource } from "@specweave-studio/contracts";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServerResponse } from "effect/http";

import { ASSET_ROUTE_PREFIX, resolveAsset } from "../assets/AssetAccess.ts";
import * as NativeAppIconResolver from "../assets/NativeAppIconResolver.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { assetFileResponse } from "../http.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as DesignRpc from "./DesignRpc.ts";
import * as DesignService from "./DesignService.ts";
import * as Store from "./DesignStore.ts";
import {
  agentIn,
  layerDesignService,
  makeDesignFixture,
  member,
  owner,
  PROJECT_A,
  PROJECT_B,
} from "./DesignService.testkit.ts";

type DesignAssetResource = Extract<AssetResource, { readonly _tag: "design-asset" }>;

const projectA = { kind: "project", projectId: PROJECT_A } as const;
const projectB = { kind: "project", projectId: PROJECT_B } as const;

// A 1x1 PNG: signature, then an IHDR that says 1 by 1.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SVG = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4'/>").toString(
  "base64",
);

const withAssets = <A, E, R>(run: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(makeDesignFixture),
    (fixture) =>
      run.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeHttpPlatform.layer,
            ServerSecretStore.layer,
            WorkspacePaths.layer,
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
            Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
          ).pipe(Layer.provideMerge(layerDesignService(fixture))),
        ),
      ),
    (fixture) => Effect.sync(fixture.cleanup),
  );

/** A design in project A holding one asset, as the canvas lane stores it. */
const designWithAsset = (mimeType: "image/png" | "image/svg+xml", data: string) =>
  Effect.gen(function* () {
    const designs = yield* DesignService.DesignService;
    const created = yield* designs.create(owner, { owner: projectA, kind: "design", title: "Art" });
    const { asset } = yield* designs.putAsset(owner, {
      owner: projectA,
      designId: created.document.id,
      mimeType,
      data,
    });
    const resource: DesignAssetResource = {
      _tag: "design-asset",
      owner: projectA,
      designId: created.document.id,
      asset,
    };
    return { designs, resource };
  });

const tokenOf = (relativeUrl: string) => {
  const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  const separator = suffix.indexOf("/");
  return { token: suffix.slice(0, separator), name: suffix.slice(separator + 1) };
};

const serve = (token: string, name: string) =>
  Effect.gen(function* () {
    const asset = yield* resolveAsset(token, name);
    if (asset === null || asset.kind !== "file") return null;
    return HttpServerResponse.toWeb(yield* assetFileResponse(asset));
  });

it.effect("mints and serves a design image through the signed asset route", () =>
  withAssets(
    Effect.gen(function* () {
      const { designs, resource } = yield* designWithAsset("image/png", PNG_1X1);
      // Anyone who may open the design gets a URL: the owner, and a paired device (members).
      for (const caller of [owner, member]) {
        const minted = yield* DesignRpc.issueDesignAssetUrl(designs, caller, resource);
        expect(minted.imageDimensions).toEqual({ width: 1, height: 1 });
        const { token, name } = tokenOf(minted.relativeUrl);
        expect(name).toBe(resource.asset);
        const response = yield* serve(token, name);
        expect(response?.status).toBe(200);
        expect(response?.headers.get("content-type")).toBe("image/png");
        expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response?.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
        expect(Buffer.from(yield* Effect.promise(() => response!.arrayBuffer()))).toEqual(
          Buffer.from(PNG_1X1, "base64"),
        );
        // The token names one file: another name, or a tampered token, is not found.
        expect(yield* resolveAsset(token, `${"0".repeat(64)}.png`)).toBeNull();
        expect(yield* resolveAsset(token, `../${name}`)).toBeNull();
        expect(yield* resolveAsset(`${token}x`, name)).toBeNull();
      }
    }),
  ),
);

it.effect("serves SVG images sandboxed", () =>
  withAssets(
    Effect.gen(function* () {
      const { designs, resource } = yield* designWithAsset("image/svg+xml", SVG);
      expect(resource.asset).toMatch(/\.svg$/);
      const minted = yield* DesignRpc.issueDesignAssetUrl(designs, owner, resource);
      const response = yield* serve(tokenOf(minted.relativeUrl).token, resource.asset);
      expect(response?.headers.get("content-type")).toBe("image/svg+xml");
      expect(response?.headers.get("content-security-policy")).toContain("sandbox");
      expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    }),
  ),
);

it.effect("refuses another owner's images and names a thread cannot reach", () =>
  withAssets(
    Effect.gen(function* () {
      const { designs, resource } = yield* designWithAsset("image/png", PNG_1X1);
      for (const [caller, attempt] of [
        // The same design id under another project: the file is looked up there, not here.
        [owner, { ...resource, owner: projectB }],
        [owner, { ...resource, owner: { kind: "playground" } }],
        // A thread of project B cannot reach project A's designs.
        [agentIn(PROJECT_B), resource],
      ] as const) {
        expect(
          yield* Effect.flip(DesignRpc.issueDesignAssetUrl(designs, caller, attempt)),
        ).toMatchObject({ _tag: "AssetWorkspaceAssetNotFoundError" });
      }
      expect(
        (yield* DesignRpc.issueDesignAssetUrl(designs, agentIn(PROJECT_A), resource)).relativeUrl,
      ).toContain(resource.asset);
    }),
  ),
);

it.effect("rejects bad asset names and reports a missing file as not found", () =>
  withAssets(
    Effect.gen(function* () {
      const { designs, resource } = yield* designWithAsset("image/png", PNG_1X1);
      const decode = Schema.decodeUnknownExit(AssetCreateUrlInput);
      for (const asset of [
        "../../design.json",
        `${"a".repeat(64)}.html`,
        `${"A".repeat(64)}.png`,
        "abc.png",
        `${"a".repeat(64)}.png/../x`,
      ]) {
        expect(decode({ resource: { ...resource, asset } })._tag, asset).toBe("Failure");
      }
      expect(decode({ resource })._tag).toBe("Success");
      const missing = `${"b".repeat(64)}.png`;
      expect(
        yield* Effect.flip(
          DesignRpc.issueDesignAssetUrl(designs, owner, { ...resource, asset: missing }),
        ),
      ).toMatchObject({ _tag: "AssetWorkspaceAssetNotFoundError" });
      // A file removed after its URL was minted is a 404, not a 500.
      const minted = yield* DesignRpc.issueDesignAssetUrl(designs, owner, resource);
      const { root } = yield* designs.ownerRoot(owner, projectA);
      NodeFS.rmSync(
        NodePath.join(
          Store.designFolder(root, resource.designId),
          Store.DESIGN_ASSETS_DIR,
          resource.asset,
        ),
      );
      expect(yield* resolveAsset(tokenOf(minted.relativeUrl).token, resource.asset)).toBeNull();
    }),
  ),
);

it.effect("inlines a page's images as data URIs in exports, never signed URLs", () =>
  withAssets(
    Effect.gen(function* () {
      const { designs, resource } = yield* designWithAsset("image/png", PNG_1X1);
      const { document } = yield* designs.get(owner, resource);
      const page = document.pages[0]!;
      const image = (id: string, asset: string) =>
        ({
          op: "add_node",
          pageId: page.id,
          node: {
            id,
            parentId: page.nodes[0]!.id,
            type: "image",
            asset,
            x: 0,
            y: 0,
            width: 10,
            height: 10,
          },
        }) as const;
      yield* designs.apply(owner, {
        ...resource,
        expectedRevision: 0,
        operations: [image("n_here", resource.asset), image("n_gone", `${"c".repeat(64)}.png`)],
      });
      const exported = yield* designs.export(owner, {
        ...resource,
        pageId: page.id,
        frameId: page.nodes[0]!.id,
        format: "html",
      });
      const html = Buffer.from(exported.data, "base64").toString("utf8");
      expect(html).toContain(`data:image/png;base64,${PNG_1X1}`);
      // A missing file still renders, as a transparent placeholder.
      expect(html).toContain("data:image/gif;base64,");
      expect(html).not.toContain(ASSET_ROUTE_PREFIX);
    }),
  ),
);
