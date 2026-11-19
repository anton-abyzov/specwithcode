// @vitest-environment jsdom
import type { ProjectSyncStatusResult } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  refreshSyncStatus,
  resetSyncStatusForTest,
  type SyncMachine,
} from "../../studio/projectSync";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";

const runAtomCommand = vi.hoisted(() => vi.fn());
const grants = vi.hoisted(() => ({ current: new Map<string, string>() }));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  runAtomCommand,
  squashAtomCommandFailure: vi.fn(),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/session", () => ({ useEnvironmentsScopeAccess: () => grants.current }));
vi.mock("../settings/useReplacedMachineRecords", () => ({
  useRetiredMachineRecords: () => new Map(),
}));

import { useProjectSyncMenu, type SyncAsk } from "./useProjectSyncMenu";

const status = (head: string): ProjectSyncStatusResult => ({
  repositories: [{ path: ".", branch: "main", head, clean: true }],
  scanLimited: false,
});
const project = (environmentId: string, id: string) =>
  ({
    environmentId,
    id,
    workspaceRoot: "/work/atlas",
    repositoryIdentity: { canonicalKey: "example.com/acme/atlas", rootPath: "/work/atlas" },
    workspaceSettings: null,
  }) as never;
const copy = (
  key: string,
  machine: string,
  role: OrchestratorCopy["role"] = "workers",
): OrchestratorCopy =>
  ({ key, machine, folder: "/work/atlas", role, main: false }) as OrchestratorCopy;
const on = (environmentId: string, label: string): SyncMachine => ({
  environmentId: environmentId as never,
  projectId: "p" as never,
  label,
});

let container: HTMLDivElement;
let root: Root;
let menu: ReturnType<typeof useProjectSyncMenu>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  runAtomCommand.mockReset();
  grants.current = new Map();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetSyncStatusForTest();
});

function Probe(props: {
  ask: SyncAsk | null;
  readOnly: boolean;
  third?: boolean;
  copies?: readonly OrchestratorCopy[];
  reachOf?: (key: string) => "open" | "offline";
}) {
  menu = useProjectSyncMenu({
    project: project("laptopE", "p"),
    label: "laptopE",
    current: "laptopE:p",
    copies: props.copies ?? [copy("laptopE:p", "laptopE"), copy("rackF:p", "rackF")],
    unknown: [],
    environments: [
      { environmentId: "laptopE" as never },
      { environmentId: "rackF" as never },
      ...(props.third ? [{ environmentId: "shelfG" as never }] : []),
    ],
    projects: [project("laptopE", "p"), project("rackF", "p")],
    nameOf: (environmentId) => environmentId,
    reachOf: props.reachOf ?? (() => "open"),
    versionOf: () => null,
    ask: props.ask,
    readOnly: props.readOnly,
  });
  return null;
}
const render = (props: Parameters<typeof Probe>[0]) =>
  act(async () => root.render(<Probe {...props} />));

it("shows a read-only window the sync fact and Sync greyed with why, and opens no dialog", async () => {
  const answers = { laptopE: status("a".repeat(40)), rackF: status("b".repeat(40)) };
  await refreshSyncStatus([on("laptopE", "laptopE"), on("rackF", "rackF")], {
    status: async (machine) => ({ ok: true, value: answers[machine.environmentId as "laptopE"] }),
  });
  await render({ ask: null, readOnly: true, third: true });
  expect(menu.syncOf("rackF:p").sync).toMatchObject({
    tone: "differs",
    text: "{k} of {n} repositories differ",
  });
  expect(menu.onSync).not.toBeNull();
  expect(menu.syncBlocked).toEqual({
    text: "This window can only read {machine}",
    values: { machine: "laptopE" },
  });
  // Greyed: choosing it opens nothing, and a window that cannot operate adds no machine.
  await act(async () => menu.onSync?.());
  expect(menu.dialog).toBeNull();
  expect(menu.onAdd).toBeNull();
});

