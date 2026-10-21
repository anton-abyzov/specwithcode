import type {
  AuthSessionState,
  EnvironmentId,
  ServerConfig,
  ServerSelfUpdateCapability,
} from "@specweave-studio/contracts";
import type { ServerUpdateState } from "@specweave-studio/client-runtime/state/server";
import { AsyncResult } from "effect/reactivity";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  configs: new Map<string, unknown>(),
  environments: [] as Array<{ readonly environmentId: string; readonly label: string }>,
  updates: new Map<string, unknown>(),
  session: null as unknown,
  continueThreadsAfterServerUpdate: false,
  updateServer: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../branding")>()),
  APP_VERSION: "1.0.66",
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly kind: string; readonly id: string }) =>
    atom.kind === "update" ? (state.updates.get(atom.id) ?? { status: "idle" }) : state.session,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateStateAtom: (id: string) => ({ kind: "update", id }),
    updateServer: { kind: "updateServer" },
  },
  updateOutdatedServer: { kind: "updateOutdatedServer" },
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: (id: string) => ({ kind: "session", id }) },
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => state.session } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.updateServer }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (
    _environmentId: string,
    select: (settings: { continueThreadsAfterServerUpdate: boolean }) => unknown,
  ) => select({ continueThreadsAfterServerUpdate: state.continueThreadsAfterServerUpdate }),
}));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => state.configs }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../ui/spinner", () => ({ Spinner: () => null }));
// Each tooltip renders inline, so a test can read which trigger carries which text.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <span data-tooltip="">{children}</span>,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: ({ children }: { children: ReactNode }) => (
    <span data-tooltip-popup="">{children}</span>
  ),
}));

import {
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "../../confirmDialog";
import { SidebarServerUpdate } from "./SidebarServerUpdate";

const currentSession = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "studio_session",
    serverUpdateScope: "environment:maintain",
  },
} as const satisfies AuthSessionState;

function server(
  environmentId: string,
  {
    label = environmentId,
    serverVersion = "1.0.65",
    serverSelfUpdate = "boot-service",
    desktopAppUpdate = false,
    serverUpdateThreadContinuation = false,
  }: {
    readonly label?: string;
    readonly serverVersion?: string;
    readonly serverSelfUpdate?: ServerSelfUpdateCapability;
    readonly desktopAppUpdate?: boolean;
    readonly serverUpdateThreadContinuation?: boolean;
  } = {},
) {
  state.configs.set(environmentId, {
    environment: {
      environmentId: environmentId as EnvironmentId,
      label,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion,
      capabilities: {
        repositoryIdentity: true,
        serverSelfUpdate,
        desktopAppUpdate,
        serverUpdateThreadContinuation,
      },
    },
  } satisfies Pick<ServerConfig, "environment">);
  state.environments.push({ environmentId, label });
}

let renderer: ReactTestRenderer | null = null;

function render() {
  act(() => {
    renderer = create(<SidebarServerUpdate />);
  });
}

function rows(): ReactTestInstance[] {
  return renderer!.root.findAll(
    (node) => node.type === "div" && node.props["data-testid"] === "sidebar-server-update",
  );
}

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}

/** Each tooltip in a row: its trigger button and the text it shows. */
function tooltips(row: ReactTestInstance) {
  return row
    .findAll((node) => node.type === "span" && node.props["data-tooltip"] === "")
    .map((tooltip) => ({
      trigger: tooltip.find((node) => node.type === "button"),
      popup: text(
        tooltip.find((node) => node.type === "span" && node.props["data-tooltip-popup"] === ""),
      ),
    }));
}

function updateButton(row: ReactTestInstance): ReactTestInstance {
  return row.find((node) => node.type === "button" && text(node) === "Update");
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.configs.clear();
  state.environments.length = 0;
  state.updates.clear();
  state.session = AsyncResult.success(currentSession);
  state.continueThreadsAfterServerUpdate = false;
  state.updateServer.mockReset();
  state.toast.mockReset();
  resetConfirmDialogForTests();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  resetConfirmDialogForTests();
  vi.unstubAllGlobals();
});

