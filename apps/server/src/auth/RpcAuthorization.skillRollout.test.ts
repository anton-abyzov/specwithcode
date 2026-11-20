import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
  clientRpcRequiredScopes,
  ProjectId,
  WS_METHODS,
  WsRpcGroup,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import { RPC_REQUIRED_SCOPES } from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

const projectId = ProjectId.make("project");
const keepRecord = {
  projectId,
  repo: "owner/repo",
  skill: "sw-do",
  scope: "user",
} as const;

describe("keep-updated records and Adopt: the client gate", () => {
  it("reads with read access and asks for more to change anything", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillsRolloutKeep, {
        projectId,
        operation: "read",
      }),
    ).toEqual([AuthOrchestrationReadScope]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillsRolloutKeep, {
        ...keepRecord,
        operation: "set",
        machineIds: ["m5"],
      }),
    ).toEqual([AuthOrchestrationReadScope, AuthSettingsWriteScope]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillsAdopt, { projectId, operation: "check" }),
    ).toEqual([AuthFilesystemReadScope]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillsAdopt, {
        projectId,
        operation: "adopt",
        skill: "sw-do",
      }),
    ).toEqual([AuthFilesystemReadScope, AuthFilesystemWriteScope]);
    // A pull request is an outward GitHub write.
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillsAdopt, {
        projectId,
        operation: "propose",
        skill: "sw-do",
        repo: "owner/repo",
        fingerprint: "f",
        confirmed: true,
      }),
    ).toEqual([AuthFilesystemReadScope, AuthSourceControlWriteScope, AuthTerminalOperateScope]);
    expect(clientRpcRequiredScopes(WS_METHODS.projectsSkillsAdopt, undefined)).toEqual([
      AuthFilesystemReadScope,
      AuthSourceControlWriteScope,
      AuthTerminalOperateScope,
    ]);
  });
});

describe("keep-updated records and Adopt: the server refusal", () => {
  const tested = [WS_METHODS.projectsSkillsRolloutKeep, WS_METHODS.projectsSkillsAdopt] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const clientWith = (scopes: ReadonlyArray<AuthEnvironmentScope>, invoked: { count: number }) => {
    const handler = () =>
      Effect.sync(() => {
        invoked.count += 1;
      }).pipe(Effect.andThen(Effect.never));
    return RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.projectsSkillsRolloutKeep, handler),
          group.toLayerHandler(WS_METHODS.projectsSkillsAdopt, handler),
          RpcAuthorization.layer(scopes),
        ),
      ),
    );
  };

  it.effect("refuses a keep-updated change without settings write before its handler runs", () =>
    Effect.gen(function* () {
      const invoked = { count: 0 };
      const client = yield* clientWith([AuthOrchestrationReadScope], invoked);
      expect(
        yield* client[WS_METHODS.projectsSkillsRolloutKeep]({
          ...keepRecord,
          operation: "set",
          machineIds: ["m5"],
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(invoked.count).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses Adopt without file write and a proposal without source control write", () =>
    Effect.gen(function* () {
      const invoked = { count: 0 };
      const reader = yield* clientWith(
        [AuthFilesystemReadScope, AuthTerminalOperateScope],
        invoked,
      );
      expect(
        yield* reader[WS_METHODS.projectsSkillsAdopt]({
          projectId,
          operation: "adopt",
          skill: "sw-do",
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthFilesystemWriteScope });
      expect(
        yield* reader[WS_METHODS.projectsSkillsAdopt]({
          projectId,
          operation: "propose",
          skill: "sw-do",
          repo: "owner/repo",
          fingerprint: "f",
          confirmed: true,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSourceControlWriteScope });
      expect(invoked.count).toBe(0);
    }).pipe(Effect.scoped),
  );
});
