import type { EnvironmentId, StudioProjectFileScript, ThreadId } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { PopoverCreateHandle } from "../ui/popover";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useStudioProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
  gitActions: vi.fn(),
}));
vi.mock("../GitActionsControl", () => ({
  default: (props: unknown) => {
    testState.gitActions(props);
    return null;
  },
}));
vi.mock("./TurnChatIntoProject", () => ({
  TurnChatIntoProject: (props: { folder: string }) => (
    <button type="button" data-folder={props.folder}>
      Turn into project
    </button>
  ),
}));

vi.mock("../../hooks/useStudioProjectFileScripts", () => ({
  useStudioProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useStudioProjectFileScripts(...args),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: () => null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => null,
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => null,
}));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({ children }: { children: (density: "full") => React.ReactNode }) =>
    children("full"),
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useStudioProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
    testState.gitActions.mockReset();
  });

  it("passes checked-in specweave-studio.json scripts to the project scripts control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/tmp/thread-details-project";
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<StudioProjectFileScript>;
    testState.useStudioProjectFileScripts.mockReturnValue(fileScripts);

    const props: ThreadDetailsPanelProps = {
      anchor: { current: null },
      handle: PopoverCreateHandle(),
      onPresentationChange: vi.fn(),
      environmentId,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: undefined,
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd,
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      envMode: "local",
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
      onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
      onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    };

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.useStudioProjectFileScripts).toHaveBeenCalledWith(environmentId, gitCwd);
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
  });

  it("offers Turn into project instead of the shared folder's scripts and Git in a chat", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/data/scratch/2026-10-17-plan-a-trip-a1b2c3d4";
    testState.useStudioProjectFileScripts.mockReturnValue([]);
    const props: ThreadDetailsPanelProps = {
      anchor: { current: null },
      handle: PopoverCreateHandle(),
      onPresentationChange: vi.fn(),
      environmentId,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: "Scratch",
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd,
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      envMode: "local",
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
      onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
      onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    };

    const sent = renderToStaticMarkup(
      <ThreadDetailsPanel {...props} chatFolder={{ path: gitCwd, chatTitle: "Plan a trip" }} />,
    );
    expect(sent).toContain(`data-folder="${gitCwd}"`);
    expect(testState.projectScriptsControl).not.toHaveBeenCalled();
    expect(testState.gitActions).not.toHaveBeenCalled();

    const draft = renderToStaticMarkup(
      <ThreadDetailsPanel {...props} chatFolder={{ path: null, chatTitle: null }} />,
    );
    expect(draft).not.toContain("Turn into project");
    expect(testState.gitActions).not.toHaveBeenCalled();
  });
});
