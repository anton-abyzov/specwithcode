import {
  EnvironmentId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
} from "@specweave-studio/contracts";
import {
  updateThreadMetadata,
  type UpdateThreadMetadataInput,
} from "@specweave-studio/client-runtime/operations";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  EnvironmentSupervisor,
  type PreparedConnection,
} from "@specweave-studio/client-runtime/connection";
import type { WsRpcProtocolClient, RpcSession } from "@specweave-studio/client-runtime/rpc";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  shell: null as null | {
    id: string;
    environmentId: string;
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
    runtime: null | { status: string };
  },
  draft: null as null | {
    environmentId: string;
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
    envMode: string;
    environmentSelection: string;
  },
  effects: [] as (() => void)[],
  commands: [] as { environmentId: string; input: UpdateThreadMetadataInput }[],
  draftWrites: [] as Record<string, unknown>[],
  stops: [] as unknown[],
  overrides: [] as unknown[],
  commandOptions: [] as unknown[],
  rejectMetadata: false,
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [initial, () => {}],
  useOptimistic: (initial: unknown) => [initial, () => {}],
  useEffect: (callback: () => void) => {
    state.effects.push(callback);
  },
  useImperativeHandle: () => {},
  useDeferredValue: (value: unknown) => value,
  useTransition: () => [false, (callback: () => void) => callback()],
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => state.shell,
  useProject: () => ({ id: "project", environmentId: "environment", workspaceRoot: "/project" }),
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown, options: unknown) => {
    if (typeof command === "function" && command.name === "updateMetadata")
      state.commandOptions.push(options);
    return command;
  },
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: {
    updateMetadata: async (input: (typeof state.commands)[number]) => {
      state.commands.push(input);
      return { _tag: state.rejectMetadata ? "Failure" : "Success" };
    },
    stopSession: async (input: unknown) => {
      state.stops.push(input);
    },
  },
}));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    status: () => null,
    listRefs: () => null,
    switchRef: () => {},
    createRef: () => {},
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: { refName: "main", pr: null, refs: [] }, refresh: () => {} }),
}));
vi.mock("~/state/queries", () => ({
  usePaginatedBranches: () => ({
    refs: [
      { name: "main", isDefault: true, current: true, kind: "local", worktreePath: "/project" },
    ],
    data: { nextCursor: null },
    isPending: false,
  }),
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (store: {
      getDraftSession: () => typeof state.draft;
      getDraftThreadByRef: () => typeof state.draft;
      setDraftThreadContext: (target: unknown, patch: Record<string, unknown>) => void;
    }) => unknown,
  ) =>
    select({
      getDraftSession: () => state.draft,
      getDraftThreadByRef: () => state.draft,
      setDraftThreadContext: (_target, patch) => {
        state.draftWrites.push(patch);
      },
    }),
}));
vi.mock("~/hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenPrLink: () => () => {} }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("~/rightPanelStore", () => ({ useRightPanelStore: () => ({}) }));
vi.mock("~/components/ThreadStatusIndicators", () => ({
  ThreadPullRequestBadgeControl: "badge",
  useLinkedThreadPullRequest: () => null,
  resolveThreadPullRequestBadge: () => null,
  prStatusIndicator: () => null,
}));
vi.mock("~/components/chat/composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("~/sourceControlPresentation", () => ({
  getSourceControlPresentation: () => ({ Icon: "icon", terminology: { singular: "pull request" } }),
}));
vi.mock("~/components/chat/ThreadDetailsControl", () => ({ ThreadDetailsControl: "details" }));
vi.mock("~/components/ComposerContextLabel", () => ({ ComposerContextLabel: "label" }));
vi.mock("~/components/chat/ThreadDetailsPrRows", () => ({ ThreadDetailsPrRows: "rows" }));
vi.mock("~/components/chat/ComposerControl", () => ({ ComposerControl: "control" }));
vi.mock("~/components/BranchPicker", () => ({
  BranchPicker: "picker",
  BranchPickerRefItem: "ref",
}));
vi.mock("~/components/ui/combobox", () => ({ ComboboxItem: "item", ComboboxTrigger: "trigger" }));
vi.mock("~/components/ui/middle-truncate", () => ({ MiddleTruncate: "middle" }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: () => {} },
}));

import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

function surface(forceNewWorktree = false) {
  return BranchToolbarBranchSelector({
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    envLocked: false,
    effectiveEnvModeOverride: "worktree",
    startFromOrigin: false,
    forceNewWorktree,
    onStartFromOriginChange: () => {},
    onActiveThreadBranchOverrideChange: (branch) => {
      state.overrides.push(branch);
    },
  });
}
function runEffects() {
  state.effects.forEach((effect) => effect());
}

