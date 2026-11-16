import { DEFAULT_ADVISOR_SETTINGS, type ThreadAdvisorMode } from "@specweave-studio/contracts";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  shell: null as null | {
    projectId: string;
    source: { advisorMode?: "on" | "off" | null; purpose?: "advisor" };
  },
  capability: true as boolean | undefined,
  enabled: false,
  sent: [] as Array<unknown>,
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
vi.mock("../../state/entities", () => ({ useThreadShell: () => state.shell }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: {
      environment: {
        capabilities: state.capability === undefined ? {} : { advisor: state.capability },
      },
      settings: { advisor: { ...DEFAULT_ADVISOR_SETTINGS, enabled: state.enabled } },
    },
  }),
}));
vi.mock("@specweave-studio/shared/projectSettings", () => ({
  resolveProjectSettings: (settings: unknown) => ({ settings }),
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { setAdvisorMode: "command" } }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => async (value: unknown) => {
    state.sent.push(value);
    return { _tag: "Success" };
  },
}));

import {
  ThreadAdvisorMenu,
  threadAdvisorMenuState,
  threadAdvisorMenuVisible,
  threadAdvisorModeForChoice,
} from "./ThreadAdvisorMenu";

const threadRef = { environmentId: "env-1", threadId: "thread-1" } as never;

function render() {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<ThreadAdvisorMenu threadRef={threadRef} separated />);
  });
  return renderer;
}

function choices(renderer: ReturnType<typeof create>) {
  return renderer.root.findAll((node) => node.type === "button" && node.props["data-choice"]);
}

function text(node: ReturnType<ReturnType<typeof create>["root"]["findByType"]>): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}

beforeEach(() => {
  state.shell = { projectId: "project-1", source: {} };
  state.capability = true;
  state.enabled = false;
  state.sent = [];
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
