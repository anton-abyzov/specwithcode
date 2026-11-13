import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";

const settings = vi.hoisted(() => ({
  value: {
    machinePhoneStepDismissed: {} as Record<string, boolean>,
    onboardingMachineRole: null as "main" | "joined" | null,
  },
  update: vi.fn(),
}));
vi.mock("@clerk/react", () => ({ useAuth: vi.fn(), useUser: vi.fn() }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: vi.fn() }));
vi.mock("../../cloud/useCloudLinkController", () => ({ useCloudLinkController: vi.fn() }));
vi.mock("../../cloud/managedRelayState", () => ({ useManagedRelayPhones: vi.fn() }));
vi.mock("../../cloud/useRememberConnectChoice", () => ({ useRememberConnectChoice: vi.fn() }));
vi.mock("../clerk/useStudioConnectAuthPrompt", () => ({ useStudioConnectAuthPrompt: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (value: typeof settings.value) => unknown) => select(settings.value),
  useUpdateClientSettings: () => settings.update,
}));
vi.mock("../../state/environments", () => ({ useEnvironment: vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: vi.fn() }));
const names = vi.hoisted(() => ({ holders: new Map<string, string>() }));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNickname: vi.fn(),
  useCustomMachineNickname: vi.fn(),
  useMachineNameHolder: () => (_id: string, name: string) => {
    const holder = names.holders.get(name.toLowerCase());
    return holder === undefined ? null : { environmentId: holder, name };
  },
}));
vi.mock("../../studio/machineIdentity", () => ({
  machineColorProps: (value: { color: string } | null | undefined) =>
    value ? { "data-machine-color": value.color } : {},
  useMachineIdentity: (id: string | null) =>
    id === null ? null : { environmentId: id, color: "teal", icon: "laptop" },
}));
vi.mock("./MachineColor", () => ({ MachineColorButton: () => null }));
const saveIdentity = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../studio/useRenameMachine", () => ({
  useRenameMachine: () => ({ lock: null, saveIdentity }),
}));
vi.mock("../../teamRules/useTeamRules", () => ({ useTeamRules: vi.fn() }));
vi.mock("../../teamRules/teamRulesView", () => ({ teamRulesReachLock: vi.fn() }));
vi.mock("../../versionSkew", () => ({ resolveServerConfigVersionMismatch: vi.fn() }));
vi.mock("./AddDeviceDialog", () => ({
  showMachinesTarget: vi.fn(),
  AddDeviceDialog: (props: { open: boolean; setup?: { step: { kind: string } } }) =>
    props.open ? <div data-add-device-dialog={props.setup?.step.kind ?? "own"} /> : null,
}));
vi.mock("./RenameMachineDialog", () => ({
  RenameMachineDialog: (props: { open: boolean; hostLabel: string }) =>
    props.open ? <div data-rename-dialog>{props.hostLabel}</div> : null,
}));

import { useAuth, useUser } from "@clerk/react";
import { useManagedRelayPhones } from "../../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useCloudLinkController } from "../../cloud/useCloudLinkController";
import { useRememberConnectChoice } from "../../cloud/useRememberConnectChoice";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useCustomMachineNickname, useMachineNickname } from "../../studio/machineNickname";
import { teamRulesReachLock } from "../../teamRules/teamRulesView";
import { useTeamRules } from "../../teamRules/useTeamRules";
import { resolveServerConfigVersionMismatch } from "../../versionSkew";
import { useStudioConnectAuthPrompt } from "../clerk/useStudioConnectAuthPrompt";
import {
  MachineNextStepCard,
  MachineSetupState,
  MachineSummary,
  PHONE_POLL_MS,
  type MachineSetup,
} from "./MachineSummary";
import type { MachineRoleRow } from "./machineNextStep.logic";

const here = EnvironmentId.make("m4");
const openAuthPrompt = vi.fn();
const reconcileCloudState = vi.fn();
const rememberConnectChoice = vi.fn();
const refreshPhones = vi.fn();
const refreshLink = vi.fn();

const thisRow: MachineRoleRow = {
  label: "Sam's MacBook Pro",
  seen: { state: "this-machine" },
  workers: null,
  workHere: null,
};
const otherRow = (label: string, parts: Partial<MachineRoleRow> = {}): MachineRoleRow => ({
  label,
  seen: { state: "connected" },
  workers: null,
  workHere: null,
  ...parts,
});

