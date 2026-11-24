// @effect-diagnostics nodeBuiltinImport:off - one test reads this package's own sources.
/**
 * 1448 T-13: the owner's switch "Use my Percy on this machine", the account's
 * link id, and who may turn the switch (AC-03, AC-15, AC-16).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  DEFAULT_PERSONAL_ASSISTANT_NAME,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  type LogicalProjectMember,
  type PersonalAssistantShared,
  type Project,
  ProjectId,
  RpcScopeAuthorization,
  ThreadId,
  WS_METHODS,
} from "@specweave-studio/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as CloudLink from "../cloud/CloudLink.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetTargets from "../fleet/FleetTargets.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import { personalLinkIdForAccount } from "./personalLinkId.ts";
import { PersonalLinkSnapshot } from "./personalLinkSnapshot.ts";
import * as PersonalLinkService from "./PersonalLinkService.ts";
import * as PersonalRestorePoint from "./personalRestorePoint.ts";
import * as PersonalShare from "./PersonalShare.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";

/** The test clock's time when a test turns the switch on. */
const SWITCHED_ON = "1970-01-01T00:00:00.000Z";
const laptop = EnvironmentId.make("env-laptop");
const desktop = EnvironmentId.make("env-desktop");
const studio = EnvironmentId.make("env-studio");
const server = EnvironmentId.make("env-server");
const ACCOUNT = "user_test_0001";

const percyLaptop = ProjectId.make("proj-percy-laptop");
const percyDesktop = ProjectId.make("proj-percy-desktop");

const memberOf = (environmentId: EnvironmentId, projectId: ProjectId): LogicalProjectMember => ({
  environmentId,
  projectId,
  coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
});

