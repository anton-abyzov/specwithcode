// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { GitHubCredentialCard } from "./GitHubCredentialCard";

const TOKEN = "gho_never_shown_anywhere";
const state = vi.hoisted(() => ({
  capabilities: {} as Record<string, Record<string, boolean>>,
  os: {} as Record<string, string>,
  allowed: true,
  settings: { copyHostSignIn: true, confirmCopySignIn: true },
  calls: [] as Array<{ command: string; request: unknown }>,
  replies: {} as Record<string, Array<unknown>>,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (id: string) => ({
    environment: { capabilities: state.capabilities[id] ?? {}, platform: { os: state.os[id] } },
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: (id: string) => id, updateSettings: "updateSettings" },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.allowed }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "m4",
  useEnvironment: (id: string | null) => (id ? { label: id.toUpperCase() } : undefined),
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (_id: string, select: (s: unknown) => unknown) =>
    select({ github: state.settings }),
}));
vi.mock("../../studio/gitHubCredentialCopy", () => ({
  gitHubCredential: {
    state: "state",
    removeCopied: "removeCopied",
    copyPreview: "copyPreview",
    copy: "copy",
  },
}));
vi.mock("./GitHubSignInPanel", () => ({
  useGitHubSignInAvailable: (id: string) => state.capabilities[id]?.gitHubSignIn === true,
  GitHubSignInPanel: (props: { startLabel?: string; secondary?: boolean }) => (
    <p>
      code panel: {props.startLabel ?? "Sign in to GitHub"}
      {props.secondary ? " (secondary)" : ""}
    </p>
  ),
}));
vi.mock("../ui/checkbox", () => ({
  Checkbox: (props: { checked: boolean; onCheckedChange: (v: boolean) => void }) => (
    <input
      type="checkbox"
      aria-label="Don't ask again"
      checked={props.checked}
      onChange={(event) => props.onCheckedChange(event.target.checked)}
    />
  ),
}));
const commands = new Map<string, (request: unknown) => Promise<unknown>>();
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => {
    let run = commands.get(command);
    if (!run) {
      run = async (request: unknown) => {
        state.calls.push({ command, request });
        const next = state.replies[command]?.shift();
        if (next instanceof Error) return { _tag: "Failure", error: next };
        return { _tag: "Success", value: next ?? null };
      };
      commands.set(command, run);
    }
    return run;
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
}));

const credentialState = (patch: Record<string, unknown> = {}) => ({
  host: "github.com",
  hostEnabled: true,
  gh: { installed: true, version: "2.88.1", outdated: false },
  ghAccounts: [],
  environmentVariables: [],
  saved: null,
  credentialHelpers: [],
  gitHubCredentialHelper: false,
  inUse: null,
  ...patch,
});
const preview = (patch: Record<string, unknown> = {}) => ({
  available: true,
  reason: null,
  message: null,
  login: "octo",
  scopes: ["repo"],
  fineGrained: false,
  expiresAt: null,
  source: "gh",
  sourceLabel: "M4",
  ...patch,
});
const FULL = { gitHubCredentialCopy: true, gitHubSignIn: true };

let root: Root;
let container: HTMLDivElement;
let changed: number;
const settle = () =>
  act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
