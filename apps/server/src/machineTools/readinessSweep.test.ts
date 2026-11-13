import type {
  MachineReadinessSweep,
  MachineReadinessToolId,
  MachineToolsCheck,
  MachineToolStatus,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sweepOnce, sweepTargets, type SweepDeps } from "./readinessSweep.ts";

const status = (
  tool: MachineReadinessToolId,
  over: Partial<MachineToolStatus> = {},
): MachineToolStatus => ({
  tool,
  presence: "present",
  version: null,
  managed: false,
  outdated: false,
  canInstall: false,
  ...over,
});

const check = (tools: ReadonlyArray<MachineToolStatus>): MachineToolsCheck => ({
  git: "present",
  node: "present",
  gh: "present",
  packageManager: null,
  installable: [],
  tools,
});

function deps(input: {
  readonly previous?: MachineReadinessSweep | null;
  readonly busy?: ReadonlyArray<boolean>;
  readonly tools: ReadonlyArray<MachineToolStatus>;
  readonly fail?: Partial<Record<MachineReadinessToolId, string>>;
}) {
  const written: MachineReadinessSweep[] = [];
  const installs: MachineReadinessToolId[] = [];
  const busy = [...(input.busy ?? [])];
  const value: SweepDeps = {
    version: "1.0.300",
    now: () => "2026-11-13T20:00:00.000Z",
    read: async () => input.previous ?? null,
    write: async (state) => {
      written.push(state);
    },
    busy: async () => busy.shift() ?? false,
    check: async () => check(input.tools),
    install: async (tool) => {
      installs.push(tool);
      return input.fail?.[tool] ?? null;
    },
  };
  return { value, written, installs };
}

describe("sweepTargets", () => {
  it("takes what is missing and the app's own older copies, in order, never Git or the person's tools", () => {
    expect(
      sweepTargets(
        check([
          status("git", { presence: "missing", canInstall: true }),
          status("specweave", { presence: "missing", canInstall: true }),
          status("gh", { outdated: true, managed: true, canInstall: true }),
          status("node", { presence: "missing", canInstall: true }),
        ]),
      ),
    ).toEqual(["node", "gh", "specweave"]);
    expect(
      sweepTargets(
        check([
          // The person's own old Node.js stays as it is.
          status("node", { outdated: true, managed: false }),
          // No pinned build for this machine.
          status("gh", { presence: "missing", canInstall: false }),
        ]),
      ),
    ).toEqual([]);
    // A server's answer without `tools` gives nothing to do.
    expect(sweepTargets({ git: "present", node: "present", gh: "present", packageManager: null, installable: [] })).toEqual([]);
  });
});

describe("sweepOnce", () => {
  it("does nothing for a version it already checked", async () => {
    const run = deps({
      previous: {
        version: "1.0.300",
        at: "x",
        state: "done",
        installed: [],
        detail: null,
      },
      tools: [status("node", { presence: "missing", canInstall: true })],
    });
    expect(await sweepOnce(run.value)).toBe("skipped");
    expect(run.installs).toEqual([]);
    expect(run.written).toEqual([]);
  });

  it("waits while work runs, and installs nothing", async () => {
    const run = deps({
      busy: [true],
      tools: [status("node", { presence: "missing", canInstall: true })],
    });
    expect(await sweepOnce(run.value)).toBe("waiting");
    expect(run.installs).toEqual([]);
    expect(run.written.at(-1)).toMatchObject({ state: "waiting", version: "1.0.300" });
  });

  it("installs what is missing once quiet, and records it", async () => {
    const run = deps({
      previous: { version: "1.0.299", at: "x", state: "done", installed: [], detail: null },
      tools: [
        status("node", { presence: "missing", canInstall: true }),
        status("specweave", { presence: "missing", canInstall: true }),
      ],
    });
    expect(await sweepOnce(run.value)).toBe("done");
    expect(run.installs).toEqual(["node", "specweave"]);
    expect(run.written.at(-1)).toEqual({
      version: "1.0.300",
      at: "2026-11-13T20:00:00.000Z",
      state: "done",
      installed: ["node", "specweave"],
      detail: null,
    });
  });

  it("stops between installs when work starts, and keeps what it installed for the next pass", async () => {
    const run = deps({
      busy: [false, false, true],
      tools: [
        status("node", { presence: "missing", canInstall: true }),
        status("gh", { presence: "missing", canInstall: true }),
      ],
    });
    expect(await sweepOnce(run.value)).toBe("waiting");
    expect(run.installs).toEqual(["node"]);
    expect(run.written.at(-1)).toMatchObject({ state: "waiting", installed: ["node"] });
  });

  it("goes on after a failed install and names it", async () => {
    const run = deps({
      tools: [
        status("node", { presence: "missing", canInstall: true }),
        status("gh", { presence: "missing", canInstall: true }),
      ],
      fail: { node: "The download failed." },
    });
    expect(await sweepOnce(run.value)).toBe("done");
    expect(run.installs).toEqual(["node", "gh"]);
    expect(run.written.at(-1)).toMatchObject({
      state: "failed",
      installed: ["gh"],
      detail: "Node.js: The download failed.",
    });
  });

  it("waits when another install holds the machine", async () => {
    const run = deps({
      tools: [status("node", { presence: "missing", canInstall: true })],
      fail: { node: "busy" },
    });
    expect(await sweepOnce(run.value)).toBe("waiting");
  });
});
