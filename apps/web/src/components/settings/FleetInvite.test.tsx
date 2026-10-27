import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AuthSessionId, EnvironmentId } from "@specweave-studio/contracts";
import type { StudioFleetInviteResult } from "@specweave-studio/contracts/studioFleet";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const runtime = vi.hoisted(() => ({ invite: vi.fn(), revoke: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => ({
  c: (await import("../../test/reactHookHarness")).reactHookHarness.useMemoCache,
}));
vi.mock("../../studio/fleet", () => {
  class FleetInviteFailure extends Error {
    constructor(
      readonly reason: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    FleetInviteFailure,
    inviteStudioFleetMachine: runtime.invite,
    revokeStudioFleetInvitation: runtime.revoke,
    readStudioFleetTailscale: vi.fn(),
    signInStudioFleetTailscale: vi.fn(),
  };
});
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: vi.fn(async () => undefined) } }),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));

import { FleetInviteFailure } from "../../studio/fleet";
import type { StudioFleetTailscaleStatus } from "@specweave-studio/contracts/studioFleet";
import {
  FleetInvitePanel,
  TailscaleReadinessNotice,
  countsAsTailscaleCheckFailure,
  fleetInviteValidity,
  tailscaleReadinessView,
  useFleetInvite,
} from "./FleetInvite";

const m4 = EnvironmentId.make("env-m4");
const invitation: StudioFleetInviteResult = {
  code: "swc-machine-synthetic-line",
  url: "https://m4.tailnet.ts.net",
  label: "Mac M4",
  expiresAt: "2027-10-18T00:00:00.000Z",
  sessionId: AuthSessionId.make("synthetic-invite-session"),
};
let connectAware = true;
const render = () => {
  hooks.beginRender();
  return useFleetInvite(m4, connectAware);
};
const panel = (
  controller: ReturnType<typeof useFleetInvite>,
  overrides: Partial<Parameters<typeof FleetInvitePanel>[0]> = {},
) =>
  FleetInvitePanel({
    controller,
    defaultName: "Mac M4",
    canManage: true,
    copied: false,
    onCopy: vi.fn(),
    ...overrides,
  });
const text = (node: unknown): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(text).join("")
      : node && typeof node === "object" && "props" in node
        ? text((node as { props: { children?: unknown } }).props.children)
        : "";
const button = (tree: unknown, label: string) =>
  visitElements(
    tree,
    (element) => typeof element.props.onClick === "function" && text(element) === label,
  ) as { props: { onClick: () => void; disabled?: boolean } } | null;
const line = (tree: unknown) =>
  visitElements(
    tree,
    (element) => element.props["aria-label"] === "Invitation line for the main machine",
  ) as { props: { value: string } } | null;

beforeEach(() => {
  connectAware = true;
  hooks.reset();
  runtime.invite.mockReset();
  render().setCoordinatorEnvironmentId("approved-primary");
  runtime.revoke.mockReset();
});

