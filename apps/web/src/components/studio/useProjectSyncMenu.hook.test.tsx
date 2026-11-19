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
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  runAtomCommand,
  squashAtomCommandFailure: vi.fn(),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/session", () => ({ useEnvironmentsScopeAccess: () => new Map() }));
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
const copy = (key: string, machine: string): OrchestratorCopy =>
  ({ key, machine, folder: "/work/atlas", role: "workers", main: false }) as OrchestratorCopy;
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
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetSyncStatusForTest();
});

function Probe(props: { ask: SyncAsk | null; readOnly: boolean; third?: boolean }) {
  menu = useProjectSyncMenu({
    project: project("m4", "p"),
    label: "m4",
    current: "m4:p",
    copies: [copy("m4:p", "m4"), copy("m5:p", "m5")],
    unknown: [],
    environments: [
      { environmentId: "m4" as never },
      { environmentId: "m5" as never },
      ...(props.third ? [{ environmentId: "mini" as never }] : []),
    ],
    projects: [project("m4", "p"), project("m5", "p")],
    reachOf: () => "open",
    versionOf: () => null,
    ask: props.ask,
    readOnly: props.readOnly,
  });
  return null;
}
const render = (props: Parameters<typeof Probe>[0]) =>
  act(async () => root.render(<Probe {...props} />));

it("shows a read-only window the sync fact and Sync greyed with why, and opens no dialog", async () => {
  const answers = { m4: status("a".repeat(40)), m5: status("b".repeat(40)) };
  await refreshSyncStatus([on("m4", "m4"), on("m5", "m5")], {
    status: async (machine) => ({ ok: true, value: answers[machine.environmentId as "m4"] }),
  });
  await render({ ask: null, readOnly: true, third: true });
  expect(menu.syncOf("m5:p").sync).toMatchObject({
    tone: "differs",
    text: "{k} of {n} repositories differ",
  });
  expect(menu.onSync).not.toBeNull();
  expect(menu.syncBlocked).toEqual({
    text: "This window can only read {machine}",
    values: { machine: "m4" },
  });
  // Greyed: choosing it opens nothing, and a window that cannot operate adds no machine.
  await act(async () => menu.onSync?.());
  expect(menu.dialog).toBeNull();
  expect(menu.onAdd).toBeNull();
});

it("reads each machine's status when a read-only window opens the menu", async () => {
  runAtomCommand.mockResolvedValue({ _tag: "Success", value: status("a".repeat(40)) });
  await render({ ask: null, readOnly: true });
  expect(menu.syncOf("m5:p").sync).toEqual({ tone: "unknown", text: "Not checked yet" });
  await act(async () => menu.onMenuOpenChange(true));
  expect(runAtomCommand).toHaveBeenCalledTimes(2);
  expect(menu.syncOf("m5:p").sync).toMatchObject({ tone: "same", text: "Same as {shown}" });
});

it("shows nothing of Sync where the project is personal or cannot be read", async () => {
  await render({ ask: null, readOnly: false });
  expect(menu.onSync).toBeNull();
  expect(menu.syncBlocked).toBeNull();
  expect(menu.syncOf("m5:p")).toEqual({ sync: null });
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
  expect(menu.dialog?.targets.map((target) => target.machine.label)).toEqual(["m5"]);
});