beforeEach(() => {
  state.shell = {
    id: "thread",
    environmentId: "environment",
    projectId: "project",
    branch: null,
    worktreePath: null,
    runtime: null,
  };
  state.draft = null;
  state.rejectMetadata = false;
  for (const values of [
    state.effects,
    state.commands,
    state.draftWrites,
    state.stops,
    state.overrides,
    state.commandOptions,
  ])
    values.length = 0;
});

describe("passive worktree branch defaults", () => {
  it("sends the observed workspace and empty-thread guards through the actual component", () => {
    surface();
    runEffects();
    expect(state.commands[0]?.input).toMatchObject({
      branch: "main",
      worktreePath: null,
      expectedWorktreePath: null,
      expectedEmpty: true,
    });
  });
  it("does not stop a native session or author an optimistic override for passive defaults", () => {
    if (state.shell) state.shell.runtime = { status: "running" };
    surface();
    runEffects();
    expect(state.stops).toEqual([]);
    expect(state.overrides).toEqual([]);
    expect(state.commandOptions).toEqual(["thread metadata update", { reportFailure: false }]);
  });
  it("preserves local draft defaults and their manual host intent", () => {
    state.shell = null;
    state.draft = {
      environmentId: "environment",
      projectId: "project",
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      environmentSelection: "manual",
    };
    surface();
    runEffects();
    expect(state.commands).toEqual([]);
    expect(state.draftWrites[0]).toMatchObject({
      branch: "main",
      worktreePath: null,
      environmentSelection: "manual",
    });
  });
  it("preserves an explicit branch selection and its optimistic override", () => {
    const picker = surface();
    picker.props.onSelectItem("main");
    expect(state.commands[0]?.input).toEqual({
      threadId: "thread",
      branch: "main",
      worktreePath: null,
    });
    expect(state.overrides).toEqual(["main"]);
  });
  it("does not default a branch once the prepared workspace is already observed", () => {
    if (state.shell) state.shell.worktreePath = "/project/prepared";
    surface();
    runEffects();
    expect(state.commands).toEqual([]);
  });
  it("does not stop or clear an existing native workspace hidden by forceNewWorktree", () => {
    if (state.shell) {
      state.shell.worktreePath = "/project/prepared";
      state.shell.runtime = { status: "running" };
    }
    surface(true);
    runEffects();
    expect(state.stops).toEqual([]);
    expect(state.commands).toEqual([]);
    expect(state.overrides).toEqual([]);
  });
  it("uses only the authoritative shell when the automatic CAS is rejected", () => {
    state.rejectMetadata = true;
    surface();
    runEffects();
    expect(state.commands).toHaveLength(1);
    expect(state.shell?.branch).toBeNull();
    expect(state.overrides).toEqual([]);
    expect(state.stops).toEqual([]);
  });
  it("keeps intentional manual workspace changes capable of stopping their current session", () => {
    if (state.shell) {
      state.shell.worktreePath = "/project/prepared";
      state.shell.runtime = { status: "running" };
    }
    const picker = surface();
    picker.props.onSelectItem("main");
    expect(state.stops).toHaveLength(1);
    expect(state.commands[0]?.input).toEqual({
      threadId: "thread",
      branch: "main",
      worktreePath: null,
    });
    expect(state.overrides).toEqual(["main"]);
  });
  it("carries the actual automatic callback guards through the real client command transport", async () => {
    surface();
    runEffects();
    const input = state.commands[0]?.input;
    expect(input).toBeDefined();
    if (!input) throw new Error("Actual selector did not issue its empty-thread default");
    const dispatched: OrchestrationV2Command[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = {
          [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
        } as unknown as WsRpcProtocolClient;
        const session: RpcSession = {
          client,
          initialConfig: Effect.succeed({} as never),
          subscribeServerConfig: (request) => client.subscribeServerConfig(request),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId: EnvironmentId.make("environment"),
            label: "Fixture",
            httpBaseUrl: "https://fixture.example.test",
            wsBaseUrl: "wss://fixture.example.test",
          }),
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        yield* updateThreadMetadata(input).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
      }).pipe(
        Effect.provideService(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
      ),
    );
    expect(dispatched[0]).toMatchObject({
      type: "thread.metadata.update",
      branch: "main",
      worktreePath: null,
      expectedWorktreePath: null,
      expectedEmpty: true,
    });
  });
});