interface World {
  configured?: boolean;
  desktop?: boolean;
  signedIn?: boolean;
  /** null: unread. */
  link?: { linked: boolean; managedTunnelActive?: boolean; revokedElsewhereAt?: string } | null;
  phones?: ReadonlyArray<unknown> | null;
  canManage?: boolean;
  lock?: "connect" | "phones" | null;
  mismatch?: { serverVersion: string; clientVersion: string } | null;
}

function world(input: World = {}) {
  const signedIn = input.signedIn ?? false;
  const link =
    input.link === undefined ? { linked: false, managedTunnelActive: false } : input.link;
  vi.mocked(hasCloudPublicConfig).mockReturnValue(input.configured ?? true);
  if (input.desktop ?? true) vi.stubGlobal("window", { desktopBridge: {} });
  else vi.stubGlobal("window", {});
  vi.mocked(useAuth).mockReturnValue({ isLoaded: true, isSignedIn: signedIn } as never);
  vi.mocked(useUser).mockReturnValue({
    user: signedIn ? { primaryEmailAddress: { emailAddress: "sam@example.com" } } : null,
  } as never);
  vi.mocked(useCloudLinkController).mockReturnValue({
    linkState: { data: link, isPending: false, error: null, refresh: refreshLink },
    linked: link?.linked ?? false,
    managedTunnelActive: link?.managedTunnelActive ?? link?.linked ?? false,
    publishAgentActivity: false,
    operationError: null,
    reconcileCloudState,
  } as never);
  vi.mocked(useManagedRelayPhones).mockReturnValue({
    accountId: signedIn ? "acct" : null,
    data: signedIn ? (input.phones === undefined ? [] : input.phones) : null,
    isPending: false,
    refresh: refreshPhones,
  } as never);
  vi.mocked(useEnvironmentScope).mockReturnValue(input.canManage ?? true);
  vi.mocked(useTeamRules).mockReturnValue({ summary: undefined } as never);
  vi.mocked(teamRulesReachLock).mockImplementation(((_: unknown, path: string) =>
    path === input.lock ? { setBy: "Team rules", message: "Off" } : null) as never);
  vi.mocked(useStudioConnectAuthPrompt).mockReturnValue({
    authPrompt: null,
    openAuthPrompt,
    openSetupAuthPrompt: vi.fn(),
  });
  vi.mocked(useRememberConnectChoice).mockReturnValue(rememberConnectChoice);
  vi.mocked(useEnvironment).mockReturnValue({
    label: "sams-mbp.local",
    serverConfig: {
      environment: { platform: { machine: "laptop" }, serverVersion: "1.0.233" },
    },
  } as never);
  vi.mocked(useMachineNickname).mockReturnValue("Sam's MacBook Pro");
  vi.mocked(useCustomMachineNickname).mockReturnValue(null);
  vi.mocked(resolveServerConfigVersionMismatch).mockReturnValue((input.mismatch ?? null) as never);
}

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

const byAttr = (root: ReactTestInstance, name: string) =>
  root.findAll((node) => typeof node.type === "string" && node.props[name] !== undefined);

