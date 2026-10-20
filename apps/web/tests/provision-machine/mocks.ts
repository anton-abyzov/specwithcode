import { useSyncExternalStore } from "react";
import {
  IDLE_PROVISION_RUN,
  reduceProvisionEvent,
  startProvisionRun,
  type ProvisionRunState,
} from "../../src/studio/provisionRunState";

// One simulated Ubuntu machine: preview, then a streamed run that stops at the root step.
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
const item = (id: string, label: string, status: string, found: string | null, wanted: string) => ({
  id,
  label,
  wanted,
  found,
  status,
  source: "pinned",
  detail: null as string | null,
  command: null as string | null,
});
const plan = [
  item("packages", "Base packages (git, curl, build tools)", "ok", "installed", "installed"),
  item("node", "Node.js", "planned", "18.19.1", "22.20.0"),
  item("gh", "GitHub CLI (gh)", "planned", null, "2.102.0"),
  item("claude", "Claude Code", "planned", null, "2.1.304"),
  item("server", "SpecWithCode server", "ok", "1.0.63", "1.0.63"),
  item("linger", "Service keeps running after logout", "planned", "off", "on"),
];
const done = [
  item("packages", "Base packages (git, curl, build tools)", "ok", "installed", "installed"),
  item("node", "Node.js", "changed", "22.20.0", "22.20.0"),
  item("gh", "GitHub CLI (gh)", "changed", "2.102.0", "2.102.0"),
  item("claude", "Claude Code", "changed", "2.1.304", "2.1.304"),
  item("server", "SpecWithCode server", "ok", "1.0.63", "1.0.63"),
  {
    ...item("linger", "Service keeps running after logout", "needs-root", "off", "on"),
    detail: "loginctl enable-linger needs root",
  },
];
const readback = {
  target,
  ok: false,
  summary: "3 installed, 2 up to date. Waiting for root: linger.",
  items: done,
  rootStep: { command: "sudo sh '/home/anton/.specwithcode/provision/root-steps.sh'", ran: false },
  userSteps: [
    { id: "claude", title: "Sign in to Claude Code", command: "claude", optional: false },
    { id: "gh", title: "Sign in to GitHub", command: "gh auth login", optional: false },
    {
      id: "workers",
      title: "Allow workers in Settings > Connections",
      command: null,
      optional: false,
    },
    {
      id: "pro",
      title: "Ubuntu Pro (optional)",
      command: "sudo pro attach <token>",
      optional: true,
    },
  ],
  logPath: "/home/anton/.specwithcode/provision/run.log",
};

let run: ProvisionRunState = IDLE_PROVISION_RUN;
const listeners = new Set<() => void>();
const set = (next: ProvisionRunState) => {
  run = next;
  listeners.forEach((listener) => listener());
};
const w = window as any;
w.calls = [];
w.provision = {
  emit: (event: any) => set(reduceProvisionEvent(run, event)),
  finish: () => set(reduceProvisionEvent(run, { type: "done", readback } as any)),
};

export const serverEnvironment = { configValueAtom: () => "config" };
export const useEnvironmentScope = () => true;
export const machineProvision = { preview: "preview", run: "run" };
export const provisionRunAtom = () => "run-state";
export const useAtomValue = (atom: string) => {
  const state = useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => run,
  );
  return atom === "config" ? { environment: { capabilities: { machineProvision: true } } } : state;
};
export const useAtomCommand = (command: string) => async (request: any) => {
  w.calls.push({ command, request });
  if (command === "preview") return { _tag: "Success", value: { target, items: plan } };
  set(startProvisionRun(run));
  w.provision.emit({ type: "plan", readback: { ...readback, items: plan } });
  w.provision.emit({ type: "item", item: { ...plan[1], status: "changed", found: "22.20.0" } });
  w.provision.emit({ type: "item", item: { ...plan[2], status: "running" } });
  w.provision.emit({ type: "log", id: "gh", line: "gh_2.102.0_linux_amd64.tar.gz: SHA-256 ok" });
  w.provision.emit({ type: "log", id: "gh", line: "installed to ~/.local/bin/gh" });
  return { _tag: "Success", value: undefined };
};
