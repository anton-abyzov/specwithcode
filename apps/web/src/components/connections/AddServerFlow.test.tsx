import { EnvironmentId, type NativeConnectionsSnapshot } from "@specweave-studio/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Apply = { environmentId: string; input: Record<string, unknown> };
const state = vi.hoisted(() => ({
  /** Machines other than the one being set up, by id. */
  machines: {} as Record<
    string,
    { label: string; connected: boolean; mayWrite: boolean; snapshot: unknown; failed?: boolean }
  >,
  apply: vi.fn(),
  refresh: vi.fn(),
  copied: [] as string[],
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, hash }: { children: ReactNode; to: string; hash?: string }) => (
    <a href={`${to}#${hash ?? ""}`}>{children}</a>
  ),
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copyToClipboard: (value: string) => state.copied.push(value),
    isCopied: false,
  }),
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    nativeConnections: (request: unknown) => request,
    nativeConnectionApply: {},
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.apply }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (id: string, scope: string) =>
    scope === "filesystem:read" || (state.machines[id]?.mayWrite ?? true),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: (id: string) => ({
    label: state.machines[id]?.label ?? "Desk",
    connection: { phase: (state.machines[id]?.connected ?? true) ? "connected" : "error" },
  }),
  useEnvironments: () => ({
    environments: [
      { environmentId: "desk", label: "Desk" },
      ...Object.entries(state.machines).map(([environmentId, machine]) => ({
        environmentId,
        label: machine.label,
      })),
    ],
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { environmentId: string } | null) => {
    const machine = atom ? state.machines[atom.environmentId] : undefined;
    return {
      data: machine?.failed ? null : (machine?.snapshot ?? null),
      error: machine?.failed ? "unreachable" : null,
      isPending: false,
      refresh: state.refresh,
    };
  },
}));

import { AddServerFlow } from "./AddServerFlow";

const desk = EnvironmentId.make("desk");
const base: NativeConnectionsSnapshot = {
  observedAt: "2026-11-18T00:00:00Z",
  runtime: "unverified",
  truncated: false,
  sources: [],
  connections: [],
  plugins: [],
  otherTools: [{ tool: "claude-desktop", status: "read", connections: [] }],
};
const { plugins: _plugins, ...old } = base;
const codexHas = (name: string): NativeConnectionsSnapshot => ({
  ...base,
  connections: [
    {
      id: `codex:${name}`,
      name,
      provider: "codex",
      sourceId: "codex-user",
      scope: "user",
      transport: "http",
      state: "configured",
      shadowed: false,
    },
  ],
});

let renderer: ReactTestRenderer;
const props = { onByHand: vi.fn(), onChanged: vi.fn(), onAdded: vi.fn() };
/** The machine answers every request: a preview lists one file per tool, a write returns an id. */
function answer({ environmentId, input }: Apply) {
  const tools = (input.tools as string[] | undefined) ?? [];
  return Promise.resolve({
    _tag: "Success",
    value: {
      ...base,
      change: {
        ...(input.preview ? {} : { id: `change-${environmentId}` }),
        preview: input.preview === true,
        files: tools.map((tool) => ({
          tool,
          path: `~/${environmentId}/${tool}.json`,
          lines: [`Add ${String(input.name)}`],
        })),
      },
    },
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.copied = [];
  state.apply.mockImplementation(answer);
  state.machines = {
    loft: { label: "Loft", connected: true, mayWrite: true, snapshot: base },
    attic: { label: "Attic", connected: true, mayWrite: true, snapshot: old },
    guest: { label: "Guest", connected: true, mayWrite: false, snapshot: base },
    away: { label: "Away", connected: false, mayWrite: true, snapshot: base },
  };
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function mount(snapshot: NativeConnectionsSnapshot = base, project = false) {
  await act(() => {
    renderer = create(
      <AddServerFlow
        environmentId={desk}
        machine="Desk"
        snapshot={snapshot}
        project={project}
        {...props}
      />,
    );
  });
}
const text = () =>
  renderer.root
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child): child is string => typeof child === "string"))
    .join(" ");