describe("inviting this machine to another one", () => {
  it("makes the line with the typed name, shows it once and forgets it on close", async () => {
    runtime.invite.mockResolvedValue(invitation);
    render().setName("  Studio Mac ");
    const before = panel(render());
    expect(line(before)).toBeNull();
    button(before, "Make the line")!.props.onClick();
    await vi.waitFor(() => expect(runtime.invite).toHaveBeenCalledOnce());
    expect(runtime.invite).toHaveBeenCalledWith(m4, {
      label: "  Studio Mac ",
      coordinatorEnvironmentId: "approved-primary",
      via: "auto",
    });
    await vi.waitFor(() => expect(render().invitation).toEqual(invitation));

    const onCopy = vi.fn();
    const shown = panel(render(), { onCopy });
    expect(line(shown)!.props.value).toBe("swc-machine-synthetic-line");
    expect(text(shown)).toContain("Settings > Connections > Add a machine");
    expect(text(shown)).toContain("works like a password");
    expect(text(shown)).toContain("valid for");
    button(shown, "Copy")!.props.onClick();
    expect(onCopy).toHaveBeenCalledExactlyOnceWith("swc-machine-synthetic-line");

    render().reset();
    const closed = render();
    expect(closed.invitation).toBeNull();
    expect(closed.name).toBe("");
    expect(line(panel(closed))).toBeNull();
  });

  it("leaves `via` out for a server that reports no Connect status (older servers reject it)", async () => {
    connectAware = false;
    runtime.invite.mockResolvedValue(invitation);
    await render().create();
    expect(runtime.invite).toHaveBeenCalledExactlyOnceWith(m4, {
      label: "",
      coordinatorEnvironmentId: "approved-primary",
    });
  });

  it("revokes the line through the session it names and stops showing it", async () => {
    runtime.invite.mockResolvedValue(invitation);
    runtime.revoke.mockResolvedValue(undefined);
    await render().create();
    button(panel(render()), "Revoke this line")!.props.onClick();
    await vi.waitFor(() => expect(runtime.revoke).toHaveBeenCalledExactlyOnceWith(invitation));
    await vi.waitFor(() => expect(render().revoked).toBe(true));
    const after = panel(render());
    expect(line(after)).toBeNull();
    expect(text(after)).toContain("no longer works");
  });

  it("shows both addresses of a SpecWithCode Connect line and that it works once", async () => {
    const connectLine: StudioFleetInviteResult = {
      code: "swc-machine-synthetic-v2",
      url: "https://m4.tailnet.ts.net",
      connectUrl: "https://prod-0123456789abcdef.spec-weave.com",
      label: "Mac M4",
      expiresAt: "2027-10-18T00:00:00.000Z",
      pairingId: "synthetic-pairing",
      redeemBy: "2026-10-19T00:00:00.000Z",
    };
    runtime.invite.mockResolvedValue(connectLine);
    runtime.revoke.mockResolvedValue(undefined);
    await render().create();
    const shown = text(panel(render()));
    expect(shown).toContain("m4.tailnet.ts.net over Tailscale");
    expect(shown).toContain("prod-0123456789abcdef.spec-weave.com over SpecWithCode Connect");
    expect(shown).toContain("within an hour");
    // Revoked by its one-time credential, since it holds no session.
    button(panel(render()), "Revoke this line")!.props.onClick();
    await vi.waitFor(() => expect(runtime.revoke).toHaveBeenCalledExactlyOnceWith(connectLine));
  });

  it.each([
    ["connect_not_linked", "SpecWithCode Connect is not linked"],
    ["connect_unreachable", "SpecWithCode Connect is not answering"],
  ] as const)("names the Connect problem %s", async (reason, title) => {
    runtime.invite.mockRejectedValue(new FleetInviteFailure(reason, "Fixture advice."));
    await render().create();
    const alert = visitElements(panel(render()), (element) => element.props.role === "alert");
    expect(text(alert)).toContain(title);
  });

  it.each([
    ["tailscale_missing", "Tailscale is not installed", "Install it from tailscale.com/download"],
    ["magic_dns_missing", "MagicDNS is off", "turn on MagicDNS"],
    ["port_occupied", "That port is already in use", "will not replace it"],
  ] as const)("says what to do when %s", async (reason, title, advice) => {
    runtime.invite.mockRejectedValue(new FleetInviteFailure(reason, `Fixture: ${advice}.`));
    expect(await render().create()).toBeNull();
    const failed = render();
    expect(failed.problem).toEqual({ reason, message: `Fixture: ${advice}.` });
    const tree = panel(failed);
    const alert = visitElements(tree, (element) => element.props.role === "alert");
    expect(text(alert)).toContain(title);
    expect(text(alert)).toContain(advice);
    expect(line(tree)).toBeNull();
  });

  it("is unavailable without access management", () => {
    const tree = panel(render(), { canManage: false });
    const action = button(tree, "Manage access required");
    expect(action?.props.disabled).toBe(true);
    expect(button(tree, "Make the line")).toBeNull();
  });

  it("says how long the line is valid in plain words", () => {
    expect(
      fleetInviteValidity("2027-10-18T00:00:00.000Z", Date.parse("2026-10-18T00:00:00.000Z")),
    ).toMatch(/^valid for 365 days, until /);
  });
});

const tailscale = (
  overrides: Partial<StudioFleetTailscaleStatus> = {},
): StudioFleetTailscaleStatus => ({
  state: "running",
  backendState: "Running",
  magicDns: true,
  platform: "darwin",
  homebrew: false,
  ...overrides,
});

