import { act, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AuthSessionState,
  type EnvironmentId,
  type ServerInstallation,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
  clipboard: vi.fn(),
  continueThreadsAfterServerUpdate: false,
  session: null as AsyncResult.AsyncResult<AuthSessionState, Error> | null,
  sessionAtom: Symbol("session"),
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: (options: { onCopy: () => void }) => ({
    copyToClipboard: (steps: string) => {
      testState.clipboard(steps);
      options.onCopy();
    },
  }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (
    _environmentId: EnvironmentId,
    selector: (settings: { continueThreadsAfterServerUpdate: boolean }) => unknown,
  ) => selector({ continueThreadsAfterServerUpdate: testState.continueThreadsAfterServerUpdate }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => testState.session }));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => testState.session },
}));
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => testState.sessionAtom },
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateServer: Symbol("updateServer") },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateServer,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toast },
}));

import {
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "~/confirmDialog";
import {
  ServerUpdateAction,
  ServerUpdateProgress,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";

const decodeSessionState = Schema.decodeUnknownSync(AuthSessionState);

const MANUAL_UPDATE_STEPS = [
  "Update SpecWithCode to 0.0.45 on the machine that runs this server:",
  "- With the desktop app on that machine: Settings > About > SpecWithCode service, then Check now or Install now.",
  "- A service installed without the desktop app: its update agent or the guarded updater, described in docs/studio/updates.md.",
  "- A server built from source: git pull, rebuild, then restart it with your usual options.",
].join("\n");

type ActionElement = ReactElement<{
  readonly onClick?: () => void;
}>;

function renderAction(): ActionElement {
  return ServerUpdateAction({
    environmentId: "env-test" as EnvironmentId,
    serverLabel: "Test server",
    selfUpdate: "boot-service",
    targetVersion: "0.0.31",
  }) as ActionElement;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const legacyAuth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "studio_session",
} as const;

const currentSession = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    ...legacyAuth,
    serverUpdateScope: "environment:maintain",
  },
} as const satisfies AuthSessionState;