const byTestId = (id: string) => renderer.root.findAll((node) => node.props["data-testid"] === id);
const button = (label: string) => {
  const found = renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      (node.props["aria-label"] === label ||
        node.children.filter((child) => typeof child === "string").join("") === label),
  )[0];
  if (!found) throw new Error(`no button "${label}" in: ${text()}`);
  return found;
};
const press = (label: string) => act(async () => void (await button(label).props.onClick?.()));
const submit = (testId: string) =>
  act(async () => void (await byTestId(testId)[0]!.props.onSubmit({ preventDefault() {} })));
const review = () => submit("add-server-summary");
/** A tool or machine tick box, found by its accessible name. */
const box = (label: string) =>
  renderer.root.findAll(
    (node) => node.props["aria-label"] === label && "onCheckedChange" in node.props,
  )[0]!;
const tick = (label: string, checked = true) =>
  act(() => box(label).props.onCheckedChange(checked));
async function paste(value: string) {
  await act(() => byTestId("add-server-paste")[0]!.props.onChange({ target: { value } }));
  await submit("add-server-pick-form");
}
const calls = () => state.apply.mock.calls.map(([call]) => call as Apply);
const called = (environmentId: string) =>
  calls().filter((call) => call.environmentId === environmentId);

describe("AddServerFlow", () => {
  it("shows what a pasted address adds, which tools get it and why one cannot", async () => {
    await mount();
    await paste("https://mcp.linear.app/mcp");
    expect(byTestId("add-server-name")[0]!.children).toEqual(["linear"]);
    expect(text()).toContain("Web address");
    expect(text()).toContain("https://mcp.linear.app/mcp");
    expect(box("Codex").props.checked).toBe(true);
    expect(box("Claude Code").props.checked).toBe(true);
    expect(box("Claude Desktop").props).toMatchObject({ checked: false, disabled: true });
    expect(text()).toContain("SpecWithCode cannot add web addresses to Claude Desktop");
    expect(text()).toContain(
      "A thread sees this server when the tool it runs on is ticked. Grok threads read Claude Code's list.",
    );
    expect(text()).toContain("appear here once they are installed on Desk.");
    expect(text()).toContain("On Desk only.");
    expect(state.apply).not.toHaveBeenCalled();
  });

  it("lists every other machine unticked, and disabled with its reason when it cannot take the add", async () => {
    await mount();
    await paste("https://mcp.linear.app/mcp");
    expect(box("Loft").props).toMatchObject({ checked: false, disabled: false });
    for (const name of ["Attic", "Guest", "Away"])
      expect(box(name).props).toMatchObject({ checked: false, disabled: true });
    expect(text()).toContain("Update SpecWithCode on Attic to add servers from here.");
    expect(text()).toContain("This sign-in cannot change files on Guest");
    expect(text()).toContain("Away is offline");
  });

  it("previews each ticked machine, saves each one and undoes one without the other", async () => {
    await mount();
    await paste("https://mcp.linear.app/mcp");
    await tick("Loft");
    expect(text()).toContain("On Desk and Loft.");
    await review();

    expect(calls()).toEqual([
      {
        environmentId: "desk",
        input: {
          action: "add",
          name: "linear",
          tools: ["codex", "claude"],
          server: { url: "https://mcp.linear.app/mcp" },
          preview: true,
        },
      },
      expect.objectContaining({ environmentId: "loft" }),
    ]);
    const reviewed = byTestId("review-machine");
    expect(reviewed.map((node) => node.props["data-machine"])).toEqual(["Desk", "Loft"]);
    expect(text()).toContain("~/desk/codex.json");
    expect(text()).toContain("~/loft/claude.json");
    expect(text()).toContain("Nothing is written until you save.");

    await press("Save on Desk and Loft");
    expect(
      calls()
        .slice(2)
        .map((call) => [call.environmentId, call.input.preview]),
    ).toEqual([
      ["desk", undefined],
      ["loft", undefined],
    ]);
    const results = byTestId("add-server-result");
    expect(results.map((node) => node.props["data-state"])).toEqual(["added", "added"]);
    expect(props.onAdded).toHaveBeenLastCalledWith("linear");
    expect(props.onChanged).toHaveBeenCalled();

    await press("Undo: Loft");
    expect(calls().at(-1)).toEqual({
      environmentId: "loft",
      input: { action: "undo", changeId: "change-loft" },
    });
    expect(byTestId("add-server-result").map((node) => node.props["data-state"])).toEqual([
      "added",
      "undone",
    ]);
    // The machines that could not take the add were never asked, before or after Save.
    for (const id of ["attic", "guest", "away"]) expect(called(id)).toEqual([]);
  });

  it("never asks a machine that is old, view only or offline, even if it was ticked by force", async () => {
    await mount();
    await paste("https://mcp.linear.app/mcp");
    for (const name of ["Attic", "Guest", "Away"]) await tick(name);
    for (const name of ["Attic", "Guest", "Away"]) expect(box(name).props.checked).toBe(false);
    await review();
    expect(byTestId("review-machine").map((node) => node.props["data-machine"])).toEqual(["Desk"]);
    await press("Save on Desk");
    for (const id of ["attic", "guest", "away"]) expect(called(id)).toEqual([]);
    expect(called("desk")).toHaveLength(2);
  });

  it("shows a refused machine in the review and skips it on Save", async () => {
    state.apply.mockImplementation((call: Apply) =>
      call.environmentId === "loft"
        ? Promise.resolve({ _tag: "Failure", cause: new Error("Team rules refuse this server.") })
        : answer(call),
    );
    await mount();
    await paste("https://mcp.linear.app/mcp");
    await tick("Loft");
    await review();
    expect(text()).toContain("Cannot be added on Loft");
    expect(text()).toContain("Team rules refuse this server.");
    expect(text()).toContain("Loft will be skipped.");
    await press("Save on Desk");
    expect(called("loft")).toHaveLength(1);
    expect(byTestId("add-server-result").map((node) => node.props["data-state"])).toEqual([
      "added",
      "skipped",
    ]);
  });

  it("leaves out, per machine, a tool that already has the name", async () => {
    state.machines.loft!.snapshot = codexHas("linear");
    await mount();
    await paste("https://mcp.linear.app/mcp");
    await tick("Loft");
    await review();
    expect(called("loft")[0]!.input.tools).toEqual(["claude"]);
    expect(called("desk")[0]!.input.tools).toEqual(["codex", "claude"]);
    expect(text()).toContain(
      "Codex on Loft already has a server named linear, so it is left out there.",
    );
  });

  it("does not write to a machine that stopped being ready between Review and Save", async () => {
    await mount();
    await paste("https://mcp.linear.app/mcp");
    await tick("Loft");
    await review();
    state.machines.loft!.connected = false;
    await act(() =>
      renderer.update(
        <AddServerFlow
          environmentId={desk}
          machine="Desk"
          snapshot={base}
          project={false}
          {...props}
        />,
      ),
    );
    await press("Save on Desk and Loft");
    expect(called("loft")).toHaveLength(1);
    expect(byTestId("add-server-result").map((node) => node.props["data-state"])).toEqual([
      "added",
      "failed",
    ]);
    expect(text()).toContain("Loft can no longer be changed from here.");
  });

  it("starts every new add with no other machine ticked", async () => {
    await mount();
    await paste("https://mcp.linear.app/mcp");
    await tick("Loft");
    await press("Cancel");
    await paste("https://mcp.notion.com/mcp");
    expect(box("Loft").props.checked).toBe(false);
    await tick("Loft");
    await review();
    await press("Save on Desk and Loft");
    await press("Done");
    await paste("https://mcp.sentry.dev/mcp");
    expect(box("Loft").props.checked).toBe(false);
    expect(text()).toContain("On Desk only.");
  });

  it("builds the sign-in commands from the name the server was saved under", async () => {
    await mount();
    await press("Add: Linear");
    expect(text()).toContain("In the browser, after you add it. No key to paste.");
    await press("Rename");
    const name = renderer.root.find((node) => node.props["aria-label"] === "Server name");
    await act(() => name.props.onChange({ target: { value: "linear-work" } }));
    await review();
    await press("Save on Desk");
    expect(text()).toContain("One step left: sign in once in each tool");
    expect(
      byTestId("add-server-sign-in")[0]!
        .findAllByType("code")
        .map((node) => node.children.join("")),
    ).toMatchInlineSnapshot(`
      [
        "codex mcp login linear-work",
        "claude mcp login linear-work",
      ]
    `);
    expect(text()).toContain("Run it in a terminal on Desk.");
    await press("Copy: claude mcp login linear-work");
    expect(state.copied).toEqual(["claude mcp login linear-work"]);
    expect(text()).not.toContain("Connected");
    expect(text()).not.toContain("Needs sign-in");
  });

  it("asks for a token entry's token before the review and sends it in the header", async () => {
    await mount();
    await press("Add: GitHub");
    await review();
    expect(text()).toContain("Fill in Personal access token.");
    expect(state.apply).not.toHaveBeenCalled();
    const field = renderer.root.find((node) => node.props.type === "password");
    await act(() => field.props.onChange({ target: { value: "tok" } }));
    await review();
    expect(called("desk")[0]!.input.server).toEqual({
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer tok" },
    });
    await press("Save on Desk");
    expect(byTestId("add-server-sign-in")).toEqual([]);
  });

  it("warns that a program runs with the account's rights, and masks its secrets", async () => {
    await mount();
    await paste("npx -y docs-mcp --api-key abc123");
    expect(text()).toContain(
      "This is a program. It will run on each machine you tick, with your account's rights.",
    );
    expect(byTestId("add-server-command")[0]!.children).toEqual(["npx -y docs-mcp --api-key ••••"]);
    expect(text()).not.toContain("abc123");
    expect(box("Claude Desktop").props).toMatchObject({ checked: true, disabled: false });
  });

  it("says a server overlaps a built-in tool before it adds it", async () => {
    await mount();
    await paste("npx -y chrome-devtools-mcp@latest");
    expect(text()).toContain("This overlaps with something built in");
    expect(text()).toContain("Agents here already browse and click in your signed-in Chrome.");
    expect(renderer.root.findByType("a").props.href).toBe("/settings/chrome#");
    expect(byTestId("add-server-summary")).toEqual([]);
    await press("Add anyway");
    expect(byTestId("add-server-name")[0]!.children).toEqual(["chrome-devtools"]);
  });

  it("refuses a paste it cannot use, with the reason and the form to fill by hand", async () => {
    await mount();
    await paste("claude mcp add --transport sse linear https://mcp.linear.app/sse");
    expect(text()).toContain("This is an SSE server, which SpecWithCode cannot add.");
    await paste("codex mcp add github --url https://x.test/mcp --bearer-token-env-var PAT");
    expect(text()).toContain(
      "SpecWithCode cannot carry over the Codex option “--bearer-token-env-var”.",
    );
    expect(byTestId("add-server-summary")).toEqual([]);
    const byHand = renderer.root
      .findAll((node) => node.props.role === "alert")[0]!
      .findByType("button");
    await act(() => byHand.props.onClick());
    expect(props.onByHand).toHaveBeenCalledTimes(1);
  });

  it("marks a catalog server that is already on the machine", async () => {
    await mount({ ...codexHas("linear"), otherTools: [] });
    expect(byTestId("catalog-linear")[0]!.findAllByType("button")[0]!.props["aria-label"]).toBe(
      "Add to more tools: Linear",
    );
    expect(byTestId("catalog-notion")[0]!.findAllByType("button")[0]!.props["aria-label"]).toBe(
      "Add: Notion",
    );
    await press("Add to more tools: Linear");
    expect(box("Codex").props).toMatchObject({ checked: false, disabled: true });
    expect(text()).toContain("Codex already has a server named linear");
  });

  it("says on a project's page that the add reaches every project", async () => {
    await mount(base, true);
    await paste("https://mcp.linear.app/mcp");
    expect(text()).toContain("Added for every project on Desk.");
  });

  it("shows six catalog servers until asked for all", async () => {
    await mount();
    expect(byTestId("add-server-catalog")[0]!.findAllByType("li")).toHaveLength(6);
    await press("Show all");
    expect(byTestId("add-server-catalog")[0]!.findAllByType("li")).toHaveLength(7);
    expect(byTestId("catalog-higgsfield")).toHaveLength(1);
  });
});
