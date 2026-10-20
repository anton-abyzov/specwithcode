// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { MachineReadinessChecklist } from "./MachineReadinessChecklist";

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
  providers: [] as unknown[],
  canManage: true,
  readiness: null as unknown,
  fail: null as Error | null,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: { providersValueAtom: () => "providers" },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.canManage }));
vi.mock("../../studio/machineHandoff", () => ({ machineHandoff: { readiness: "readiness" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (request: unknown) => {
    state.calls.push(request);
    return state.fail
      ? { _tag: "Failure", error: state.fail }
      : { _tag: "Success", value: state.readiness };
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
}));
vi.mock("./ProviderAuthenticationSection", () => ({
  ProviderAuthenticationSection: (props: { environmentLabel: string; instanceId: string }) => (
    <p>
      Sign-in flow for {props.instanceId} on {props.environmentLabel}
    </p>
  ),
}));

const provider = (instanceId: string, status: string, extra: Record<string, unknown> = {}) => ({
  instanceId,
  driver: instanceId,
  enabled: true,
  installed: true,
  auth: { status, ...extra },
});

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
const mount = async (projectId?: string) => {
  await act(async () =>
    root.render(
      <MachineReadinessChecklist
        environmentId={"m3" as never}
        environmentLabel="M3"
        projectId={projectId as never}
      />,
    ),
  );
  await settle();
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.calls = [];
  state.canManage = true;
  state.fail = null;
  state.providers = [
    provider("claudeAgent", "authenticated", { email: "me@example.com" }),
    provider("codex", "unauthenticated"),
  ];
  state.readiness = {
    checkedAt: "2026-10-19T20:00:00.000Z",
    folder: "/Users/me/Projects/project",
    github: { status: "signed-out", accounts: [], detail: null },
    repositories: [
      { path: ".", origin: "https://github.com/me/app.git", status: "ok", detail: null },
      {
        path: "repositories/private",
        origin: "git@github.com:me/private.git",
        status: "no-access",
        detail: "Permission denied (publickey).",
      },
    ],
    repositoriesTruncated: false,
    tools: [
      { name: "pnpm", action: "Dev", found: true },
      { name: "cargo", action: "Build", found: false },
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

it("checks the machine and project, and lists what still needs a sign-in or access", async () => {
  await mount("copied");
  expect(state.calls).toEqual([{ environmentId: "m3", input: { projectId: "copied" } }]);
  const text = container.textContent ?? "";
  expect(text).toContain("Claude: signed in");
  expect(text).toContain("me@example.com");
  expect(text).toContain("Codex: not signed in");
  expect(text).toContain("GitHub CLI: not signed in");
  expect(text).toContain("run gh auth login");
  expect(text).toContain("1 of 2 repositories cannot reach their origin");
  expect(text).toContain("repositories/private");
  expect(text).toContain("Permission denied (publickey).");
  expect(text).toContain("Missing tools: cargo");
  expect(text).toContain("Sign-ins are never copied between machines");
});

it("signs in on that machine itself and checks again on request", async () => {
  await mount();
  expect(state.calls).toEqual([{ environmentId: "m3", input: {} }]);
  await act(async () => button("Sign in on M3").click());
  expect(container.textContent).toContain("Sign-in flow for codex on M3");
  await act(async () => button("Check again").click());
  await settle();
  expect(state.calls).toHaveLength(2);
});

it("hides sign-in for a browser without provider permission and explains an older server", async () => {
  state.canManage = false;
  state.fail = new Error("");
  await mount();
  expect(container.textContent).not.toContain("Sign in on M3");
  expect(container.textContent).toContain(
    "M3 could not be checked. It may run an older SpecWithCode.",
  );
});
