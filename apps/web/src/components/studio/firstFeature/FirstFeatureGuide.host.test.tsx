// @vitest-environment jsdom
// The guide's host: what it stores, writes and removes (1398 AC-21, AC-24, AC-25).
import type { ProjectBoardCard } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canWrite: true,
  config: { settings: {}, providers: [] } as unknown,
  cards: [] as unknown[],
  reads: 0,
  commands: {} as Record<string, ReturnType<typeof vi.fn>>,
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => {
    state.reads += 1;
    return state.config;
  },
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config", updateSettings: "updateSettings" },
}));
vi.mock("../../../state/session", () => ({ useEnvironmentScope: () => state.canWrite }));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => state.commands[command],
}));
vi.mock("../../../state/projects", () => ({ projectEnvironment: { delete: "delete" } }));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { cards: state.cards }, refresh: () => {} }),
}));
vi.mock("../../../studio/projectWorkspace", () => ({
  projectWorkspace: { board: () => "board", firstFeatureGuide: "mark" },
}));
vi.mock("../../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: vi.fn() },
}));

const { FirstFeatureGuide } = await import("./FirstFeatureGuide");
const { FIRST_FEATURE_REQUEST, FIRST_FEATURE_REQUEST_NO_REVIEW } =
  await import("./firstFeature.logic");
const { DEFAULT_SERVER_SETTINGS, ProviderDriverKind, ProviderInstanceId } =
  await import("@specweave-studio/contracts");
type Props = Parameters<typeof FirstFeatureGuide>[0];

const doneCard: ProjectBoardCard = {
  incrementId: "0001-dark-mode-switch",
  title: "Dark mode switch",
  status: "done",
  column: "done",
  tasks: { total: 4, done: 4 },
  blocked: false,
  updatedAt: null,
  pullRequests: [],
  specPath: null,
};
const sample = (ended?: string) =>
  ({
    environmentId: "env-1",
    id: "project-1",
    title: "First feature",
    workspaceSettings: {
      sample: "first-feature",
      firstFeatureGuide: { started: "2026-11-18T10:00:00.000Z", ...(ended ? { ended } : {}) },
    },
  }) as unknown as Props["project"];

