// @effect-diagnostics anyUnknownInErrorContext:off -- the project, memory and Connect services are loosely typed fakes.
/**
 * The `memory-export` and `memory-merge` peer paths for a linked personal
 * assistant while the owner's switch is off here (1448 D-12): a seat still
 * linked then gives a peer that drives the pair nothing and takes nothing.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type PersonalAssistantShared,
  type Project,
  ProjectId,
  type ServerSettings as ServerSettingsValue,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CloudLink from "../cloud/CloudLink.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import type { HandoffRefusal, ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LinkedMemoryPeers from "./LinkedMemoryPeers.ts";
import { LinkedMemorySync } from "./LinkedMemorySync.ts";
import { PERSONAL_SWITCH_OFF_MESSAGE, personalSwitchGuard } from "./LinkedPeerRoute.ts";
import * as ProjectService from "./ProjectService.ts";

const SELF = EnvironmentId.make("env-laptop");
const PEER = EnvironmentId.make("env-desktop");
const SELF_SEAT = ProjectId.make("percy-laptop");
const PEER_SEAT = ProjectId.make("percy-desktop");
const USER = "user_owner_1";

const member = (environmentId: EnvironmentId, projectId: ProjectId) => ({
  environmentId,
  projectId,
  coordinatorThreadId: `project-coordinator:${projectId}`,
});

const copyOf = (kind: "personal" | "code"): Project =>
  ({
    id: SELF_SEAT,
    title: "Percy",
    deletedAt: null,
    workspaceSettings: {
      kind,
      logicalProject: {
        id: "logical:percy",
        coordinatorId: `project-coordinator:${SELF_SEAT}`,
        members: [member(SELF, SELF_SEAT), member(PEER, PEER_SEAT)],
      },
    },
  }) as unknown as Project;

const ownCaller: ReceiverCaller = {
  sourceEnvironmentId: PEER,
  grant: {
    coordinatorEnvironmentId: PEER,
    kind: "own",
    owner: "self",
    legacy: false,
    revoked: false,
    maxRuntimeMode: "full-access",
    projects: { kind: "none" },
    accounts: { kind: "all" },
  } as unknown as EffectiveWorkGrant,
  runtimeCeiling: "full-access",
  cloudUserId: USER,
};

/** The laptop's receiver, with its switch as given; records every memory call it lets through. */
const laptop = (enabled: boolean) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const project = copyOf("personal");
    const layer = Layer.mergeAll(
      Layer.succeed(ProjectService.ProjectService, {
        getById: (id: ProjectId) =>
          Effect.succeed(id === project.id ? Option.some(project) : Option.none()),
      } as never),
      Layer.succeed(LinkedMemorySync, {
        memoryExport: () =>
          Effect.sync(() => {
            calls.push("export");
            return { environmentId: SELF, files: [], tombstones: [], digest: "d" } as never;
          }),
        memoryMerge: () =>
          Effect.sync(() => {
            calls.push("merge");
            return {} as never;
          }),
      } as never),
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(SELF),
      } as never),
      Layer.succeed(CloudLink.CloudLink, {
        linkState: () => Effect.succeed({ linked: true, cloudUserId: USER }),
      } as never),
      Layer.succeed(ServerSecretStore.ServerSecretStore, {
        get: () => Effect.succeed(Option.none()),
      } as never),
      ServerSettings.layerTest({
        personalAssistantShared: { enabled, machines: [PEER] } satisfies PersonalAssistantShared,
      }),
    );
    const receiver = yield* Effect.provide(LinkedMemoryPeers.makeReceiver, layer);
    return { receiver, calls };
  });

const refusalOf = <A>(effect: Effect.Effect<A, HandoffRefusal>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((refusal) => ({ code: refusal.code, message: refusal.message })),
  );

describe("LinkedMemoryPeers: a linked Percy seat and the owner's switch", () => {
  it.effect("moves memory while the switch is on here", () =>
    Effect.gen(function* () {
      const { receiver, calls } = yield* laptop(true);
      yield* receiver.memoryExport(ownCaller, { projectId: SELF_SEAT, forProjectId: PEER_SEAT });
      assert.deepStrictEqual(calls, ["export"]);
    }),
  );

  it.effect("exports and merges nothing while the switch is off here, though still linked", () =>
    Effect.gen(function* () {
      const { receiver, calls } = yield* laptop(false);
      const exported = yield* refusalOf(
        receiver.memoryExport(ownCaller, { projectId: SELF_SEAT, forProjectId: PEER_SEAT }),
      );
      assert.deepStrictEqual(exported, { code: "invalid", message: PERSONAL_SWITCH_OFF_MESSAGE });
      const merged = yield* refusalOf(
        receiver.memoryMerge(ownCaller, {
          projectId: SELF_SEAT,
          peer: { environmentId: PEER, projectId: PEER_SEAT, label: "Desktop" },
          export: { environmentId: PEER, files: [], tombstones: [] } as never,
        }),
      );
      assert.deepStrictEqual(merged, { code: "invalid", message: PERSONAL_SWITCH_OFF_MESSAGE });
      assert.deepStrictEqual(calls, []);
    }),
  );
});

describe("personalSwitchGuard", () => {
  const settingsWith = (read: Effect.Effect<ServerSettingsValue, unknown>) =>
    Option.some({
      getSettings: read,
    } as unknown as ServerSettings.ServerSettingsService["Service"]);
  const off = Effect.succeed({
    personalAssistantShared: { enabled: false, machines: [] },
  } as unknown as ServerSettingsValue);

  it.effect("passes a code project whatever the switch says", () =>
    Effect.gen(function* () {
      const project = yield* personalSwitchGuard(settingsWith(off))(copyOf("code"));
      assert.strictEqual(project.id, SELF_SEAT);
    }),
  );

  it.effect("refuses a personal seat when the settings cannot be read", () =>
    Effect.gen(function* () {
      const refusal = yield* refusalOf(
        personalSwitchGuard(settingsWith(Effect.fail("unreadable")))(copyOf("personal")),
      );
      assert.strictEqual(refusal.message, PERSONAL_SWITCH_OFF_MESSAGE);
    }),
  );
});
