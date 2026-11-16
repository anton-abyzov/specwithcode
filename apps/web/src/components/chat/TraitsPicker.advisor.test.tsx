// @vitest-environment jsdom

/**
 * The Advisor row inside the composer's options menu: it loads lazily, joins
 * a model's own options, and keeps the menu reachable on a model with none.
 */
import {
  DEFAULT_ADVISOR_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@specweave-studio/contracts";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  shell: null as null | { projectId: string; source: { purpose?: "advisor" } },
  capability: true,
}));

vi.mock("../ui/menu", () => {
  const Pass = (props: { children?: ReactNode }) => <div>{props.children}</div>;
  return {
    Menu: Pass,
    MenuGroup: Pass,
    MenuGroupLabel: Pass,
    MenuItem: Pass,
    MenuCheckboxItem: Pass,
    MenuSeparator: () => <hr />,
    MenuPopup: (props: { children?: ReactNode }) => <div data-menu-popup="">{props.children}</div>,
    MenuRadioGroup: Pass,
    MenuRadioItem: (props: { value: string; children?: ReactNode }) => (
      <button type="button" data-choice={props.value}>
        {props.children}
      </button>
    ),
    MenuTrigger: (props: { render?: ReactElement; children?: ReactNode }) => (
      <div data-menu-trigger="">
        {props.render}
        {props.children}
      </div>
    ),
  };
});
vi.mock("../ui/tooltip", () => {
  const Pass = (props: { children?: ReactNode }) => <>{props.children}</>;
  return {
    Tooltip: Pass,
    TooltipPopup: Pass,
    TooltipTrigger: (props: { render?: ReactElement; children?: ReactNode }) => (
      <>
        {props.render}
        {props.children}
      </>
    ),
  };
});
vi.mock("../../state/entities", () => ({ useThreadShell: () => state.shell }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: {
      environment: { capabilities: { advisor: state.capability } },
      settings: { advisor: { ...DEFAULT_ADVISOR_SETTINGS, enabled: true } },
    },
  }),
}));
vi.mock("@specweave-studio/shared/projectSettings", () => ({
  resolveProjectSettings: (settings: unknown) => ({ settings }),
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { setAdvisorMode: "command" } }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => async () => ({ _tag: "Success" }),
}));

// The draft store first: loading lib/utils first meets an import cycle.
import "../../composerDraftStore";
import { TraitsMenuContent, TraitsPicker } from "./TraitsPicker";
import { renderProviderTraitsPicker } from "./composerProviderState";

const CODEX = ProviderDriverKind.make("codex");
const INSTANCE = ProviderInstanceId.make("codex");
const threadRef = { environmentId: "env-1", threadId: "thread-1" } as never;

const PLAIN_MODEL: ServerProviderModel = {
  slug: "plain-model",
  name: "Plain model",
  isCustom: false,
  capabilities: null,
} as never;
const EFFORT_MODEL: ServerProviderModel = {
  slug: "effort-model",
  name: "Effort model",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ],
  },
} as never;

const base = {
  provider: CODEX,
  instanceId: INSTANCE,
  prompt: "",
  onPromptChange: () => {},
  planModeEnabled: false,
};

/** Renders, then lets the lazy Advisor row load. */
async function mount(element: ReactElement): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  await act(async () => {
    await import("./ThreadAdvisorMenu");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return renderer;
}

const advisorChoices = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAll((node) => node.type === "button" && node.props["data-choice"] !== undefined)
    .map((node) => node.props["data-choice"] as string);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.shell = { projectId: "project-1", source: {} };
  state.capability = true;
});

describe("the Advisor row in the options menu", () => {
  it("loads after the model's own options", async () => {
    const renderer = await mount(
      <TraitsMenuContent
        {...base}
        models={[EFFORT_MODEL]}
        model="effort-model"
        threadRef={threadRef}
      />,
    );
    expect(advisorChoices(renderer)).toEqual(["low", "high", "follow", "on", "off"]);
    expect(JSON.stringify(renderer.toJSON())).toContain("Follow project (on)");
  });

  it("follows the saved options of a model the provider no longer lists", async () => {
    const renderer = await mount(
      <TraitsMenuContent
        {...base}
        models={[EFFORT_MODEL]}
        model="retired-model"
        modelOptions={[{ id: "reasoningEffort", value: "high" }]}
        threadRef={threadRef}
      />,
    );
    expect(advisorChoices(renderer)).toEqual(["follow", "on", "off"]);
  });

  it("opens a menu with the Advisor group alone on a model with no options", async () => {
    const renderer = await mount(
      <TraitsPicker
        {...base}
        models={[PLAIN_MODEL]}
        model="plain-model"
        threadRef={threadRef}
        advisorRowAvailable
      />,
    );
    expect(
      renderer.root.findAll((node) => node.props["data-composer-advisor-only-trigger"] === ""),
    ).not.toHaveLength(0);
    expect(advisorChoices(renderer)).toEqual(["follow", "on", "off"]);
  });

  it("renders nothing on a model with no options when the row cannot show", async () => {
    const renderer = await mount(
      <TraitsPicker {...base} models={[PLAIN_MODEL]} model="plain-model" threadRef={threadRef} />,
    );
    expect(renderer.toJSON()).toBeNull();
  });
});

describe("renderProviderTraitsPicker", () => {
  const input = {
    ...base,
    models: [PLAIN_MODEL],
    model: "plain-model",
    modelOptions: undefined,
  };

  it("keeps the picker for a saved thread that can show the Advisor row", () => {
    expect(
      renderProviderTraitsPicker({ ...input, threadRef, advisorRowAvailable: true }),
    ).not.toBeNull();
  });

  it("drops it for a draft, or when the row cannot show", () => {
    expect(renderProviderTraitsPicker({ ...input, threadRef })).toBeNull();
    expect(
      renderProviderTraitsPicker({
        ...input,
        draftId: "draft-1" as never,
        advisorRowAvailable: true,
      }),
    ).toBeNull();
  });
});
