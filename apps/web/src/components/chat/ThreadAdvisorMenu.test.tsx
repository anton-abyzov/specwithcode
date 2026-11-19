import {
  DEFAULT_ADVERSARIAL_REVIEW_SETTINGS,
  DEFAULT_ADVISOR_SETTINGS,
  type ThreadAdvisorMode,
} from "@specweave-studio/contracts";
import type { ReactElement, ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  shell: null as null | {
    projectId: string;
    title?: string;
    modelSelection?: { instanceId: string; model: string };
    source: {
      advisorMode?: "on" | "off" | null;
      reviewMode?: "on" | "off" | null;
      purpose?: "advisor";
    };
  },
  capability: true as boolean | undefined,
  reviewCapability: false,
  enabled: false,
  reviewEnabled: false,
  sent: [] as Array<unknown>,
  items: [] as Array<unknown>,
  preview: { advisor: null, sameModel: false, pastLimit: null } as {
    advisor: { instanceId: string; model: string } | null;
    sameModel: boolean;
    pastLimit: { instanceId: string; model: string } | null;
  },
}));

vi.mock("@specweave-studio/shared/advisor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@specweave-studio/shared/advisor")>()),
  threadAdvisorPreview: () => state.preview,
}));

vi.mock("../ui/menu", async () => {
  const { createContext, use } = await import("react");
  const Radio = createContext<{ value: string; onValueChange: (value: string) => void } | null>(
    null,
  );
  return {
    MenuGroup: (props: { children: ReactNode }) => <div>{props.children}</div>,
    MenuSeparator: () => <hr />,
    MenuRadioGroup: (props: {
      value: string;
      onValueChange: (value: string) => void;
      children: ReactNode;
    }) => <Radio value={props}>{props.children}</Radio>,
    MenuRadioItem: function Item(props: { value: string; children: ReactNode }) {
      const radio = use(Radio);
      return (
        <button
          type="button"
          data-choice={props.value}
          data-checked={radio?.value === props.value}
          onClick={() => radio?.onValueChange(props.value)}
        >
          {props.children}
        </button>
      );
    },
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { render?: ReactElement }) => <>{props.render}</>,
  TooltipPopup: (props: { children?: ReactNode }) => <span data-note="">{props.children}</span>,
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () =>
    state.shell === null
      ? null
      : {
          title: "Sign in with passkeys",
          modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-2" },
          ...state.shell,
        },
  useThreadVisibleTurnItems: () => state.items,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: {
      providers: [
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          models: [
            { slug: "claude-fable-5-2", name: "Fable 5.2" },
            { slug: "claude-opus-5-5", name: "Opus 5.5" },
          ],
        },
        { instanceId: "codex", driver: "codex", models: [{ slug: "gpt-6-astra", name: "GPT-6 Astra" }] },
      ],
      environment: {
        capabilities: {
          ...(state.capability === undefined ? {} : { advisor: state.capability }),
          threadReviewMode: state.reviewCapability,
        },
      },
      settings: {
        advisor: { ...DEFAULT_ADVISOR_SETTINGS, enabled: state.enabled },
        adversarialReview: {
          ...DEFAULT_ADVERSARIAL_REVIEW_SETTINGS,
          autoOnFeatureComplete: state.reviewEnabled,
        },
      },
    },
  }),
}));
vi.mock("@specweave-studio/shared/projectSettings", () => ({
  resolveProjectSettings: (settings: unknown) => ({ settings }),
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { setAdvisorMode: "advisor", setReviewMode: "review" },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: string) => async (value: unknown) => {
    state.sent.push(command === "advisor" ? value : { review: value });
    return { _tag: "Success" };
  },
}));

import {
  ThreadAdvisorMenu,
  threadAdvisorMenuState,
  threadAdvisorMenuVisible,
  threadAdvisorModeForChoice,
  threadReviewMenuState,
  threadReviewMenuVisible,
} from "./ThreadAdvisorMenu";

const threadRef = { environmentId: "env-1", threadId: "thread-1" } as never;

function render() {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<ThreadAdvisorMenu threadRef={threadRef} separated />);
  });
  return renderer;
}

function choices(renderer: ReturnType<typeof create>, kind: "advisor" | "review" = "advisor") {
  const attribute = kind === "advisor" ? "data-thread-advisor-menu" : "data-thread-review-menu";
  const rows = renderer.root.findAll((node) => node.type === "div" && node.props[attribute]);
  return rows.flatMap((row) =>
    row.findAll((node) => node.type === "button" && node.props["data-choice"]),
  );
}

function text(node: ReturnType<ReturnType<typeof create>["root"]["findByType"]>): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}

beforeEach(() => {
  state.shell = { projectId: "project-1", source: {} };
  state.capability = true;
  state.reviewCapability = false;
  state.enabled = false;
  state.reviewEnabled = false;
  state.sent = [];
  state.items = [];
  state.preview = { advisor: null, sameModel: false, pastLimit: null };
});

