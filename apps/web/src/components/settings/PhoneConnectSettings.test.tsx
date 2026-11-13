import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";

vi.mock("~/cloud/publicConfig", () => ({ hasCloudPublicConfig: vi.fn() }));
vi.mock("~/state/environments", () => ({
  useEnvironment: vi.fn(),
  usePrimaryEnvironmentId: vi.fn(),
}));
vi.mock("~/studio/machineNickname", () => ({
  useMachineNickname: vi.fn(),
  useCustomMachineNickname: () => null,
  useMachineNameHolder: () => () => null,
}));
// The summary's rename and identity hooks reach the app runtime; the card needs neither.
vi.mock("~/studio/useRenameMachine", () => ({
  useRenameMachine: () => ({ lock: "unsupported", rename: vi.fn(), saveIdentity: vi.fn() }),
}));
vi.mock("~/studio/machineIdentity", () => ({ useMachineIdentity: () => null }));
vi.mock("../ui/qr-code", () => ({
  QRCodeSvg: (props: { value: string; size: number }) => (
    <i data-qr={props.value} data-size={props.size} />
  ),
}));
vi.mock("./PhoneDevicesSettings", () => ({
  PhoneDevicesSettings: () => <div data-phone-list />,
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section data-title={title}>{children}</section>
  ),
  TeamRulesLabel: ({ children }: { children: ReactNode }) => <span data-rules>{children}</span>,
}));
// What the real MachineSummary module reads; the card under test is handed its setup.
vi.mock("@clerk/react", () => ({ useAuth: vi.fn(), useUser: vi.fn() }));
vi.mock("~/cloud/managedRelayState", () => ({ useManagedRelayPhones: vi.fn() }));
vi.mock("~/cloud/useCloudLinkController", () => ({ useCloudLinkController: vi.fn() }));
vi.mock("~/cloud/useRememberConnectChoice", () => ({ useRememberConnectChoice: vi.fn() }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: vi.fn(),
  useUpdateClientSettings: vi.fn(),
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: vi.fn() }));
vi.mock("~/teamRules/useTeamRules", () => ({ useTeamRules: vi.fn() }));
vi.mock("~/teamRules/teamRulesView", () => ({ teamRulesReachLock: vi.fn() }));
vi.mock("~/versionSkew", () => ({ resolveServerConfigVersionMismatch: vi.fn() }));
vi.mock("../clerk/useStudioConnectAuthPrompt", () => ({ useStudioConnectAuthPrompt: vi.fn() }));
vi.mock("./RenameMachineDialog", () => ({ RenameMachineDialog: () => null }));
vi.mock("./MachineSummary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MachineSummary")>();
  return {
    ...actual,
    // The card reads its own setup only when the page hands none in.
    MachineSetupState: ({ children }: { children: (setup: unknown) => ReactNode }) =>
      children(own.setup),
  };
});

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useMachineNickname } from "~/studio/machineNickname";
import type { MachineConnect, MachineNextStep } from "./machineNextStep.logic";
import type { MachineSetup } from "./MachineSummary";
import { PHONE_APP_URL } from "./PhoneConnect.logic";
import { PhoneConnectSettings } from "./PhoneConnectSettings";

const own = vi.hoisted(() => ({ setup: null as unknown }));
const account = "sam@example.com";
const on: MachineConnect = { kind: "on", account };

function setupOf(
  connect: MachineConnect,
  step: MachineNextStep,
  rest: Partial<MachineSetup> = {},
): MachineSetup {
  return {
    connect,
    connectLocked: false,
    lock: null,
    phones: 0,
    step,
    error: null,
    retry: vi.fn(),
    busy: false,
    signIn: vi.fn(),
    turnOn: vi.fn(),
    dismissPhoneStep: vi.fn(),
    ...rest,
  };
}

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

let renderer: ReactTestRenderer | null = null;
function show(setup?: MachineSetup, pairRow?: ReactNode) {
  act(() => {
    renderer = create(<PhoneConnectSettings setup={setup} pairRow={pairRow} />);
  });
  const root = renderer!.root;
  const all = (name: string) =>
    root.findAll((node) => typeof node.type === "string" && node.props[name] !== undefined);
  return {
    root,
    empty: () => renderer!.toJSON() === null,
    card: () => all("data-phone-card")[0]?.props["data-phone-card"],
    steps: () => all("data-phone-step").map((step) => [step.props["data-state"], textOf(step)]),
    codes: () => all("data-qr").map((code) => [code.props["data-qr"], code.props["data-size"]]),
    buttons: () => root.findAllByType("button").map((item) => textOf(item)),
    press: (label: string) => {
      const found = root.findAllByType("button").find((item) => textOf(item) === label);
      if (!found) throw new Error(`No button "${label}"`);
      act(() => found.props.onClick());
    },
    text: () => textOf(root),
    has: (name: string) => all(name).length > 0,
  };
}