function page(rows: ReadonlyArray<MachineRoleRow> = [thisRow], body?: ReactNode) {
  let seen: MachineSetup | null = null;
  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = create(
      <MachineSetupState environmentId={here}>
        {(setup) => {
          seen = setup;
          return (
            <>
              <MachineSummary environmentId={here} rows={rows} setup={setup} />
              <MachineNextStepCard setup={setup} machineName="Sam's MacBook Pro">
                {body}
              </MachineNextStepCard>
            </>
          );
        }}
      </MachineSetupState>,
    );
  });
  const root = renderer!.root;
  return {
    root,
    setup: () => seen!,
    unmount: () => act(() => renderer!.unmount()),
    facts: () => byAttr(root, "data-machine-fact").map((fact) => textOf(fact)),
    step: () => byAttr(root, "data-machine-next-step")[0] ?? null,
    stepKind: () => byAttr(root, "data-machine-next-step")[0]?.props["data-machine-next-step"],
    buttons: () => root.findAllByType("button").map((button) => textOf(button)),
    press: (label: string) => {
      const button = root.findAllByType("button").find((item) => textOf(item) === label);
      if (!button) throw new Error(`No button "${label}"`);
      act(() => button.props.onClick());
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.value = { machinePhoneStepDismissed: {}, onboardingMachineRole: null };
  reconcileCloudState.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MachineSummary", () => {
  it("opens with this machine: name, kind, role, version and three facts", () => {
    world();
    const view = page();
    expect(textOf(byAttr(view.root, "data-machine-name")[0]!)).toBe("Sam's MacBook Pro");
    expect(textOf(byAttr(view.root, "data-machine-about")[0]!)).toBe(
      "Laptop · Main machine · 1.0.233, up to date",
    );
    expect(view.facts()).toEqual([
      "Connect: not signed in",
      "Phone: none yet",
      "Other machines: none",
    ]);
  });

  it("names the account, the phones and the other machines once they are there", () => {
    world({ signedIn: true, link: { linked: true, managedTunnelActive: true }, phones: [{}] });
    const view = page([thisRow, otherRow("M1"), otherRow("M3")]);
    expect(view.facts()).toEqual([
      "Connect: linked as sam@example.com",
      "Phone: 1 linked",
      "Other machines: 2",
    ]);
    expect(byAttr(view.root, "data-machine-fact").map((fact) => fact.props["data-ok"])).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("says helper for the machine that may run work here, and an update when one waits", () => {
    world({ mismatch: { serverVersion: "1.0.230", clientVersion: "1.0.233" } });
    const view = page([thisRow, otherRow("M4", { workHere: { status: "active" } })]);
    expect(textOf(byAttr(view.root, "data-machine-about")[0]!)).toBe(
      "Laptop · Helper for M4 · 1.0.230, update to 1.0.233 available",
    );
  });

  it("says not set up for a machine that was meant to join and has not", () => {
    world();
    settings.value.onboardingMachineRole = "joined";
    const view = page();
    expect(textOf(byAttr(view.root, "data-machine-about")[0]!)).toContain("Not set up");
  });

  it("opens the add dialog with the page's setup, without a primary button", () => {
    world({ signedIn: true, link: { linked: true, managedTunnelActive: true }, phones: [{}] });
    const view = page();
    expect(byAttr(view.root, "data-add-device-dialog")).toHaveLength(0);
    view.press("Add a device or machine");
    expect(byAttr(view.root, "data-add-device-dialog")[0]!.props["data-add-device-dialog"]).toBe(
      "done",
    );
  });

  it("renames from the summary without a primary button", () => {
    world({ signedIn: true, link: { linked: true, managedTunnelActive: true }, phones: [{}] });
    const view = page();
    expect(view.buttons()).toEqual(["Add a device or machine", "Rename"]);
    expect(byAttr(view.root, "data-rename-dialog")).toHaveLength(0);
    view.press("Rename");
    expect(textOf(byAttr(view.root, "data-rename-dialog")[0]!)).toBe("sams-mbp.local");
  });
});

describe("the machine's short name", () => {
  const named = (label: string) =>
    vi.mocked(useEnvironment).mockReturnValue({
      label,
      serverConfig: {
        environment: { platform: { machine: "laptop" }, serverVersion: "1.0.233" },
      },
    } as never);

  beforeEach(() => {
    names.holders.clear();
    saveIdentity.mockClear();
  });

  it("offers the chip in the computer name in one click", () => {
    world({ signedIn: true, link: { linked: true, managedTunnelActive: true }, phones: [{}] });
    named("Anton M5MAX PROLED");
    const view = page();
    expect(view.buttons()).toEqual(["Add a device or machine", "Call it M5", "Rename"]);
    view.press("Call it M5");
    expect(saveIdentity).toHaveBeenCalledWith(here, {
      name: "M5",
      color: "teal",
      icon: "laptop",
      short: "",
    });
  });

  it("leaves a name another machine already shows to the Rename dialog", () => {
    world({ signedIn: true, link: { linked: true, managedTunnelActive: true }, phones: [{}] });
    named("Anton M5MAX PROLED");
    names.holders.set("m5", "stale-m5");
    const view = page();
    expect(view.buttons()).toEqual(["Add a device or machine", "Rename"]);
  });

  it("offers nothing once a name is chosen, and keeps the computer name in view", () => {
    world({ signedIn: true, link: { linked: true, managedTunnelActive: true }, phones: [{}] });
    named("Anton M5MAX PROLED");
    vi.mocked(useCustomMachineNickname).mockReturnValue("M5");
    vi.mocked(useMachineNickname).mockReturnValue("M5");
    const view = page();
    expect(view.buttons()).toEqual(["Add a device or machine", "Rename"]);
    expect(textOf(byAttr(view.root, "data-machine-about")[0]!)).toContain(
      "Computer name Anton M5MAX PROLED",
    );
  });
});

describe("the one next step", () => {
  it("is Sign in while signed out, and the button opens the sign-in", () => {
    world();
    const view = page();
    expect(view.stepKind()).toBe("sign-in");
    expect(textOf(view.step()!)).toContain("Sign in to SpecWithCode Connect");
    expect(view.buttons()).toEqual(["Add a device or machine", "Rename", "Sign in"]);
    view.press("Sign in");
    expect(openAuthPrompt).toHaveBeenCalledTimes(1);
    expect(reconcileCloudState).not.toHaveBeenCalled();
  });

  it("is Turn on once signed in, and turning on keeps the choice", async () => {
    world({ signedIn: true });
    const view = page();
    expect(view.stepKind()).toBe("turn-on");
    expect(view.buttons()).toEqual(["Add a device or machine", "Rename", "Turn on"]);
    await act(async () => {
      view.press("Turn on");
    });
    expect(reconcileCloudState).toHaveBeenCalledWith({ managedTunnel: true, publish: true });
    expect(rememberConnectChoice).toHaveBeenCalledWith(true);
  });

  it("says the machine was deregistered from another device, and offers to turn it on again", () => {
    world({
      signedIn: true,
      link: { linked: false, revokedElsewhereAt: "2026-11-12T23:00:00.000Z" },
    });
    const view = page();
    expect(view.stepKind()).toBe("turn-on");
    expect(view.facts()[0]).toBe("Connect: deregistered from another device");
    expect(textOf(byAttr(view.root, "data-machine-deregistered-elsewhere")[0]!)).toBe(
      "This machine was deregistered from another device, so it is off SpecWithCode Connect.",
    );
    expect(view.buttons()).toContain("Turn on");
  });

  it("says so on the sign-in step too, and not once the machine is linked again", () => {
    const revokedElsewhereAt = "2026-11-12T23:00:00.000Z";
    world({ link: { linked: false, revokedElsewhereAt } });
    const signedOut = page();
    expect(signedOut.stepKind()).toBe("sign-in");
    expect(byAttr(signedOut.root, "data-machine-deregistered-elsewhere")).toHaveLength(1);
    signedOut.unmount();

    world({
      signedIn: true,
      link: { linked: true, managedTunnelActive: true, revokedElsewhereAt },
    });
    const linked = page();
    expect(linked.facts()[0]).toBe("Connect: linked as sam@example.com");
    expect(byAttr(linked.root, "data-machine-deregistered-elsewhere")).toHaveLength(0);
  });

  it("says nothing of the kind for a machine that was simply never linked", () => {
    world({ signedIn: true });
    expect(byAttr(page().root, "data-machine-deregistered-elsewhere")).toHaveLength(0);
  });

  it("keeps activity for phone notifications off on a link that already had it off", async () => {
    world({ signedIn: true, link: { linked: true, managedTunnelActive: false } });
    const view = page();
    expect(view.stepKind()).toBe("turn-on");
    await act(async () => {
      view.press("Turn on");
    });
    expect(reconcileCloudState).toHaveBeenCalledWith({ managedTunnel: true, publish: false });
  });

  it("does not record a choice when turning on fails", async () => {
    world({ signedIn: true });
    reconcileCloudState.mockResolvedValue(false);
    const view = page();
    await act(async () => {
      view.press("Turn on");
    });
    expect(rememberConnectChoice).not.toHaveBeenCalled();
  });

  it("is Add your phone once Connect is on, with the phone steps as its body", () => {
    world({ signedIn: true, link: { linked: true, managedTunnelActive: true } });
    const view = page([thisRow], <p data-phone-steps>steps</p>);
    expect(view.stepKind()).toBe("add-phone");
    expect(textOf(view.step()!)).toContain("Waiting for your phone…");
    expect(byAttr(view.root, "data-phone-steps")).toHaveLength(1);
    // Waiting is not a button: this step has no primary one.
    expect(view.buttons()).toEqual(["Add a device or machine", "Rename", "Not now"]);
  });

  it("looks for the phone by itself while it waits, and stops once one is there", () => {
    vi.useFakeTimers();
    try {
      world({ signedIn: true, link: { linked: true, managedTunnelActive: true } });
      const waiting = page();
      expect(refreshPhones).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(PHONE_POLL_MS * 2));
      expect(refreshPhones).toHaveBeenCalledTimes(2);
      expect(PHONE_POLL_MS).toBeLessThan(10_000);
      waiting.unmount();
      act(() => void vi.advanceTimersByTime(PHONE_POLL_MS * 2));
      expect(refreshPhones).toHaveBeenCalledTimes(2);

      refreshPhones.mockClear();
      world({ signedIn: true, link: { linked: true, managedTunnelActive: true }, phones: [{}] });
      page();
      act(() => void vi.advanceTimersByTime(PHONE_POLL_MS * 2));
      expect(refreshPhones).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers Not now for this machine", () => {
    world({ signedIn: true, link: { linked: true, managedTunnelActive: true } });
    settings.value.machinePhoneStepDismissed = { m1: true };
    const view = page();
    view.press("Not now");
    expect(settings.update).toHaveBeenCalledWith({
      machinePhoneStepDismissed: { m1: true, m4: true },
    });
  });

  it("draws no step once done, with a phone linked or after Not now: the facts say it", () => {
    world({ signedIn: true, link: { linked: true, managedTunnelActive: true }, phones: [{}] });
    let view = page();
    expect(view.setup().step.kind).toBe("done");
    expect(view.step()).toBeNull();
    expect(textOf(view.root)).not.toContain("You are set");
    expect(view.buttons()).toEqual(["Add a device or machine", "Rename"]);

    world({ signedIn: true, link: { linked: true, managedTunnelActive: true } });
    settings.value.machinePhoneStepDismissed = { m4: true };
    view = page();
    expect(view.setup().step.kind).toBe("done");
    expect(view.step()).toBeNull();
  });

  it("says where to do it in a window that cannot change this machine's link", () => {
    world({ desktop: false });
    const view = page();
    expect(view.stepKind()).toBe("sign-in");
    expect(view.buttons()).toEqual(["Add a device or machine", "Rename"]);
    expect(textOf(view.step()!)).toContain("Open SpecWithCode on Sam's MacBook Pro to do this.");
  });

  it("offers no button without leave to manage the link", () => {
    world({ signedIn: true, canManage: false });
    const view = page();
    expect(view.stepKind()).toBe("turn-on");
    expect(view.buttons()).toEqual(["Add a device or machine", "Rename"]);
  });

  it("offers no step Team rules forbid, and the fact says why", () => {
    world({ signedIn: true, lock: "connect" });
    const view = page();
    expect(view.setup().step.kind).toBe("done");
    expect(view.step()).toBeNull();
    expect(view.facts()[0]).toBe("Connect: off by your team's rules");
    expect(view.setup().lock).toEqual({ setBy: "Team rules", message: "Off" });
  });

  it("hands on why the link could not be read, and a way to read it again", () => {
    world({ signedIn: true, link: null });
    vi.mocked(useCloudLinkController).mockReturnValue({
      linkState: { data: null, isPending: false, error: "offline", refresh: refreshLink },
      linked: false,
      managedTunnelActive: false,
      publishAgentActivity: false,
      operationError: null,
      reconcileCloudState,
    } as never);
    const view = page();
    expect(view.facts()[0]).toBe("Connect: could not check");
    expect(view.setup().error).toBe("offline");
    view.setup().retry();
    expect(refreshLink).toHaveBeenCalledTimes(1);
  });

  it("draws no step while the link is read", () => {
    world({ signedIn: true, link: null });
    vi.mocked(useCloudLinkController).mockReturnValue({
      linkState: { data: null, isPending: true, error: null, refresh: refreshLink },
      linked: false,
      managedTunnelActive: false,
      publishAgentActivity: false,
      operationError: null,
      reconcileCloudState,
    } as never);
    const view = page();
    expect(view.step()).toBeNull();
    expect(view.facts()[0]).toBe("Connect: checking…");
  });

  it("has no step and reads no account in a build without SpecWithCode Connect", () => {
    world({ configured: false });
    const view = page();
    expect(view.setup().step.kind).toBe("done");
    expect(view.step()).toBeNull();
    expect(view.facts()[0]).toBe("Connect: not in this build");
    expect(useAuth).not.toHaveBeenCalled();
    expect(useCloudLinkController).not.toHaveBeenCalled();
  });
});
