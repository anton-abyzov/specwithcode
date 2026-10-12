import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId, ProjectId } from "@specweave-studio/contracts";
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
  return environments().map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    projectId: state.project ? ProjectId.make("project-1") : null,
  }));
}

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ targets: targets(), connectedEnvironments: environments() }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    claudeWorkflowMode: state.workflowMode,
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

  it("sets workflow mode without changing reasoning effort or instructions", () => {
    render();
    act(() => picker("automatic").props.onChange({ target: { value: "automatic" } }));
    expect(state.update).toHaveBeenCalledExactlyOnceWith({ claudeWorkflowMode: "automatic" });
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
});
