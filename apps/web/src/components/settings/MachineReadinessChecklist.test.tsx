// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { MachineReadinessChecklist, readinessProviders } from "./MachineReadinessChecklist";

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
  providers: [] as unknown[],
  canManage: true,
  readiness: null as unknown,
  fail: null as Error | null,
  signInAvailable: true,
  access: null as unknown,
  coordinatorProvider: null as string | null,
  coordinatorAsked: [] as Array<[unknown, unknown]>,
}));
vi.mock("../../studio/useCoordinatorProvider", () => ({
  useCoordinatorProvider: (environmentId: unknown, projectId: unknown) => {
    state.coordinatorAsked.push([environmentId, projectId]);
    return projectId ? state.coordinatorProvider : null;
  },
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

vi.mock("./GitHubCredentialCard", async () => {
  const { useEffect } = await import("react");
  return {
    GitHubCredentialCard: (props: {
      environmentLabel: string;
      onState?: (value: unknown) => void;
    }) => {
      const { onState } = props;
      useEffect(() => {
        if (state.access) onState?.(state.access);
      }, [onState]);
      return <p>GitHub sign-in panel for {props.environmentLabel}</p>;
    },
    useGitHubCredentialCardAvailable: () => state.signInAvailable,
  };
});

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
const mount = async (projectId?: string, coordinatorOnly = false) => {
  await act(async () =>
    root.render(
      <MachineReadinessChecklist
        environmentId={"m3" as never}
        environmentLabel="M3"
        projectId={projectId as never}
        coordinatorOnly={coordinatorOnly}
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
  state.signInAvailable = true;
  state.access = null;
  state.coordinatorProvider = null;
  state.coordinatorAsked = [];
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
  expect(text).toContain("Coding-agent sign-ins are never copied between machines");
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

const withGitHub = (github: unknown) => {
  state.readiness = { ...(state.readiness as object), github };
};

it("offers signing gh in from this device when that machine is signed out", async () => {
  withGitHub({ status: "signed-out", accounts: [], detail: "The token in default is invalid." });
  await mount();
  const text = container.textContent ?? "";
  expect(text).toContain("GitHub CLI: not signed in");
  expect(text).toContain("The token in default is invalid.");
  expect(text).toContain("GitHub sign-in panel for M3");
  expect(text).toContain("Or, in a terminal on M3, run gh auth login.");
});

it("offers signing in when gh is installed but its sign-in is unknown", async () => {
  withGitHub({
    status: "unknown",
    accounts: [],
    detail: "This gh is too old to report its sign-in.",
  });
  await mount();
  expect(container.textContent).toContain("GitHub CLI: sign-in unknown");
  expect(container.textContent).toContain("GitHub sign-in panel for M3");
});

it("asks to provision a machine without gh and drops the gh hint", async () => {
  withGitHub({ status: "not-installed", accounts: [], detail: null });
  await mount();
  const text = container.textContent ?? "";
  expect(text).toContain("GitHub CLI: not installed");
  expect(text).toContain("Run specwithcode provision on M3.");
  // A copied sign-in still works without gh, so the card stays; the gh hint does not.
  expect(text).toContain("GitHub sign-in panel for M3");
  expect(text).not.toContain("gh auth login");
});

it("shows the signed-in account with no gh hint", async () => {
  withGitHub({
    status: "signed-in",
    accounts: [{ host: "github.com", login: "octo" }],
    detail: null,
  });
  await mount();
  const text = container.textContent ?? "";
  expect(text).toContain("GitHub CLI: signed in as octo (github.com)");
  // The card then only reports the login; it offers nothing by default (its own tests).
  expect(text).toContain("GitHub sign-in panel for M3");
  expect(text).not.toContain("run gh auth login");
});

it("gives the plain gh hint, without an orphaned Or, when the panel cannot show", async () => {
  state.signInAvailable = false;
  withGitHub({ status: "signed-out", accounts: [], detail: null });
  await mount();
  const text = container.textContent ?? "";
  expect(text).not.toContain("GitHub sign-in panel");
  expect(text).toContain("In a terminal on M3, run gh auth login.");
  expect(text).not.toContain("Or, in a terminal");
});

it("asks to update an old gh instead of offering sign-in", async () => {
  withGitHub({
    status: "unknown",
    accounts: [],
    detail: "This gh is too old to report its sign-in; update it, then check again.",
    outdated: true,
  });
  await mount();
  const text = container.textContent ?? "";
  expect(text).toContain("Update gh on M3, then sign in.");
  expect(text).not.toContain("gh auth login");
});

it("counts a copied sign-in as signed in and drops the gh auth login hint", async () => {
  state.access = {
    host: "github.com",
    hostEnabled: true,
    gh: { installed: true, version: "2.88.1", outdated: false },
    ghAccounts: [],
    environmentVariables: [],
    saved: { copiedFrom: "M4", copiedAt: "2026-10-27T00:00:00Z", login: "octo" },
    credentialHelpers: [],
    gitHubCredentialHelper: false,
    inUse: { source: "copied", login: "octo" },
  };
  await mount();
  const text = container.textContent ?? "";
  expect(text).toContain("GitHub: signed in as octo (copied from M4)");
  expect(text).not.toContain("GitHub CLI: not signed in");
  expect(text).not.toContain("gh auth login");
  expect(text).not.toContain("Pull requests need it.");
});

it("after a move, lists only the provider the coordinator runs with", async () => {
  state.coordinatorProvider = "codex";
  await mount("moved", true);
  expect(state.coordinatorAsked.at(-1)).toEqual(["m3", "moved"]);
  const text = container.textContent ?? "";
  expect(text).toContain("Codex: not signed in");
  expect(text).not.toContain("Claude");
  expect(button("Sign in on M3")).toBeTruthy();
});

it("after a move, says when the coordinator's provider is not set up there", async () => {
  state.coordinatorProvider = "cursor";
  await mount("moved", true);
  const text = container.textContent ?? "";
  // An id the machine does not list is never shown raw.
  expect(text).toContain("The coordinator's coding agent: not set up on M3");
  expect(text).not.toContain("cursor");
  expect(text).toContain("Install and turn it on in Settings › Providers on M3.");
  expect(text).not.toContain("Claude");
  expect(text).not.toContain("Codex");
  expect(text).not.toContain("No coding agent");
});

it("after a move, lists every enabled provider until the coordinator's provider is known", async () => {
  await mount("moved", true);
  const text = container.textContent ?? "";
  expect(text).toContain("Claude: signed in");
  expect(text).toContain("Codex: not signed in");
  expect(text).not.toContain("No coding agent");
});

it("without the coordinator filter, every installed provider is listed and none asked about", async () => {
  await mount("copied");
  expect(state.coordinatorAsked.every(([, projectId]) => projectId === null)).toBe(true);
  expect(container.textContent).toContain("Claude: signed in");
  expect(container.textContent).toContain("Codex: not signed in");
});

it("readinessProviders keeps enabled, installed providers and filters to the coordinator's", () => {
  const off = { ...provider("cursor", "authenticated"), enabled: false, displayName: "Cursor" };
  const all = [
    provider("claudeAgent", "authenticated"),
    provider("codex", "unauthenticated"),
    off,
  ] as never[];
  expect(
    readinessProviders(all, { only: false, instanceId: null }).shown.map(
      (p: { instanceId: string }) => p.instanceId,
    ),
  ).toEqual(["claudeAgent", "codex"]);
  expect(
    readinessProviders(all, { only: true, instanceId: null }).shown.map(
      (p: { instanceId: string }) => p.instanceId,
    ),
  ).toEqual(["claudeAgent", "codex"]);
  expect(
    readinessProviders(all, { only: true, instanceId: "codex" }).shown.map(
      (p: { instanceId: string }) => p.instanceId,
    ),
  ).toEqual(["codex"]);
  // Installed but turned off: named by its display name, not shown as a sign-in.
  expect(readinessProviders(all, { only: true, instanceId: "cursor" })).toEqual({
    shown: [],
    missing: "Cursor",
  });
  expect(readinessProviders(all, { only: true, instanceId: "gone" }).missing).toBe(
    "The coordinator's coding agent",
  );
  // A known driver id reads as its product name.
  expect(readinessProviders([], { only: true, instanceId: "claudeAgent" }).missing).toBe("Claude");
});
