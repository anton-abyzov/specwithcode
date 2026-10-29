import {
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  WS_METHODS,
  ProjectId,
  CommandId,
  WsRpcGroup,
  clientRpcRequiredScopes,
  type AuthEnvironmentScope,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthEnvironmentMaintainScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates ACP Registry discovery from provisioning", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverSearchAcpRegistry)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareAcpRegistryAgent)).toBe(
      AuthProvidersManageScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverUninstallAcpRegistryManagedBinary)).toBe(
      AuthProvidersManageScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverAcceptAcpRegistryUrlAuth)).toBe(
      AuthProvidersManageScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverListAcpRegistrySessions)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverImportAcpRegistrySession)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverLogoutAcpRegistry)).toBe(
      AuthProvidersManageScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsChecks)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("requires source control writes to start, retry, or cancel project clones", () => {
    for (const method of [
      WS_METHODS.projectCloneStart,
      WS_METHODS.projectCloneRetry,
      WS_METHODS.projectCloneCancel,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSourceControlWriteScope);
    }
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeProjectClones)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("separates viewing pull request file progress from writing it", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsFilesViewed)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsSetFilesViewed)).toBe(
      AuthSourceControlWriteScope,
    );
  });

  it("separates preview control from observation", () => {
    for (const method of [
      WS_METHODS.previewOpen,
      WS_METHODS.previewNavigate,
      WS_METHODS.previewResize,
      WS_METHODS.previewRefresh,
      WS_METHODS.previewClose,
      WS_METHODS.previewReportStatus,
      WS_METHODS.previewAdjust,
      WS_METHODS.previewClearProfile,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthPreviewOperateScope);
    }
    for (const method of [
      WS_METHODS.previewList,
      WS_METHODS.subscribePreviewEvents,
      WS_METHODS.subscribeDiscoveredLocalServers,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [
      WS_METHODS.terminalObserve,
      WS_METHODS.subscribeTerminalEvents,
      WS_METHODS.subscribeTerminalMetadata,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalRestart,
      WS_METHODS.terminalClose,
      WS_METHODS.terminalCloseIdle,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
    {
      scopes: [AuthOrchestrationReadScope, AuthDiagnosticsReadScope],
      missing: AuthEnvironmentMaintainScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

const designAssetResource = {
  _tag: "design-asset",
  owner: { kind: "playground" },
  designId: "d_abc",
  asset: `${"a".repeat(64)}.png`,
} as const;

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
      designAssetResource,
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("mints design image URLs only with filesystem:read, like design.get", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    const makeClient = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
              Effect.succeed({ relativeUrl: "/api/assets/design", expiresAt: 1 }),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
    const denied = yield* makeClient([AuthOrchestrationReadScope]);
    expect(
      yield* denied[WS_METHODS.assetsCreateUrl]({ resource: designAssetResource }).pipe(
        Effect.flip,
      ),
    ).toMatchObject({ requiredPermission: AuthFilesystemReadScope });
    const allowed = yield* makeClient([AuthFilesystemReadScope]);
    expect(
      yield* allowed[WS_METHODS.assetsCreateUrl]({ resource: designAssetResource }),
    ).toMatchObject({ relativeUrl: "/api/assets/design" });
  }).pipe(Effect.scoped),
);

describe("project plan command authorization", () => {
  const tested = [WS_METHODS.projectsPlanVerify] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  it.effect.each([
    { scopes: [AuthOrchestrationOperateScope], missing: AuthTerminalOperateScope },
    { scopes: [AuthTerminalOperateScope], missing: AuthOrchestrationOperateScope },
    { scopes: [AuthOrchestrationReadScope], missing: AuthOrchestrationOperateScope },
  ])("rejects verification without $missing before execution", ({ scopes, missing }) =>
    Effect.gen(function* () {
      let invoked = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.projectsPlanVerify, () =>
              Effect.sync(() => {
                invoked = true;
              }).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.projectsPlanVerify]({
          projectId: ProjectId.make("project"),
          taskId: "T-1",
          expectedRevision: 1,
          commandId: CommandId.make("command"),
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: missing });
      expect(invoked).toBe(false);
    }),
  );
});

it.effect("rejects native config discovery without filesystem read before reading files", () =>
  Effect.gen(function* () {
    const method = WS_METHODS.nativeConnectionsRead;
    expect(requiredScopeForRpcMethod(method)).toBe(AuthFilesystemReadScope);
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> => tag !== method,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(method, () =>
            Effect.sync(() => {
              handled = true;
              return {
                observedAt: new Date().toISOString(),
                sources: [],
                connections: [],
                truncated: false,
                runtime: "unverified" as const,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    const error = yield* client[method]({}).pipe(Effect.flip);
    expect(error._tag).toBe("EnvironmentAuthorizationError");
    expect(handled).toBe(false);
  }),
);

describe("project link authorization", () => {
  const tested = [WS_METHODS.projectLinkAccept] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const member = {
    environmentId: "m4" as never,
    projectId: ProjectId.make("kept"),
    coordinatorThreadId: ThreadId.make("project-coordinator:kept"),
  };
  it.effect.each([
    { scopes: [AuthOrchestrationOperateScope], missing: AuthSettingsWriteScope },
    { scopes: [AuthSettingsWriteScope], missing: AuthOrchestrationOperateScope },
  ])(
    "rejects relinquishing a coordinator without $missing before execution",
    ({ scopes, missing }) =>
      Effect.gen(function* () {
        let invoked = false;
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.projectLinkAccept, () =>
                Effect.sync(() => {
                  invoked = true;
                }).pipe(Effect.andThen(Effect.never)),
              ),
              RpcAuthorization.layer(scopes),
            ),
          ),
        );
        expect(
          yield* client[WS_METHODS.projectLinkAccept]({
            operationId: "11111111-1111-4111-8111-111111111111",
            projectId: ProjectId.make("joining"),
            kept: member,
            logicalProject: {
              id: "logical:kept",
              title: "EasyChamp",
              coordinatorId: "coordinator:logical:kept",
              members: [member],
            },
            coordinatorBinding: { epoch: 0, state: "active" },
            keptFingerprint: {
              root: "folder",
              repositories: [],
              skippedLinks: 0,
              truncated: false,
            },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: missing });
        expect(invoked).toBe(false);
      }),
  );
});

describe("skills control center authorization", () => {
  const tested = [
    WS_METHODS.projectsSkillsVersions,
    WS_METHODS.projectsSkillsAction,
    WS_METHODS.projectsSkillsFleetPush,
    WS_METHODS.projectsSkillsStudioLink,
  ] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const projectId = ProjectId.make("project");
  const toggle = (provider: string) =>
    ({
      kind: "toggle-skill",
      provider: ProviderDriverKind.make(provider),
      instanceId: ProviderInstanceId.make(provider),
      enabled: false,
      scope: "user",
    }) as const;
  const actions = [
    { action: { kind: "install-version", version: "1.2.3" }, wide: true },
    { action: { kind: "pin", version: "1.2.3" }, wide: true },
    { action: { kind: "unpin" }, wide: true },
    { action: { kind: "update-latest" }, wide: true },
    { action: toggle("claudeAgent"), wide: false },
    { action: toggle("codex"), wide: true },
    {
      action: {
        kind: "toggle-plugin",
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: ProviderInstanceId.make("claudeAgent"),
        pluginId: "sw@specweave",
        enabled: false,
        scope: "user",
      },
      wide: true,
    },
  ] as const;

  it.each(actions)("asks the same scopes on client and server for $action.kind", (entry) => {
    const input = { projectId, skill: "sw-do", preview: true, action: entry.action };
    expect(clientRpcRequiredScopes(WS_METHODS.projectsSkillsAction, input)).toEqual(
      entry.wide
        ? [AuthFilesystemWriteScope, AuthTerminalOperateScope]
        : [AuthFilesystemWriteScope],
    );
  });

  it("reads versions with read access, pushes with maintain and links with operate", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.projectsSkillsVersions)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectsSkillsFleetPush)).toBe(
      AuthEnvironmentMaintainScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.projectsSkillsStudioLink)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it.effect.each(actions.filter((entry) => entry.wide))(
    "rejects $action.kind without terminal operate before its handler runs",
    (entry) =>
      Effect.gen(function* () {
        let invoked = false;
        const never = () =>
          Effect.sync(() => {
            invoked = true;
          }).pipe(Effect.andThen(Effect.never));
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.projectsSkillsVersions, never),
              group.toLayerHandler(WS_METHODS.projectsSkillsAction, never),
              group.toLayerHandler(WS_METHODS.projectsSkillsFleetPush, never),
              group.toLayerHandler(WS_METHODS.projectsSkillsStudioLink, never),
              RpcAuthorization.layer([AuthFilesystemWriteScope, AuthOrchestrationOperateScope]),
            ),
          ),
        );
        expect(
          yield* client[WS_METHODS.projectsSkillsAction]({
            projectId,
            skill: "sw-do",
            preview: false,
            action: entry.action,
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthTerminalOperateScope });
        expect(
          yield* client[WS_METHODS.projectsSkillsFleetPush]({
            projectId,
            skillId: "anton-abyzov/vskill/sw-do",
            version: "1.2.3",
            pin: true,
            targets: [{ machineId: "m3", scope: "user" }],
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthEnvironmentMaintainScope });
        expect(invoked).toBe(false);
      }).pipe(Effect.scoped),
  );
});
