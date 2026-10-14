import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  ProjectId,
  WS_METHODS,
  WsRpcGroup,
} from "@specweave-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Authorization from "../auth/RpcAuthorization.ts";

it.effect("allows inspection with read access and rejects import before its handler runs", () =>
  Effect.gen(function* () {
    const methods = [
      WS_METHODS.projectsEnvironmentImport,
      WS_METHODS.projectsEnvironmentImportPreview,
    ] as const;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof Authorization.RPC_REQUIRED_SCOPES,
          (typeof methods)[number]
        > => !methods.includes(tag as (typeof methods)[number]),
      ),
    );
    let applied = false;
    const preview = {
      revision: 0,
      root: "/work",
      fingerprint: "a".repeat(64),
      repositories: [],
      environment: { repositories: [], additionalFolders: [] },
      canApply: true,
    };
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.projectsEnvironmentImportPreview, () =>
            Effect.succeed(preview),
          ),
          group.toLayerHandler(WS_METHODS.projectsEnvironmentImport, () =>
            Effect.sync(() => {
              applied = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          Authorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    const projectId = ProjectId.make("rpc-import");
    expect(
      yield* client[WS_METHODS.projectsEnvironmentImportPreview]({ projectId, root: "/work" }),
    ).toEqual(preview);
    expect(
      yield* client[WS_METHODS.projectsEnvironmentImport]({
        projectId,
        root: "/work",
        expectedRevision: 0,
        fingerprint: preview.fingerprint,
        commandId: CommandId.make("rpc-apply"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(applied).toBe(false);
  }).pipe(Effect.scoped),
);
