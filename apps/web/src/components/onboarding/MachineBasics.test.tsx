// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type ExecutionEnvironmentPlatformOs,
  type MachineToolsCheck,
} from "@specweave-studio/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { MachineToolInstallState } from "../../studio/machineTools";

const IDLE: MachineToolInstallState = {
  tool: null,
  status: "idle",
  lines: [],
  detail: null,
  handedOff: false,
};

const state = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  installAtom: null as unknown as Atom.Writable<MachineToolInstallState>,
}));

vi.mock("../../studio/machineTools", () => ({
  machineTools: { check: "check", install: "install" },
  IDLE_MACHINE_TOOL_INSTALL: {
    tool: null,
    status: "idle",
    lines: [],
    detail: null,
    handedOff: false,
  },
  machineToolInstallAtom: () => state.installAtom,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "check" | "install") => state[command],
}));

import { MachineBasics } from "./MachineBasics";

const ENV = EnvironmentId.make("env-new-machine");
const ALL_PRESENT: MachineToolsCheck = {
  git: "present",
  node: "present",
  gh: "present",
  packageManager: null,
  installable: [],
};

let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer;

function answer(check: MachineToolsCheck | "older-server") {
  state.check.mockResolvedValue(
    check === "older-server"
      ? { _tag: "Failure", cause: new Error("Unknown method") }
      : { _tag: "Success", value: check },
  );
}

async function render(os: ExecutionEnvironmentPlatformOs, readOnly = false) {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <MachineBasics
          environmentId={ENV}
          os={os}
          readOnly={readOnly}
          fallback={<p data-fallback>old Git row</p>}
        />
      </RegistryContext.Provider>,
    );
  });
}

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
const rows = () =>
  renderer.root
    .findAll((node) => typeof node.type === "string" && node.props["data-agent-row"] !== undefined)
    .map((node) => node.props["data-agent-row"] as string);
const button = (label: string) =>
  renderer.root.find(
    (node) =>
      node.type === "button" && (node.props["aria-label"] === label || text(node) === label),
  );
const hasButton = (label: string) => {
  try {
    button(label);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  registry = AtomRegistry.make();
  state.installAtom = Atom.make<MachineToolInstallState>(IDLE).pipe(Atom.keepAlive);
  state.check.mockReset();
  state.install.mockReset();
  state.install.mockResolvedValue({ _tag: "Success", value: undefined });
});

afterEach(() => {
  act(() => renderer?.unmount());
});