describe("ServerUpdateAction", () => {
  beforeEach(() => {
    testState.updateServer.mockReset();
    testState.toast.mockReset();
    testState.clipboard.mockReset();
    testState.continueThreadsAfterServerUpdate = false;
    testState.session = AsyncResult.success(currentSession);
  });

  it.each([
    { serverUpdateScope: undefined, scopes: ["orchestration:operate"], allowed: true },
    { serverUpdateScope: undefined, scopes: ["orchestration:read"], allowed: false },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["orchestration:operate"],
      allowed: false,
    },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["environment:maintain"],
      allowed: true,
    },
  ] as const)(
    "uses the advertised update scope $serverUpdateScope with grant $scopes",
    async ({ serverUpdateScope, scopes, allowed }) => {
      testState.session = AsyncResult.success(
        decodeSessionState({
          ...currentSession,
          scopes,
          auth: {
            ...legacyAuth,
            ...(serverUpdateScope === undefined ? {} : { serverUpdateScope }),
          },
        }),
      );
      testState.updateServer.mockResolvedValue(
        AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
      );

      renderAction().props.onClick?.();
      await flushPromises();

      expect(testState.updateServer).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it("keeps a known grant usable while the session refreshes", async () => {
    testState.session = AsyncResult.waiting(AsyncResult.success(currentSession));
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledOnce();
  });

  it("does not dispatch an update after maintenance access is removed", async () => {
    const action = renderAction();
    testState.session = AsyncResult.success({ ...currentSession, scopes: [] });
    action.props.onClick?.();
    await flushPromises();
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it.each([
    [
      { kind: "npm-global", prefix: "/opt/node" },
      `${MANUAL_UPDATE_STEPS}\nThis server runs from a global npm install under /opt/node. The npm registry has no specweave-studio package, so npm cannot update it.`,
      "Update steps copied",
      "no package registry carries specweave-studio",
    ],
    [
      { kind: "npx" },
      `${MANUAL_UPDATE_STEPS}\nThis server was started with npx. The npm registry has no specweave-studio package, so npx cannot fetch a newer one.`,
      "Update steps copied",
      "Follow the copied steps on that machine.",
    ],
    [
      undefined,
      MANUAL_UPDATE_STEPS,
      "Update steps copied",
      "Follow the copied steps on that machine.",
    ],
  ] satisfies ReadonlyArray<readonly [ServerInstallation | undefined, string, string, string]>)(
    "copies honest manual steps for %j without invoking remote update",
    (installation, steps, title, guidance) => {
      const action = ServerUpdateAction({
        environmentId: "env-test" as EnvironmentId,
        serverLabel: "Test server",
        selfUpdate: null,
        installation,
        targetVersion: "0.0.45",
      }) as ActionElement;
      action.props.onClick?.();
      expect(testState.clipboard).toHaveBeenCalledWith(steps);
      expect(testState.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title,
          description: expect.stringContaining(guidance),
        }),
      );
      expect(testState.updateServer).not.toHaveBeenCalled();
    },
  );

  it("reports success only after the shared update flow reconnects", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Reconnected on specweave-studio@0.0.31.",
    });
  });

  it("reports one result when the update action is double-clicked", async () => {
    let finishUpdate: (() => void) | undefined;
    testState.updateServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = () =>
            resolve(
              AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
            );
        }),
    );

    const action = renderAction();
    action.props.onClick?.();
    action.props.onClick?.();

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
    finishUpdate?.();
    await flushPromises();
    expect(testState.toast).toHaveBeenCalledTimes(1);
  });

  it("quietly releases the action when the operation is interrupted", async () => {
    testState.updateServer.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.toast).not.toHaveBeenCalled();
  });

  it("keeps the manual instruction for desktop servers without remote update support", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateAction
        environmentId={"env-test" as EnvironmentId}
        serverLabel="Test server"
        selfUpdate="desktop-managed"
        targetVersion="0.0.31"
      />,
    );

    expect(markup).toContain("Update the desktop app on that machine to update this server.");
    expect(markup).not.toContain("<button");
  });

  it("updates remote desktop apps through the shared update flow", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.34", method: "desktop-app" as const }),
    );

    const action = ServerUpdateAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "desktop-managed",
      desktopAppUpdate: true,
      targetVersion: "0.0.31",
    }) as ActionElement;

    // No confirm-dialog host is mounted in this test, which the component
    // treats as consent: the click itself was the request.
    action.props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Desktop app relaunched on 0.0.34.",
    });
  });

  it("leaves thread continuation off by default", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );
    const action = ServerUpdateAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "boot-service",
      threadContinuation: true,
      targetVersion: "0.0.31",
    }) as ActionElement;

    action.props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
  });

  it("applies the saved thread continuation preference automatically", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );
    testState.continueThreadsAfterServerUpdate = true;
    const action = ServerUpdateAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "boot-service",
      threadContinuation: true,
      targetVersion: "0.0.31",
    }) as ActionElement;

    action.props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31", continueRunningThreads: true },
    });
  });
});