const fable = { instanceId: "claudeAgent", model: "claude-fable-5-2" };
const astra = { instanceId: "codex", model: "gpt-6-astra" };
const builtInConsult = {
  sourceThreadId: "thread-1",
  sourceItemId: "item-1",
  item: {
    type: "dynamic_tool",
    toolName: "advisor",
    title: "Asked the advisor (claude-fable-5-2)",
    status: "completed",
    output: "Check the migration first.",
  },
};

function note(renderer: ReturnType<typeof create>) {
  const found = renderer.root.findAll(
    (node) => node.type === "div" && node.props["data-thread-advisor-note"] !== undefined,
  );
  return found.length === 0
    ? null
    : { kind: found[0]!.props["data-thread-advisor-note"], text: found[0]!.children.map((line) => text(line as never)) };
}

describe("the Advisor row's note", () => {
  it("names the advisor, says when it is the thread's own model, and who answers past the limit", () => {
    state.enabled = true;
    state.preview = { advisor: fable, sameModel: true, pastLimit: astra };
    expect(note(render())).toEqual({
      kind: "advisor",
      text: ["Advisor: Fable 5.2, same model as this thread", "Past 200,000 tokens: GPT-6 Astra"],
    });
  });

  it("names Fable alone for an Opus thread", () => {
    state.enabled = true;
    state.shell = {
      projectId: "project-1",
      source: {},
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    };
    state.preview = { advisor: fable, sameModel: false, pastLimit: null };
    expect(note(render())).toEqual({ kind: "advisor", text: ["Advisor: Fable 5.2"] });
  });

  it("says so when no model can advise", () => {
    state.enabled = true;
    expect(note(render())).toEqual({
      kind: "none",
      text: ["No model can advise this thread right now."],
    });
  });

  it("in pass-through, names the model Claude's own setting answered with", () => {
    state.items = [builtInConsult];
    expect(note(render())).toEqual({
      kind: "pass-through",
      text: ["Claude's own advisor setting answered here: Fable 5.2"],
    });
  });

  it("says nothing in pass-through before Claude's own advisor answered, or for Off", () => {
    expect(note(render())).toBeNull();
    state.items = [builtInConsult];
    state.shell = { projectId: "project-1", source: { advisorMode: "off" } };
    expect(note(render())).toBeNull();
  });
});

describe("threadAdvisorMenuState", () => {
  it.each<[ThreadAdvisorMode | null | undefined, boolean, string, boolean]>([
    [undefined, true, "follow", true],
    [null, false, "follow", false],
    ["on", false, "on", true],
    ["off", true, "off", false],
    ["on", true, "on", true],
    ["off", false, "off", false],
  ])("mode %s with the project %s", (mode, projectEnabled, choice, enabled) => {
    expect(threadAdvisorMenuState(mode, { enabled: projectEnabled })).toEqual({
      choice,
      enabled,
      projectEnabled,
    });
  });

  it("writes null to follow the project again", () => {
    expect(threadAdvisorModeForChoice("follow")).toBeNull();
    expect(threadAdvisorModeForChoice("on")).toBe("on");
    expect(threadAdvisorModeForChoice("off")).toBe("off");
  });

  it("shows only with the capability and never on an advisor thread", () => {
    expect(threadAdvisorMenuVisible({ capability: true, purpose: undefined })).toBe(true);
    expect(threadAdvisorMenuVisible({ capability: false, purpose: undefined })).toBe(false);
    expect(threadAdvisorMenuVisible({ capability: true, purpose: "advisor" })).toBe(false);
  });
});

describe("ThreadAdvisorMenu", () => {
  it("offers Follow project, On and Off with the project's value beside Follow", () => {
    state.enabled = true;
    const renderer = render();
    const buttons = choices(renderer);
    expect(buttons.map((button) => button.props["data-choice"])).toEqual(["follow", "on", "off"]);
    expect(buttons.map(text)).toEqual(["Follow project (on)", "On", "Off"]);
    expect(buttons[0]!.props["data-checked"]).toBe(true);
  });

  it.each<[ThreadAdvisorMode | null, boolean, string, string]>([
    [null, false, "follow", "Follow project (off)"],
    ["on", false, "on", "Follow project (off)"],
    ["off", true, "off", "Follow project (on)"],
  ])("marks the thread's choice %s (project on: %s)", (mode, enabled, checked, followLabel) => {
    state.enabled = enabled;
    state.shell = { projectId: "project-1", source: { advisorMode: mode } };
    const buttons = choices(render());
    expect(buttons.find((button) => button.props["data-checked"])?.props["data-choice"]).toBe(
      checked,
    );
    expect(text(buttons[0]!)).toBe(followLabel);
  });

  it.each<[string, ThreadAdvisorMode | null, ThreadAdvisorMode | null]>([
    ["on", null, "on"],
    ["off", "on", "off"],
    ["follow", "off", null],
  ])("choosing %s sends thread.advisor-mode.set", (choice, from, advisorMode) => {
    state.shell = { projectId: "project-1", source: { advisorMode: from } };
    const renderer = render();
    act(() => {
      choices(renderer)
        .find((button) => button.props["data-choice"] === choice)!
        .props.onClick();
    });
    expect(state.sent).toEqual([
      { environmentId: "env-1", input: { threadId: "thread-1", advisorMode } },
    ]);
  });

  it("sends nothing when the current choice is picked again", () => {
    const renderer = render();
    act(() => {
      choices(renderer)[0]!.props.onClick();
    });
    expect(state.sent).toEqual([]);
  });

  it("is hidden when the server does not advertise the advisor", () => {
    state.capability = undefined;
    expect(render().toJSON()).toBeNull();
    state.capability = false;
    expect(render().toJSON()).toBeNull();
  });

  it("is hidden for an advisor thread and for a draft", () => {
    state.shell = { projectId: "project-1", source: { purpose: "advisor" } };
    expect(render().toJSON()).toBeNull();
    state.shell = null;
    expect(render().toJSON()).toBeNull();
  });
});

