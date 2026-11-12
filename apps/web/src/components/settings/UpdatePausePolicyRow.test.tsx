import { EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  configs: new Map<string, unknown>(),
  access: "granted" as "granted" | "denied" | "signed-out" | "unknown",
  persist: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { environmentId: string }) => mocks.configs.get(atom.environmentId) ?? null,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: (environmentId: string) => ({ environmentId }),
    updateSettings: "updateSettings",
  },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScopeAccess: () => mocks.access }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "updateSettings" ? mocks.persist : vi.fn()),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("../ui/switch", () => ({
  Switch: (props: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (value: boolean) => void;
    "aria-label": string;
  }) => (
    <button
      role="switch"
      aria-label={props["aria-label"]}
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onCheckedChange(!props.checked)}
    />
  ),
}));

import { UpdatePausePolicyRow } from "./UpdatePausePolicyRow";

const linux = EnvironmentId.make("env-minisforum");
const mac = EnvironmentId.make("env-m4");

function config(os: string, settings: Record<string, unknown> = {}) {
  return {
    environment: { platform: { os, arch: "x64" } },
    settings: { pauseWorkForUpdates: false, continueThreadsAfterServerUpdate: true, ...settings },
  };
}

let renderer: ReactTestRenderer | null = null;

async function render(environmentId = linux, reachable = true) {
  await act(async () => {
    renderer = create(
      <UpdatePausePolicyRow
        environmentId={environmentId}
        label={environmentId === linux ? "Minisforum" : "M4"}
        reachable={reachable}
        local={environmentId === mac}
      />,
    );
  });
}

const toggle = () => renderer!.root.findByProps({ role: "switch" });
const text = () =>
  renderer!.root
    .findAllByType("p")
    .map((node) => node.children.join(""))
    .join("\n");

