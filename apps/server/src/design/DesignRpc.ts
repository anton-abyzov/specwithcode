import {
  AuthAccessWriteScope,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceContextResolutionError,
  WS_METHODS,
  WsDesignRpcGroup,
  type AssetResource,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { issueAssetUrl } from "../assets/AssetAccess.ts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import { DesignService, layerWithRender, type DesignCaller } from "./DesignService.ts";
import * as DesignSystemRpc from "./systems/DesignSystemRpc.ts";
import { DesignSystemProposals, discardProposalsForSystem } from "./systems/DesignSystemService.ts";
import * as DesignSystems from "./systems/adapters.ts";
import { DesignWsHandlers } from "../project/ProjectWorkspaceRpc.ts";

/**
 * Sessions of the owner on this machine: the desktop app, the startup link
 * the server prints, the local CLI and development tokens. Every other
 * session (a paired phone or browser, a device sign-in, a linked machine, an
 * MCP client) is a member and gets the design's `members` access, unless it
 * holds `access:write` (see `designCallerForSession`).
 */
const OWNER_SESSION_SUBJECTS: ReadonlySet<string> = new Set([
  "desktop-bootstrap",
  "administrative-bootstrap",
  "cli-issued-session",
  "reusable-dev-token",
  "reusable-dev-token-child",
]);

/**
 * The design caller for a connection. A session that holds `access:write`
 * already manages who may connect here (pairing links, sessions), so it is the
 * owner too: that is how the desktop app signs in to a service it did not
 * start (it pairs through the service's CLI, subject `one-time-token`, with
 * the administrative scopes), and without it the app could not bind a design
 * to the thread it had just started.
 */
export const designCallerForSession = (
  session: Pick<AuthenticatedSession, "subject" | "scopes">,
): DesignCaller => ({
  actor: { kind: "user" },
  audience:
    OWNER_SESSION_SUBJECTS.has(session.subject) || session.scopes.includes(AuthAccessWriteScope)
      ? "owner"
      : "members",
});

/**
 * The `design.*` and `designSystem.*` handlers for one connection (see
 * `WsDesignRpcGroup`). Needs the server's one `DesignSystemProposals`, since
 * deleting a system discards the open proposals that would update it.
 */
export const layerRpcHandlers = (session: Pick<AuthenticatedSession, "subject" | "scopes">) =>
  WsDesignRpcGroup.middleware(RpcInstrumentation).toLayer(
    Effect.gen(function* () {
      const designs = yield* DesignService;
      const proposals = yield* DesignSystemProposals;
      const caller = designCallerForSession(session);
      return {
        [WS_METHODS.designList]: (input) => designs.list(caller, input),
        [WS_METHODS.designGet]: (input) => designs.get(caller, input),
        [WS_METHODS.designCreate]: (input) => designs.create(caller, input),
        [WS_METHODS.designApply]: (input) => designs.apply(caller, input),
        [WS_METHODS.designHistory]: (input) => designs.history(caller, input),
        [WS_METHODS.designSaveVersion]: (input) => designs.saveVersion(caller, input),
        [WS_METHODS.designRestore]: (input) => designs.restore(caller, input),
        [WS_METHODS.designCopy]: (input) => designs.copy(caller, input),
        [WS_METHODS.designDelete]: (input) => designs.remove(caller, input),
        [WS_METHODS.designAssetPut]: (input) => designs.putAsset(caller, input),
        [WS_METHODS.designExport]: (input) => designs.export(caller, input),
        [WS_METHODS.designWatch]: (input) => designs.watch(caller, input),
        [WS_METHODS.designSystemList]: (input) => designs.systemList(caller, input),
        [WS_METHODS.designSystemGet]: (input) => designs.systemGet(caller, input),
        [WS_METHODS.designSystemCopy]: (input) => designs.systemCopy(caller, input),
        [WS_METHODS.designSystemRename]: (input) => designs.systemRename(caller, input),
        [WS_METHODS.designSystemDelete]: (input) =>
          designs.systemRemove(caller, input).pipe(
            Effect.map(({ deleted, owner }) => {
              discardProposalsForSystem(proposals, owner, input.systemId);
              return { deleted };
            }),
          ),
        [WS_METHODS.designSystemUsage]: (input) => designs.systemUsage(caller, input),
      };
    }),
  );

/**
 * A signed URL for one of a design's images. The file comes from the design's
 * owner after the same checks as design.get; a missing design or image, or one
 * the caller may not open, is reported as not found.
 */
export const issueDesignAssetUrl = (
  designs: DesignService["Service"],
  caller: DesignCaller,
  resource: Extract<AssetResource, { readonly _tag: "design-asset" }>,
) =>
  designs.assetFile(caller, resource).pipe(
    Effect.mapError(
      (error): AssetWorkspaceAssetNotFoundError | AssetWorkspaceContextResolutionError =>
        error.code === "operation_failed"
          ? new AssetWorkspaceContextResolutionError({ resource, cause: error })
          : new AssetWorkspaceAssetNotFoundError({ resource }),
    ),
    Effect.flatMap((designAssetFile) => issueAssetUrl({ resource, designAssetFile })),
  );

/**
 * What `/ws` adds for designs, so ws.ts takes a single import (its type graph
 * is near TypeScript's instantiation depth): one DesignService for the server's
 * lifetime, rendering in its headless browser, with each connection's design
 * handlers and design image URLs over it.
 */
export const makeWsLayers = Effect.gen(function* () {
  const previewBrowser = yield* PreviewBrowser.PreviewBrowser;
  // Design-system proposals are the server's, shared with the MCP tools.
  const proposals = yield* DesignSystemProposals;
  const context = yield* Layer.build(
    layerWithRender.pipe(
      Layer.provide(Layer.succeed(PreviewBrowser.PreviewBrowser, previewBrowser)),
    ),
  );
  const designs = Context.get(context, DesignService);
  return {
    layerRpcHandlers: (session: Pick<AuthenticatedSession, "subject" | "scopes">) =>
      Layer.merge(
        layerRpcHandlers(session),
        DesignSystemRpc.layerRpcHandlers(designCallerForSession(session)).pipe(
          Layer.provide(DesignSystems.layer),
        ),
      ).pipe(
        Layer.provide(Layer.succeed(DesignSystemProposals, proposals)),
        Layer.provide(Layer.succeed(DesignService, designs)),
      ),
    issueAssetUrl: (
      session: Pick<AuthenticatedSession, "subject" | "scopes">,
      resource: Extract<AssetResource, { readonly _tag: "design-asset" }>,
    ) => issueDesignAssetUrl(designs, designCallerForSession(session), resource),
  };
});

/** Provides `DesignWsHandlers`, which ws.ts reads to serve the design RPCs. */
export const layerWsHandlers = Layer.effect(
  DesignWsHandlers,
  Effect.gen(function* () {
    const layers = yield* makeWsLayers;
    const services = yield* Effect.context<
      | Layer.Services<ReturnType<typeof layers.layerRpcHandlers>>
      | Effect.Services<ReturnType<typeof layers.issueAssetUrl>>
    >();
    return DesignWsHandlers.of({
      layerRpcHandlers: (session) =>
        layers.layerRpcHandlers(session).pipe(Layer.provide(Layer.succeedContext(services))),
      issueAssetUrl: (session, resource) =>
        layers.issueAssetUrl(session, resource).pipe(Effect.provideContext(services)),
    });
  }),
);