beforeEach(() => {
  vi.mocked(hasCloudPublicConfig).mockReturnValue(true);
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(EnvironmentId.make("m4"));
  vi.mocked(useEnvironment).mockReturnValue({ label: "sams-mbp.local" } as never);
  vi.mocked(useMachineNickname).mockReturnValue("Sam's MacBook Pro");
  own.setup = null;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("Your phone", () => {
  it("is one card of three steps with Sign in as its only button while signed out", () => {
    const setup = setupOf({ kind: "signed-out" }, { kind: "sign-in", canAct: true });
    const view = show(setup);
    expect(view.card()).toBe("sign-in");
    expect(view.steps().map(([state]) => state)).toEqual(["current", "todo", "todo"]);
    expect(view.buttons()).toEqual(["Sign in"]);
    expect(view.codes()).toEqual([]);
    view.press("Sign in");
    expect(setup.signIn).toHaveBeenCalledTimes(1);
  });

  it("offers Turn on once signed in", () => {
    const setup = setupOf({ kind: "off", account }, { kind: "turn-on", canAct: true });
    const view = show(setup);
    expect(view.card()).toBe("turn-on");
    expect(view.buttons()).toEqual(["Turn on"]);
    expect(view.text()).toContain("Signed in as sam@example.com.");
    view.press("Turn on");
    expect(setup.turnOn).toHaveBeenCalledTimes(1);
  });

  it("waits for the phone with the store code and no primary button once Connect is on", () => {
    const view = show(setupOf(on, { kind: "add-phone" }));
    expect(view.card()).toBe("add-phone");
    expect(view.text()).toContain("Waiting for your phone…");
    // Connect being on is done, so it folds away: the summary's facts already say it.
    expect(view.text()).not.toContain("Sam's MacBook Pro is on SpecWithCode Connect");
    expect(view.steps().map(([state]) => state)).toEqual(["current", "todo"]);
    expect(view.text()).toContain("Sign in on the phone as sam@example.com");
    expect(view.text()).toContain("App Store · Google Play");
    expect(view.codes()).toEqual([[PHONE_APP_URL, 104]]);
    expect(view.buttons()).toEqual(["Not now"]);
  });

  it("drops the highlight after Not now and keeps the steps left and the code", () => {
    const view = show(setupOf(on, { kind: "done" }));
    expect(view.card()).toBe("plain");
    expect(view.text()).not.toContain("Next step");
    expect(view.steps().map(([state]) => state)).toEqual(["current", "todo"]);
    expect(view.codes()).toHaveLength(1);
    expect(view.buttons()).toEqual([]);
  });

  it("is only the list of phones once every step is done", () => {
    const view = show(setupOf(on, { kind: "done" }, { phones: 1 }));
    expect(view.steps()).toEqual([]);
    expect(view.codes()).toEqual([]);
    const titles = view.root
      .findAll((node) => typeof node.type === "string" && node.props["data-title"] !== undefined)
      .map((node) => node.props["data-title"]);
    expect(titles).toEqual(["Phones"]);
    expect(view.has("data-phone-list")).toBe(true);
    expect(view.buttons()).toEqual([]);
  });

  it("offers Try again, and nothing else, when the link cannot be read", () => {
    const setup = setupOf({ kind: "unknown" }, { kind: "done" }, { error: "offline" });
    const view = show(setup);
    expect(view.card()).toBe("failed");
    expect(view.text()).toContain("Could not check SpecWithCode Connect");
    expect(view.text()).toContain("offline");
    expect(view.buttons()).toEqual(["Try again"]);
    view.press("Try again");
    expect(setup.retry).toHaveBeenCalledTimes(1);
  });

  it("says where to do it in a window that cannot change this machine's link", () => {
    const view = show(setupOf({ kind: "signed-out" }, { kind: "sign-in", canAct: false }));
    expect(view.text()).toContain("Open SpecWithCode on Sam's MacBook Pro to do this.");
    expect(view.buttons()).toEqual([]);
  });

  it("keeps Sign in when Team rules only keep phones off", () => {
    const signIn = vi.fn();
    const view = show(
      setupOf(
        { kind: "signed-out" },
        { kind: "sign-in", canAct: true },
        {
          signIn,
          lock: { setBy: "Set by Acme", message: "Your team keeps phones off this machine." },
        },
      ),
    );
    expect(view.card()).toBe("sign-in");
    expect(view.steps()).toEqual([]);
    expect(view.text()).toContain("Your team keeps phones off this machine.");
    expect(view.buttons()).toEqual(["Sign in"]);
    view.press("Sign in");
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("shows only the rule when Team rules keep this machine off Connect", () => {
    const view = show(
      setupOf(
        { kind: "signed-out" },
        { kind: "done" },
        {
          connectLocked: true,
          lock: { setBy: "Set by Acme", message: "Your team keeps this machine off Connect." },
        },
      ),
    );
    expect(view.card()).toBe("locked");
    expect(view.buttons()).toEqual([]);
  });

  it("shows the rule and no steps when Team rules keep phones off", () => {
    const view = show(
      setupOf(
        { kind: "off", account },
        { kind: "done" },
        { lock: { setBy: "Set by Acme", message: "Your team keeps phones off this machine." } },
      ),
    );
    expect(view.card()).toBe("locked");
    expect(view.steps()).toEqual([]);
    expect(view.text()).toContain("Your team keeps phones off this machine.");
    expect(view.text()).toContain("Set by Acme");
    expect(view.buttons()).toEqual([]);
  });

  it("draws the pairing row last and quiet, never as the only way", () => {
    const view = show(
      setupOf(on, { kind: "add-phone" }),
      <button data-pair-row>Pair with a private QR code</button>,
    );
    expect(view.buttons()).toEqual(["Not now", "Pair with a private QR code"]);
    expect(view.steps()).toHaveLength(2);
  });

  it("reads its own setup when the page hands none in", () => {
    own.setup = setupOf({ kind: "signed-out" }, { kind: "sign-in", canAct: true });
    const view = show();
    expect(view.card()).toBe("sign-in");
  });

  it("draws nothing in a build without SpecWithCode Connect or before the machine is known", () => {
    vi.mocked(hasCloudPublicConfig).mockReturnValue(false);
    expect(show(setupOf(on, { kind: "add-phone" })).empty()).toBe(true);
    act(() => renderer?.unmount());
    vi.mocked(hasCloudPublicConfig).mockReturnValue(true);
    vi.mocked(usePrimaryEnvironmentId).mockReturnValue(null);
    expect(show(setupOf(on, { kind: "add-phone" })).empty()).toBe(true);
  });
});
