// @vitest-environment jsdom
/**
 * 0898 AC-01 and AC-04 on the card: nothing changes until the member turns it
 * on, the exact summary is shown first, the self-hosted credential is
 * write-only, and turning it off asks the team to remove this machine.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { TeamUsageSettings } from "./TeamUsageSettings";

const state = vi.hoisted(() => ({
  allowed: true,
  calls: [] as Array<{ command: string; request: unknown }>,
  replies: {} as Record<string, Array<unknown>>,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.allowed }));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { label: string }) => options.label,
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
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

const preview = {
  machineLabel: "Work Mac",
  at: "2026-11-19T10:00:00.000Z",
  accounts: [
    {
      provider: "claudeAgent",
      accountLabel: "Work Max",
      planTier: "Max 20x",
      windows: [{ kind: "session", remainingPercent: 64, lowestRemainingPercent: 12 }],
      limitHits: 2,
      handoffs: 1,
      providerSwitches: 0,
    },
  ],
};
const status = (patch: Record<string, unknown> = {}) => ({
  config: { enabled: false },
  selfHostedCredentialSet: false,
  preview,
  ...patch,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  state.allowed = true;
  state.calls = [];
  state.replies = {};
  commands.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => {});
async function mount() {
  await act(async () => {
    root.render(<TeamUsageSettings environmentId={"m4" as never} environmentLabel="M4" />);
  });
  await flush();
}
const byLabel = (label: string) =>
  host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const button = (text: string) =>
  [...host.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === text,
  ) as HTMLButtonElement;
const radio = (text: string) =>
  [...host.querySelectorAll("label")]
    .find((entry) => entry.textContent?.includes(text))!
    .querySelector("input")!;
const type = async (element: HTMLElement | null, value: string) => {
  const input = element as HTMLInputElement | HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
};
const updates = () =>
  state.calls
    .filter((call) => call.command === "team-usage:update")
    .map((call) => call.request) as Array<{
    input: { config: Record<string, unknown>; selfHostedCredential?: string };
  }>;

it("is off until the member turns it on, and shows the exact summary first", async () => {
  state.replies["team-usage:status"] = [status()];
  await mount();
  expect(byLabel("Share daily usage with my team")?.getAttribute("aria-checked")).toBe("false");
  expect(state.calls.map((call) => call.command)).toEqual(["team-usage:status"]);
  expect(JSON.parse(host.querySelector("[data-team-usage-preview]")!.textContent!)).toEqual(
    preview,
  );
});

it("opts in to the picked verified-skill.com org", async () => {
  state.replies["team-usage:status"] = [status()];
  state.replies["team-usage:orgs"] = [
    {
      orgs: [
        { tenantId: "t-1", label: "Acme" },
        { tenantId: "t-2", label: "Beta" },
      ],
    },
  ];
  state.replies["team-usage:update"] = [
    status({
      config: { enabled: true, endpoint: { kind: "hosted", tenantId: "t-2", orgLabel: "Beta" } },
    }),
  ];
  await mount();
  await act(async () => button("Choose org").click());
  await type(byLabel("Org"), "t-2");
  await act(async () => byLabel("Share daily usage with my team")!.click());
  await flush();
  expect(updates()).toEqual([
    {
      environmentId: "m4",
      input: {
        config: { enabled: true, endpoint: { kind: "hosted", tenantId: "t-2", orgLabel: "Beta" } },
      },
    },
  ]);
  expect(byLabel("Share daily usage with my team")?.getAttribute("aria-checked")).toBe("true");
});

it("refuses to turn on with no destination, without calling the machine", async () => {
  state.replies["team-usage:status"] = [status()];
  await mount();
  await act(async () => byLabel("Share daily usage with my team")!.click());
  expect(updates()).toEqual([]);
  expect(host.textContent).toContain("Pick your org first.");
});

it("sends a self-hosted credential once, never shows it, and shows the machine's refusal", async () => {
  state.replies["team-usage:status"] = [status()];
  state.replies["team-usage:update"] = [new Error("The team endpoint must use https://.")];
  await mount();
  await act(async () => radio("A self-hosted team endpoint").click());
  await type(byLabel("Endpoint URL"), "https://team.example/usage");
  const credential = byLabel("Endpoint credential") as HTMLInputElement;
  expect(credential.type).toBe("password");
  await type(credential, "team-secret");
  await act(async () => byLabel("Share daily usage with my team")!.click());
  await flush();
  expect(updates()[0]!.input).toEqual({
    config: { enabled: true, endpoint: { kind: "selfHosted", url: "https://team.example/usage" } },
    selfHostedCredential: "team-secret",
  });
  expect(host.textContent).toContain("The team endpoint must use https://.");
  expect(host.querySelector("[data-team-usage-preview]")!.textContent).not.toContain("team-secret");
});

it("turning it off keeps the destination and shows the pending removal", async () => {
  const endpoint = { kind: "hosted", tenantId: "t-1", orgLabel: "Acme" };
  state.replies["team-usage:status"] = [
    status({ config: { enabled: true, endpoint, machineLabel: "Work Mac" } }),
  ];
  state.replies["team-usage:update"] = [
    status({
      config: { enabled: false, endpoint, machineLabel: "Work Mac" },
      removalPending: "Work Mac",
    }),
  ];
  await mount();
  await act(async () => byLabel("Share daily usage with my team")!.click());
  await flush();
  expect(updates()[0]!.input.config).toEqual({
    enabled: false,
    endpoint,
    machineLabel: "Work Mac",
  });
  expect(host.textContent).toContain('Removing "Work Mac" from the team.');
});

it("is not offered on a connection without settings:write", async () => {
  state.allowed = false;
  await mount();
  expect(host.innerHTML).toBe("");
  expect(state.calls).toEqual([]);
});