it("reads each machine's status when a read-only window opens the menu", async () => {
  runAtomCommand.mockResolvedValue({ _tag: "Success", value: status("a".repeat(40)) });
  await render({ ask: null, readOnly: true });
  expect(menu.syncOf("rackF:p").sync).toEqual({ tone: "unknown", text: "Not checked yet" });
  await act(async () => menu.onMenuOpenChange(true));
  expect(runAtomCommand).toHaveBeenCalledTimes(2);
  expect(menu.syncOf("rackF:p").sync).toMatchObject({ tone: "same", text: "Same as {shown}" });
});

it("shows nothing of Sync where the project is personal or cannot be read", async () => {
  await render({ ask: null, readOnly: false });
  expect(menu.onSync).toBeNull();
  expect(menu.syncBlocked).toBeNull();
  expect(menu.syncOf("rackF:p")).toEqual({ sync: null });
  await act(async () => menu.onMenuOpenChange(true));
  expect(runAtomCommand).not.toHaveBeenCalled();
});

it("offers Add by the dialog's rule, and Sync with a dialog, to a window that can operate", async () => {
  const ask = vi.fn<SyncAsk>();
  await render({ ask, readOnly: false });
  // Both paired machines have the project: nothing to add.
  expect(menu.onAdd).toBeNull();
  expect(menu.syncBlocked).toBeNull();
  await render({ ask, readOnly: false, third: true });
  await act(async () => menu.onAdd?.());
  expect(ask).toHaveBeenCalledWith("add");
  await act(async () => menu.onSync?.());
  expect(menu.dialog?.targets.map((target) => target.machine.label)).toEqual(["rackF"]);
});

it("offers Sync between linked machines only, and lists a separate project greyed", async () => {
  const ask = vi.fn<SyncAsk>();
  const copies = [copy("laptopE:p", "laptopE"), copy("rackF:p", "rackF"), copy("deskB:q", "deskB", "independent")];
  await render({ ask, readOnly: false, copies });
  await act(async () => menu.onSync?.());
  expect(
    menu.dialog?.targets.map((target) => [target.machine.label, target.blocked?.text ?? null]),
  ).toEqual([
    ["rackF", null],
    ["deskB", "Separate project"],
  ]);
  // Opening the menu reads the separate project's status too, and asks nothing else of it.
  runAtomCommand.mockResolvedValue({ _tag: "Success", value: status("a".repeat(40)) });
  await act(async () => menu.onMenuOpenChange(true));
  expect(runAtomCommand.mock.calls.map(([, command]) => command)).toEqual(
    Array.from({ length: 3 }, () => "projectSync.status"),
  );
});

it("has no Sync where the only other machine has the repository as a separate project", async () => {
  const ask = vi.fn<SyncAsk>();
  await render({
    ask,
    readOnly: false,
    copies: [copy("laptopE:p", "laptopE"), copy("deskB:q", "deskB", "independent")],
  });
  expect(menu.onSync).toBeNull();
  expect(menu.syncBlocked).toBeNull();
});

it("tells the open dialog when a grant changes on either machine", async () => {
  const ask = vi.fn<SyncAsk>();
  await render({ ask, readOnly: false });
  await act(async () => menu.onSync?.());
  expect(menu.dialog?.shownBlocked).toBeNull();
  expect(menu.dialog?.targets[0]).toMatchObject({ blocked: null, note: null });

  grants.current = new Map([["rackF", "denied"]]);
  await render({ ask, readOnly: false });
  expect(menu.dialog?.shownBlocked).toBeNull();
  expect(menu.dialog?.targets[0]?.blocked).toEqual({
    text: "This window can only read {machine}",
    values: { machine: "rackF" },
  });

  grants.current = new Map([["laptopE", "denied"]]);
  await render({ ask, readOnly: false });
  expect(menu.dialog?.shownBlocked).toEqual({
    text: "This window can only read {machine}",
    values: { machine: "laptopE" },
  });
  expect(menu.dialog?.targets[0]?.blocked).toBeNull();
});