describe("FirstFeatureGuide host", () => {
  let root: Root;
  let container: HTMLDivElement;
  const ok = () => vi.fn(async () => ({ _tag: "Success", value: {} }));

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    state.canWrite = true;
    state.config = { settings: {}, providers: [] };
    state.cards = [];
    state.reads = 0;
    state.navigate.mockClear();
    state.commands = { mark: ok(), updateSettings: ok(), delete: ok() };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function show(
    project: Props["project"],
    extra: { author?: Props["author"]; onAsk?: Props["onAsk"] } = {},
  ) {
    await act(async () =>
      root.render(
        <FirstFeatureGuide
          project={project}
          specweave="on"
          specweaveWaiting={false}
          askWaiting={false}
          author={extra.author ?? null}
          canOperate
          onShowBoard={() => {}}
          onOpenIncrement={() => {}}
          onAsk={extra.onAsk ?? (() => {})}
          onOpenThread={() => {}}
        />,
      ),
    );
  }
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name);
  const openedHere = () =>
    localStorage.setItem(
      "swc:first-feature:env-1:project-1",
      JSON.stringify({ skipped: [], seenInReview: true, openedReview: true, closed: false }),
    );

  it("reads nothing and draws nothing outside the sample", async () => {
    await show({ ...sample(), workspaceSettings: {} } as unknown as Props["project"]);
    expect(container.innerHTML).toBe("");
    expect(state.reads).toBe(0);
  });

  it("stores finished once when the end is reached, and remembers it here", async () => {
    state.cards = [doneCard];
    openedHere();
    await show(sample());
    await show(sample());
    expect(state.commands.mark).toHaveBeenCalledTimes(1);
    expect(state.commands.mark).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { projectId: "project-1", mark: "finished" },
    });
    expect(localStorage.getItem("swc:first-feature-finished:env-1")).toBe("true");
  });

  it("marks the guide left on the server when it is left before the end", async () => {
    await show(sample());
    await act(async () => button("Leave the guide")!.click());
    expect(state.commands.mark).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { projectId: "project-1", mark: "left" },
    });
  });

  it("turns on review for the machine only when pressed, and says why it cannot", async () => {
    state.cards = [doneCard];
    openedHere();
    await show(sample("finished"));
    expect(state.commands.updateSettings).not.toHaveBeenCalled();
    await act(async () => button("Review finished features in all projects on this Mac")!.click());
    expect(state.commands.updateSettings).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { patch: { adversarialReview: { autoOnFeatureComplete: true } } },
    });
    expect(container.textContent).toContain("On for all projects on this Mac.");

    await act(async () => root.unmount());
    root = createRoot(container);
    state.canWrite = false;
    await show(sample("finished"));
    expect(button("Review finished features in all projects on this Mac")!.disabled).toBe(true);
    expect(container.textContent).toContain(
      "This connection cannot change the settings of this Mac.",
    );
  });

  it("removes the finished sample after a confirm, keeping its folder, and goes home", async () => {
    state.cards = [doneCard];
    openedHere();
    await show(sample("finished"));
    await act(async () => button("Remove the sample project")!.click());
    expect(state.commands.delete).not.toHaveBeenCalled();
    await act(async () => button("Remove")!.click());
    expect(state.commands.delete).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { projectId: "project-1", force: true, confirmationTitle: "First feature" },
    });
    expect(state.navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("writes the request only once it knows whether a review can run, and only once", async () => {
    const onAsk = vi.fn();
    await show(sample(), { onAsk });
    // No builder known yet: which request to write cannot be told.
    expect(button("Write it for me")!.disabled).toBe(true);
    const ready = (id: string, slug: string) => ({
      instanceId: ProviderInstanceId.make(id),
      driver: ProviderDriverKind.make(id),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-18T12:00:00.000Z",
      version: null,
      models: [{ slug, name: slug, isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    });
    state.config = {
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [ready("claudeAgent", "claude-opus-5-5"), ready("codex", "gpt-6.1-sol")],
    };
    const author = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
    await show(sample(), { onAsk, author });
    await act(async () => button("Write it for me")!.click());
    expect(onAsk).toHaveBeenCalledWith(FIRST_FEATURE_REQUEST);
    expect(button("Write it for me")).toBeUndefined();
    expect(button("Open the thread")).toBeDefined();
  });

  it("offers the request again when the right one changes after it was written", async () => {
    const onAsk = vi.fn();
    const ready = (id: string, slug: string) => ({
      instanceId: ProviderInstanceId.make(id),
      driver: ProviderDriverKind.make(id),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-18T12:00:00.000Z",
      version: null,
      models: [{ slug, name: slug, isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    });
    const author = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
    state.config = {
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [ready("claudeAgent", "claude-opus-5-5"), ready("codex", "gpt-6.1-sol")],
    };
    await show(sample(), { onAsk, author });
    await act(async () => button("Write it for me")!.click());
    expect(onAsk).toHaveBeenLastCalledWith(FIRST_FEATURE_REQUEST);
    // The second family signs out before Send: the sentence still describes what was written.
    state.config = {
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [ready("claudeAgent", "claude-opus-5-5")],
    };
    await show(sample(), { onAsk, author });
    expect(container.textContent).toContain("plan it, build it, review it and close it.");
    await act(async () => button("Write it for me")!.click());
    expect(onAsk).toHaveBeenLastCalledWith(FIRST_FEATURE_REQUEST_NO_REVIEW);
    expect(container.textContent).toContain("plan it, build it and close it.");
    expect(button("Write it for me")).toBeUndefined();
  });

  it("tries a failed finished mark again", async () => {
    vi.useFakeTimers();
    try {
      state.cards = [doneCard];
      openedHere();
      state.commands.mark = vi
        .fn()
        .mockResolvedValueOnce({ _tag: "Failure", cause: {} })
        .mockResolvedValue({ _tag: "Success", value: {} });
      await show(sample());
      expect(container.textContent).toContain("The guide could not be updated. Try again.");
      expect(localStorage.getItem("swc:first-feature-finished:env-1")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(state.commands.mark).toHaveBeenCalledTimes(2);
      expect(localStorage.getItem("swc:first-feature-finished:env-1")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });
});