beforeEach(() => {
  mocks.configs.clear();
  mocks.configs.set(linux, config("linux"));
  mocks.configs.set(mac, config("darwin"));
  mocks.access = "granted";
  mocks.persist.mockReset();
  mocks.persist.mockImplementation(
    async (command: { input: { patch: { pauseWorkForUpdates: boolean } } }) => ({
      _tag: "Success",
      value: { pauseWorkForUpdates: command.input.patch.pauseWorkForUpdates },
    }),
  );
  mocks.toast.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("UpdatePausePolicyRow", () => {
  it("is off by default and says the update waits for quiet", async () => {
    mocks.configs.set(linux, {
      environment: { platform: { os: "linux", arch: "x64" } },
      settings: { continueThreadsAfterServerUpdate: true },
    });
    await render();
    expect(toggle().props["aria-checked"]).toBe(false);
    expect(toggle().props.disabled).toBe(false);
    expect(text()).toContain(
      "An update waits up to 30 minutes for Minisforum to have no running work. If it is still busy then, Minisforum stays on its version until the next update.",
    );
    expect(text()).toContain("Update now still installs right away.");
  });

  it("says a Mac keeps waiting for quiet when off", async () => {
    await render(mac);
    expect(toggle().props["aria-checked"]).toBe(false);
    expect(text()).toContain(
      "An update waits until M4 has no running work, however long that takes. Update now still installs right away.",
    );
    expect(text()).not.toContain("30 minutes");
  });

  it("covers both waits when the machine's OS is not known", async () => {
    mocks.configs.set(linux, config("windows"));
    await render();
    expect(text()).toContain("A Mac keeps waiting as long as that takes");
    expect(text()).toContain("a Linux machine waits up to 30 minutes");
  });

  it("clears the new position once the machine reports the saved value", async () => {
    await render(linux);
    await act(async () => {
      toggle().props.onClick();
    });
    expect(toggle().props["aria-checked"]).toBe(true);
    // The machine now reports the saved value; the row follows it from here on.
    mocks.configs.set(linux, config("linux", { pauseWorkForUpdates: true }));
    await act(async () => {
      renderer!.update(
        <UpdatePausePolicyRow environmentId={linux} label="Minisforum" reachable local={false} />,
      );
    });
    expect(toggle().props["aria-checked"]).toBe(true);
    // A later change made elsewhere shows, so no stale position is held.
    mocks.configs.set(linux, config("linux", { pauseWorkForUpdates: false }));
    await act(async () => {
      renderer!.update(
        <UpdatePausePolicyRow environmentId={linux} label="Minisforum" reachable local={false} />,
      );
    });
    expect(toggle().props["aria-checked"]).toBe(false);
  });

  it("writes nothing for a second toggle while a save is in flight", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocks.persist.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render(linux);
    await act(async () => {
      toggle().props.onClick();
    });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(toggle().props.disabled).toBe(true);
    await act(async () => {
      toggle().props.onClick();
    });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ _tag: "Success", value: { pauseWorkForUpdates: true } });
    });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(toggle().props.disabled).toBe(false);
  });

  it("patches only the machine whose card it is on", async () => {
    await render(linux);
    await act(async () => {
      toggle().props.onClick();
    });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.persist).toHaveBeenCalledWith({
      environmentId: linux,
      input: { patch: { pauseWorkForUpdates: true } },
    });
    // The new position shows until the machine reports it.
    expect(toggle().props["aria-checked"]).toBe(true);
    expect(text()).toContain("After 30 minutes of waiting, running turns pause");
  });

  it("names the Mac's own wait when on there", async () => {
    mocks.configs.set(mac, config("darwin", { pauseWorkForUpdates: true }));
    await render(mac);
    expect(toggle().props["aria-checked"]).toBe(true);
    expect(text()).toContain("After the wait set in “Pause running work after”");
  });

  it("says it has no effect while threads do not continue after restarts", async () => {
    mocks.configs.set(
      linux,
      config("linux", { pauseWorkForUpdates: true, continueThreadsAfterServerUpdate: false }),
    );
    await render();
    expect(toggle().props["aria-checked"]).toBe(true);
    expect(text()).toContain(
      "Has no effect on Minisforum while “Continue threads after restarts” is off there",
    );
    // The effective value is off, so the row does not promise a pause.
    expect(text()).toContain("An update waits up to 30 minutes for Minisforum");
    expect(text()).not.toContain("running turns pause, the update installs");
  });

  it("restores the switch and shows an error when the save fails", async () => {
    mocks.persist.mockResolvedValue({ _tag: "Failure" });
    await render();
    await act(async () => {
      toggle().props.onClick();
    });
    expect(toggle().props["aria-checked"]).toBe(false);
    // The machine may have applied it and only the reply was lost: say what is known.
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Could not save update settings",
        description:
          "The change could not be confirmed on Minisforum. The switch shows what Minisforum reports.",
      }),
    );
  });

  it("restores the switch when the machine's release predates the setting", async () => {
    // An older server accepts the patch, drops the unknown key and answers with its settings.
    mocks.persist.mockResolvedValue({ _tag: "Success", value: {} });
    await render();
    await act(async () => {
      toggle().props.onClick();
    });
    expect(toggle().props["aria-checked"]).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description:
          "Minisforum runs a SpecWithCode version without this setting. Update Minisforum first.",
      }),
    );
  });

  it("is disabled on an unreachable machine and writes nothing", async () => {
    await render(linux, false);
    expect(toggle().props.disabled).toBe(true);
    expect(text()).toContain("Minisforum is unreachable");
    await act(async () => {
      toggle().props.onClick();
    });
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("is disabled before the machine's settings arrive and without settings access", async () => {
    mocks.configs.delete(linux);
    await render();
    expect(toggle().props.disabled).toBe(true);
    act(() => renderer?.unmount());
    mocks.configs.set(linux, config("linux"));
    mocks.access = "denied";
    await render();
    expect(toggle().props.disabled).toBe(true);
    expect(text()).toContain("This connection cannot change settings on Minisforum.");
  });

  it.each(["unknown", "signed-out"] as const)(
    "is disabled without a permission line while access is %s",
    async (access) => {
      mocks.access = access;
      await render();
      expect(toggle().props.disabled).toBe(true);
      expect(text()).not.toContain("This connection cannot change settings");
      await act(async () => {
        toggle().props.onClick();
      });
      expect(mocks.persist).not.toHaveBeenCalled();
    },
  );
});
