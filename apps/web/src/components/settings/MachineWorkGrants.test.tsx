import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@specweave-studio/contracts";
import type {
  StudioWorkGrant,
  StudioWorkGrantsSnapshot,
} from "@specweave-studio/contracts/studioFleet";
import { visitElements } from "../../test/reactElementTree";

vi.mock("../../studio/fleet", () => ({
  changeMachineWorkGrant: vi.fn(),
  useMachineWorkGrants: vi.fn(),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("./settingsLayout", () => ({ SettingsSection: () => null }));
import {
  MachineWorkGrantRow,
  MachineWorkGrantsList,
  workGrantAccountsSummary,
  workGrantProjectsSummary,
  workGrantStatus,
} from "./MachineWorkGrants";

const m4 = EnvironmentId.make("env-m4");
const friend = EnvironmentId.make("env-friend");
const claude = ProviderInstanceId.make("claude");
const codex = ProviderInstanceId.make("codex");
const grant: StudioWorkGrant = {
  coordinatorEnvironmentId: m4,
  machineLabel: "M4MAX",
  projects: { kind: "linked" },
  accounts: { kind: "all" },
  owner: "self",
  hopLimit: 2,
  runtimeCap: "auto",
  expiresAt: "2026-11-18T12:00:00.000Z" as never,
  status: "active",
  revokedAt: null,
  interruptAt: null,
  runningThreads: 0,
  legacy: false,
};
const snapshot: StudioWorkGrantsSnapshot = {
  grants: [grant],
  projects: [
    { id: ProjectId.make("p-web"), title: "specwithcode", linkedTo: [m4] },
    { id: ProjectId.make("p-notes"), title: "notes", linkedTo: [] },
  ],
  accounts: [
    { instanceId: claude, label: "Claude", driver: "claudeAgent", account: "me@example.com" },
    { instanceId: codex, label: "Codex", driver: "codex", account: null },
  ],
};
const children = (element: { props: { children?: unknown } }) => element.props.children;

describe("who can run work on this Mac", () => {
  it("names the linked projects, chosen projects and sign-ins it may use", () => {
    expect(workGrantProjectsSummary(grant, snapshot.projects)).toBe(
      "Projects linked to M4MAX: specwithcode",
    );
    expect(
      workGrantProjectsSummary({ ...grant, coordinatorEnvironmentId: friend }, snapshot.projects),
    ).toBe("Projects linked to M4MAX (none yet)");
    expect(
      workGrantProjectsSummary(
        { ...grant, projects: { kind: "listed", projectIds: [ProjectId.make("p-notes")] } },
        snapshot.projects,
      ),
    ).toBe("notes");
    expect(workGrantAccountsSummary({ kind: "all" }, snapshot.accounts)).toBe(
      "All sign-ins on this machine",
    );
    expect(
      workGrantAccountsSummary({ kind: "listed", instanceIds: [claude] }, snapshot.accounts),
    ).toBe("Claude (me@example.com)");
    expect(workGrantAccountsSummary({ kind: "none" }, snapshot.accounts)).toContain(
      "every launch is refused",
    );
  });

  it("says a revoked machine's new work is refused and when its running threads stop", () => {
    const revoked = workGrantStatus({
      ...grant,
      status: "revoked",
      revokedAt: "2026-10-19T12:00:00.000Z" as never,
      interruptAt: "2026-10-19T12:02:00.000Z" as never,
      runningThreads: 2,
    });
    expect(revoked).toContain("New work is refused");
    expect(revoked).toContain("2 running threads stop at");
    expect(workGrantStatus({ ...grant, status: "expired", expiresAt: null })).toContain(
      "must allow workers here again",
    );
    expect(workGrantStatus({ ...grant, runningThreads: 1 })).toMatch(
      /^Active until .* · 1 running thread$/,
    );
  });

  it("offers Revoke on an active grant and Allow again on a revoked one", () => {
    const onChange = vi.fn();
    const row = (value: StudioWorkGrant) =>
      MachineWorkGrantRow({ grant: value, snapshot, canManage: true, pending: false, onChange });
    const revoke = visitElements(row(grant), (element) => children(element) === "Revoke");
    (revoke!.props.onClick as () => void)();
    expect(onChange).toHaveBeenLastCalledWith({
      action: "revoke",
      input: { coordinatorEnvironmentId: m4 },
    });
    const revoked = row({ ...grant, status: "revoked" });
    expect(visitElements(revoked, (element) => children(element) === "Revoke")).toBeNull();
    const restore = visitElements(revoked, (element) => children(element) === "Allow again");
    (restore!.props.onClick as () => void)();
    expect(onChange).toHaveBeenLastCalledWith({
      action: "restore",
      input: { coordinatorEnvironmentId: m4 },
    });
  });

  it("edits whose machine it is, its projects and its sign-ins", () => {
    const onChange = vi.fn();
    const tree = MachineWorkGrantRow({
      grant: { ...grant, accounts: { kind: "listed", instanceIds: [claude] } },
      snapshot,
      canManage: true,
      pending: false,
      onChange,
    });
    const select = (label: string) =>
      visitElements(tree, (element) => element.props.label === label);
    (select("Whose machine M4MAX is")!.props.onChange as (value: string) => void)("other");
    expect(onChange).toHaveBeenLastCalledWith({
      action: "update",
      input: { coordinatorEnvironmentId: m4, owner: "other" },
    });
    (select("Projects M4MAX may use")!.props.onChange as (value: string) => void)("listed");
    expect(onChange).toHaveBeenLastCalledWith({
      action: "update",
      input: { coordinatorEnvironmentId: m4, projects: { kind: "listed", projectIds: [] } },
    });
    const accounts = visitElements(
      tree,
      (element) =>
        element.props.label === "Sign-ins M4MAX may use" && Array.isArray(element.props.items),
    );
    expect(accounts?.props.selected).toEqual([claude]);
    (accounts!.props.onChange as (ids: ReadonlyArray<string>) => void)([claude, codex]);
    expect(onChange).toHaveBeenLastCalledWith({
      action: "update",
      input: {
        coordinatorEnvironmentId: m4,
        accounts: { kind: "listed", instanceIds: [claude, codex] },
      },
    });
  });

  it("explains a grant from before scopes and locks a revoked or read-only row", () => {
    const legacy = MachineWorkGrantRow({
      grant: { ...grant, legacy: true, projects: { kind: "all" } },
      snapshot,
      canManage: true,
      pending: false,
      onChange: vi.fn(),
    });
    expect(
      visitElements(
        legacy,
        (element) =>
          typeof children(element) === "string" &&
          (children(element) as string).includes("before work could be limited"),
      ),
    ).not.toBeNull();
    for (const locked of [
      { grant: { ...grant, status: "revoked" as const }, canManage: true },
      { grant, canManage: false },
    ]) {
      const tree = MachineWorkGrantRow({
        ...locked,
        snapshot,
        pending: false,
        onChange: vi.fn(),
      });
      expect(
        visitElements(tree, (element) => element.props.label === "Whose machine M4MAX is")?.props
          .disabled,
      ).toBe(true);
    }
  });

  it("says no machine can start work here when there are no grants", () => {
    const tree = MachineWorkGrantsList({
      snapshot: { ...snapshot, grants: [] },
      loading: false,
      failed: false,
      canManage: true,
      pending: null,
      error: null,
      notice: null,
      onRefresh: vi.fn(),
      onChange: vi.fn(),
    });
    expect(
      visitElements(
        tree,
        (element) =>
          typeof children(element) === "string" &&
          (children(element) as string).startsWith("No other machine can start work here"),
      ),
    ).not.toBeNull();
  });
});