describe("Machine basics", () => {
  it("is one quiet line when Git, Node.js and the GitHub CLI are all there", async () => {
    answer(ALL_PRESENT);
    await render("darwin");
    expect(rows()).toEqual([]);
    expect(text(renderer.root)).toContain("Git, Node.js and GitHub CLI are ready.");
  });

  it("gives only the missing tool a row, and keeps gh under a closed optional line", async () => {
    answer({ ...ALL_PRESENT, node: "missing", gh: "missing", installable: ["node", "gh"] });
    await render("linux");
    expect(rows()).toEqual(["node", "gh"]);
    const optional = renderer.root.find((node) => node.props["data-machine-basics-optional"]);
    expect(optional.props.open).toBeUndefined();
    expect(text(optional)).toContain("Optional, for publishing to GitHub");
    expect(text(renderer.root)).not.toContain("are ready.");
  });

  it("says Git and Node.js are ready when only the optional GitHub CLI is missing", async () => {
    answer({ ...ALL_PRESENT, gh: "missing", installable: ["gh"] });
    await render("windows");
    expect(text(renderer.root)).toContain("Git and Node.js are ready.");
    expect(rows()).toEqual(["gh"]);
  });

  it("installs Node.js on the machine being set up and shows its log", async () => {
    answer({ ...ALL_PRESENT, node: "missing", installable: ["node"] });
    await render("darwin");
    await act(async () => button("Install Node.js").props.onClick());
    expect(state.install).toHaveBeenCalledWith({ environmentId: ENV, input: { tool: "node" } });

    act(() =>
      registry.set(state.installAtom, {
        ...IDLE,
        tool: "node",
        status: "running",
        lines: ["Downloading https://nodejs.org/dist/v22.20.0/node.tar.gz"],
      }),
    );
    const log = renderer.root.find((node) => node.props.role === "log");
    expect(text(log)).toContain("nodejs.org");
    expect(hasButton("Install Node.js")).toBe(false);

    // When it ends the machine is read again, and the row stays as Ready.
    answer(ALL_PRESENT);
    await act(async () =>
      registry.set(state.installAtom, { ...registry.get(state.installAtom), status: "done" }),
    );
    expect(state.check).toHaveBeenCalledTimes(2);
    expect(rows()).toEqual(["node"]);
    expect(
      renderer.root.find((node) => node.props["data-agent-row"] === "node").props[
        "data-agent-state"
      ],
    ).toBe("present");
  });

  it("keeps a failed install's log and offers Retry", async () => {
    answer({ ...ALL_PRESENT, gh: "missing", installable: ["gh"] });
    await render("linux");
    await act(async () =>
      registry.set(state.installAtom, {
        ...IDLE,
        tool: "gh",
        status: "failed",
        lines: ["Downloading"],
        detail: "SHA-256 mismatch. Nothing was installed.",
      }),
    );
    expect(text(renderer.root)).toContain("SHA-256 mismatch");
    expect(hasButton("Install GitHub CLI")).toBe(true);
    expect(text(button("Install GitHub CLI"))).toBe("Retry");
  });

  it("installs Git with one click on Windows when winget is there", async () => {
    answer({
      ...ALL_PRESENT,
      git: "missing",
      packageManager: "winget",
      installable: ["git"],
    });
    await render("windows");
    expect(text(renderer.root)).toContain("winget");
    await act(async () => button("Install Git").props.onClick());
    expect(state.install).toHaveBeenCalledWith({ environmentId: ENV, input: { tool: "git" } });
  });

  it("links to Git for Windows when there is no winget", async () => {
    answer({ ...ALL_PRESENT, git: "missing", packageManager: null });
    await render("windows");
    expect(hasButton("Install Git")).toBe(false);
    const link = renderer.root.find((node) => node.type === "a");
    expect(link.props.href).toBe("https://git-scm.com/downloads");
  });

  it("gives Linux the distribution's own command and Check again, with no install button", async () => {
    answer({ ...ALL_PRESENT, git: "missing", packageManager: "dnf" });
    await render("linux");
    expect(hasButton("Install Git")).toBe(false);
    expect(text(renderer.root)).toContain("sudo dnf install git");
    await act(async () => button("Check again").props.onClick());
    expect(state.check).toHaveBeenCalledTimes(2);
  });

  it("asks macOS again while its own window installs the developer tools", async () => {
    vi.useFakeTimers();
    try {
      answer({ ...ALL_PRESENT, git: "missing", installable: ["git"] });
      await render("darwin");
      await act(async () =>
        registry.set(state.installAtom, { ...IDLE, tool: "git", status: "done", handedOff: true }),
      );
      expect(text(renderer.root)).toContain("macOS window");
      const before = state.check.mock.calls.length;
      await act(async () => vi.advanceTimersByTime(5_000));
      expect(state.check.mock.calls.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows no buttons to someone who may not install on that machine", async () => {
    answer({ ...ALL_PRESENT, node: "missing", installable: ["node"] });
    await render("darwin", true);
    expect(rows()).toEqual(["node"]);
    expect(hasButton("Install Node.js")).toBe(false);
    expect(text(renderer.root)).toContain("ask someone who can maintain this machine");
    expect(renderer.root.find((node) => node.type === "a").props.href).toBe(
      "https://nodejs.org/en/download",
    );
  });

  it("gives someone who may not install the Mac's own Git command", async () => {
    answer({ ...ALL_PRESENT, git: "missing", installable: ["git"] });
    await render("darwin", true);
    expect(hasButton("Install Git")).toBe(false);
    expect(text(renderer.root)).toContain("xcode-select --install");
  });

  it("forgets an install that ended before setup opened", async () => {
    answer({ ...ALL_PRESENT, git: "missing", installable: ["git"] });
    registry.set(state.installAtom, { ...IDLE, tool: "git", status: "done", handedOff: true });
    await render("darwin");
    expect(registry.get(state.installAtom).status).toBe("idle");
    expect(text(renderer.root)).not.toContain("macOS window");
    expect(state.check).toHaveBeenCalledTimes(1);
  });

  it("falls back to the old Git row for a machine on an older SpecWithCode", async () => {
    answer("older-server");
    await render("darwin");
    expect(renderer.root.findAll((node) => node.props["data-fallback"]).length).toBe(1);
  });
});
