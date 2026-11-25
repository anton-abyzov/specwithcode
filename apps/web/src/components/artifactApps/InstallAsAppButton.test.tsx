import type {
  DesktopArtifactAppInstallInput,
  DesktopArtifactAppInstallResult,
} from "@specweave-studio/contracts";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock("../ui/toast", () => ({ toastManager: { add: state.addToast } }));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { InstallAsAppButton } from "./InstallAsAppButton";

const app = {
  installId: "0123456789abcdef0123456789abcdef",
  name: "Morning dashboard",
  environmentId: "env-1",
  threadId: "thread-1",
  attachmentId: "att-1",
  title: "Morning dashboard",
  installedAt: "2026-11-24T10:00:00.000Z",
};

let renderer: ReactTestRenderer | undefined;

function stubBridge(bridge: object | undefined) {
  vi.stubGlobal("window", bridge === undefined ? {} : { desktopBridge: bridge });
}

async function render() {
  await act(async () => {
    renderer = create(
      <InstallAsAppButton
        environmentId="env-1"
        threadId="thread-1"
        attachmentId="att-1"
        title="Morning dashboard"
      />,
    );
  });
  return renderer!;
}

async function click() {
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("InstallAsAppButton", () => {
  it("renders nothing outside the desktop app", async () => {
    stubBridge(undefined);
    expect((await render()).toJSON()).toBeNull();
  });

  it("renders nothing on a desktop build without installs", async () => {
    stubBridge({ getWindowRole: () => "main" });
    expect((await render()).toJSON()).toBeNull();
  });

  it("asks the shell to install the page and says it opens in its own window", async () => {
    const installArtifactApp = vi.fn(
      async (_input: DesktopArtifactAppInstallInput): Promise<DesktopArtifactAppInstallResult> => ({
        status: "installed",
        app,
      }),
    );
    stubBridge({ installArtifactApp });
    await render();
    await click();
    expect(installArtifactApp).toHaveBeenCalledWith({
      environmentId: "env-1",
      threadId: "thread-1",
      attachmentId: "att-1",
      title: "Morning dashboard",
    });
    expect(state.addToast).toHaveBeenCalledWith({
      type: "success",
      title: "Morning dashboard is installed. It opens in its own window.",
    });
  });

  it("says when the page is already installed", async () => {
    stubBridge({ installArtifactApp: async () => ({ status: "already-installed", app }) });
    await render();
    await click();
    expect(state.addToast).toHaveBeenCalledWith({
      type: "info",
      title: "Morning dashboard is already installed.",
    });
  });

  it("says nothing when the person cancels", async () => {
    stubBridge({ installArtifactApp: async () => ({ status: "cancelled" }) });
    await render();
    await click();
    expect(state.addToast).not.toHaveBeenCalled();
  });

  it("shows the shell's reason when the install fails", async () => {
    stubBridge({
      installArtifactApp: async () => ({ status: "failed", message: "The folder is read-only." }),
    });
    await render();
    await click();
    expect(state.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "The folder is read-only." }),
    );
  });

  it("reports a rejected call as a failure", async () => {
    stubBridge({
      installArtifactApp: async () => {
        throw new Error("IPC closed");
      },
    });
    await render();
    await click();
    expect(state.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "IPC closed" }),
    );
  });

  it("asks once while the shell's dialog is still open", async () => {
    let finish: (result: DesktopArtifactAppInstallResult) => void = () => undefined;
    const installArtifactApp = vi.fn(
      () =>
        new Promise<DesktopArtifactAppInstallResult>((resolve) => {
          finish = resolve;
        }),
    );
    stubBridge({ installArtifactApp });
    await render();
    const onClick = renderer!.root.findByType("button").props.onClick as () => void;
    await act(async () => {
      onClick();
      onClick();
    });
    expect(installArtifactApp).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findByType("button").props.disabled).toBe(true);
    await act(async () => finish({ status: "cancelled" }));
    expect(renderer!.root.findByType("button").props.disabled).toBe(false);
  });
});