describe("ServerUpdatesAction", () => {
  let renderer: ReactTestRenderer | undefined;
  const targets: ReadonlyArray<ServerUpdateTarget> = [
    {
      environmentId: "batch-a" as EnvironmentId,
      serverLabel: "Laptop",
      selfUpdate: "boot-service",
      targetVersion: "0.0.31",
      threadContinuation: true,
      continueThreadsAfterServerUpdate: true,
    },
    {
      environmentId: "batch-b" as EnvironmentId,
      serverLabel: "Office",
      selfUpdate: "respawn",
      targetVersion: "0.0.31",
      threadContinuation: true,
      continueThreadsAfterServerUpdate: false,
    },
    {
      environmentId: "batch-c" as EnvironmentId,
      serverLabel: "Manual",
      selfUpdate: null,
      targetVersion: "0.0.31",
    },
  ];
  const success = AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const });

  async function mount(batch = targets) {
    await act(async () => {
      renderer = create(<ServerUpdatesAction targets={batch} />);
    });
    return renderer!.root.findByType("button");
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    testState.updateServer.mockReset();
    testState.toast.mockReset();
    resetConfirmDialogForTests();
  });
  afterEach(async () => {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    resetConfirmDialogForTests();
    vi.unstubAllGlobals();
  });

  it("updates both supported machines with their own continuation preference and skips the manual machine", async () => {
    testState.updateServer.mockResolvedValue(success);
    const button = await mount();
    await act(async () => {
      button.props.onClick();
    });

    expect(testState.updateServer.mock.calls.map(([target]) => target)).toEqual([
      {
        environmentId: "batch-a",
        input: { targetVersion: "0.0.31", continueRunningThreads: true },
      },
      { environmentId: "batch-b", input: { targetVersion: "0.0.31" } },
    ]);
    expect(testState.toast.mock.calls.map(([toast]) => toast.title)).toEqual([
      "Laptop updated",
      "Office updated",
    ]);
  });

  it("names a failed machine while letting the other machine complete", async () => {
    testState.updateServer
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Download failed"))))
      .mockResolvedValueOnce(success);
    const button = await mount();
    await act(async () => {
      button.props.onClick();
    });

    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Laptop update failed",
      description: "Download failed",
    });
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Office updated" }),
    );
    expect(button.props.disabled).toBe(false);
  });

  it("starts each machine once when double-clicked and disables the action until both finish", async () => {
    const completions: Array<() => void> = [];
    testState.updateServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          completions.push(() => resolve(success));
        }),
    );
    const button = await mount();
    await act(async () => {
      button.props.onClick();
      button.props.onClick();
    });
    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(button.props.disabled).toBe(true);
    await act(async () => {
      completions[0]!();
    });
    expect(button.props.disabled).toBe(true);
    await act(async () => {
      completions[1]!();
    });
    expect(button.props.disabled).toBe(false);
    expect(testState.toast).toHaveBeenCalledTimes(2);
  });

  it("asks once for desktop machines and cancels the entire batch", async () => {
    registerConfirmDialogHost();
    const button = await mount(
      targets.map((target, index) =>
        index < 2 ? { ...target, selfUpdate: "desktop-managed", desktopAppUpdate: true } : target,
      ),
    );
    await act(async () => {
      button.props.onClick();
    });
    const confirmation = readConfirmDialogState();
    expect(confirmation).toEqual(
      expect.objectContaining({
        status: "confirming",
        message: expect.stringContaining("Laptop, Office"),
      }),
    );
    expect(testState.updateServer).not.toHaveBeenCalled();
    await act(async () => {
      respondToConfirmDialog(false);
    });
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(button.props.disabled).toBe(false);
  });
});

describe("ServerUpdateProgress", () => {
  it("shows one calm status row for the restart wait", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "resuming",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );

    expect(markup).toContain("Restarting…");
    // The wait state is monochrome and calm: no versions, no step rail, no
    // success/warning colors, one duty-cycled pulse on the dot.
    expect(markup).not.toContain("0.0.30");
    expect(markup).not.toContain("Resum");
    expect(markup).not.toContain("text-success");
    expect(markup).not.toContain("text-primary");
    expect(markup).toContain("animate-status-pulse");
    expect(markup).not.toContain("animate-spin");
  });

  it("folds the sub-second installing handoff into the download phase", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );

    expect(markup).toContain("Downloading…");
    expect(markup).not.toContain("Install");
  });

  it("keeps the failure visible with its retryable error", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "failed",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
          message: "The package could not be verified.",
        }}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The package could not be verified.");
    expect(markup).not.toContain("animate-status-pulse");
  });
});
