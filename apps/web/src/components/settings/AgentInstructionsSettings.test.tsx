import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  LEGACY_DEFAULT_AGENT_INSTRUCTIONS,
  ProjectId,
} from "@specweave-studio/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ScopedSettingsPatch } from "./scopedSettings";
import {
  agentInstructionPreviews,
  instructionValuesAreMixed,
  previewAgentInstructions,
} from "./agentInstructionsSettings.logic";

const state = vi.hoisted(() => ({
  project: true,
  globalRules: ["Use headless browsers.", "Save verification evidence."],
  projectRules: ["Run project tests.", "Run project tests."],
  canWrite: true,
  workflowMode: "on-request" as "disabled" | "on-request" | "automatic",
  ultracodeDefault: "threads" as "off" | "threads" | "all",
  /** Per-target workflow modes; null gives every target `workflowMode`. */
  targetModes: null as ReadonlyArray<"disabled" | "on-request" | "automatic"> | null,
  responseStyle: "concise" as "concise" | "detailed",
  mixedWorkflow: false,
  update: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

function environments() {
  return state.globalRules.map((global, index) => ({
    environmentId: EnvironmentId.make(`env-${index}`),
    label: `Machine ${index + 1}`,
    serverConfig: {
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        agentInstructions: global,
        projectSettingsOverrides: { "project-1": { agentInstructions: state.projectRules[index] } },
      },
    },
  }));
}

function targets() {
  return environments().map((environment, index) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    projectId: state.project ? ProjectId.make("project-1") : null,
    settings: {
      ...DEFAULT_UNIFIED_SETTINGS,
      claudeWorkflowMode: state.targetModes?.[index] ?? state.workflowMode,
      claudeUltracodeDefault: state.ultracodeDefault,
    },
  }));
}

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ targets: targets(), connectedEnvironments: environments() }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    claudeWorkflowMode: state.targetModes?.[0] ?? state.workflowMode,
    claudeUltracodeDefault: state.ultracodeDefault,
    responseStyle: state.responseStyle,
  }),
  useScopedSettingsMixed: () => state.mixedWorkflow,
  useScopedSettingsWriteAllowed: () => state.canWrite,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("./settingsSearch", () => ({ searchableSetting: (id: string) => ({ id, title: id }) }));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({
    children,
    control,
    resetAction,
  }: {
    children: ReactNode;
    control: ReactNode;
    resetAction: ReactNode;
  }) => (
    <div>
      {control}
      {resetAction}
      {children}
    </div>
  ),
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button onClick={onClick}>Reset {label}</button>
  ),
}));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/toggle-group", () => ({
  ToggleGroup: ({
    children,
    onValueChange,
    value,
  }: {
    children: ReactNode;
    onValueChange: (value: string[]) => void;
    value: string[];
  }) => (
    <fieldset data-value={value.join(",")}>
      {Array.isArray(children)
        ? children.map((child: { key: string; props: { value: string; children: ReactNode } }) => (
            <button
              key={child.key}
              data-option={child.props.value}
              onClick={() => onValueChange([child.props.value])}
            >
              {child.props.children}
            </button>
          ))
        : null}
    </fieldset>
  ),
  Toggle: () => null,
}));
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    value,
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
    value: string;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectPopup: ({ children }: { children: ReactNode }) => children,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

import { AgentInstructionsSettings } from "./AgentInstructionsSettings";

