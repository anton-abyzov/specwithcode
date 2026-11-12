import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: false, userId: null as string | null },
  canManageRelay: true,
  connectLock: null as { message: string; setBy: string } | null,
  serverConfig: {} as object | null,
  linkState: {
    data: { linked: false, cloudUserId: null } as object | null,
    error: null as string | null,
    isPending: false,
    target: { environmentId: "env-m5" } as object | null,
    refresh: () => {},
  },
  operationError: null as string | null,
  reconcile: vi.fn(async (_desired: object) => true),
  toast: vi.fn(),
  storage: {} as Record<string, unknown>,
}));

vi.mock("@clerk/react", () => ({ useAuth: () => runtime.auth }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ _tag: "Success" }) }));
vi.mock("~/cloud/publicConfig", () => ({ hasCloudPublicConfig: () => true }));
vi.mock("~/cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => ({
    linkState: runtime.linkState,
    operationError: runtime.operationError,
    reconcileCloudState: runtime.reconcile,
  }),
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: (key: string, initial: unknown) => [
    runtime.storage[key] ?? initial,
    (next: unknown) => {
      runtime.storage[key] =
        typeof next === "function"
          ? (next as (state: unknown) => unknown)(runtime.storage[key] ?? initial)
          : next;
    },
  ],
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ isReady: true, environments: [] }),
  usePrimaryEnvironment: () => ({ environmentId: "env-m5", serverConfig: runtime.serverConfig }),
  usePrimaryEnvironmentId: () => "env-m5",
}));
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => ({}) },
  readEnvironmentScope: () => runtime.canManageRelay,
  useEnvironmentScope: () => runtime.canManageRelay,
}));
vi.mock("~/teamRules/useTeamRules", () => ({ useTeamRules: () => ({ summary: undefined }) }));
vi.mock("~/teamRules/teamRulesView", () => ({ teamRulesReachLock: () => runtime.connectLock }));
vi.mock("./CloudEnvironmentConnectList", () => ({ CloudEnvironmentConnectRows: () => null }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
}));
vi.mock("../ui/wizard", () => ({
  WizardPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  WizardHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
  WizardPanel: ({ children }: { children: ReactNode }) => <>{children}</>,
  WizardFooter: ({ children, leading }: { children: ReactNode; leading?: ReactNode }) => (
    <>
      {leading}
      {children}
    </>
  ),
  WizardSteps: () => null,
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label="Don't show this again"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));
vi.mock("../ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    disabled?: boolean;
    "aria-label"?: string;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      role="switch"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      {...props}
    />
  ),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: runtime.toast } }));

import { ConnectOnboardingDialog } from "./ConnectOnboardingDialog";

const TURNED_ON =
  "This machine is now reachable from your other devices on this account. Turn it off here or any time in Settings > Machines > SpecWithCode Connect.";
const OFF_KEY = "studio:connect-turned-off:v1";
const OPT_OUT_KEY = "studio:connect-onboarding-opt-out:v1";

let renderer: ReactTestRenderer | null = null;
const rerender = () => act(async () => renderer!.update(<ConnectOnboardingDialog />));
/** The app is open and signed out; then this account signs in. */
async function signIn(userId = "user_a") {
  runtime.auth = { isLoaded: true, isSignedIn: false, userId: null };
  if (renderer === null) {
    await act(async () => {
      renderer = create(<ConnectOnboardingDialog />);
    });
  } else {
    await rerender();
  }
  runtime.auth = { isLoaded: true, isSignedIn: true, userId };
  await rerender();
  await rerender();
}
const texts = () => JSON.stringify(renderer!.toJSON());
const button = (label: string) =>
  renderer!.root.findAll((node) => node.type === "button" && node.props.children === label)[0] ??
  null;
const toggle = (label: string) =>
  renderer!.root.findAll(
    (node) => node.type === "input" && node.props["aria-label"] === label,
  )[0] ?? null;
const publishSwitch = () => toggle("Publish this environment");

