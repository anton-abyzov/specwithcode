// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProvisionMachineButton } from "./ProvisionMachineSheet";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; request: unknown }>,
  preview: null as unknown,
  run: null as unknown,
  capability: true as boolean | undefined,
  canMaintain: true,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "config"
      ? { environment: { capabilities: { machineProvision: state.capability } } }
      : state.run,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.canMaintain }));
vi.mock("../../studio/machineProvision", () => ({
  machineProvision: { preview: "preview", run: "run" },
  provisionRunAtom: () => "run-state",
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => async (request: unknown) => {
    state.calls.push({ command, request });
    return { _tag: "Success", value: command === "preview" ? state.preview : undefined };
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
}));
vi.mock("../ui/sheet", () => ({
  Sheet: (props: { open: boolean; children: React.ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  SheetPopup: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
  SheetHeader: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
  SheetTitle: (props: { children: React.ReactNode }) => <h2>{props.children}</h2>,
  SheetDescription: (props: { children: React.ReactNode }) => <p>{props.children}</p>,
}));

const item = (id: string, label: string, status: string, found: string | null, wanted: string) => ({
  id,
  label,
  wanted,
  found,
  status,
  source: "pinned",
  detail: null,
  command: null,
});
const target = {
  platform: "linux",
  arch: "x64",
  osId: "ubuntu",
  osVersion: "24.04",
  prettyName: "Ubuntu 24.04.3 LTS",
  libc: "glibc",
  init: "systemd",
  supported: true,
  reason: null,
  nearest: null,
};
const IDLE = { status: "idle", items: [], logs: {}, readback: null, error: null };

let root: Root;
let container: HTMLDivElement;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const button = (label: string) => {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button ${label}: ${container.textContent}`);
  return element;
};
const mount = async () => {
  await act(async () =>
    root.render(
      <ProvisionMachineButton environmentId={"m3" as never} environmentLabel="Ministorm" />,
    ),
  );
  await settle();
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.calls = [];
  state.capability = true;
  state.canMaintain = true;
  state.run = IDLE;
  state.preview = {
    target,
    items: [
      item("git", "git", "ok", "2.43.0", ">= 2.34"),
      item("gh", "GitHub CLI (gh)", "planned", "2.40.0", "2.102.0"),
      item("claude", "Claude Code", "planned", null, "2.1.304"),
    ],
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("previews the default set with versions, then provisions on that machine", async () => {
  await mount();
  await act(async () => button("Provision").click());
  await settle();
  expect(state.calls).toEqual([
    { command: "preview", request: { environmentId: "m3", input: {} } },
  ]);
  const text = container.textContent ?? "";
  expect(text).toContain("Ubuntu 24.04.3 LTS");
  expect(text).toContain("2.40.0 → 2.102.0");
  expect(text).toContain("Will update");
  expect(text).toContain("Will install");
  expect(text).toContain("never restarts the SpecWithCode server");
  await act(async () => button("Provision Ministorm").click());
  expect(state.calls.at(-1)).toEqual({
    command: "run",
    request: { environmentId: "m3", input: { resume: false } },
  });
});

it("shows the readback, the root line and the user's steps, and retries a failed run", async () => {
  state.run = {
    status: "failed",
    items: [item("linger", "Service keeps running after logout", "needs-root", "off", "on")],
    logs: {},
    error: null,
    readback: {
      target,
      summary: "Waiting for root: linger.",
      items: [],
      rootStep: { command: "sudo sh '/home/me/.specwithcode/provision/root-steps.sh'", ran: false },
      userSteps: [
        { id: "claude", title: "Sign in to Claude Code", command: "claude", optional: false },
        {
          id: "workers",
          title: "Allow workers in Settings > Connections",
          command: null,
          optional: false,
        },
      ],
      logPath: "/home/me/.specwithcode/provision/run.log",
    },
  };
  await mount();
  await act(async () => button("Provision").click());
  await settle();
  const text = container.textContent ?? "";
  expect(state.calls).toEqual([]);
  expect(text).toContain("Waiting for root: linger.");
  expect(text).toContain("sudo sh '/home/me/.specwithcode/provision/root-steps.sh'");
  expect(text).toContain("SpecWithCode never asks for it");
  expect(text).toContain("Sign in to Claude Code");
  expect(text).toContain("Allow workers in Settings > Connections");
  await act(async () => button("Retry").click());
  expect(state.calls.at(-1)).toEqual({
    command: "run",
    request: { environmentId: "m3", input: { resume: true } },
  });
});

it("does not offer Provision on an unsupported system", async () => {
  state.preview = {
    target: { ...target, supported: false, reason: "Alpine (musl) is not supported." },
    items: [],
  };
  await mount();
  await act(async () => button("Provision").click());
  await settle();
  expect(container.textContent).toContain("Alpine (musl) is not supported.");
  expect(button("Provision Ministorm").disabled).toBe(true);
});

it("hides on older servers and needs the maintain permission", async () => {
  state.capability = undefined;
  await mount();
  expect(container.textContent).toBe("");
  state.capability = true;
  state.canMaintain = false;
  await mount();
  expect(button("Provision").disabled).toBe(true);
});
