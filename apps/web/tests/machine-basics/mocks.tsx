// Stand-ins for the machine's RPCs. The Machine basics block and its rows are
// the app's own; what the machine answers comes from the fixture's query.
import type { MachineToolsCheck } from "@specweave-studio/contracts";
import { Atom } from "effect/reactivity";

import type { MachineToolInstallState } from "../../src/studio/machineTools";

export const IDLE_MACHINE_TOOL_INSTALL: MachineToolInstallState = {
  tool: null,
  status: "idle",
  lines: [],
  detail: null,
  handedOff: false,
};

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "missing";

const CHECKS: Record<string, MachineToolsCheck> = {
  ready: { git: "present", node: "present", gh: "present", packageManager: null, installable: [] },
  "no-gh": {
    git: "present",
    node: "present",
    gh: "missing",
    packageManager: null,
    installable: ["gh"],
  },
  missing: {
    git: "missing",
    node: "missing",
    gh: "missing",
    packageManager: null,
    installable: ["git", "node", "gh"],
  },
  installing: {
    git: "present",
    node: "missing",
    gh: "present",
    packageManager: null,
    installable: ["node"],
  },
  linux: {
    git: "missing",
    node: "missing",
    gh: "present",
    packageManager: "apt",
    installable: ["node"],
  },
};

const installing: MachineToolInstallState =
  view === "installing"
    ? {
        tool: "node",
        status: "running",
        lines: [
          "Downloading https://nodejs.org/dist/v22.20.0/node-v22.20.0-darwin-arm64.tar.gz",
          "Downloaded 31.4 MB, SHA-256 matches the pinned build.",
          "Unpacking Node.js",
        ],
        detail: null,
        handedOff: false,
      }
    : IDLE_MACHINE_TOOL_INSTALL;
const atom = Atom.make<MachineToolInstallState>(installing).pipe(Atom.keepAlive);

export const machineTools = { check: "check", install: "install" };
export const machineToolInstallAtom = () => atom;
export const useAtomCommand = (command: string) =>
  command === "check"
    ? async () => ({ _tag: "Success", value: CHECKS[view] ?? CHECKS.missing })
    : async () => ({ _tag: "Success", value: undefined });
