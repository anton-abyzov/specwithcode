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
import { withReadableGrantLabels, workGrantMachineLabel } from "./machineWorkGrants.logic";

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
  it("never prints a coordinator's raw environment id as its name", () => {
    const uuid = EnvironmentId.make("4d73e481-1b03-4ee8-b4c1-87a448431538");
    const unnamed = { ...grant, coordinatorEnvironmentId: uuid, machineLabel: uuid as string };
    expect(workGrantMachineLabel(grant)).toBe("M4MAX");
    expect(workGrantMachineLabel(unnamed)).toBe("Machine 4d73e481");
    // A name this app knows (a nickname or a saved connection) comes before the short id.
    expect(workGrantMachineLabel(unnamed, () => "M4")).toBe("M4");
    expect(workGrantMachineLabel(unnamed, (id) => id)).toBe("Machine 4d73e481");
    const labeled = withReadableGrantLabels({ ...snapshot, grants: [grant, unnamed] });
    expect(labeled?.grants.map((entry) => entry.machineLabel)).toEqual([
      "M4MAX",
      "Machine 4d73e481",
    ]);
    expect(labeled?.grants[0]).toBe(grant);
    expect(workGrantProjectsSummary(labeled!.grants[1]!, snapshot.projects)).toBe(
      "Projects linked to Machine 4d73e481 (none yet)",
    );
    expect(withReadableGrantLabels(null)).toBeNull();
  });
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

  it("lists an archived, automated or No project choice only while the grant names it", () => {
    const withUnavailable: StudioWorkGrantsSnapshot = {
      ...snapshot,
      projects: [
        ...snapshot.projects,
        { id: ProjectId.make("p-old"), title: "old", linkedTo: [m4], unavailable: "archived" },
        {
          id: ProjectId.make("p-scratch"),
          title: "No project",
          linkedTo: [],
          unavailable: "scratch",
        },
      ],
    };
    const listed = (projectIds: ReadonlyArray<ProjectId>) =>
      visitElements(
        MachineWorkGrantRow({
          grant: { ...grant, projects: { kind: "listed", projectIds } },
          snapshot: withUnavailable,
          canManage: true,
          pending: false,
          onChange: vi.fn(),
        }),
        (element) =>
          element.props.label === "Projects M4MAX may use" && Array.isArray(element.props.items),
      )!.props.items;
    expect(listed([])).toEqual([
      { id: "p-web", title: "specwithcode" },
      { id: "p-notes", title: "notes" },
    ]);
    expect(listed([ProjectId.make("p-old")])).toEqual([
      { id: "p-web", title: "specwithcode" },
      { id: "p-notes", title: "notes" },
      { id: "p-old", title: "old", unavailable: "archived, uncheck to remove" },
    ]);
    expect(listed([ProjectId.make("p-scratch")])).toContainEqual({
      id: "p-scratch",
      title: "No project",
      unavailable: "folder for chats, uncheck to remove",
    });
    // The grant still covers a linked project once archived, so the summary names it.
    expect(workGrantProjectsSummary(grant, withUnavailable.projects)).toBe(
      "Projects linked to M4MAX: specwithcode, old (archived)",
    );
    expect(
      workGrantProjectsSummary(
        { ...grant, projects: { kind: "listed", projectIds: [ProjectId.make("p-old")] } },
        withUnavailable.projects,
      ),
    ).toBe("old (archived)");
    // A grant naming only the chats folder must not read like "No projects".
    expect(
      workGrantProjectsSummary(
        { ...grant, projects: { kind: "listed", projectIds: [ProjectId.make("p-scratch")] } },
        withUnavailable.projects,
      ),
    ).toBe("No project folder (chats)");
    // An id the snapshot no longer lists (the assistant, a deleted project) names nothing.
    const gone = ProjectId.make("p-assistant");
    expect(
      workGrantProjectsSummary(
        { ...grant, projects: { kind: "listed", projectIds: [ProjectId.make("p-old"), gone] } },
        withUnavailable.projects,
      ),
    ).toBe("old (archived)");
    expect(
      workGrantProjectsSummary(
        { ...grant, projects: { kind: "listed", projectIds: [gone] } },
        withUnavailable.projects,
      ),
    ).toBe("No projects");
    // The row has no checkbox for it, so the next change sends the list without it.
    const selected = visitElements(
      MachineWorkGrantRow({
        grant: {
          ...grant,
          projects: { kind: "listed", projectIds: [ProjectId.make("p-old"), gone] },
        },
        snapshot: withUnavailable,
        canManage: true,
        pending: false,
        onChange: vi.fn(),
      }),
      (element) =>
        element.props.label === "Projects M4MAX may use" && Array.isArray(element.props.items),
    )!.props.selected;
    expect(selected).toEqual(["p-old"]);
    // A machine with nothing to offer still reads "No projects" for an id it no longer lists...
    const onlyGone = { ...grant, projects: { kind: "listed" as const, projectIds: [gone] } };
    expect(workGrantProjectsSummary(onlyGone, [])).toBe("No projects");
    // ...while a failed project read keeps the grant's ids rather than understating it.
    expect(workGrantProjectsSummary(onlyGone, [], true)).toBe(
      "1 chosen project (could not read this machine's projects)",
    );
    expect(workGrantProjectsSummary(grant, [], true)).toBe(
      "Projects linked to M4MAX (could not read this machine's projects)",
    );
    const selectedWhen = (projectsUnreadable: boolean) =>
      visitElements(
        MachineWorkGrantRow({
          grant: onlyGone,
          snapshot: {
            ...snapshot,
            projects: [],
            ...(projectsUnreadable ? { projectsUnreadable } : {}),
          },
          canManage: true,
          pending: false,
          onChange: vi.fn(),
        }),
        (element) =>
          element.props.label === "Projects M4MAX may use" && Array.isArray(element.props.items),
      )!.props.selected;
    expect(selectedWhen(true)).toEqual([gone]);
    const emptyWhenUnreadable = visitElements(
      MachineWorkGrantRow({
        grant: onlyGone,
        snapshot: { ...snapshot, projects: [], projectsUnreadable: true },
        canManage: true,
        pending: false,
        onChange: vi.fn(),
      }),
      (element) =>
        element.props.label === "Projects M4MAX may use" && Array.isArray(element.props.items),
    )!.props.empty;
    expect(emptyWhenUnreadable).toBe(
      "Could not read this machine's projects. The grant keeps its choices.",
    );
    expect(selectedWhen(false)).toEqual([]);
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