describe("Tailscale on this machine before the line", () => {
  it("maps each state to what the person can do", () => {
    expect(tailscaleReadinessView(null, false).kind).toBe("checking");
    expect(tailscaleReadinessView(null, true).kind).toBe("unreachable");

    const missingMac = tailscaleReadinessView(
      tailscale({ state: "not_installed", backendState: null, homebrew: true }),
      false,
    );
    expect(missingMac).toMatchObject({
      kind: "not_installed",
      action: "install",
      downloadUrl: "https://tailscale.com/download/mac",
      brewCommand: "brew install --cask tailscale",
    });
    expect(
      tailscaleReadinessView(
        tailscale({ state: "not_installed", backendState: null, homebrew: false }),
        false,
      ).brewCommand,
    ).toBeNull();
    expect(
      tailscaleReadinessView(
        tailscale({
          state: "not_installed",
          backendState: null,
          platform: "linux",
          homebrew: true,
        }),
        false,
      ),
    ).toMatchObject({ downloadUrl: "https://tailscale.com/download/linux", brewCommand: null });

    expect(
      tailscaleReadinessView(tailscale({ state: "signed_out", backendState: "NeedsLogin" }), false),
    ).toMatchObject({ kind: "signed_out", action: "sign_in", title: "Tailscale is not signed in" });
    expect(
      tailscaleReadinessView(tailscale({ state: "signed_out", backendState: "Stopped" }), false),
    ).toMatchObject({ kind: "signed_out", action: "sign_in", title: "Tailscale is turned off" });
    expect(tailscaleReadinessView(tailscale({ magicDns: false }), false)).toMatchObject({
      kind: "no_magic_dns",
      action: null,
    });
    expect(tailscaleReadinessView(tailscale(), false).kind).toBe("ready");
  });

  const readiness = (status: StudioFleetTailscaleStatus | null) => ({
    status,
    failed: false,
    signingIn: false,
    loginUrl: null,
    problem: null,
    signIn: vi.fn(async () => undefined),
    openUrl: vi.fn(),
  });

  it("opens the download page and offers the Homebrew command without running it", () => {
    const state = readiness(
      tailscale({ state: "not_installed", backendState: null, homebrew: true }),
    );
    const onCopyCommand = vi.fn();
    const tree = TailscaleReadinessNotice({ readiness: state, canManage: true, onCopyCommand });
    button(tree, "Install Tailscale")!.props.onClick();
    expect(state.openUrl).toHaveBeenCalledExactlyOnceWith("https://tailscale.com/download/mac");
    button(tree, "Copy")!.props.onClick();
    expect(onCopyCommand).toHaveBeenCalledExactlyOnceWith("brew install --cask tailscale");
    expect(state.signIn).not.toHaveBeenCalled();
  });

  it("signs in only for an access manager", () => {
    const state = readiness(tailscale({ state: "signed_out", backendState: "NeedsLogin" }));
    const tree = TailscaleReadinessNotice({
      readiness: state,
      canManage: true,
      onCopyCommand: vi.fn(),
    });
    button(tree, "Sign in to Tailscale")!.props.onClick();
    expect(state.signIn).toHaveBeenCalledOnce();
    const denied = TailscaleReadinessNotice({
      readiness: state,
      canManage: false,
      onCopyCommand: vi.fn(),
    });
    expect(button(denied, "Manage access required")?.props.disabled).toBe(true);
  });

  it("says the line uses SpecWithCode Connect when Tailscale is off and Connect is linked", () => {
    const tree = TailscaleReadinessNotice({
      readiness: readiness(
        tailscale({
          state: "signed_out",
          backendState: "Stopped",
          connect: { linked: true, origin: "https://prod-0123456789abcdef.spec-weave.com" },
        }),
      ),
      canManage: true,
      onCopyCommand: vi.fn(),
    });
    expect(text(tree)).toBe("Tailscale is off here, so the line uses SpecWithCode Connect.");
  });

  it("shows nothing once Tailscale is ready", () => {
    expect(
      TailscaleReadinessNotice({
        readiness: readiness(tailscale()),
        canManage: true,
        onCopyCommand: vi.fn(),
      }),
    ).toBeNull();
  });

  it("keeps checking while the connection is still starting", () => {
    expect(
      countsAsTailscaleCheckFailure(new FleetInviteFailure("permission", "Not connected yet.")),
    ).toBe(false);
    expect(
      countsAsTailscaleCheckFailure(new FleetInviteFailure("unknown", "Could not check.")),
    ).toBe(true);
    expect(countsAsTailscaleCheckFailure(new Error("network"))).toBe(true);
  });

  it("holds back the line while Tailscale is not ready", () => {
    const tree = panel(render(), { blocked: true });
    expect(button(tree, "Make the line")?.props.disabled).toBe(true);
    expect(button(panel(render()), "Make the line")?.props.disabled).toBe(false);
  });
});

it("requires explicit coordinator approval and shows the local identity for enrollment", async () => {
  render().setCoordinatorEnvironmentId("");
  const controller = render();
  expect(button(panel(controller), "Make the line")!.props.disabled).toBe(true);
  expect(text(panel(controller))).toContain("env-m4");
  expect(await controller.create()).toBeNull();
  expect(runtime.invite).not.toHaveBeenCalled();
});