const button = (label: string) => {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button ${label}: ${container.textContent}`);
  return element;
};
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};
const mount = async () => {
  await act(async () =>
    root.render(
      <GitHubCredentialCard
        environmentId={"m3" as never}
        environmentLabel="M3"
        onChanged={() => (changed += 1)}
      />,
    ),
  );
  await settle();
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.capabilities = { m4: FULL, m3: FULL };
  state.os = { m4: "darwin", m3: "linux" };
  state.allowed = true;
  state.settings = { copyHostSignIn: true, confirmCopySignIn: true };
  state.calls = [];
  state.replies = { state: [credentialState()], copyPreview: [preview()] };
  commands.clear();
  changed = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("offers this Mac's sign-in first, confirms it, and remembers Don't ask again", async () => {
  state.replies.copy = [{ login: "octo", copiedAt: "2026-10-27T00:00:00Z" }];
  state.replies.state!.push(
    credentialState({
      inUse: { source: "copied", login: "octo" },
      saved: { copiedFrom: "M4", copiedAt: "2026-10-27T00:00:00Z", login: "octo" },
    }),
  );
  await mount();
  expect(container.textContent).toContain("code panel: Sign in with a code instead (secondary)");
  await click(button("Use this Mac's GitHub sign-in"));
  expect(container.textContent).toContain("scopes repo; does not expire");
  expect(container.textContent).toContain("stored only in M3's secret store");
  expect(container.textContent).toContain("revoking it on GitHub signs out every machine");
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await click(checkbox);
  await click(button("Copy sign-in"));
  expect(state.calls.map((call) => call.command)).toEqual([
    "state",
    "copyPreview",
    "copy",
    "updateSettings",
    "state",
  ]);
  expect(state.calls[3]!.request).toEqual({
    environmentId: "m4",
    input: { patch: { github: { confirmCopySignIn: false } } },
  });
  expect(state.calls[2]!.request).toEqual({
    environmentId: "m4",
    input: { targetEnvironmentId: "m3" },
  });
  expect(container.textContent).toContain("Signed in as octo (copied from M4).");
  expect(changed).toBe(1);
  expect(container.innerHTML).not.toContain(TOKEN);
});

it("keeps asking when the copy failed, even with Don't ask again ticked", async () => {
  state.replies.copy = [new Error("M3 did not answer over the tailnet.")];
  await mount();
  await click(button("Use this Mac's GitHub sign-in"));
  await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Copy sign-in"));
  expect(state.calls.map((call) => call.command)).not.toContain("updateSettings");
});

it("replaces a token saved by hand only after a confirmation that says so", async () => {
  state.settings.confirmCopySignIn = false;
  state.replies.state = [credentialState({ inUse: { source: "saved", login: "pat-owner" } })];
  state.replies.copy = [{ login: "octo", copiedAt: "2026-10-27T00:00:00Z" }];
  await mount();
  expect(container.textContent).toContain(
    "Using a GitHub token saved in Settings on M3 (pat-owner).",
  );
  await click(button("Replace the saved token with this Mac's sign-in (octo)"));
  expect(container.textContent).toContain(
    "It replaces the token saved in Settings on M3 (pat-owner)",
  );
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  await click(button("Copy sign-in"));
  expect(state.calls.find((call) => call.command === "copy")?.request).toEqual({
    environmentId: "m4",
    input: { targetEnvironmentId: "m3", replaceSaved: true },
  });
});

it("copies without asking when the setting says so", async () => {
  state.settings.confirmCopySignIn = false;
  state.replies.copy = [{ login: "octo", copiedAt: "2026-10-27T00:00:00Z" }];
  await mount();
  await click(button("Use this Mac's GitHub sign-in"));
  expect(state.calls.map((call) => call.command)).toContain("copy");
  expect(container.textContent).not.toContain("Copy sign-in");
});

it("names a non-Mac source by its label and puts the code first when copying is off", async () => {
  state.os.m4 = "linux";
  state.settings.copyHostSignIn = false;
  await mount();
  expect(container.textContent).toContain("code panel: Sign in to GitHub");
  expect(container.textContent).not.toContain("(secondary)");
  button("Use M4's GitHub sign-in");
});

it("falls back to the code panel alone on a machine too old to copy to", async () => {
  state.capabilities.m3 = { gitHubSignIn: true };
  await mount();
  expect(container.textContent).toContain("code panel: Sign in to GitHub");
  expect(state.calls).toEqual([]);
});

it("offers no copy when the source machine lacks the capability", async () => {
  state.capabilities.m4 = {};
  await mount();
  expect(state.calls.map((call) => call.command)).toEqual(["state"]);
  expect(container.textContent).toContain("code panel: Sign in to GitHub");
  expect(container.textContent).not.toContain("GitHub sign-in’s");
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

it("leaves an existing gh login alone and offers no code", async () => {
  state.replies.state = [
    credentialState({
      inUse: { source: "gh", login: "octo" },
      ghAccounts: [{ login: "octo", active: true, authenticated: true }],
    }),
  ];
  await mount();
  expect(container.textContent).toContain("Already signed in as octo on M3.");
  expect(container.textContent).toContain("Same account as M4; nothing to copy.");
  expect(container.textContent).not.toContain("code panel");
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

it("shows a different gh account and keeps a copy as an explicit secondary choice", async () => {
  state.replies.state = [
    credentialState({
      inUse: { source: "gh", login: "work" },
      ghAccounts: [{ login: "work", active: true, authenticated: true }],
    }),
  ];
  await mount();
  expect(container.textContent).toContain("Already signed in as work on M3.");
  expect(container.textContent).not.toContain("code panel");
  button("Use this Mac's sign-in (octo) instead");
});

it("explains the host has no token to copy and keeps the code", async () => {
  state.replies.copyPreview = [
    preview({
      available: false,
      reason: "no-token",
      login: null,
      message: "M4 has no GitHub sign-in to copy. Sign in on M4 first, or use a code instead.",
    }),
  ];
  await mount();
  expect(container.textContent).toContain("M4 has no GitHub sign-in to copy.");
  expect(container.textContent).toContain("code panel: Sign in to GitHub");
});

it("removes only the copied sign-in and can hand back to gh's own login", async () => {
  state.replies.state = [
    credentialState({
      inUse: { source: "copied", login: "octo" },
      saved: { copiedFrom: "M4", copiedAt: "2026-10-27T00:00:00Z", login: "octo" },
      ghAccounts: [{ login: "work", active: true, authenticated: true }],
    }),
  ];
  state.replies.removeCopied = [
    credentialState({
      inUse: { source: "gh", login: "work" },
      ghAccounts: [{ login: "work", active: true, authenticated: true }],
    }),
  ];
  await mount();
  expect(container.textContent).toContain("Signed in as octo (copied from M4).");
  expect(container.textContent).toContain("gh on M3: work (active)");
  expect(container.textContent).toContain("the agents, terminals and git it starts there");
  button("Use gh's work for SpecWithCode instead");
  await click(button("Remove copied sign-in"));
  expect(state.calls.at(-1)).toEqual({
    command: "removeCopied",
    request: { environmentId: "m3", input: {} },
  });
  expect(container.textContent).toContain("Already signed in as work on M3.");
  expect(changed).toBe(1);
});

it("shows a copy failure without anything secret", async () => {
  state.settings.confirmCopySignIn = false;
  state.replies.copy = [new Error("M3 did not answer over the tailnet.")];
  await mount();
  await click(button("Use this Mac's GitHub sign-in"));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "M3 did not answer over the tailnet.",
  );
  expect(container.innerHTML).not.toContain(TOKEN);
});