describe("SidebarServerUpdate", () => {
  it("shows the only server's versions and explains Update on the text and the button", () => {
    server("only");
    render();

    const [row] = rows();
    const description =
      "SpecWithCode on the server runs 1.0.65; this app runs 1.0.66. " +
      "Update installs 1.0.66 on the server and restarts its server. " +
      "Threads running there stop for the restart. " +
      "Nothing else on the server changes: no settings, no other software.";
    const [label, update] = tooltips(row!);

    expect(rows()).toHaveLength(1);
    expect(text(label!.trigger)).toBe("Server 1.0.65 → 1.0.66");
    expect(label!.popup).toBe(description);
    expect(label!.trigger.props["aria-description"]).toBe(description);
    expect(update!.trigger).toBe(updateButton(row!));
    expect(update!.popup).toBe(description);
    expect(update!.trigger.props["aria-description"]).toBe(description);
    expect(text(row!)).not.toContain("Server update");
  });

  it("names each machine and words its own update path", () => {
    server("mini", {
      label: "ministorm",
      serverSelfUpdate: "desktop-managed",
      desktopAppUpdate: true,
    });
    server("box", { label: "Build box", serverVersion: "1.0.64", serverSelfUpdate: "respawn" });
    render();

    const [ministorm, box] = rows().map((row) => tooltips(row));

    expect(ministorm!.map(({ trigger }) => text(trigger))).toEqual([
      "ministorm 1.0.65 → 1.0.66",
      "Update",
    ]);
    for (const { popup } of ministorm!) {
      expect(popup).toBe(
        "SpecWithCode on ministorm runs 1.0.65; this app runs 1.0.66. " +
          "Update installs the newest SpecWithCode release on ministorm and relaunches the app there. " +
          "Threads running there stop for the restart. " +
          "Nothing else on ministorm changes: no settings, no other software.",
      );
    }
    expect(box!.map(({ trigger }) => text(trigger))).toEqual([
      "Build box 1.0.64 → 1.0.66",
      "Update",
    ]);
    for (const { popup } of box!) {
      expect(popup).toBe(
        "SpecWithCode on Build box runs 1.0.64; this app runs 1.0.66. " +
          "Update installs 1.0.66 on Build box and restarts its server. " +
          "Threads running there stop for the restart. " +
          "Nothing else on Build box changes: no settings, no other software.",
      );
    }
  });

  it.each([
    { threadContinuation: true, setting: true, threads: "continue after the restart" },
    { threadContinuation: true, setting: false, threads: "stop for the restart" },
    { threadContinuation: false, setting: true, threads: "stop for the restart" },
  ])(
    "says threads $threads when continuation is $threadContinuation and the setting is $setting",
    ({ threadContinuation, setting, threads }) => {
      server("only", { serverUpdateThreadContinuation: threadContinuation });
      state.continueThreadsAfterServerUpdate = setting;
      render();

      for (const { popup } of tooltips(rows()[0]!)) {
        expect(popup).toContain(` Threads running there ${threads}. `);
      }
    },
  );

  it("keeps naming the machine's server in the desktop confirm dialog", async () => {
    registerConfirmDialogHost();
    server("mini", {
      label: "ministorm",
      serverSelfUpdate: "desktop-managed",
      desktopAppUpdate: true,
    });
    server("box", { label: "Build box", serverVersion: "1.0.66" });
    render();

    await act(async () => {
      updateButton(rows()[0]!).props.onClick();
    });

    expect(readConfirmDialogState()).toEqual(
      expect.objectContaining({
        status: "confirming",
        message:
          "Update the SpecWithCode desktop app that runs the ministorm server? It will close and relaunch on that machine.",
      }),
    );
    await act(async () => {
      respondToConfirmDialog(false);
    });
    expect(state.updateServer).not.toHaveBeenCalled();
  });

  it("keeps naming the machine's server in the update toast", async () => {
    server("mini", { label: "ministorm" });
    server("box", { label: "Build box", serverVersion: "1.0.66" });
    state.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "1.0.66", method: "boot-service" as const }),
    );
    render();

    expect(rows()).toHaveLength(1);
    await act(async () => {
      updateButton(rows()[0]!).props.onClick();
    });
    await flushPromises();

    expect(state.updateServer).toHaveBeenCalledWith({
      environmentId: "mini",
      input: { targetVersion: "1.0.66" },
    });
    expect(state.toast).toHaveBeenCalledWith({
      type: "success",
      title: "ministorm server updated",
      description: "Reconnected on specweave-studio@1.0.66.",
    });
  });

  it("leaves a failed row's Retry button without the explanation", () => {
    server("only");
    state.updates.set("only", {
      status: "failed",
      stage: "downloading",
      fromVersion: "1.0.65",
      targetVersion: "1.0.66",
      message: "Download failed.",
    } satisfies ServerUpdateState);
    render();

    const [row] = rows();
    const retry = row!.find((node) => node.type === "button" && text(node) === "Retry");

    expect(retry.props["aria-description"]).toBeUndefined();
    expect(tooltips(row!).map(({ popup }) => popup)).toEqual([
      "Could not update server: Download failed.",
    ]);
  });
});