const personalProject = (
  id: ProjectId,
  members?: ReadonlyArray<LogicalProjectMember>,
): Project => ({
  id,
  title: "Percy",
  workspaceRoot: `/tmp/personal/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
  faviconPath: null,
  projectIcon: { kind: "lucide", name: "sparkles", color: "violet" },
  workspaceSettings: {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    kind: "personal",
    revision: 1,
    ...(members === undefined
      ? {}
      : {
          logicalProject: {
            id: personalLinkIdForAccount(ACCOUNT),
            title: "Percy",
            coordinatorId: members[0]!.coordinatorThreadId,
            members: [...members],
          },
          coordinatorBinding: { epoch: 0, state: "active" as const, routineOwner: true },
        }),
  },
});

interface HarnessOptions {
  readonly projects?: ReadonlyArray<Project>;
  /** The Connect user this machine is linked to; null is not linked. */
  readonly cloudUserId?: string | null;
  readonly aideEnabled?: boolean;
  readonly shared?: PersonalAssistantShared;
  readonly peerStates?: ReadonlyMap<EnvironmentId, PersonalShare.PersonalSharePeerState>;
  readonly points?: ReadonlyArray<PersonalRestorePoint.PersonalRestorePointSummary>;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const store = new Map<ProjectId, Project>((options.projects ?? []).map((p) => [p.id, p]));
  const created: Array<{ readonly name: string; readonly kind: string | undefined }> = [];
  const writes: Array<PersonalAssistantShared> = [];
  const ownership: string[] = [];
  const points = options.points ?? [];
  /** Each restore, with whether the seat was still linked and the switch on at that moment. */
  const restores: Array<{
    readonly projectId: ProjectId;
    readonly id: string | undefined;
    readonly linked: boolean;
    readonly enabled: boolean;
  }> = [];
  const switchNow = () => writes.at(-1) ?? options.shared ?? { enabled: false, machines: [] };

  const environmentLayer = Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(laptop),
    getDescriptor: Effect.succeed({
      environmentId: laptop,
      label: "laptop.local",
      platform: { os: "darwin", arch: "arm64" },
    }),
  } as never);

  const projectLayer = Layer.succeed(ProjectService.ProjectService, {
    snapshot: Effect.sync(() => ({
      projects: [...store.values()],
      updatedAt: "2026-11-02T00:00:00.000Z",
    })),
    getById: (id: ProjectId) => Effect.sync(() => Option.fromUndefinedOr(store.get(id))),
    update: (input: {
      readonly projectId: ProjectId;
      readonly ownership?: {
        readonly mode: string;
        readonly logicalProject: unknown;
        readonly coordinatorBinding: unknown;
      };
    }) =>
      Effect.sync(() => {
        const existing = store.get(input.projectId)!;
        if (input.ownership) ownership.push(input.ownership.mode);
        const updated = {
          ...existing,
          workspaceSettings: {
            ...existing.workspaceSettings!,
            ...(input.ownership
              ? {
                  logicalProject: input.ownership.logicalProject,
                  coordinatorBinding: input.ownership.coordinatorBinding,
                }
              : {}),
            revision: (existing.workspaceSettings?.revision ?? 0) + 1,
          },
        } as Project;
        store.set(updated.id, updated);
        return updated;
      }),
  } as never);

  // What "Set up" does: the machine's assistant when there is one, else a new one.
  const foldersLayer = Layer.succeed(ManagedProjectFolders.ManagedProjectFolders, {
    createNamedProject: (input: { readonly name: string; readonly kind?: string }) =>
      Effect.sync(() => {
        const existing = [...store.values()].find(
          (project) => project.workspaceSettings?.kind === "personal",
        );
        if (existing) return { projectId: existing.id, workspaceRoot: existing.workspaceRoot };
        created.push({ name: input.name, kind: input.kind });
        const project = { ...personalProject(percyLaptop), title: input.name };
        store.set(project.id, project);
        return { projectId: project.id, workspaceRoot: project.workspaceRoot };
      }),
  } as never);

  const baseSettings = ServerSettings.layerTest({
    aideEnabled: options.aideEnabled ?? true,
    machineNicknames: { [studio]: { name: "Studio", updatedAt: "2026-11-01T00:00:00.000Z" } },
    ...(options.shared === undefined ? {} : { personalAssistantShared: options.shared }),
  });
  // The same test settings, counting each write of the switch.
  const settingsLayer = Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      return {
        ...base,
        setPersonalAssistantShared: (value: PersonalAssistantShared) => {
          writes.push(value);
          return base.setPersonalAssistantShared!(value);
        },
      };
    }),
  ).pipe(Layer.provide(baseSettings));

  const cloudLayer = Layer.succeed(CloudLink.CloudLink, {
    linkState: () =>
      Effect.succeed({
        linked: (options.cloudUserId ?? ACCOUNT) !== null,
        cloudUserId: options.cloudUserId === undefined ? ACCOUNT : options.cloudUserId,
      }),
  } as never);

  const fleetLayer = Layer.succeed(FleetTargets.FleetTargets, {
    load: Effect.succeed({
      version: 1 as const,
      machines: [
        { id: "desktop", label: "Desktop", environmentId: desktop, url: "https://desktop.example" },
        {
          id: "studio",
          label: "studio-host",
          environmentId: studio,
          url: "https://studio.example",
        },
      ],
    }),
    fetch: globalThis.fetch,
  } as never);

  const linkLayer = PersonalLinkService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        environmentLayer,
        projectLayer,
        Layer.succeed(ProjectWorkspaceService.ProjectWorkspaceService, {} as never),
        Layer.succeed(PersonalLinkSnapshot, { snapshot: () => Effect.succeed("unused") }),
      ),
    ),
  );

  const layer = PersonalShare.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        environmentLayer,
        projectLayer,
        foldersLayer,
        settingsLayer,
        cloudLayer,
        fleetLayer,
        linkLayer,
        Layer.succeed(PersonalShare.PersonalSharePeers, {
          states: Effect.succeed(
            options.peerStates ?? new Map<EnvironmentId, PersonalShare.PersonalSharePeerState>(),
          ),
          changing: (effect) => effect,
        }),
        Layer.succeed(PersonalRestorePoint.PersonalRestorePoint, {
          capture: () => Effect.die("no capture in these tests"),
          list: () => Effect.succeed(points),
          restore: (projectId: ProjectId, id?: string) =>
            Effect.sync(() => {
              restores.push({
                projectId,
                id,
                linked:
                  (store.get(projectId)?.workspaceSettings?.logicalProject?.members.length ?? 0) >
                  1,
                enabled: switchNow().enabled,
              });
              return {} as never;
            }),
        } as unknown as PersonalRestorePoint.PersonalRestorePoint["Service"]),
      ),
    ),
  );

  return { layer, store, created, writes, ownership, restores };
};

const storedSwitch = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  return (yield* settings.getSettings).personalAssistantShared;
});

describe("PersonalShare status", () => {
  it.effect("is off by default and names the account's link id", () => {
    const harness = makeHarness({ projects: [personalProject(percyLaptop)] });
    return Effect.gen(function* () {
      const share = yield* PersonalShare.PersonalShare;
      const status = yield* share.status;
      assert.deepStrictEqual(status, {
        enabled: false,
        environmentId: laptop,
        machineLabel: "laptop.local",
        connectLinked: true,
        linkId: personalLinkIdForAccount(ACCOUNT),
        projectId: percyLaptop,
        assistantName: "Percy",
        linked: false,
        members: [],
        routineOwner: true,
        start: false,
        machines: [],
        confirmedMachines: [],
        restorePoints: [],
        undoRestorePointId: null,
        refusal: null,
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "says why the switch cannot be turned on: no Connect link, then the assistant off",
    () =>
      Effect.gen(function* () {
        const offline = yield* PersonalShare.PersonalShare.pipe(
          Effect.flatMap((share) => share.status),
          Effect.provide(makeHarness({ cloudUserId: null, aideEnabled: false }).layer),
        );
        assert.strictEqual(offline.connectLinked, false);
        assert.strictEqual(offline.linkId, null);
        assert.strictEqual(offline.refusal, "not_connected");
        assert.strictEqual(offline.projectId, null);

        const assistantOff = yield* PersonalShare.PersonalShare.pipe(
          Effect.flatMap((share) => share.status),
          Effect.provide(makeHarness({ aideEnabled: false }).layer),
        );
        assert.strictEqual(assistantOff.refusal, "assistant_off");
      }),
  );

  it.effect("shows a link member as joined and a confirmed machine as waiting, with names", () => {
    const harness = makeHarness({
      projects: [
        personalProject(percyLaptop, [
          memberOf(laptop, percyLaptop),
          memberOf(desktop, percyDesktop),
        ]),
      ],
      shared: { enabled: true, machines: [studio, server] },
    });
    return Effect.gen(function* () {
      const status = yield* (yield* PersonalShare.PersonalShare).status;
      assert.strictEqual(status.linked, true);
      assert.deepStrictEqual(
        status.members.map((member) => member.environmentId),
        [laptop, desktop],
      );
      assert.deepStrictEqual(status.machines, [
        // The owner's name for a machine wins over the fleet list's.
        { environmentId: studio, label: "Studio", state: "waiting" },
        // A machine this one has no name for is still listed, by id.
        { environmentId: server, label: null, state: "waiting" },
        // A member another seat vouched for is listed though it was not confirmed here.
        { environmentId: desktop, label: "Desktop", state: "joined" },
      ]);
      // Only what the owner confirmed here, never a vouched member.
      assert.deepStrictEqual(status.confirmedMachines, [studio, server]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("takes each machine's state from the reconciler when it supplies one", () => {
    const harness = makeHarness({
      projects: [personalProject(percyLaptop)],
      shared: { enabled: true, machines: [desktop, studio] },
      peerStates: new Map<EnvironmentId, PersonalShare.PersonalSharePeerState>([
        [desktop, { state: "switch_off", detail: "Turn Percy on there." }],
        [server, { state: "not_confirmed", lastSyncedAt: "2026-11-20T10:00:00.000Z" }],
      ]),
    });
    return Effect.gen(function* () {
      const status = yield* (yield* PersonalShare.PersonalShare).status;
      assert.deepStrictEqual(status.machines, [
        {
          environmentId: desktop,
          label: "Desktop",
          state: "switch_off",
          detail: "Turn Percy on there.",
        },
        { environmentId: studio, label: "Studio", state: "waiting" },
        {
          environmentId: server,
          label: null,
          state: "not_confirmed",
          lastSyncedAt: "2026-11-20T10:00:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("PersonalShare.setShared on", () => {
  it.effect("refuses a machine that is not linked to Connect and changes nothing", () => {
    const harness = makeHarness({ cloudUserId: null });
    return Effect.gen(function* () {
      const share = yield* PersonalShare.PersonalShare;
      const refused = yield* share
        .setShared({ enabled: true, machines: [desktop] })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "not_connected");
      assert.strictEqual(refused.message, PersonalShare.PERSONAL_SHARE_NOT_CONNECTED_MESSAGE);
      assert.deepStrictEqual(yield* storedSwitch, { enabled: false, machines: [] });
      assert.deepStrictEqual(harness.created, []);
      assert.deepStrictEqual(harness.writes, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses while Settings keeps the assistant off, and makes no assistant", () => {
    const harness = makeHarness({ aideEnabled: false });
    return Effect.gen(function* () {
      const share = yield* PersonalShare.PersonalShare;
      const refused = yield* share.setShared({ enabled: true }).pipe(Effect.flip);
      assert.strictEqual(refused.code, "assistant_off");
      assert.strictEqual(refused.message, PersonalShare.PERSONAL_SHARE_ASSISTANT_OFF_MESSAGE);
      assert.deepStrictEqual(yield* storedSwitch, { enabled: false, machines: [] });
      assert.deepStrictEqual(harness.created, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("makes this machine's Percy when it has none, then stores the switch", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const share = yield* PersonalShare.PersonalShare;
      const status = yield* share.setShared({
        enabled: true,
        // This machine's own id and a repeat are never stored.
        machines: [desktop, laptop, studio, desktop],
        start: true,
        name: "Percy",
      });
      assert.deepStrictEqual(harness.created, [
        { name: DEFAULT_PERSONAL_ASSISTANT_NAME, kind: "personal" },
      ]);
      assert.deepStrictEqual(yield* storedSwitch, {
        enabled: true,
        machines: [desktop, studio],
        start: true,
        name: "Percy",
        // When the owner turned it on: it clears an older removal of this machine.
        enabledAt: SWITCHED_ON,
      });
      assert.strictEqual(status.enabled, true);
      assert.strictEqual(status.start, true);
      assert.strictEqual(status.projectId, percyLaptop);
      assert.strictEqual(status.assistantName, DEFAULT_PERSONAL_ASSISTANT_NAME);
      assert.strictEqual(status.linkId, personalLinkIdForAccount(ACCOUNT));
      // Turning the switch on links nothing by itself: the seats link once theirs agree.
      assert.strictEqual(status.linked, false);
      assert.deepStrictEqual(
        status.machines.map((machine) => [machine.environmentId, machine.state]),
        [
          [desktop, "waiting"],
          [studio, "waiting"],
        ],
      );
      assert.deepStrictEqual(harness.ownership, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the assistant the machine already has, and writes once for a repeat", () => {
    const harness = makeHarness({ projects: [personalProject(percyLaptop)] });
    return Effect.gen(function* () {
      const share = yield* PersonalShare.PersonalShare;
      const first = yield* share.setShared({ enabled: true, machines: [desktop] });
      const second = yield* share.setShared({ enabled: true, machines: [desktop] });
      assert.deepStrictEqual(second, first);
      assert.deepStrictEqual(harness.created, []);
      assert.deepStrictEqual([...harness.store.keys()], [percyLaptop]);
      // Still on: the second call keeps the first switch-on time, so nothing is written.
      assert.deepStrictEqual(harness.writes, [
        { enabled: true, machines: [desktop], enabledAt: SWITCHED_ON },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "keeps the confirmed machines, the start choice and the name when they are left out",
    () => {
      const harness = makeHarness({
        projects: [personalProject(percyLaptop)],
        shared: { enabled: false, machines: [desktop], start: true, name: "Percy" },
      });
      return Effect.gen(function* () {
        const share = yield* PersonalShare.PersonalShare;
        yield* share.setShared({ enabled: true });
        assert.deepStrictEqual(yield* storedSwitch, {
          enabled: true,
          machines: [desktop],
          start: true,
          name: "Percy",
          enabledAt: SWITCHED_ON,
        });
        // An empty list and `start: false` are choices, not omissions.
        yield* share.setShared({ enabled: true, machines: [], start: false });
        assert.deepStrictEqual(yield* storedSwitch, {
          enabled: true,
          machines: [],
          name: "Percy",
          enabledAt: SWITCHED_ON,
        });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("refuses more machines than the setting holds", () => {
    const harness = makeHarness({ projects: [personalProject(percyLaptop)] });
    return Effect.gen(function* () {
      const share = yield* PersonalShare.PersonalShare;
      const machines = Array.from({ length: 33 }, (_, index) =>
        EnvironmentId.make(`env-extra-${index}`),
      );
      const refused = yield* share.setShared({ enabled: true, machines }).pipe(Effect.flip);
      assert.strictEqual(refused.code, "invalid");
      assert.deepStrictEqual(harness.writes, []);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("PersonalShare.setShared off", () => {
  it.effect("stores the switch off and leaves the link; this machine keeps its Percy", () => {
    const harness = makeHarness({
      projects: [
        personalProject(percyLaptop, [
          memberOf(laptop, percyLaptop),
          memberOf(desktop, percyDesktop),
        ]),
      ],
      shared: { enabled: true, machines: [desktop] },
    });
    return Effect.gen(function* () {
      const share = yield* PersonalShare.PersonalShare;
      const status = yield* share.setShared({ enabled: false });
      assert.deepStrictEqual(yield* storedSwitch, { enabled: false, machines: [desktop] });
      assert.deepStrictEqual(harness.ownership, ["unlink"]);
      assert.strictEqual(status.enabled, false);
      assert.strictEqual(status.linked, false);
      assert.deepStrictEqual(status.members, []);
      // The local assistant is still there, as its own unlinked seat.
      assert.strictEqual(status.projectId, percyLaptop);
      const kept = harness.store.get(percyLaptop)!;
      assert.strictEqual(kept.deletedAt, null);
      assert.deepStrictEqual(
        kept.workspaceSettings?.logicalProject?.members.map((member) => member.environmentId),
        [laptop],
      );

      // Again: nothing is written and nothing is left twice.
      yield* share.setShared({ enabled: false });
      assert.deepStrictEqual(harness.ownership, ["unlink"]);
      assert.deepStrictEqual(harness.writes, [{ enabled: false, machines: [desktop] }]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "can always be turned off: without Connect, with the assistant off, with no Percy",
    () => {
      const harness = makeHarness({
        cloudUserId: null,
        aideEnabled: false,
        shared: { enabled: true, machines: [desktop] },
      });
      return Effect.gen(function* () {
        const share = yield* PersonalShare.PersonalShare;
        const status = yield* share.setShared({ enabled: false });
        assert.strictEqual(status.enabled, false);
        assert.deepStrictEqual(yield* storedSwitch, { enabled: false, machines: [desktop] });
        assert.deepStrictEqual(harness.created, []);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("PersonalShare.undo", () => {
  const savedPoints: ReadonlyArray<PersonalRestorePoint.PersonalRestorePointSummary> = [
    {
      id: "20261124T110000000Z-undo",
      savedAt: "2026-11-24T11:00:00.000Z",
      reason: "before-undo",
      memoryFileCount: 3,
      path: "/scratch/backups/personal-link/20261124T110000000Z-undo.percy.json",
    },
    {
      id: "20261124T100000000Z-link",
      savedAt: "2026-11-24T10:00:00.000Z",
      reason: "before-link",
      memoryFileCount: 2,
      path: "/scratch/backups/personal-link/20261124T100000000Z-link.percy.json",
    },
  ];

  it.effect("status lists the saved copies, newest first, without a path", () => {
    const harness = makeHarness({ projects: [personalProject(percyLaptop)], points: savedPoints });
    return Effect.gen(function* () {
      const status = yield* (yield* PersonalShare.PersonalShare).status;
      assert.deepStrictEqual(status.restorePoints, [
        {
          id: "20261124T110000000Z-undo",
          savedAt: "2026-11-24T11:00:00.000Z",
          reason: "before-undo",
          memoryFileCount: 3,
        },
        {
          id: "20261124T100000000Z-link",
          savedAt: "2026-11-24T10:00:00.000Z",
          reason: "before-link",
          memoryFileCount: 2,
        },
      ]);
      assert.notInclude(JSON.stringify(status), "/scratch");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "turns the switch off, leaves the link, then restores this series' before-link copy",
    () => {
      const harness = makeHarness({
        projects: [
          personalProject(percyLaptop, [
            {
              environmentId: laptop,
              projectId: percyLaptop,
              coordinatorThreadId: ThreadId.make("t-l"),
            },
            {
              environmentId: desktop,
              projectId: ProjectId.make("percy-desktop"),
              coordinatorThreadId: ThreadId.make("t-d"),
            },
          ]),
        ],
        shared: { enabled: true, machines: [desktop], enabledAt: "2026-11-24T09:00:00.000Z" },
        // This series began when the switch went on at 09:00; the undo before it is older.
        points: [
          savedPoints[1]!,
          {
            ...savedPoints[0]!,
            id: "20261124T080000000Z-undo",
            savedAt: "2026-11-24T08:00:00.000Z",
          },
        ],
      });
      return Effect.gen(function* () {
        const share = yield* PersonalShare.PersonalShare;
        assert.strictEqual((yield* share.status).undoRestorePointId, "20261124T100000000Z-link");
        const status = yield* share.undo({});
        assert.deepStrictEqual(harness.restores, [
          { projectId: percyLaptop, id: "20261124T100000000Z-link", linked: false, enabled: false },
        ]);
        assert.deepStrictEqual(harness.ownership, ["unlink"]);
        assert.deepStrictEqual(yield* storedSwitch, { enabled: false, machines: [desktop] });
        assert.strictEqual(status.enabled, false);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("restores the copy it is given, and refuses one this machine does not have", () => {
    const harness = makeHarness({ projects: [personalProject(percyLaptop)], points: savedPoints });
    return Effect.gen(function* () {
      const share = yield* PersonalShare.PersonalShare;
      const refused = yield* share.undo({ restorePointId: "elsewhere" }).pipe(Effect.flip);
      assert.strictEqual(refused.code, "no_restore_point");
      assert.deepStrictEqual(harness.restores, []);
      assert.deepStrictEqual(harness.writes, []);
      yield* share.undo({ restorePointId: "20261124T110000000Z-undo" });
      assert.deepStrictEqual(
        harness.restores.map((entry) => entry.id),
        ["20261124T110000000Z-undo"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("never picks a before-link copy older than the current series by itself", () => {
    // An undo at 11:00 began a new series; its before-link copy at 10:00 belongs to the last one.
    const harness = makeHarness({
      projects: [personalProject(percyLaptop)],
      shared: { enabled: true, machines: [desktop], enabledAt: "2026-11-24T09:00:00.000Z" },
      points: savedPoints,
    });
    return Effect.gen(function* () {
      const share = yield* PersonalShare.PersonalShare;
      // Settings offers no copy as this link's either.
      assert.isNull((yield* share.status).undoRestorePointId);
      const refused = yield* share.undo({}).pipe(Effect.flip);
      assert.strictEqual(refused.code, "no_restore_point");
      assert.include(refused.message, "20261124T110000000Z-undo, 20261124T100000000Z-link");
      assert.include(refused.message, "percy undo --restore-point <id>");
      assert.deepStrictEqual(harness.restores, []);
      assert.deepStrictEqual(harness.writes, []);
      yield* share.undo({ restorePointId: "20261124T100000000Z-link" });
      assert.deepStrictEqual(
        harness.restores.map((entry) => entry.id),
        ["20261124T100000000Z-link"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses in plain words while this machine has no restore point", () => {
    const harness = makeHarness({ projects: [personalProject(percyLaptop)] });
    return Effect.gen(function* () {
      const share = yield* PersonalShare.PersonalShare;
      const refused = yield* share.undo({}).pipe(Effect.flip);
      assert.strictEqual(refused.code, "no_restore_point");
      assert.include(refused.message, "no saved copy of Percy");
      assert.deepStrictEqual(harness.writes, []);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("only the owner turns the Percy switch (1448 AC-15)", () => {
  const coordinator = {
    kind: "coordinator" as const,
    environmentId: EnvironmentId.make("env-other-machine"),
  };

  /** Runs the socket's authorization for one call, saying whether the handler ran. */
  const attempt = (method: string, payload: unknown) =>
    Effect.gen(function* () {
      const authorize = yield* RpcScopeAuthorization;
      let ran = false;
      const call = Effect.sync(() => {
        ran = true;
      });
      const exit = yield* Effect.exit(
        Effect.scoped(authorize(call as never, { rpc: { _tag: method }, payload } as never)),
      );
      const message = Exit.isFailure(exit)
        ? String((Cause.squash(exit.cause) as { readonly message?: unknown }).message)
        : null;
      return { ran, message };
    });

  it.effect("refuses another machine's key before the handler runs, whatever scopes it holds", () =>
    Effect.gen(function* () {
      for (const [method, payload] of [
        [WS_METHODS.personalLinkSetShared, { enabled: true, machines: ["env-other-machine"] }],
        [WS_METHODS.personalLinkShareStatus, {}],
        [WS_METHODS.personalLinkUndo, {}],
      ] as const) {
        assert.isTrue(RpcAuthorization.refusesOwnerOnlyRpc(method, coordinator), method);
        const refused = yield* attempt(method, payload);
        assert.strictEqual(refused.ran, false, method);
        assert.strictEqual(
          refused.message,
          "Only this machine's owner can see or change personal data access here.",
          method,
        );
      }
    }).pipe(Effect.provide(RpcAuthorization.layer([AuthSettingsWriteScope], coordinator))),
  );

  it.effect("refuses a session that may not write settings", () =>
    Effect.gen(function* () {
      const refused = yield* attempt(WS_METHODS.personalLinkSetShared, { enabled: true });
      assert.strictEqual(refused.ran, false);
      assert.isNotNull(refused.message);
    }).pipe(Effect.provide(RpcAuthorization.layer([AuthOrchestrationOperateScope]))),
  );

  it.effect("lets the owner's own session through", () =>
    Effect.gen(function* () {
      const allowed = yield* attempt(WS_METHODS.personalLinkSetShared, { enabled: true });
      assert.deepStrictEqual(allowed, { ran: true, message: null });
    }).pipe(Effect.provide(RpcAuthorization.layer([AuthSettingsWriteScope]))),
  );

  it("has one write path in the server, and no MCP tool reaches it", () => {
    const root = NodePath.resolve(import.meta.dirname, "..");
    const sources = NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => file.split(NodePath.sep).join("/"));
    const mentioning = (needle: RegExp, files: ReadonlyArray<string>) =>
      files
        .filter((file) => needle.test(NodeFS.readFileSync(NodePath.join(root, file), "utf8")))
        .toSorted();
    // The setting is written by the settings service's one method, called only by PersonalShare.
    assert.deepStrictEqual(mentioning(/setPersonalAssistantShared/, sources), [
      "project/PersonalShare.ts",
      "serverSettings.ts",
    ]);
    // Agents' tools never turn the switch or run the undo.
    assert.deepStrictEqual(
      mentioning(
        /PersonalShare\b|personalLinkSetShared|personalLinkUndo|personalAssistantShared/,
        sources.filter((file) => file.startsWith("mcp/")),
      ),
      [],
    );
  });

  it.effect("is not changed by a settings update, even one that names the switch", () => {
    const harness = makeHarness({ projects: [personalProject(percyLaptop)] });
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const updated = yield* settings.updateSettings({
        aideEnabled: true,
        personalAssistantShared: { enabled: true, machines: [desktop] },
      } as never);
      assert.deepStrictEqual(updated.personalAssistantShared, { enabled: false, machines: [] });
      assert.strictEqual((yield* (yield* PersonalShare.PersonalShare).status).enabled, false);
    }).pipe(Effect.provide(harness.layer));
  });
});