beforeEach(() => {
  vi.stubGlobal("window", {
    desktopBridge: {},
    sessionStorage: { getItem: () => null },
  });
  runtime.canManageRelay = true;
  runtime.connectLock = null;
  runtime.serverConfig = {};
  runtime.linkState = {
    data: { linked: false, cloudUserId: null },
    error: null,
    isPending: false,
    target: { environmentId: "env-m5" },
    refresh: () => {},
  };
  runtime.operationError = null;
  runtime.reconcile.mockReset();
  runtime.reconcile.mockResolvedValue(true);
  runtime.toast.mockReset();
  runtime.storage = {};
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("SpecWithCode Connect after sign-in", () => {
  it("turns Connect on by itself once, and the wizard says so and where to turn it off", async () => {
    await signIn();
    expect(runtime.reconcile).toHaveBeenCalledExactlyOnceWith({
      managedTunnel: true,
      publish: true,
    });
    expect(runtime.toast).toHaveBeenCalledExactlyOnceWith({
      type: "success",
      title: "SpecWithCode Connect is on",
      description: TURNED_ON,
    });
    expect(texts()).toContain(TURNED_ON);
    expect(publishSwitch()?.props.checked).toBe(true);
    // It is on already, so nothing is left to decline.
    expect(button("Not now")).toBeNull();
    await rerender();
    expect(runtime.reconcile).toHaveBeenCalledOnce();
  });
  it("does not act on a cold load with a restored session", async () => {
    runtime.auth = { isLoaded: true, isSignedIn: true, userId: "user_a" };
    await act(async () => {
      renderer = create(<ConnectOnboardingDialog />);
    });
    await rerender();
    expect(runtime.reconcile).not.toHaveBeenCalled();
    expect(renderer!.toJSON()).toBeNull();
  });
  it("lets the owner turn it straight back off, and then leaves it off at the next sign-in", async () => {
    await signIn();
    runtime.linkState = { ...runtime.linkState, data: { linked: true, cloudUserId: "user_a" } };
    await rerender();
    await act(async () => publishSwitch()!.props.onChange({ target: { checked: false } }));
    await act(async () =>
      toggle("Publish agent activity")!.props.onChange({ target: { checked: false } }),
    );
    await act(async () => button("Continue")!.props.onClick());
    expect(runtime.reconcile).toHaveBeenLastCalledWith({ managedTunnel: false, publish: false });
    expect(runtime.storage[OFF_KEY]).toEqual({ accounts: ["user_a"] });
    expect(runtime.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "SpecWithCode Connect turned off" }),
    );
    // Signed out, the machine is unlinked again; the same account signs back in.
    runtime.linkState = { ...runtime.linkState, data: { linked: false, cloudUserId: null } };
    runtime.reconcile.mockClear();
    await signIn();
    expect(runtime.reconcile).not.toHaveBeenCalled();
    // The wizard does not propose turning it back on either.
    expect(publishSwitch()?.props.checked).toBe(false);
    expect(texts()).not.toContain(TURNED_ON);
  });
  it("leaves it off for an account that turned it off in Settings", async () => {
    runtime.storage[OFF_KEY] = { accounts: ["user_a"] };
    await signIn();
    expect(runtime.reconcile).not.toHaveBeenCalled();
    // Another account on this machine is still turned on.
    await signIn("user_b");
    expect(runtime.reconcile).toHaveBeenCalledOnce();
  });
  it("leaves alone an account that chose not to see the wizard again", async () => {
    runtime.storage[OPT_OUT_KEY] = { optOutAccounts: ["user_a"] };
    await signIn();
    expect(runtime.reconcile).not.toHaveBeenCalled();
    expect(renderer!.toJSON()).toBeNull();
  });
  it("never turns it on against Team rules", async () => {
    runtime.connectLock = { message: "Set by Acme", setBy: "Acme" };
    await signIn();
    expect(runtime.reconcile).not.toHaveBeenCalled();
  });
  it("leaves a machine that is already linked as it is", async () => {
    runtime.linkState = {
      ...runtime.linkState,
      data: { linked: true, cloudUserId: "user_a", managedTunnelActive: false },
    };
    await signIn();
    expect(runtime.reconcile).not.toHaveBeenCalled();
    expect(publishSwitch()?.props.checked).toBe(false);
  });
  it("records no off choice when both switches are unticked over a link it leaves running", async () => {
    runtime.linkState = {
      ...runtime.linkState,
      data: { linked: true, cloudUserId: "user_a", managedTunnelActive: true },
    };
    await signIn();
    await act(async () => publishSwitch()!.props.onChange({ target: { checked: false } }));
    await act(async () =>
      toggle("Publish agent activity")!.props.onChange({ target: { checked: false } }),
    );
    await act(async () => button("Continue")!.props.onClick());
    // The link from before this sign-in is not torn down, so it is not "off".
    expect(runtime.reconcile).not.toHaveBeenCalled();
    expect(runtime.storage[OFF_KEY]).toBeUndefined();
  });
  it("remembers both switches unticked on a machine that is not linked", async () => {
    runtime.reconcile.mockResolvedValue(false);
    await signIn();
    runtime.reconcile.mockClear();
    await act(async () => publishSwitch()!.props.onChange({ target: { checked: false } }));
    await act(async () =>
      toggle("Publish agent activity")!.props.onChange({ target: { checked: false } }),
    );
    await act(async () => button("Continue")!.props.onClick());
    expect(runtime.reconcile).not.toHaveBeenCalled();
    expect(runtime.storage[OFF_KEY]).toEqual({ accounts: ["user_a"] });
  });
  it("does nothing from a browser, or with a session that cannot manage the link", async () => {
    vi.stubGlobal("window", { sessionStorage: { getItem: () => null } });
    await signIn();
    expect(runtime.reconcile).not.toHaveBeenCalled();
    vi.stubGlobal("window", { desktopBridge: {}, sessionStorage: { getItem: () => null } });
    runtime.canManageRelay = false;
    await signIn("user_b");
    expect(runtime.reconcile).not.toHaveBeenCalled();
  });
  it("shows the failure and offers to retry when turning it on failed, never a silent off", async () => {
    runtime.reconcile.mockResolvedValue(false);
    runtime.operationError = "Could not reach SpecWithCode Connect.";
    await signIn();
    expect(runtime.reconcile).toHaveBeenCalledOnce();
    expect(runtime.toast).not.toHaveBeenCalled();
    expect(texts()).not.toContain(TURNED_ON);
    expect(texts()).toContain("Could not reach SpecWithCode Connect.");
    expect(publishSwitch()?.props.checked).toBe(true);
    expect(button("Continue")?.props.disabled).toBe(false);
    expect(runtime.storage[OFF_KEY]).toBeUndefined();
  });
  it("holds back when Not now is pressed before the link state is known", async () => {
    runtime.linkState = { ...runtime.linkState, data: null, isPending: true };
    await signIn();
    expect(runtime.reconcile).not.toHaveBeenCalled();
    await act(async () => button("Not now")!.props.onClick());
    runtime.linkState = {
      ...runtime.linkState,
      data: { linked: false, cloudUserId: null },
      isPending: false,
    };
    await rerender();
    expect(runtime.reconcile).not.toHaveBeenCalled();
  });
});