describe("the Adversarial review row", () => {
  beforeEach(() => {
    state.reviewCapability = true;
  });

  it.each<[ThreadAdvisorMode | null | undefined, boolean, string, boolean]>([
    [undefined, true, "follow", true],
    [null, false, "follow", false],
    ["on", false, "on", true],
    ["off", true, "off", false],
  ])("reads mode %s with the project %s", (mode, projectEnabled, choice, enabled) => {
    expect(threadReviewMenuState(mode, { autoOnFeatureComplete: projectEnabled })).toEqual({
      choice,
      enabled,
      projectEnabled,
    });
  });

  it("shows with the capability, never on an advisor or a review thread", () => {
    const visible = (input: Partial<Parameters<typeof threadReviewMenuVisible>[0]>) =>
      threadReviewMenuVisible({ capability: true, purpose: undefined, title: "Fix", ...input });
    expect(visible({})).toBe(true);
    expect(visible({ capability: false })).toBe(false);
    expect(visible({ purpose: "advisor" })).toBe(false);
    expect(visible({ title: "Adversarial review: Fix" })).toBe(false);
  });

  it("comes after Advisor with its description and the project's value beside Follow", () => {
    state.reviewEnabled = true;
    const renderer = render();
    const rows = renderer.root.findAll(
      (node) =>
        node.type === "div" &&
        (node.props["data-thread-advisor-menu"] || node.props["data-thread-review-menu"]),
    );
    expect(
      rows.map((row) => (row.props["data-thread-review-menu"] ? "review" : "advisor")),
    ).toEqual(["advisor", "review"]);
    const review = rows[1]!;
    expect(text(review)).toContain("Adversarial review");
    expect(text(review)).toContain(
      "Has a model from another family review this thread's work when its feature is finished.",
    );
    expect(choices(renderer, "review").map(text)).toEqual(["Follow project (on)", "On", "Off"]);
  });

  it("gives each row an info button named after it, with its time note", () => {
    const renderer = render();
    const buttons = renderer.root.findAll(
      (node) => node.type === "button" && node.props["data-thread-choice-time-note"] !== undefined,
    );
    expect(buttons.map((button) => button.props["aria-label"])).toEqual([
      "How much longer work takes with Advisor",
      "How much longer work takes with Adversarial review",
    ]);
    const notes = renderer.root.findAll(
      (node) => node.type === "span" && node.props["data-note"] !== undefined,
    );
    expect(notes.map(text)).toEqual([
      expect.stringContaining("each consult adds about 2 minutes"),
      expect.stringContaining("a median 2.6 times as long"),
    ]);
  });

  it.each<[string, "on" | "off" | null, "on" | "off" | null]>([
    ["on", null, "on"],
    ["off", "on", "off"],
    ["follow", "off", null],
  ])("choosing %s sends thread.review-mode.set", (choice, from, reviewMode) => {
    state.shell = { projectId: "project-1", source: { reviewMode: from } };
    const renderer = render();
    act(() => {
      choices(renderer, "review")
        .find((button) => button.props["data-choice"] === choice)!
        .props.onClick();
    });
    expect(state.sent).toEqual([
      { review: { environmentId: "env-1", input: { threadId: "thread-1", reviewMode } } },
    ]);
  });

  it("is hidden on a review thread, which keeps its Advisor row", () => {
    state.shell = { projectId: "project-1", title: "Adversarial review: Fix", source: {} };
    const renderer = render();
    expect(choices(renderer, "advisor")).toHaveLength(3);
    expect(choices(renderer, "review")).toHaveLength(0);
  });

  it("shows alone on a server with review choices but no advisor", () => {
    state.capability = false;
    const renderer = render();
    expect(choices(renderer, "advisor")).toHaveLength(0);
    expect(choices(renderer, "review")).toHaveLength(3);
  });
});