let renderer: ReactTestRenderer | null = null;
function render() {
  act(() => {
    renderer = create(<AgentInstructionsSettings />);
  });
}
function editor() {
  return renderer!.root.findByType("textarea");
}
function edit(value: string) {
  act(() => editor().props.onChange({ target: { value } }));
}
function blur() {
  act(() => editor().props.onBlur());
}
/** Both pickers render as selects; tell them apart by the options they offer. */
function picker(option: string) {
  return renderer!.root
    .findAllByType("select")
    .find((select) => select.findAllByType("option").some((item) => item.props.value === option))!;
}
function segmented() {
  return renderer!.root.findByType("fieldset");
}
function choose(option: string) {
  act(() =>
    segmented()
      .findAllByType("button")
      .find((button) => button.props["data-option"] === option)!
      .props.onClick(),
  );
}
function resetButton(label: string) {
  return renderer!.root
    .findAllByType("button")
    .find((button) => button.children.join("").includes(`Reset ${label}`))!;
}
function previews() {
  return renderer!.root.findAllByType("pre").map((item) => item.children.join(""));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.project = true;
  state.globalRules = ["Use headless browsers.", "Save verification evidence."];
  state.projectRules = ["Run project tests.", "Run project tests."];
  state.canWrite = true;
  state.workflowMode = "on-request";
  state.ultracodeDefault = "threads";
  state.targetModes = null;
  state.responseStyle = "concise";
  state.mixedWorkflow = false;
  state.update.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("agent instruction settings", () => {
  it("edits only project additions while showing each environment's global rules", () => {
    render();
    expect(editor().props.value).toBe("Run project tests.");
    expect(previews()[0]).toContain("Use headless browsers.");
    expect(previews()[1]).toContain("Save verification evidence.");
    edit("New project rule.");
    blur();
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      agentInstructions: "New project rule.",
    });
    expect(previews()[0]).toContain("Use headless browsers.");
    expect(previews()[0]).toContain("New project rule.");
    expect(previews()[1]).toContain("Save verification evidence.");
  });

  it("does not clear mixed project additions when the empty editor is untouched", () => {
    state.projectRules = ["First project rule.", "Second project rule."];
    render();
    expect(editor().props.value).toBe("");
    blur();
    expect(state.update).not.toHaveBeenCalled();
    expect(previews()[0]).toContain("First project rule.");
    expect(previews()[1]).toContain("Second project rule.");
  });

  it("shows an empty project addition when global instructions are inherited", () => {
    state.projectRules = ["", ""];
    render();
    expect(editor().props.value).toBe("");
    expect(previews()[0]).toContain("Use headless browsers.");
    edit("A project addition.");
    blur();
    expect(state.update).toHaveBeenCalledWith({ agentInstructions: "A project addition." });
  });

  it("disables instruction editing without settings write permission", () => {
    state.canWrite = false;
    render();
    expect(editor().props.disabled).toBe(true);
    edit("Unwritable rule.");
    blur();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("offers Disabled and On request, and sets the mode without touching instructions", () => {
    render();
    const options = picker("disabled")
      .findAllByType("option")
      .map((item) => item.props.value);
    expect(options).toEqual(["disabled", "on-request"]);
    act(() => picker("disabled").props.onChange({ target: { value: "disabled" } }));
    expect(state.update).toHaveBeenCalledExactlyOnceWith({ claudeWorkflowMode: "disabled" });
  });

  it("reads a stored Automatic mode as On request plus All chats", () => {
    state.workflowMode = "automatic";
    render();
    expect(picker("disabled").props.value).toBe("on-request");
    expect(segmented().props["data-value"]).toBe("all");
  });

  it("writes both keys when the default changes on an Automatic machine", () => {
    state.workflowMode = "automatic";
    render();
    choose("threads");
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      claudeWorkflowMode: "on-request",
      claudeUltracodeDefault: "threads",
    });
  });

  it("keeps All chats when an Automatic machine turns workflows off", () => {
    state.workflowMode = "automatic";
    render();
    act(() => picker("disabled").props.onChange({ target: { value: "disabled" } }));
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      claudeWorkflowMode: "disabled",
      claudeUltracodeDefault: "all",
    });
  });

  it("writes only the default when Off is picked", () => {
    render();
    expect(segmented().props["data-value"]).toBe("threads");
    choose("off");
    expect(state.update).toHaveBeenCalledExactlyOnceWith({ claudeUltracodeDefault: "off" });
  });

  it("resets the default to Threads once another value is saved", () => {
    state.ultracodeDefault = "off";
    render();
    act(() => resetButton("Ultracode by default").props.onClick());
    expect(state.update).toHaveBeenCalledExactlyOnceWith({ claudeUltracodeDefault: "threads" });
  });

  it("shows no reset while the default is Threads", () => {
    render();
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.children.join("").includes("Ultracode by default")),
    ).toBe(false);
  });

  it("does not count a stored Automatic beside On request plus All chats as mixed", () => {
    state.targetModes = ["automatic", "on-request"];
    state.ultracodeDefault = "all";
    render();
    expect(picker("disabled").props.value).toBe("on-request");
    expect(segmented().props["data-value"]).toBe("all");
    // Writing the mode is a no-op for the On request target, so both keys go together.
    choose("off");
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      claudeWorkflowMode: "on-request",
      claudeUltracodeDefault: "off",
    });
  });

  it("never turns workflows on for a Disabled target when the default changes", () => {
    state.targetModes = ["automatic", "disabled"];
    render();
    expect(picker("disabled").props.value).toBeNull();
    choose("off");
    expect(state.update).toHaveBeenCalledExactlyOnceWith({ claudeUltracodeDefault: "off" });
  });

  it("defaults the response style to concise and switches it to detailed", () => {
    render();
    expect(picker("detailed").props.value).toBe("concise");
    expect(renderer!.root.findAllByProps({ children: "Reset response style" })).toHaveLength(0);
    act(() => picker("detailed").props.onChange({ target: { value: "detailed" } }));
    expect(state.update).toHaveBeenCalledExactlyOnceWith({ responseStyle: "detailed" });
  });

  it("offers a reset back to concise once detailed is saved", () => {
    state.responseStyle = "detailed";
    render();
    expect(picker("detailed").props.value).toBe("detailed");
    act(() =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.join("").includes("response style"))!
        .props.onClick(),
    );
    expect(state.update).toHaveBeenCalledExactlyOnceWith({ responseStyle: "concise" });
  });

  it("shows each global layer at environment scope without project additions", () => {
    state.project = false;
    render();
    expect(editor().props["aria-label"]).toBe("Global instructions");
    expect(previews()[0]).toContain("Use headless browsers.");
    expect(previews()[0]).not.toContain("Run project tests.");
    edit("New shared rule.");
    expect(previews().every((text) => text.includes("New shared rule."))).toBe(true);
  });

  it("reads raw layers rather than copying the effective global value into a project override", () => {
    const rows = agentInstructionPreviews(targets(), environments());
    expect(instructionValuesAreMixed(rows)).toBe(false);
    expect(previewAgentInstructions(rows[0]!)).toContain("Run project tests.");
    expect(rows[0]!.editableInstructions).not.toContain("Use headless browsers.");
  });

  it("shows a saved copy of the retired default as empty global instructions", () => {
    state.globalRules = [LEGACY_DEFAULT_AGENT_INSTRUCTIONS];
    state.projectRules = [""];
    const [row] = agentInstructionPreviews(
      targets().map((target) => ({ ...target, projectId: null })),
      environments(),
    );
    expect(row!.editableInstructions).toBe("");
    expect(previewAgentInstructions(row!)).toBe("");
  });
});
