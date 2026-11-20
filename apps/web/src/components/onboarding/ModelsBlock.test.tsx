// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  config: null as null | { providers: ReadonlyArray<unknown>; settings: unknown },
  scope: vi.fn(),
  editor: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.config }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: (environmentId: string) => environmentId },
}));
vi.mock("../settings/SettingsScopeContext", () => ({
  SettingsScopeProvider: (props: { children: ReactNode } & Record<string, unknown>) => {
    mocks.scope(props);
    return <div data-scope>{props.children}</div>;
  },
}));
vi.mock("../settings/ModelTracksSettings", () => ({
  ModelTracksSettings: (props: { sources?: boolean }) => {
    mocks.editor(props);
    return <p data-editor>Model tracks editor</p>;
  },
}));
vi.mock("../ui/dialog", () => {
  const Pass = (props: { children?: ReactNode }) => <div>{props.children}</div>;
  return {
    Dialog: Pass,
    DialogHeader: Pass,
    DialogPanel: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
    DialogPopup: (props: { children?: ReactNode }) => <div role="dialog">{props.children}</div>,
  };
});

import { ModelsBlock } from "./ModelsBlock";

const environmentId = EnvironmentId.make("this-computer");
const checkedAt = "2026-11-18T17:59:00.000Z";
function agent(
  id: string,
  driver: string,
  models: ReadonlyArray<readonly [string, string]>,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    version: null,
    models: models.map(([slug, name]) => ({ slug, name, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...over,
  };
}
const claude = agent("claudeAgent", "claudeAgent", [
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-fable-5-2", "Claude Fable 5.2"],
]);
const codex = agent("codex", "codex", [
  ["gpt-6.1-sol", "GPT-6.1 Sol"],
  ["gpt-6-astra", "GPT-6 Astra"],
  ["gpt-6-luna", "GPT-6 Luna"],
]);
const muse = agent("muse", "muse", [["muse-wonder-1.0", "Muse Wonder 1.0"]]);
const signedOut = (provider: ServerProvider): ServerProvider => ({
  ...provider,
  status: "error",
  auth: { status: "unauthenticated" },
});
const settings = { adversarialReview: { reviewers: [] } };

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mocks.scope.mockClear();
  mocks.editor.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function show(providers: ReadonlyArray<ServerProvider>, extra?: ReactNode) {
  mocks.config = { providers, settings };
  act(() =>
    root.render(
      <section>
        {extra}
        <ModelsBlock environmentId={environmentId} machineLabel="This Mac" />
      </section>,
    ),
  );
}
const line = (track: string) => host.querySelector<HTMLElement>(`[data-model-track="${track}"]`);
const named = (track: string) =>
  [...(line(track)?.querySelectorAll("[data-model-name]") ?? [])].map((node) =>
    node.getAttribute("data-model-name"),
  );
const marks = (track: string) =>
  [...(line(track)?.querySelectorAll("[data-provider-logo]") ?? [])].map((node) =>
    node.getAttribute("data-provider-logo"),
  );
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((node) => node.textContent === label);

describe("ModelsBlock", () => {
  it("shows the three tracks by their Settings names, three models, then a count", () => {
    show([claude, codex, muse]);
    expect([...host.querySelectorAll("dt")].map((node) => node.textContent)).toEqual([
      "Daily",
      "Complex",
      "Review",
    ]);
    // 1339 built-in Daily order: Opus, Sonnet, Sol, then the free GPT-6 Luna; no Muse.
    expect(named("daily")).toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-6.1 Sol"]);
    expect(line("daily")?.textContent).toContain("+1 more");
    expect(named("complex")).toEqual(["Claude Fable 5.2", "GPT-6 Astra"]);
    expect(named("review")).toEqual(["Muse Wonder 1.0", "GPT-6.1 Sol"]);
    for (const track of ["daily", "complex", "review"]) {
      const first = line(track)?.querySelectorAll("[data-model-first]");
      expect(first?.length).toBe(1);
      expect(first?.[0]?.closest("[data-model-name]")).toBe(
        line(track)?.querySelector("[data-model-name]"),
      );
    }
  });

  it("draws each model's own provider mark, in light and dark", () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      show([claude, codex, muse]);
      expect(marks("daily")).toEqual(["claude", "claude", "openai"]);
      expect(marks("complex")).toEqual(["claude", "openai"]);
      expect(marks("review")).toEqual(["meta", "openai"]);
    }
    document.documentElement.classList.remove("dark");
  });

  it("reads one line while no agent is ready", () => {
    show([signedOut(claude), signedOut(codex)]);
    expect(host.querySelector("[data-models-block]")?.getAttribute("data-models-state")).toBe(
      "none-ready",
    );
    expect(host.querySelector("[data-models-block] p")?.textContent).toBe(
      "Ready once an agent is signed in.",
    );
    expect(host.querySelector("dl")).toBeNull();
  });

  it("follows a sign-in on the step on the next render", () => {
    show([signedOut(claude), signedOut(codex)]);
    expect(host.querySelector("dl")).toBeNull();
    show([claude, signedOut(codex)]);
    expect(named("daily")).toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5"]);
    show([claude, codex]);
    expect(named("review")).toEqual(["GPT-6.1 Sol"]);
  });

  it("says there is no reviewer with one family ready, and Add one goes to an agent", () => {
    // The step's shapes: a ready Codex card nests its own unmarked row, tool rows carry no
    // mark, and a found agent that is signed in but not turned on is not ready.
    const rows = (
      <>
        <div data-agent-ready="true">
          <div data-agent-row="claudeAgent" data-agent-state="ready">
            <button type="button">Claude</button>
          </div>
        </div>
        <div data-agent-ready="true">
          <div data-agent-row="codex">
            <button type="button">Use another account</button>
          </div>
        </div>
        <div data-agent-ready="false">
          <div data-agent-row="muse" data-agent-state="ready">
            <button type="button">Turn on Muse Code</button>
          </div>
        </div>
        <div data-agent-row="node" data-agent-state="present">
          <button type="button">Node details</button>
        </div>
      </>
    );
    show([claude, signedOut(codex)], rows);
    const review = line("review");
    expect(review?.getAttribute("data-model-line")).toBe("no-reviewer");
    expect(review?.textContent).toContain(
      "No reviewer yet. A review needs a model from a second family, such as Codex or Muse Code.",
    );
    expect(marks("review")).toEqual(["openai", "meta"]);
    expect(review?.textContent).not.toMatch(/Claude/);
    act(() => button("Add one")?.click());
    expect(document.activeElement?.textContent).toBe("Turn on Muse Code");
  });

  it("Change opens the Models editor for this machine only, without Sources", async () => {
    show([claude, codex]);
    expect(host.querySelector("[data-editor]")).toBeNull();
    expect(mocks.editor).not.toHaveBeenCalled();
    await act(async () => {
      button("Change")?.click();
      await vi.dynamicImportSettled();
    });
    await vi.waitFor(() => expect(host.querySelector("[data-editor]")).not.toBeNull());
    expect(mocks.editor).toHaveBeenLastCalledWith({ sources: false });
    expect(mocks.scope).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: { machine: environmentId }, singleEnvironment: true }),
    );
  });

  it("adds no step control: nothing in it is a neutral wizard action", () => {
    show([claude, codex]);
    expect(host.querySelector("[data-wizard-neutral]")).toBeNull();
    expect([...host.querySelectorAll("button")].map((node) => node.textContent)).toEqual([
      "Change",
    ]);
  });
});
