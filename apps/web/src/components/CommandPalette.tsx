"use client";

import { ProjectCreationAction } from "./studio/ProjectCreationAction";

import { findMachineAssistant, personalAssistantSetupStep } from "../studio/personalAssistant";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import { CloneProjectDestination } from "./studio/CloneProjectDestination";
import { threadPullRequestLinkMode } from "@specweave-studio/client-runtime/thread-pull-request-compatibility";
import { visibleThreadPullRequests } from "@specweave-studio/shared/threadPullRequests";

import { scopeProjectRef, scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  canCreateProjectInEnvironment,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  getNewProjectGitHubRepository,
  getNewProjectGitHubTarget,
  getNewProjectPathPreview,
  normalizePastedCloneUrl,
} from "@specweave-studio/client-runtime/operations/projects";
import { threadSearchMatchKey } from "@specweave-studio/client-runtime/state/thread-search";
import { resolveThreadReferenceCopyTarget } from "@specweave-studio/shared/threadReference";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@specweave-studio/client-runtime/state/filesystem";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
  type DesktopWslState,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type FilesystemBrowseResult,
  type ProjectId,
  type SourceControlDiscoveryResult,
  type SourceControlProviderKind,
  type SourceControlRepositoryInfo,
  DEFAULT_PERSONAL_ASSISTANT_NAME,
  PERSONAL_ASSISTANT_LABEL,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  resolveEnvironmentMachineKind,
} from "@specweave-studio/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import {
  ArrowRightLeftIcon,
  ActivityIcon,
  AppWindowIcon,
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  CheckIcon,
  ChevronRightIcon,
  CornerLeftUpIcon,
  FileSearchIcon,
  ConciergeBellIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  ListCollapseIcon,
  ListTodoIcon,
  MessageSquareDashedIcon,
  LinkIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  PuzzleIcon,
  RotateCcwIcon,
  SettingsIcon,
  SquarePenIcon,
  SunIcon,
  TextSearchIcon,
} from "lucide-react";
import { requestHandOffMachine } from "./handoff/HandOffMachineDialog";
import { useModsStore } from "../mods/modsStore";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useOpenPanelPullRequestUrl } from "../hooks/useOpenPanelPullRequestUrl";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { useClientSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { useCustomThemes } from "../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
import { BUILT_IN_THEMES } from "@specweave-studio/shared/themePalettes";
import { getThemeDefinition } from "../themePalette";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  ThemePreviewCircle,
} from "./settings/ThemePreviewCircles";
import { readLocalApi } from "../localApi";
import { desktopLocalBackendId, isThisMachineTarget } from "../connection/desktopLocal";
import { environmentConnectionStatusText } from "../lib/machineStatus";
import { filesystemEnvironment, useFilesystemReadAccess } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useScratchProject } from "../hooks/useScratchProject";
import { useProjectFolderChoice } from "../hooks/useProjectFolderChoice";
import { useFindFolderCopies, useNewProject } from "../hooks/useNewProject";
import {
  FolderLinkSuggestion,
  type FolderLinkSuggestionRequest,
  type LinkTarget,
} from "./studio/FolderLinkSuggestion";
import { ProjectLinkDialog } from "./studio/ProjectLinkDialog";
import {
  defaultProjectMachine,
  newProjectDraft,
  resolveNewProjectName,
  suggestProjectMachine,
  type NewProjectKind,
} from "../studio/projectCreation";
import {
  projectCreationGroups,
  projectMachineGroup,
  ProjectCreationPreview,
} from "./studio/ProjectCreation";
import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { projectPickerMembers } from "../studio/projectListVisibility";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useServerConfigs, useThreadShells, waitForProject } from "../state/entities";
import { useThreadSearch } from "../state/queries";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseDirectoryPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../lib/projectPaths";
import { onOpenCommandPalette } from "../commandPaletteBus";
import {
  setTimelineDetail,
  TIMELINE_DETAIL_DESCRIPTIONS,
  TIMELINE_DETAIL_LABELS,
  TIMELINE_DETAIL_LEVELS,
  useTimelineDetailShortcut,
} from "../timelineDetail";
import { isPreviewFocused } from "../lib/previewFocus";
import { canOpenProjectWindowFor, openProjectWindow } from "../lib/projectWindow";
import { isTerminalFocused } from "../lib/terminalFocus";
import {
  PULL_REQUESTS_PANEL_REF,
  selectActiveRightPanel,
  useRightPanelStore,
} from "../rightPanelStore";
import { getLatestThreadForProject, sortThreads } from "../lib/threadSort";
import {
  cn,
  getLocalFileManagerName,
  isMacPlatform,
  isWindowsPlatform,
  newProjectId,
} from "../lib/utils";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";
import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
} from "../wslPaths";
import {
  ADDON_ICON_CLASS,
  browseInputEndPaddingClass,
  buildBrowseGroups,
  buildCommandPaletteProjectMetadata,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  buildLinkedThreadActionItems,
  buildCommandPaletteRows,
  enumerateCommandPaletteItems,
  findHighlightedCommandPaletteItem,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
  type CommandPaletteProject,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  filterPinnedBrowseEntries,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  collapseRestartedBrowsePath,
  reduceCommandPaletteUiState,
  type SearchOverlayMode,
} from "./CommandPalette.logic";
import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "./Sidebar.logic";
import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import {
  CommandPaletteResults,
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "./CommandPaletteResults";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon, ForgejoIcon } from "./Icons";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { openLinkPullRequestDialog } from "./pullRequest/LinkPullRequestDialog";
import { openLinkIncrementDialog } from "./chat/LinkIncrementDialog";
import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import { searchSettingsBySection, SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";
import {
  PROJECT_SETTINGS_TAB_LABELS,
  PROJECT_SETTINGS_TABS,
  searchProjectSettings,
} from "./studio/projectSettingsSearch.logic";
import { requestProjectSettings } from "../studio/projectSettingsRequests";
import {
  COMMAND_PALETTE_META_ICON_CLASS,
  CommandPaletteMetaDot,
  ThreadCommandSubtitle,
} from "./ThreadCommandSubtitle";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../state/server";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "../keybindings";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "./ui/command";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "../sidebarProjectGrouping";
import type { Project } from "../types";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "~/components/pullRequest/pullRequestListPreferences";

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];

function getEnvironmentBrowsePlatform(os: string | null | undefined): string {
  if (os === "windows") {
    return "Win32";
  }
  if (os === "darwin") {
    return "MacIntel";
  }
  if (os === "linux") {
    return "Linux";
  }
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

interface AddProjectEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  readonly isPrimary: boolean;
  readonly isConnected: boolean;
  readonly status: string;
}

type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "forgejo" | "bitbucket" | "azure-devops"
>;
type AddProjectRemoteSource = AddProjectRemoteProviderKind | "url";

type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

const REMOTE_PROJECT_SOURCES: ReadonlyArray<AddProjectRemoteSource> = [
  "url",
  "github",
  "gitlab",
  "forgejo",
  "bitbucket",
  "azure-devops",
];
const REMOTE_PROJECT_PROVIDER_SOURCES: ReadonlyArray<AddProjectRemoteProviderKind> = [
  "github",
  "gitlab",
  "forgejo",
  "bitbucket",
  "azure-devops",
];

function remoteProjectSourceLabel(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "forgejo":
      return "Forgejo / Gitea";
    case "gitlab":
      return "GitLab";
    case "bitbucket":
      return "Bitbucket";
    case "azure-devops":
      return "Azure DevOps";
    case "url":
      return "Git URL";
  }
}

function remoteProjectSourcePathHint(source: AddProjectRemoteSource): string {
  switch (source) {
    case "forgejo":
    case "github":
      return "owner/repo";
    case "gitlab":
      return "group/project";
    case "bitbucket":
      return "workspace/repository";
    case "azure-devops":
      return "project/repository";
    case "url":
      return "URL";
  }
}

function remoteProjectSourceProvider(
  source: AddProjectRemoteSource,
): AddProjectRemoteProviderKind | null {
  return source === "url" ? null : source;
}

function remoteProjectSourceIcon(source: AddProjectRemoteSource, className: string): ReactNode {
  switch (source) {
    case "github":
      return <GitHubIcon className={className} />;
    case "forgejo":
      return <ForgejoIcon className={className} />;
    case "gitlab":
      return <GitLabIcon className={className} />;
    case "bitbucket":
      return <BitbucketIcon className={className} />;
    case "azure-devops":
      return <AzureDevOpsIcon className={className} />;
    case "url":
      return <LinkIcon className={className} />;
  }
}

function projectFaviconIcon(project: Project): ReactNode {
  return <ProjectFavicon project={project} className={ITEM_ICON_CLASS} />;
}

function remoteProjectInputPlaceholder(flow: AddProjectCloneFlow | null): string | null {
  if (!flow) return null;
  if (flow.step === "confirm") return null;
  if (flow.source === "url") {
    return "Enter Git clone URL";
  }
  return `Enter ${remoteProjectSourceLabel(flow.source)} repository (${remoteProjectSourcePathHint(flow.source)})`;
}

function sourceProviderKind(source: AddProjectRemoteSource): AddProjectRemoteProviderKind | null {
  return source === "url" ? null : source;
}

function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
): ReadonlyArray<AddProjectRemoteProviderKind> {
  return REMOTE_PROJECT_PROVIDER_SOURCES.toSorted((left, right) => {
    const leftReady = readinessBySource[left].ready;
    const rightReady = readinessBySource[right].ready;
    if (leftReady !== rightReady) {
      return leftReady ? -1 : 1;
    }
    return remoteProjectSourceLabel(left).localeCompare(remoteProjectSourceLabel(right));
  });
}

type AddProjectRemoteSourceReadiness = Record<
  AddProjectRemoteSource,
  { readonly ready: boolean; readonly hint: string | null }
>;

function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const unavailable = {
    ready: false,
    hint: "Provider status unavailable. Open Settings -> Source Control and rescan.",
  } as const;
  const defaultReadiness: AddProjectRemoteSourceReadiness = {
    url: { ready: true, hint: null },
    github: unavailable,
    gitlab: unavailable,
    forgejo: unavailable,
    bitbucket: unavailable,
    "azure-devops": unavailable,
  };

  if (!discovery) {
    return defaultReadiness;
  }

  const providerByKind = new Map(
    discovery.sourceControlProviders.map((provider) => [provider.kind, provider]),
  );
  const readiness = { ...defaultReadiness };

  for (const source of REMOTE_PROJECT_SOURCES) {
    const kind = sourceProviderKind(source);
    if (!kind) continue;
    const provider = providerByKind.get(kind);
    if (!provider) {
      readiness[source] = unavailable;
      continue;
    }
    if (provider.status !== "available") {
      readiness[source] = { ready: false, hint: provider.installHint };
      continue;
    }
    if (provider.auth.status === "unauthenticated") {
      readiness[source] = {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
      };
      continue;
    }
    readiness[source] = { ready: true, hint: null };
  }

  return readiness;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "An error occurred.";
}

const OVERLAY_MODE_BY_COMMAND = {
  "commandPalette.toggle": "command",
  "filePicker.toggle": "files",
  "projectSearch.toggle": "content",
} as const satisfies Partial<Record<string, SearchOverlayMode>>;

function overlayModeForCommand(command: string | null): SearchOverlayMode | null {
  if (command === null) return null;
  return command in OVERLAY_MODE_BY_COMMAND
    ? OVERLAY_MODE_BY_COMMAND[command as keyof typeof OVERLAY_MODE_BY_COMMAND]
    : null;
}

const APPEARANCE_OPTIONS = [
  { mode: "system", label: "System", icon: MonitorIcon },
  { mode: "light", label: "Light", icon: SunIcon },
  { mode: "dark", label: "Dark", icon: MoonIcon },
] as const;

function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn't save theme selection",
      description: "Try again.",
    }),
  );
}

function projectFavicon(project: Project) {
  return <ProjectFavicon project={project} className="size-4" />;
}

export function CommandPalette({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: "SetOpen", open }), []);
  const toggleMode = useCallback(
    (mode: SearchOverlayMode) => dispatch({ _tag: "ToggleMode", mode }),
    [],
  );
  const openAddProject = useCallback(() => dispatch({ _tag: "OpenAddProject" }), []);
  const openNewAssistant = useCallback(() => dispatch({ _tag: "OpenNewAssistant" }), []);
  const openNewThreadIn = useCallback(() => dispatch({ _tag: "OpenNewThreadIn" }), []);
  const clearOpenIntent = useCallback(() => dispatch({ _tag: "ClearOpenIntent" }), []);
  // Add folder found copies of the folder on other machines; the palette closes for it.
  const [folderSuggestion, setFolderSuggestion] = useState<FolderLinkSuggestionRequest | null>(
    null,
  );
  // The added folder and the copy it links with, for the link dialog.
  const [linkRequest, setLinkRequest] = useState<{
    readonly project: EnvironmentProject;
    readonly candidate: LinkTarget;
  } | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { theme, themeHalves, resolvedTheme, appearanceMode, setAppearanceMode } = useTheme();
  useTimelineDetailShortcut();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );

  useEffect(() => {
    if (!state.open || state.mode === "command") return;
    const onEscapeKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      toggleMode("command");
    };
    window.addEventListener("keydown", onEscapeKeyDown, true);
    return () => window.removeEventListener("keydown", onEscapeKeyDown, true);
  }, [state.mode, state.open, toggleMode]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Resolve with the complete shortcut context so customized bindings
      // using any documented `when` condition (e.g. previewFocus) work.
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          modelPickerOpen: composerHandleRef.current?.isModelPickerOpen() ?? false,
        },
      });
      if (command === "appearance.cycle") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        const nextMode =
          appearanceMode === "system" ? "light" : appearanceMode === "light" ? "dark" : "system";
        if (!setAppearanceMode(nextMode)) {
          notifyThemeSaveFailure();
        } else {
          toastManager.add({
            id: "appearance-cycle",
            title: `Appearance: ${APPEARANCE_OPTIONS.find((option) => option.mode === nextMode)?.label}`,
            timeout: 1500,
          });
        }
        return;
      }
      if (command === "theme.select") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        dispatch({ _tag: "OpenChangeTheme" });
        return;
      }
      if (command === "themeEditor.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleThemeEditorForTheme({
          theme,
          themeHalves,
          initialAppearance: resolvedTheme,
        });
        return;
      }
      if (command === "usage.open") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        void navigate({ to: "/usage" });
        return;
      }
      if (command === "design.open") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        void navigate({ to: "/design" });
        return;
      }
      const mode = overlayModeForCommand(command);
      if (mode === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleMode(mode);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    appearanceMode,
    keybindings,
    navigate,
    previewOpen,
    resolvedTheme,
    setAppearanceMode,
    setOpen,
    terminalOpen,
    theme,
    themeHalves,
    toggleMode,
  ]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open === "new-thread-in") {
          openNewThreadIn();
        } else if (detail.open === "add-project") {
          openAddProject();
        } else if (detail.open === "new-assistant") {
          openNewAssistant();
        } else if (detail.query !== undefined) {
          dispatch({
            _tag: "OpenSearch",
            query: detail.query,
            ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
          });
        } else {
          setOpen(true);
        }
      }),
    [openAddProject, openNewAssistant, openNewThreadIn, setOpen],
  );

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            toggleMode("command");
            return;
          }
          setOpen(open);
        }}
      >
        {/* Block background focus calls for the entire time the palette is open. */}
        <div className="contents" inert={state.open}>
          {children}
        </div>
        <CommandPaletteDialog
          mode={state.mode}
          openIntent={state.openIntent}
          setOpen={setOpen}
          openOverlayMode={toggleMode}
          clearOpenIntent={clearOpenIntent}
          onFolderCopies={setFolderSuggestion}
        />
      </CommandDialog>
      <FolderLinkSuggestion
        request={folderSuggestion}
        onClose={() => setFolderSuggestion(null)}
        onLink={(project, candidate) => setLinkRequest({ project, candidate })}
      />
      {linkRequest !== null && (
        <ProjectLinkDialog
          open
          onOpenChange={(open) => {
            if (!open) setLinkRequest(null);
          }}
          project={linkRequest.project}
          initialCandidate={linkRequest.candidate}
        />
      )}
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly mode: SearchOverlayMode;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
  readonly onFolderCopies: (request: FolderLinkSuggestionRequest) => void;
}) {
  const composerHandleRef = useComposerHandleContext();

  return (
    <CommandDialogPopup
      aria-label={
        props.mode === "files"
          ? "File picker"
          : props.mode === "content"
            ? "Search project contents"
            : "Command palette"
      }
      className={cn(
        "overflow-hidden has-[[data-command-form]]:max-h-[min(48rem,90dvh)]",
        props.mode === "content" && "h-105",
      )}
      data-command-palette="true"
      data-palette-mode={props.mode}
      data-testid="command-palette"
      finalFocus={() => {
        composerHandleRef?.current?.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        props.setOpen(false);
      }}
    >
      {props.mode === "files" ? (
        <ProjectFilePicker setOpen={props.setOpen} />
      ) : props.mode === "content" ? (
        <ProjectContentSearchDialog onOpenChange={props.setOpen} />
      ) : (
        <OpenCommandPaletteDialog
          openIntent={props.openIntent}
          setOpen={props.setOpen}
          openOverlayMode={props.openOverlayMode}
          clearOpenIntent={props.clearOpenIntent}
          onFolderCopies={props.onFolderCopies}
        />
      )}
    </CommandDialogPopup>
  );
}

function OpenCommandPaletteDialog(props: {
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
  readonly onFolderCopies: (request: FolderLinkSuggestionRequest) => void;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  // Set on a project's workspace page.
  const routeProjectKey = useParams({
    strict: false,
    select: (params) => params.projectKey ?? null,
  });
  const { clearOpenIntent, onFolderCopies, openIntent, openOverlayMode, setOpen } = props;
  const [query, setQuery] = useState(openIntent?.kind === "search" ? openIntent.query : "");
  const [linkedThreadSearch, setLinkedThreadSearch] = useState(
    openIntent?.kind === "search" ? openIntent : null,
  );
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const resultListRef = useRef<LegendListRef | null>(null);
  // Typing or entering a submenu clears the highlight. Base UI keeps its own on the
  // first row, but the palette shows none until the user navigates, and the first
  // ArrowDown lands on it.
  const highlightClearedRef = useRef(false);
  function clearTypedHighlight(): void {
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
  }
  const clientSettings = useClientSettings();
  const modCommands = useModsStore((state) => state.commands);
  const modChannels = useModsStore((state) => state.channels);
  const createProject = useAtomCommand(projectEnvironment.create, {
    reportFailure: false,
  });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, startScratchThread } = useScratchProject();
  const lookupRepository = useAtomQueryRunner(sourceControlEnvironment.repository, {
    reportFailure: false,
  });
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const desktopLocalBootstraps = useDesktopLocalBootstraps();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const availableSettingsSearchItems = useAvailableSettingsSearchItems();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const projects = useProjects();
  const referenceThreadRef =
    pathname === "/pull-requests"
      ? environments.some(
          (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
        )
        ? PULL_REQUESTS_PANEL_REF
        : null
      : activeThread
        ? scopeThreadRef(activeThread.environmentId, activeThread.id)
        : null;
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(referenceThreadRef);
  const activeThreadServerConfig = useServerConfigs().get(
    activeThread?.environmentId ?? ("" as EnvironmentId),
  );
  const activeThreadReferenceCopyTarget =
    referenceThreadRef === null || (pathname === "/pull-requests" && !openPanelPullRequestUrl)
      ? null
      : resolveThreadReferenceCopyTarget({
          threadId: referenceThreadRef.threadId,
          openPanelPullRequestUrl,
          pullRequests: activeThread?.pullRequests,
          linkedPullRequestUrl:
            activeThread?.linkedPullRequest?.url ?? activeThread?.branchPullRequest?.url ?? null,
        });
  const copyActiveThreadReference = useCallback(async () => {
    const target = activeThreadReferenceCopyTarget;
    if (target === null) return;
    try {
      const didCopy = await writeTextToClipboard(target.value, target.clipboardTarget);
      if (!didCopy) return;
      toastManager.add({
        type: "success",
        title: target.successTitle,
        description: target.value,
      });
    } catch (error) {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: target.failureTitle,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [activeThreadReferenceCopyTarget]);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useThreadShells();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const {
    theme,
    themeHalves,
    resolvedTheme,
    appearanceMode,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
  } = useTheme();
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const themeCards = useMemo(() => {
    const seen = new Set<string>();
    return [
      ...STANDARD_THEME_CARDS.map((card) => ({ ...card, id: null })),
      ...[...BUILT_IN_THEMES, ...customThemes, ...environmentThemes]
        .filter((definition) => {
          if (seen.has(definition.id)) return false;
          seen.add(definition.id);
          return true;
        })
        .map(getThemeCardDefinition),
    ];
  }, [customThemes, environmentThemes]);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providerEntryByEnvironmentAndInstanceId = useMemo(() => {
    const map = new Map<string, ProviderInstanceEntry>();
    for (const environment of environments) {
      const serverConfig = environment.serverConfig;
      const environmentProviders =
        serverConfig?.providers ??
        (environment.environmentId === primaryEnvironmentId ? providers : []);
      const derived = deriveProviderInstanceEntries(environmentProviders);
      // Settings fill the ACP registry identity (agent id, icon URL) the
      // derived entries alone do not carry.
      const entries = serverConfig
        ? applyProviderInstanceSettings(derived, serverConfig.settings)
        : derived;
      for (const entry of entries) {
        map.set(`${environment.environmentId}:${entry.instanceId}`, entry);
      }
    }
    return map;
  }, [environments, primaryEnvironmentId, providers]);
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const environmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  const threadSearchQuery = currentView === null && !isActionsOnly ? deferredQuery : "";
  const threadSearch = useThreadSearch(environmentIds, threadSearchQuery);
  const threadContentMatchByKey = useMemo(
    () =>
      new Map(
        threadSearch.matches.flatMap((match) =>
          match.source === "user" || match.source === "assistant"
            ? [[threadSearchMatchKey(match), match] as const]
            : [],
        ),
      ),
    [threadSearch.matches],
  );
  const [browseGeneration, setBrowseGeneration] = useState(0);
  const browseNavigationRef = useRef<ReturnType<typeof createBrowseNavigationCoordinator> | null>(
    null,
  );
  if (browseNavigationRef.current === null) {
    browseNavigationRef.current = createBrowseNavigationCoordinator();
  }
  const browseNavigation = browseNavigationRef.current;
  const [addProjectEnvironmentId, setAddProjectEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
  const findFolderCopies = useFindFolderCopies();
  const [isCheckingFolderCopies, setIsCheckingFolderCopies] = useState(false);
  const checkingFolderCopiesRef = useRef(false);
  const [addProjectCloneFlow, setAddProjectCloneFlow] = useState<AddProjectCloneFlow | null>(null);
  // The name step of New project: while set, the palette input is the name.
  const [newProjectFlow, setNewProjectFlow] = useState<{
    readonly environmentId: EnvironmentId;
    /** Machine of the Add project sources view under this step; null from the palette root. */
    readonly sourcesEnvironmentId: EnvironmentId | null;
    readonly kind: NewProjectKind;
  } | null>(null);
  const [newProjectPublishesToGitHub, setNewProjectPublishesToGitHub] = useState(false);
  const [isCreatingNewProject, setIsCreatingNewProject] = useState(false);
  // State lags a render behind, so a repeated Enter could start a second create.
  const newProjectSubmittingRef = useRef(false);
  const createNewProject = useNewProject();
  const newProjectEnvironmentId = newProjectFlow?.environmentId ?? null;
  const folderChoice = useProjectFolderChoice(newProjectEnvironmentId, isCreatingNewProject, {
    remember: true,
    defaultPath:
      environments.find((environment) => environment.environmentId === newProjectEnvironmentId)
        ?.serverConfig?.newProjectsRoot ?? null,
    // The system folder dialog only shows this device's disks, and only the
    // macOS desktop app maps its paths one-to-one onto the primary machine.
    nativePicker:
      newProjectEnvironmentId !== null &&
      newProjectEnvironmentId === primaryEnvironmentId &&
      typeof window !== "undefined" &&
      window.desktopBridge !== undefined &&
      isMacPlatform(navigator.platform)
        ? {
            label: "Choose in Finder…",
            pick: async (initialPath) =>
              (await readLocalApi()?.dialogs.pickFolder(
                initialPath ? { initialPath } : undefined,
              )) ?? null,
          }
        : null,
  });
  const [isRemoteProjectCloning, setIsRemoteProjectCloning] = useState(false);
  const cloneFolderChoice = useProjectFolderChoice(
    addProjectCloneFlow?.step === "confirm" ? addProjectCloneFlow.environmentId : null,
    isRemoteProjectCloning,
  );
  const cloneLookupGeneration = useRef(0);
  const [isRemoteProjectLookingUp, setIsRemoteProjectLookingUp] = useState(false);
  const projectGroupingSettings = useMemo(
    () => selectProjectGroupingSettings(clientSettings),
    [clientSettings],
  );

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectEnvironmentLocationById = useMemo(
    () =>
      new Map(
        environments.map((environment) => {
          const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
          const isLocal = isPrimary || isDesktopLocalConnectionTarget(environment.entry.target);
          return [
            environment.environmentId,
            {
              kind: isLocal ? "local" : "remote",
              label: isPrimary
                ? "Local"
                : isLocal
                  ? `${environment.label} (Local)`
                  : environment.label,
              machine: resolveEnvironmentMachineKind(environment.serverConfig),
            },
          ] as const;
        }),
      ),
    [environments],
  );
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: clientSettings.sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      clientSettings.sidebarProjectSortOrder,
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
    ],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        unsortedProjectGroups,
        threads,
        clientSettings.sidebarProjectSortOrder,
      ),
    [clientSettings.sidebarProjectSortOrder, threads, unsortedProjectGroups],
  );
  const contextualProjectRef = useMemo(
    () =>
      resolveThreadActionProjectRef({
        activeDraftThread,
        activeThread: activeThread ?? undefined,
        defaultProjectRef,
        handleNewThread,
      }),
    [activeDraftThread, activeThread, defaultProjectRef, handleNewThread],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: contextualProjectRef,
      }),
    [contextualProjectRef, projectGroups],
  );
  const pickerProjects = useMemo(
    () =>
      projectPickerEntries.map(({ group, targetProject }) => ({
        ...targetProject,
        displayName: group.displayName,
      })),
    [projectPickerEntries],
  );
  const projectGroupByTargetKey = useMemo(
    () =>
      new Map(
        projectPickerEntries.map(({ group, targetProject }) => [
          `${targetProject.environmentId}:${targetProject.id}`,
          group,
        ]),
      ),
    [projectPickerEntries],
  );

  const addProjectEnvironmentOptions = useMemo(() => {
    const options = environments.map((environment): AddProjectEnvironmentOption => {
      const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
      return {
        environmentId: environment.environmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary,
          environmentId: environment.environmentId,
          runtimeLabel: environment.label,
        }),
        isPrimary,
        machine: resolveEnvironmentMachineKind(environment.serverConfig),
        isConnected:
          canCreateProjectInEnvironment(environment.connection.phase) &&
          readEnvironmentScope(environment.environmentId, AuthOrchestrationOperateScope),
        status: readEnvironmentScope(environment.environmentId, AuthOrchestrationOperateScope)
          ? environmentConnectionStatusText(
              environment.connection,
              isThisMachineTarget(environment.entry),
            )
          : "Read-only connection",
      };
    });

    options.sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });

    return options;
  }, [environments]);
  const currentExecutionEnvironmentId =
    activeThread?.environmentId ??
    activeDraftThread?.environmentId ??
    contextualProjectRef?.environmentId ??
    primaryEnvironmentId;
  const defaultAddProjectEnvironmentId = defaultProjectMachine(
    currentExecutionEnvironmentId,
    addProjectEnvironmentOptions
      .filter((option) => option.isConnected)
      .map((option) => option.environmentId),
  );
  const wslAddProjectEnvironmentOption = useMemo(
    () =>
      addProjectEnvironmentOptions.find((option) => {
        if (!option.isConnected) {
          return false;
        }
        const environment = environments.find(
          (candidate) => candidate.environmentId === option.environmentId,
        );
        return environment
          ? desktopLocalBackendId(environment.entry.target)?.startsWith("wsl:") === true
          : false;
      }) ?? null,
    [addProjectEnvironmentOptions, environments],
  );
  const browseEnvironmentId = addProjectEnvironmentId ?? defaultAddProjectEnvironmentId;
  const canCreateProject = useEnvironmentScope(browseEnvironmentId, AuthOrchestrationOperateScope);
  const browseEnvironment =
    environments.find((environment) => environment.environmentId === browseEnvironmentId) ?? null;
  // A desktop-local secondary backend (today: the WSL backend). The picker is
  // available against these too — the desktop dispatches pickFolder into the
  // backend's filesystem when routed by its instance id.
  const browseEnvironmentIsDesktopLocal =
    browseEnvironment !== null && isDesktopLocalConnectionTarget(browseEnvironment.entry.target);
  // Map the browsed desktop-local env to its desktop pool instance id (e.g.
  // "wsl:ubuntu"). The catalog environmentId is descriptor-derived and won't
  // route on the desktop side; pickFolder only recognizes the pool id, which
  // the bootstrap list exposes. Match on backend URL, exactly as Sidebar's
  // LocalSecondaryStatus does (environment.displayUrl === bootstrap.httpBaseUrl).
  const browseDesktopInstanceId = useMemo(() => {
    if (!browseEnvironmentIsDesktopLocal || browseEnvironment === null) {
      return null;
    }
    const displayUrl = browseEnvironment.displayUrl;
    if (displayUrl === null) {
      return null;
    }
    return (
      desktopLocalBootstraps.find((bootstrap) => bootstrap.httpBaseUrl === displayUrl)?.id ?? null
    );
  }, [browseEnvironment, browseEnvironmentIsDesktopLocal, desktopLocalBootstraps]);
  const sourceControlDiscovery = useEnvironmentQuery(
    browseEnvironmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: browseEnvironmentId,
          input: {},
        }),
  );
  const browseEnvironmentPlatform = getEnvironmentBrowsePlatform(
    browseEnvironment?.serverConfig?.environment.platform.os,
  );
  const isRemoteProjectCloneFlow = addProjectCloneFlow !== null;
  const isRemoteProjectRepositoryStep = addProjectCloneFlow?.step === "repository";
  // The destination step pins the repository folder onto the browsed path, so
  // the proposed clone target is "<chosen folder>/<repo>" instead of the bare
  // folder. A lookup reports "owner/repo"; a pasted clone URL falls back to its
  // own last segment, minus ".git".
  const pinnedCloneDirectoryName =
    addProjectCloneFlow?.step === "confirm"
      ? getCloneDirectoryName(
          addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.remoteUrl,
        )
      : "";
  const browsePath = useMemo(
    () =>
      getFilesystemBrowsePath(
        query,
        browseEnvironmentPlatform,
        browseEnvironmentId !== null && !isRemoteProjectCloneFlow && newProjectFlow === null,
      ),
    [
      browseEnvironmentId,
      browseEnvironmentPlatform,
      isRemoteProjectRepositoryStep,
      newProjectFlow,
      query,
    ],
  );
  const isBrowsing = browsePath.isBrowsing;
  const browseDirectoryPath = browsePath.directoryPath;
  const paletteMode = getCommandPaletteMode({ currentView, isBrowsing });
  const getAddProjectInitialQueryForEnvironment = useCallback(
    (environmentId: EnvironmentId | null): string => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      const environmentSettings = environment?.serverConfig?.settings ?? null;
      const baseDirectory = environmentSettings?.addProjectBaseDirectory?.trim() ?? "";
      if (baseDirectory.length === 0) {
        return "~/";
      }
      return ensureBrowseDirectoryPath(baseDirectory);
    },
    [environments],
  );

  const projectCwdById = useMemo(
    () =>
      new Map<ProjectId, string>(projects.map((project) => [project.id, project.workspaceRoot])),
    [projects],
  );
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const projectTitleById = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.title])),
    [projects],
  );

  const activeThreadId = activeThread?.id;
  const currentProjectEnvironmentId =
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null;
  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  // A disconnected current machine never silently redirects standalone work.
  const scratchTargetEnvironmentId = scratchEnvironmentId(currentExecutionEnvironmentId);
  const currentProjectCwd = currentProjectId
    ? (projectCwdById.get(currentProjectId) ?? null)
    : null;
  const currentProjectCwdForBrowse =
    browseEnvironmentId && currentProjectEnvironmentId === browseEnvironmentId
      ? currentProjectCwd
      : null;
  const getBrowseCwdForEnvironment = useCallback(
    (environmentId: EnvironmentId | null): string | null =>
      environmentId && currentProjectEnvironmentId === environmentId ? currentProjectCwd : null,
    [currentProjectCwd, currentProjectEnvironmentId],
  );
  const relativePathNeedsActiveProject =
    isExplicitRelativeProjectPath(query.trim()) && currentProjectCwdForBrowse === null;
  const browseAccess = useFilesystemReadAccess(browseEnvironmentId);
  const hasBrowseTarget =
    isBrowsing &&
    browsePath.directoryPath.length > 0 &&
    browseEnvironmentId !== null &&
    !relativePathNeedsActiveProject;
  const browseQuery = useEnvironmentQuery(
    browseAccess.canReadFiles && hasBrowseTarget
      ? filesystemEnvironment.browse({
          environmentId: browseEnvironmentId,
          input: {
            partialPath: browsePath.directoryPath,
            ...(currentProjectCwdForBrowse ? { cwd: currentProjectCwdForBrowse } : {}),
          },
        })
      : null,
  );
  const browseResult = browseQuery.data;
  const isBrowsePending = hasBrowseTarget && (browseAccess.isPending || browseQuery.isPending);
  const browseAccessError =
    hasBrowseTarget && !browseAccess.isPending && !browseAccess.canReadFiles
      ? (browseAccess.error ?? "This connection cannot browse host folders.")
      : null;
  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const { visibleEntries: visibleBrowseEntries, exactEntry: exactBrowseEntry } = useMemo(
    () =>
      pinnedCloneDirectoryName
        ? filterPinnedBrowseEntries({
            browseEntries,
            filterQuery: browsePath.filterQuery,
            pinnedDirectoryName: pinnedCloneDirectoryName,
            caseSensitive: !isWindowsPlatform(browseEnvironmentPlatform),
          })
        : filterFilesystemBrowseEntries(browseEntries, browsePath.filterQuery),
    [browseEntries, browseEnvironmentPlatform, browsePath.filterQuery, pinnedCloneDirectoryName],
  );

  const prefetchBrowsePath = useCallback(
    async (
      partialPath: string,
      environmentId: EnvironmentId | null = browseEnvironmentId,
      cwd: string | null = currentProjectCwdForBrowse,
    ): Promise<void> => {
      if (!environmentId) {
        return;
      }
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (
        !readEnvironmentScope(environmentId, AuthFilesystemReadScope) ||
        !canPreloadBrowsePath(environment?.connection.phase)
      ) {
        return;
      }

      await loadBrowsePath({
        environmentId,
        input: {
          partialPath,
          ...(cwd ? { cwd } : {}),
        },
      });
    },
    [browseEnvironmentId, currentProjectCwdForBrowse, environments, loadBrowsePath],
  );

  useEffect(
    () => () => {
      browseNavigation.invalidate();
    },
    [browseNavigation],
  );

  const openProjectFromSearch = useMemo(
    () => async (project: (typeof projects)[number]) => {
      const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
      const groupedProjectKeys = group
        ? new Set(
            group.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          )
        : null;
      const latestThread = groupedProjectKeys
        ? (sortThreads(
            threads.filter(
              (thread) =>
                thread.archivedAt === null &&
                groupedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
            ),
            clientSettings.sidebarThreadSortOrder,
          )[0] ?? null)
        : getLatestThreadForProject(
            threads.filter((thread) => thread.environmentId === project.environmentId),
            project.id,
            clientSettings.sidebarThreadSortOrder,
          );
      if (latestThread) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
        return;
      }

      await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    },
    [
      clientSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
      projectGroupByTargetKey,
      threads,
    ],
  );

  // Pickers list neither a machine's "No project" folder, an archived project nor a
  // project a check or agent made for itself; "No project" shows once, as its own item,
  // and an archived project takes no new work until it is restored.
  const listedPickerProjects = useMemo(
    () => projectPickerMembers(pickerProjects, scratchWorkspaceRootFor),
    [pickerProjects, scratchWorkspaceRootFor],
  );
  const projectSearchItems = useMemo(
    () =>
      buildProjectActionItems({
        projects: listedPickerProjects,
        valuePrefix: "project",
        searchTerms: (project) => {
          const members = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`)
            ?.memberProjects ?? [project];
          return buildCommandPaletteProjectMetadata({
            projects: members,
            locationByEnvironmentId: projectEnvironmentLocationById,
          }).searchTerms;
        },
        renderDescription: (project) => {
          const members = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`)
            ?.memberProjects ?? [project];
          const metadata = buildCommandPaletteProjectMetadata({
            projects: members,
            locationByEnvironmentId: projectEnvironmentLocationById,
          });
          const location = projectEnvironmentLocationById.get(project.environmentId) ?? {
            kind: "remote" as const,
            label: "Remote",
            machine: "server" as const,
          };
          return (
            <ProjectSearchDescription
              environmentLabels={metadata.environmentLabels}
              grouped={members.length > 1}
              location={location}
              workspaceRoot={project.workspaceRoot}
            />
          );
        },
        icon: projectFaviconIcon,
        runProject: openProjectFromSearch,
      }),
    [
      listedPickerProjects,
      openProjectFromSearch,
      projectEnvironmentLocationById,
      projectGroupByTargetKey,
    ],
  );

  const projectThreadItems = useMemo(() => {
    const isScratch = (project: CommandPaletteProject) =>
      isScratchProject(project, scratchWorkspaceRootFor(project.environmentId));
    const projectItems = enumerateCommandPaletteItems(
      buildProjectActionItems({
        projects: listedPickerProjects,
        valuePrefix: "new-thread-in",
        searchTerms: (project) => {
          const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
          const location = projectEnvironmentLocationById.get(project.environmentId);
          return [
            ...(group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ??
              []),
            ...(location ? [location.label] : []),
          ];
        },
        renderDescription: (project) => {
          const location = projectEnvironmentLocationById.get(project.environmentId) ?? {
            kind: "remote",
            label: "Remote",
            machine: "server" as const,
          };
          return (
            <span className="flex min-w-0 items-center gap-1">
              <span className="inline-flex min-w-0 items-center gap-1">
                {location.kind === "remote" ? (
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={location.machine}
                    className={COMMAND_PALETTE_META_ICON_CLASS}
                  />
                ) : null}
                <span className="truncate">{location.label}</span>
              </span>
              <CommandPaletteMetaDot />
              <span className="truncate">{project.workspaceRoot}</span>
            </span>
          );
        },
        icon: projectFaviconIcon,
        runProject: async (project) => {
          const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
          const contextualRefBelongsToGroup =
            contextualProjectRef !== null &&
            group?.memberProjectRefs.some(
              (projectRef) =>
                projectRef.environmentId === contextualProjectRef.environmentId &&
                projectRef.projectId === contextualProjectRef.projectId,
            );
          await handleNewThread(
            contextualRefBelongsToGroup
              ? contextualProjectRef
              : scopeProjectRef(project.environmentId, project.id),
          );
        },
      }),
    );
    if (scratchTargetEnvironmentId === null) return projectItems;

    // "No project" goes right after the current project: visible without
    // scrolling past every project, while Enter still starts in the current
    // one. When the current thread has no project, it is the current entry and
    // goes first. It keeps its own shortcut, so the projects' mod+1..9 hold.
    const noProjectIndex = pickerProjects[0] !== undefined && isScratch(pickerProjects[0]) ? 0 : 1;
    return [
      ...projectItems.slice(0, noProjectIndex),
      {
        kind: "action" as const,
        value: "new-thread-in:no-project",
        searchTerms: ["no project", "without project", "none"],
        title: "No project",
        icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.newWithoutProject" as const,
        run: async () => {
          await startScratchThread(scratchTargetEnvironmentId);
        },
      },
      ...projectItems.slice(noProjectIndex),
    ];
  }, [
    contextualProjectRef,
    handleNewThread,
    listedPickerProjects,
    pickerProjects,
    projectEnvironmentLocationById,
    projectGroupByTargetKey,
    scratchTargetEnvironmentId,
    scratchWorkspaceRootFor,
    startScratchThread,
  ]);

  const allThreadItems = useMemo(
    () =>
      buildThreadActionItems({
        threads,
        ...(activeThreadId ? { activeThreadId } : {}),
        projectTitleById,
        sortOrder: clientSettings.sidebarThreadSortOrder,
        icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
        renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
        renderTrailingContent: (thread) => <ThreadRowTrailingStatus thread={thread} />,
        renderDescription: (thread, { projectTitle }) => {
          const modelInstanceId =
            thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
          const providerEntry =
            providerEntryByEnvironmentAndInstanceId.get(
              `${thread.environmentId}:${modelInstanceId}`,
            ) ?? null;
          return (
            <ThreadCommandSubtitle
              project={projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
              projectTitle={projectTitle ?? null}
              environmentLabel={
                projectEnvironmentLocationById.get(thread.environmentId)?.label ?? "Remote"
              }
              branch={thread.branch}
              worktreePath={thread.worktreePath}
              isCurrent={thread.id === activeThreadId}
              driverKind={providerEntry?.driverKind ?? null}
              providerDisplayName={
                thread.runtime?.providerName ?? providerEntry?.displayName ?? modelInstanceId
              }
              acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
              acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
            />
          );
        },
        getContentMatch: (thread) => {
          const match = threadContentMatchByKey.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          );
          return match && (match.source === "user" || match.source === "assistant")
            ? {
                source: match.source,
                snippet: match.snippet,
                query: threadSearch.query,
              }
            : undefined;
        },
        runThread: async (thread) => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        },
      }),
    [
      activeThreadId,
      clientSettings.sidebarThreadSortOrder,
      navigate,
      projectCwdById,
      projectByKey,
      projectEnvironmentLocationById,
      projectTitleById,
      providerEntryByEnvironmentAndInstanceId,
      threadContentMatchByKey,
      threadSearch.query,
      threads,
    ],
  );
  const recentThreadItems = allThreadItems.slice(0, RECENT_THREAD_LIMIT);

  const pushPaletteView = useCallback(
    (view: CommandPaletteView): void => {
      browseNavigation.invalidate();
      setViewStack((previousViews) => [
        ...previousViews,
        {
          addonIcon: view.addonIcon,
          groups: view.groups,
          ...(view.initialQuery ? { initialQuery: view.initialQuery } : {}),
        },
      ]);
      highlightClearedRef.current = true;
      setHighlightedItemValue(null);
      setQuery(view.initialQuery ?? "");
    },
    [browseNavigation],
  );

  function pushView(item: CommandPaletteSubmenuItem): void {
    pushPaletteView({
      addonIcon: item.addonIcon,
      groups: item.groups,
      ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
    });
  }

  function popView(): void {
    browseNavigation.invalidate();
    setAddProjectCloneFlow(null);
    setNewProjectFlow(null);
    if (viewStack.length <= 1) {
      setAddProjectEnvironmentId(null);
    } else if (newProjectFlow?.sourcesEnvironmentId) {
      // The machine switcher may have moved off the sources view's machine.
      setAddProjectEnvironmentId(newProjectFlow.sourcesEnvironmentId);
    }
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setHighlightedItemValue(null);
    setQuery("");
  }

  function handleQueryChange(rawQuery: string): void {
    const nextQuery = isBrowsing ? collapseRestartedBrowsePath(rawQuery) : rawQuery;
    browseNavigation.invalidate();
    clearTypedHighlight();
    setQuery(nextQuery);
    if (newProjectFlow?.kind === "code") newProjectDraft.keep(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  const startAddProjectBrowse = useCallback(
    async (environmentId: EnvironmentId): Promise<void> => {
      const initialQuery = getAddProjectInitialQueryForEnvironment(environmentId);
      const initialBrowsePath = getBrowseDirectoryPath(initialQuery);
      const browseCwd = getBrowseCwdForEnvironment(environmentId);
      const view: CommandPaletteView = {
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [],
        initialQuery,
      };

      await browseNavigation.run(
        () =>
          initialBrowsePath.length > 0
            ? prefetchBrowsePath(initialBrowsePath, environmentId, browseCwd)
            : Promise.resolve(),
        () => {
          setAddProjectEnvironmentId(environmentId);
          setAddProjectCloneFlow(null);
          pushPaletteView(view);
        },
      );
    },
    [
      browseNavigation,
      getAddProjectInitialQueryForEnvironment,
      getBrowseCwdForEnvironment,
      prefetchBrowsePath,
      pushPaletteView,
    ],
  );

  const startAddProjectClone = useCallback(
    (environmentId: EnvironmentId, source: AddProjectRemoteSource): void => {
      setAddProjectEnvironmentId(environmentId);
      cloneFolderChoice.reset();
      setAddProjectCloneFlow({ step: "repository", environmentId, source });
      pushPaletteView({
        addonIcon: remoteProjectSourceIcon(source, ADDON_ICON_CLASS),
        groups: [],
        initialQuery: "",
      });
    },
    [pushPaletteView, cloneFolderChoice.reset],
  );

  /** Folder that holds an environment's name-only projects, or null when it has none. */
  const newProjectsRootFor = useCallback(
    (environmentId: EnvironmentId | null): string | null =>
      environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
        ?.newProjectsRoot ?? null,
    [environments],
  );

  const startNewProject = useCallback(
    (
      environmentId: EnvironmentId,
      sourcesEnvironmentId: EnvironmentId | null,
      kind: NewProjectKind = "code",
    ): void => {
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow(null);
      setNewProjectFlow({ environmentId, sourcesEnvironmentId, kind });
      setNewProjectPublishesToGitHub(false);
      pushPaletteView({
        addonIcon:
          kind === "personal" ? (
            <ConciergeBellIcon className={ADDON_ICON_CLASS} />
          ) : (
            <FolderGit2Icon className={ADDON_ICON_CLASS} />
          ),
        groups: [],
      });
      // Coming back to New project picks up the name typed before.
      if (kind === "code") setQuery(newProjectDraft.name());
    },
    [pushPaletteView],
  );

  const buildAddProjectSourceGroups = useCallback(
    (
      environmentId: EnvironmentId,
      readinessBySource: AddProjectRemoteSourceReadiness,
    ): CommandPaletteView["groups"] => {
      const sourceItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
        {
          kind: "action",
          value: `action:add-project:${environmentId}:local`,
          searchTerms: ["local", "folder", "directory", "browse"],
          title: "Local folder",
          description: "Browse a folder on disk",
          icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
          keepOpen: true,
          run: async () => {
            await startAddProjectBrowse(environmentId);
          },
        },
      ];

      if (newProjectsRootFor(environmentId) !== null) {
        sourceItems.unshift({
          kind: "action",
          value: `action:add-project:${environmentId}:new`,
          searchTerms: ["new project", "create", "empty", "repository", "git init"],
          title: "New project",
          description: "Start a code project from a name",
          icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
          keepOpen: true,
          run: async () => {
            startNewProject(environmentId, environmentId);
          },
        });
      }

      const orderedSources: ReadonlyArray<AddProjectRemoteSource> = [
        "url",
        ...sortAddProjectProviderSources(readinessBySource),
      ];

      for (const source of orderedSources) {
        const label = remoteProjectSourceLabel(source);
        const title = source === "url" ? "Git URL" : `${label} repository`;
        const description =
          source === "url"
            ? "Clone from a remote URL"
            : `Clone ${label} ${remoteProjectSourcePathHint(source)}`;
        const readiness = readinessBySource[source];
        if (!readiness.ready) continue;

        sourceItems.push({
          kind: "action",
          value: `action:add-project:${environmentId}:${source}`,
          searchTerms: ["clone", "remote", "repository", "repo", "git", label],
          title,
          description,
          icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
          keepOpen: true,
          run: async () => {
            startAddProjectClone(environmentId, source);
          },
        });
      }

      return [{ value: `sources:${environmentId}`, label: "Sources", items: sourceItems }];
    },
    [newProjectsRootFor, startAddProjectBrowse, startAddProjectClone, startNewProject],
  );

  const startAddProjectSourceSelection = useCallback(
    (environmentId: EnvironmentId): void => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Environment unavailable",
            description: `${environment?.label ?? "The selected environment"} is not connected.`,
          }),
        );
        return;
      }
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow(null);
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [
          ...buildAddProjectSourceGroups(
            environmentId,
            buildAddProjectRemoteSourceReadiness(
              browseEnvironmentId === environmentId ? sourceControlDiscovery.data : null,
            ),
          ),
          {
            value: "existing-project-machine",
            label: "Execution machine",
            items: addProjectEnvironmentOptions.map((option) => ({
              ...buildEnvironmentItem(option, `existing-machine:${option.environmentId}`, (id) => {
                setViewStack((views) => views.slice(0, -1));
                startAddProjectSourceSelection(id);
              }),
              ...(option.environmentId === environmentId
                ? { titleTrailingContent: <CheckIcon className="ms-auto size-4" /> }
                : {}),
            })),
          },
        ],
      });
    },
    [
      browseEnvironmentId,
      buildAddProjectSourceGroups,
      addProjectEnvironmentOptions,
      environments,
      pushPaletteView,
      sourceControlDiscovery.data,
    ],
  );

  const buildEnvironmentItem = (
    option: AddProjectEnvironmentOption,
    value: string,
    run: (environmentId: EnvironmentId) => void,
  ): CommandPaletteActionItem => ({
    kind: "action",
    value,
    searchTerms: [option.label, option.environmentId, option.isPrimary ? "this device" : ""],
    title: option.label,
    description: option.isConnected
      ? option.isPrimary
        ? "This device"
        : "Connected"
      : option.status,
    disabled: !option.isConnected,
    icon: <EnvironmentMachineIcon kind={option.machine} className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => {
      run(option.environmentId);
    },
  });
  const addProjectEnvironmentItems = addProjectEnvironmentOptions.map((option) =>
    buildEnvironmentItem(
      option,
      `action:add-project:environment:${option.environmentId}`,
      startAddProjectSourceSelection,
    ),
  );
  const newProjectEnvironmentOptions = addProjectEnvironmentOptions.filter(
    (option) => option.isConnected && newProjectsRootFor(option.environmentId) !== null,
  );

  const addProjectEnvironmentGroups = useMemo<CommandPaletteView["groups"]>(
    () => [
      {
        value: "environments",
        label: "Environments",
        items: addProjectEnvironmentItems,
      },
    ],
    [addProjectEnvironmentItems],
  );

  const openAddProjectFlow = useCallback(() => {
    // With no connected environment there is nothing to browse, so the only
    // useful next step is connecting one.
    if (!addProjectEnvironmentOptions.some((option) => option.isConnected)) {
      setOpen(false);
      void navigate({ to: "/settings/connections" });
      return;
    }

    if (defaultAddProjectEnvironmentId === null) {
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: addProjectEnvironmentGroups,
      });
      return;
    }

    void startAddProjectSourceSelection(defaultAddProjectEnvironmentId);
  }, [
    addProjectEnvironmentGroups,
    addProjectEnvironmentOptions.length,
    defaultAddProjectEnvironmentId,
    navigate,
    pushPaletteView,
    setOpen,
    startAddProjectSourceSelection,
  ]);

  const openMachineAssistant = (assistant: (typeof projects)[number]) => {
    setOpen(false);
    void navigate({
      to: "/projects/$projectKey",
      params: {
        projectKey: deriveLogicalProjectKeyFromSettings(assistant, projectGroupingSettings),
      },
    });
  };

  const openNewProjectFlow = (kind: NewProjectKind = "code") => {
    if (kind === "personal") {
      // Each machine has its own private assistant: open or make the one on
      // the machine in context, never another machine's.
      const connected = addProjectEnvironmentOptions.filter((option) => option.isConnected);
      const step = personalAssistantSetupStep({
        projects,
        connectedEnvironmentIds: connected.map((option) => option.environmentId),
        preferredEnvironmentId: currentExecutionEnvironmentId,
      });
      if (step.kind === "open") {
        openMachineAssistant(step.assistant);
        return;
      }
      if (step.kind === "create") {
        startNewProject(step.environmentId as EnvironmentId, null, kind);
        return;
      }
      pushPaletteView({
        addonIcon: <ConciergeBellIcon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value: "assistant-choose-machine",
            label: "Each machine has its own assistant. Choose one",
            items: addProjectEnvironmentOptions.map((option) => {
              const assistant = findMachineAssistant(projects, option.environmentId);
              return {
                ...buildEnvironmentItem(
                  option,
                  `action:assistant:machine:${option.environmentId}`,
                  (environmentId) =>
                    assistant
                      ? openMachineAssistant(assistant)
                      : startNewProject(environmentId, null, kind),
                ),
                description: option.isConnected
                  ? assistant
                    ? `Open ${assistant.title}`
                    : "Set up its assistant"
                  : option.status,
              };
            }),
          },
        ],
      });
      return;
    }
    const target = suggestProjectMachine({
      current: currentExecutionEnvironmentId,
      eligible: newProjectEnvironmentOptions.map((option) => option.environmentId),
      primary: primaryEnvironmentId,
      loadBalancing: {
        enabled: clientSettings.loadBalancingEnabled,
        weights: clientSettings.loadBalancingWeights,
      },
    });
    if (target !== null) {
      startNewProject(target, null, kind);
      return;
    }
    pushPaletteView({
      addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "new-project-select-machine",
          label: "Choose an execution machine",
          items: newProjectEnvironmentOptions.map((option) =>
            buildEnvironmentItem(option, `new-project:choose:${option.environmentId}`, (id) =>
              startNewProject(id, null, kind),
            ),
          ),
        },
      ],
    });
  };

  useLayoutEffect(() => {
    if (openIntent?.kind !== "search") return;
    browseNavigation.invalidate();
    cloneLookupGeneration.current += 1;
    setIsRemoteProjectLookingUp(false);
    setAddProjectCloneFlow(null);
    setNewProjectFlow(null);
    setViewStack([]);
    setLinkedThreadSearch(openIntent);
    setQuery(openIntent.query);
    clearOpenIntent();
  }, [browseNavigation, clearOpenIntent, openIntent]);

  useLayoutEffect(() => {
    if (openIntent?.kind !== "add-project") {
      return;
    }
    clearOpenIntent();
    openAddProjectFlow();
  }, [clearOpenIntent, openAddProjectFlow, openIntent]);

  // The sidebar's Personal assistant row opens straight on the name step.
  useLayoutEffect(() => {
    if (openIntent?.kind !== "new-assistant") return;
    clearOpenIntent();
    if (newProjectEnvironmentOptions.length === 0) {
      openAddProjectFlow();
      return;
    }
    openNewProjectFlow("personal");
  });

  useLayoutEffect(() => {
    if (openIntent?.kind !== "new-thread-in" || projectThreadItems.length === 0) {
      return;
    }
    clearOpenIntent();
    browseNavigation.invalidate();
    setAddProjectCloneFlow(null);
    setNewProjectFlow(null);
    setViewStack([]);
    setQuery("");
    // projectThreadItems already lists the current project first.
    pushPaletteView({
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],
    });
  }, [clearOpenIntent, browseNavigation, openIntent, projectThreadItems, pushPaletteView]);

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  if (projects.length > 0) {
    const activeProjectTitle =
      projectPickerEntries.find((entry) => entry.isPreferred)?.group.displayName ??
      (currentProjectId ? (projectTitleById.get(currentProjectId) ?? null) : null);

    if (activeProjectTitle) {
      actionItems.push({
        kind: "action",
        value: "action:new-thread",
        searchTerms: ["new thread", "chat", "create", "draft"],
        title: (
          <>
            New thread in <span className="font-semibold">{activeProjectTitle}</span>
          </>
        ),
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.new",
        run: async () => {
          await startNewThreadFromContext({
            activeDraftThread,
            activeThread: activeThread ?? undefined,
            defaultProjectRef,
            handleNewThread,
          });
        },
      });
    }

    actionItems.push({
      kind: "submenu",
      value: "action:new-thread-in",
      searchTerms: ["new thread", "project", "pick", "choose", "select"],
      title: "New thread in...",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],
    });
  }

  if (scratchTargetEnvironmentId !== null) {
    actionItems.push({
      kind: "action",
      value: "action:new-thread-without-project",
      searchTerms: ["new thread", "no project", "without project", "none", "chat"],
      title: "New thread without a project",
      icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.newWithoutProject",
      run: async () => {
        await startScratchThread(scratchTargetEnvironmentId);
      },
    });
  }

  const scratchChoices = addProjectEnvironmentOptions.filter(
    (option) => option.isConnected && scratchWorkspaceRootFor(option.environmentId) !== null,
  );
  if (scratchChoices.length > 0)
    actionItems.push({
      kind: "submenu",
      value: "action:standalone-machine",
      title: "Standalone chat on…",
      searchTerms: ["scratch", "machine", "without project"],
      icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <MonitorIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "scratch-machines",
          label: "Choose an execution machine",
          items: scratchChoices.map((option) => ({
            ...buildEnvironmentItem(option, `scratch:machine:${option.environmentId}`, (id) => {
              setOpen(false);
              void startScratchThread(id);
            }),
            keepOpen: false,
          })),
        },
      ],
    });

  if (activeThreadReferenceCopyTarget !== null) {
    actionItems.push({
      kind: "action",
      value: "action:copy-thread-reference",
      searchTerms: ["copy", "pull request", "pr link", "thread id", "reference"],
      title:
        activeThreadReferenceCopyTarget.kind === "pull-request" ? "Copy PR link" : "Copy thread ID",
      description: activeThreadReferenceCopyTarget.value,
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "thread.copyReference",
      run: copyActiveThreadReference,
    });
  }

  if (
    activeThread !== null &&
    readEnvironmentScope(activeThread.environmentId, AuthOrchestrationOperateScope)
  ) {
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    actionItems.push({
      kind: "action",
      value: "action:link-increment",
      searchTerms: ["link", "increment", "specweave", "plan", "spec", "tasks"],
      title: "Link SpecWeave increment to thread",
      icon: <ListTodoIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openLinkIncrementDialog(threadRef);
      },
    });
  }

  if (
    activeThread !== null &&
    threadPullRequestLinkMode(activeThreadServerConfig?.environment.capabilities) !== "unsupported"
  ) {
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    actionItems.push({
      kind: "action",
      value: "action:link-pull-request",
      searchTerms: ["link", "pull request", "pr", "attach", "stack"],
      title: "Link pull request to thread",
      icon: <PullRequestGlyph.link className={ITEM_ICON_CLASS} />,
      run: async () => {
        openLinkPullRequestDialog(threadRef);
      },
    });
    if (activeThreadServerConfig?.environment.capabilities.threadPullRequests === true) {
      actionItems.push({
        kind: "action",
        value: "action:open-thread-pull-requests",
        searchTerms: ["pull requests", "linked", "stack", "prs"],
        title: "Show linked pull requests",
        disabled: visibleThreadPullRequests(activeThread.pullRequests).length === 0,
        icon: <PullRequestGlyph.link className={ITEM_ICON_CLASS} />,
        run: async () => {
          useRightPanelStore.getState().open(threadRef, "pull-requests");
        },
      });
    }
  }

  if (activeThread !== null) {
    const thread = activeThread;
    actionItems.push({
      kind: "action",
      value: "action:restart-agent-session",
      searchTerms: ["restart", "reset", "reload", "agent", "session", "skills", "plugins", "mcp"],
      title: "Restart agent session",
      icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
      // Stopping the provider process keeps the conversation: the next message
      // spawns a fresh one that resumes it and reloads skills, plugins, and MCP
      // servers. The fresh workspace scan updates the composer's slash menu.
      // Failures throw into executeItem's error toast.
      run: async () => {
        const { environmentId } = thread;
        if (thread.runtime !== null) {
          const stopped = await stopThreadSession({
            environmentId,
            input: { threadId: thread.id },
          });
          if (stopped._tag === "Failure") throw squashAtomCommandFailure(stopped);
        }
        // The server stops the process after accepting the command. A failed
        // stop shows in the thread.
        toastManager.add({
          type: "success",
          title: "Agent session will restart",
          description: "Your next message starts a fresh session.",
        });
        const project = projectByKey.get(`${environmentId}:${thread.projectId}`);
        if (!project) return;
        const refreshed = await refreshProviders({
          environmentId,
          input: {
            instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
            cwd: thread.worktreePath ?? project.workspaceRoot,
            fresh: true,
          },
        });
        if (refreshed._tag === "Failure") throw squashAtomCommandFailure(refreshed);
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:open-file-picker",
    searchTerms: ["go to file", "open file", "file picker", "find file", "quick open"],
    title: "Go to file",
    icon: <FileSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "filePicker.toggle",
    run: async () => {
      openOverlayMode("files");
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:search-project-contents",
    searchTerms: ["search project", "find in files", "grep", "content search", "text search"],
    title: "Search project contents",
    icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "projectSearch.toggle",
    run: async () => {
      openOverlayMode("content");
    },
  });

  if (newProjectEnvironmentOptions.length > 0) {
    actionItems.push({
      kind: "action",
      value: "action:new-project",
      searchTerms: ["new project", "create project", "empty", "repository", "repo", "git init"],
      title: "New project",
      icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        openNewProjectFlow();
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:new-personal-assistant",
      searchTerms: ["personal assistant", "my assistant", "agent", "personal project", "routines"],
      title: PERSONAL_ASSISTANT_LABEL,
      icon: <ConciergeBellIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        openNewProjectFlow("personal");
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:add-project",
    searchTerms: [
      "add project",
      "folder",
      "directory",
      "browse",
      "clone",
      "remote",
      "repository",
      "repo",
      "git",
      "github",
      "gitlab",
      "forgejo",
      "bitbucket",
      "azure",
      "devops",
      "url",
      "environment",
    ],
    title: "Add project",
    icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => {
      openAddProjectFlow();
    },
  });

  if (wslAddProjectEnvironmentOption) {
    actionItems.push({
      kind: "action",
      value: "action:add-project:wsl-folder",
      searchTerms: ["add project", "open", "wsl", "linux", "folder", "directory"],
      title: "Open WSL folder",
      description: wslAddProjectEnvironmentOption.label,
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        await startAddProjectBrowse(wslAddProjectEnvironmentOption.environmentId);
      },
    });
  }

  for (const command of modCommands) {
    const channel = modChannels[command.mod];
    if (channel === undefined) continue;
    actionItems.push({
      kind: "action",
      value: `mod:${command.mod}:${command.name}`,
      searchTerms: [command.mod, command.name, command.description, "mod"],
      title: command.description,
      description: `${command.mod} mod`,
      icon: <PuzzleIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        channel.runCommand(command.name);
      },
    });
  }

  const changeThemeItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-theme",
    searchTerms: ["change theme", "appearance", "colors", "palette"],
    title: "Change theme",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "theme.select",
    groups: [
      {
        value: "themes",
        label: "Change theme",
        items: themeCards.map(({ id, label, previews }) => ({
          kind: "action",
          value: id === null ? "theme:standard" : `theme:palette:${id}`,
          title: label,
          description: previews.length === 1 ? `For ${previews[0]!.mode} mode` : undefined,
          searchTerms: [label, "theme", "appearance"],
          icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent: (
            <span className="flex shrink-0 items-center gap-2">
              {(themeHalves?.[resolvedTheme] ?? getThemeDefinition(theme)?.id ?? null) === id ? (
                <span className="text-xs text-muted-foreground">Current</span>
              ) : null}
              <span className="flex items-center gap-1" aria-hidden>
                {previews.map((preview) => (
                  <ThemePreviewCircle
                    key={preview.mode}
                    colors={preview.colors}
                    mode={preview.mode}
                    className="size-3 border-0"
                  />
                ))}
              </span>
            </span>
          ),
          run: async () => {
            const saved =
              previews.length === 1 && id !== null
                ? setThemeHalf(previews[0]!.mode, id)
                : setTheme(id ?? appearanceMode);
            if (!saved) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };
  actionItems.push(changeThemeItem);

  const changeAppearanceItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-appearance",
    searchTerms: ["change appearance", "light", "dark", "system", "mode", "toggle"],
    title: "Change appearance",
    icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <MonitorIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "appearance.cycle",
    groups: [
      {
        value: "appearance",
        label: "Change appearance",
        items: APPEARANCE_OPTIONS.map(({ mode, label, icon: Icon }) => ({
          kind: "action",
          value: `appearance:${mode}`,
          title: label,
          searchTerms: [label, "appearance", "mode"],
          icon: <Icon className={ITEM_ICON_CLASS} />,
          titleTrailingContent:
            appearanceMode === mode ? (
              <span className="text-xs text-muted-foreground">Current</span>
            ) : undefined,
          run: async () => {
            if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };
  actionItems.push(changeAppearanceItem);

  actionItems.push({
    kind: "submenu",
    value: "action:timeline-detail",
    searchTerms: ["timeline detail", "verbose", "concise", "compact", "thinking", "tool calls"],
    title: "Change timeline detail",
    icon: <ListCollapseIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <ListCollapseIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "timeline.cycleDetail",
    groups: [
      {
        value: "timeline-detail",
        label: "Timeline detail",
        items: TIMELINE_DETAIL_LEVELS.map((level) => ({
          kind: "action",
          value: `timeline-detail:${level}`,
          title: TIMELINE_DETAIL_LABELS[level],
          description: TIMELINE_DETAIL_DESCRIPTIONS[level],
          searchTerms: [TIMELINE_DETAIL_LABELS[level], "timeline", "detail"],
          icon: <ListCollapseIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent:
            clientSettings.timelineDetail === level ? (
              <span className="text-xs text-muted-foreground">Current</span>
            ) : undefined,
          run: async () => setTimelineDetail(level),
        })),
      },
    ],
  });

  useLayoutEffect(() => {
    if (openIntent?.kind !== "change-theme") return;
    clearOpenIntent();
    browseNavigation.invalidate();
    cloneLookupGeneration.current += 1;
    setIsRemoteProjectLookingUp(false);
    setAddProjectCloneFlow(null);
    setNewProjectFlow(null);
    setViewStack([]);
    pushPaletteView({
      addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: "themes", label: "Change theme", items: [] }],
    });
  }, [browseNavigation, clearOpenIntent, openIntent, pushPaletteView]);

  actionItems.push({
    kind: "action",
    value: "action:theme-editor",
    searchTerms: ["theme", "appearance", "colors", "palette", "customize"],
    title: "Toggle theme editor",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "themeEditor.toggle",
    run: async () => {
      toggleThemeEditorForTheme({
        theme,
        themeHalves,
        initialAppearance: resolvedTheme,
      });
    },
  });

  if (
    environments.some(
      (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
    )
  ) {
    actionItems.push({
      kind: "action",
      value: "action:pull-requests",
      searchTerms: [
        "code review",
        "pull requests",
        "prs",
        "pr",
        "github",
        "review",
        "merge",
        "branch",
      ],
      title: "Open Code Review",
      icon: <PullRequestGlyph.pullRequest className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:usage",
    searchTerms: ["usage", "use", "tokens", "cost", "spend", "limits", "stats", "analytics"],
    title: "Open usage",
    icon: <ChartNoAxesColumnIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "usage.open",
    run: async () => {
      await navigate({ to: "/usage" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:design",
    searchTerms: ["design", "designs", "canvas", "mockup", "prototype", "playground", "gallery"],
    title: "Open Design",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "design.open",
    run: async () => {
      await navigate({ to: "/design" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:status",
    searchTerms: ["status", "health", "outage", "incidents", "uptime", "providers", "machines"],
    title: "Open status",
    icon: <ActivityIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/status" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:handoff-machine",
    searchTerms: ["hand off", "handoff", "machine", "move threads", "sleep", "close laptop"],
    title: "Hand off this machine…",
    icon: <ArrowRightLeftIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      requestHandOffMachine();
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:settings",
    searchTerms: ["settings", "preferences", "configuration", "keybindings"],
    title: "Open settings",
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings" });
    },
  });

  // Target the project whose workspace is open, then the active thread or
  // draft's project, falling back to the first sidebar group.
  const contextualProjectGroup =
    (routeProjectKey === null
      ? null
      : projectGroups.find((group) => group.projectKey === routeProjectKey)) ??
    (contextualProjectRef
      ? projectGroupByTargetKey.get(
          `${contextualProjectRef.environmentId}:${contextualProjectRef.projectId}`,
        )
      : null) ??
    projectGroups[0] ??
    null;
  if (contextualProjectGroup) {
    actionItems.push({
      kind: "action",
      value: "action:project-settings",
      searchTerms: [
        "project",
        "settings",
        "name",
        "icon",
        "scripts",
        "model",
        "workspace",
        "grouping",
        "checkout",
        "remove",
        "specweave-studio.json",
      ],
      title: "Project settings",
      description: contextualProjectGroup.displayName,
      icon: <FolderIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/projects/$projectKey",
          params: { projectKey: contextualProjectGroup.projectKey },
        });
        requestProjectSettings(contextualProjectGroup.projectKey, Date.now(), { tab: "general" });
      },
    });
    // Only desktop builds with project windows offer this.
    if (canOpenProjectWindowFor(contextualProjectGroup.projectKey)) {
      actionItems.push({
        kind: "action",
        value: "action:open-project-window",
        searchTerms: ["project", "window", "new window", "open", "pop out", "separate", "detach"],
        title: "Open project in new window",
        description: contextualProjectGroup.displayName,
        icon: <AppWindowIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await openProjectWindow({
            projectKey: contextualProjectGroup.projectKey,
            title: contextualProjectGroup.displayName,
          });
        },
      });
    }
  }

  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });
  // Sections the query names lead as roots, then the rows of each section.
  const settingsSearchItems: CommandPaletteActionItem[] = searchSettingsBySection(
    deferredQuery,
    availableSettingsSearchItems,
  ).flatMap((result): CommandPaletteActionItem[] => {
    if (result.kind === "section") {
      if (!result.matched) return [];
      return [
        {
          kind: "action",
          value: `setting-section:${result.section}`,
          searchTerms: [result.label, "settings"],
          title: result.label,
          description: "Settings section",
          icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            await navigate({ to: result.section, hash: "", hashScrollIntoView: false });
          },
        },
      ];
    }
    const item = result.row;
    return [
      {
        kind: "action",
        value: `setting:${item.id}`,
        searchTerms: [item.title, SETTINGS_SECTION_LABELS[item.to], ...(item.searchTerms ?? [])],
        title: item.title,
        description: `Settings · ${SETTINGS_SECTION_LABELS[item.to]}`,
        ...(item.secondary ? { secondary: true } : {}),
        icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await navigate({
            to: item.to,
            hash: item.targetId ?? item.id,
            replace: pathname === item.to,
            hashScrollIntoView: false,
            state: { settingsTargetHighlight: true },
          });
        },
      },
    ];
  });
  // The project in view (route or thread) also exposes its Project settings rows.
  const settingsProject =
    routeProjectKey !== null || contextualProjectRef ? contextualProjectGroup : null;
  const openProjectSettingsAt = async (projectKey: string, tab: string, row?: string) => {
    await navigate({ to: "/projects/$projectKey", params: { projectKey } });
    requestProjectSettings(projectKey, Date.now(), row ? { tab, row } : { tab });
  };
  if (settingsProject) {
    for (const result of searchProjectSettings(deferredQuery, PROJECT_SETTINGS_TABS)) {
      if (result.kind === "section" && !result.matched) continue;
      const tabLabel = PROJECT_SETTINGS_TAB_LABELS[result.section];
      settingsSearchItems.push({
        kind: "action",
        value: `project-setting:${result.id}`,
        searchTerms:
          result.kind === "section"
            ? [tabLabel, "project settings"]
            : [result.row.title, tabLabel, "project settings", ...(result.row.searchTerms ?? [])],
        title: result.kind === "section" ? tabLabel : result.row.title,
        description:
          result.kind === "section"
            ? `Project settings · ${settingsProject.displayName}`
            : `Project settings · ${tabLabel}`,
        icon: <FolderIcon className={ITEM_ICON_CLASS} />,
        run: () =>
          openProjectSettingsAt(
            settingsProject.projectKey,
            result.section,
            result.kind === "row" ? result.row.id : undefined,
          ),
      });
    }
  }
  const activeGroups =
    browseEnvironmentId !== null &&
    currentView?.groups.some((group) => group.value.startsWith("sources:"))
      ? [
          ...buildAddProjectSourceGroups(
            browseEnvironmentId,
            buildAddProjectRemoteSourceReadiness(sourceControlDiscovery.data),
          ),
          {
            value: "existing-project-machine",
            label: "Execution machine",
            items: addProjectEnvironmentOptions.map((option) => ({
              ...buildEnvironmentItem(option, `existing-machine:${option.environmentId}`, (id) => {
                setAddProjectEnvironmentId(id);
              }),
              ...(option.environmentId === browseEnvironmentId
                ? { titleTrailingContent: <CheckIcon className="ms-auto size-4" /> }
                : {}),
            })),
          },
        ]
      : currentView?.groups[0]?.value === "themes"
        ? changeThemeItem.groups
        : currentView?.groups[0]?.value === "appearance"
          ? changeAppearanceItem.groups
          : (currentView?.groups ?? rootGroups);

  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    projectSearchItems: projectSearchItems,
    settingsSearchItems,
    threadSearchItems:
      linkedThreadSearch?.linkedThreads && deferredQuery === linkedThreadSearch.query
        ? buildLinkedThreadActionItems({
            ...linkedThreadSearch.linkedThreads,
            query: linkedThreadSearch.query,
            icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
            runThread: async (thread) => {
              await navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
              });
            },
          })
        : allThreadItems,
  });

  const handleAddProjectForEnvironment = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly rawCwd: string;
      readonly platform: string;
      readonly currentProjectCwd: string | null;
    }) => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === input.environmentId,
      );
      if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Environment unavailable",
            description: `${environment?.label ?? "The selected environment"} is not connected.`,
          }),
        );
        return;
      }
      const rawCwd = input.rawCwd;

      if (isUnsupportedWindowsProjectPath(rawCwd.trim(), input.platform)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: "Windows-style paths are only supported on Windows.",
          }),
        );
        return;
      }

      if (isExplicitRelativeProjectPath(rawCwd.trim()) && !input.currentProjectCwd) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: "Relative paths require an active project.",
          }),
        );
        return;
      }

      const cwd = resolveProjectPathForDispatch(rawCwd, input.currentProjectCwd);
      if (cwd.length === 0) return;

      const existing = findProjectByPath(
        projects.filter((project) => project.environmentId === input.environmentId),
        cwd,
      );
      if (existing) {
        const latestThread = getLatestThreadForProject(
          threads.filter((thread) => thread.environmentId === existing.environmentId),
          existing.id,
          clientSettings.sidebarThreadSortOrder,
        );
        if (latestThread && latestThread.settledOverride !== "settled") {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(latestThread.environmentId, latestThread.id),
            ),
          });
        } else {
          const navigationResult = await settlePromise(() =>
            handleNewThread(scopeProjectRef(existing.environmentId, existing.id)),
          );
          if (navigationResult._tag === "Failure") {
            const error = squashAtomCommandFailure(navigationResult);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to open project",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
            return;
          }
        }
        setOpen(false);
        return;
      }

      if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Cannot add project",
            description: "This connection cannot add projects.",
          }),
        );
        return;
      }
      const projectId = newProjectId();
      const title = inferProjectTitleFromPath(cwd);
      // "added": the project exists but its draft did not open (already reported).
      const addFolder = async (): Promise<"failed" | "added" | "opened"> => {
        const createResult = await createProject({
          environmentId: input.environmentId,
          input: {
            projectId,
            title,
            workspaceRoot: cwd,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: null,
          },
        });
        if (createResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(createResult)) {
            const error = squashAtomCommandFailure(createResult);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to add project",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return "failed";
        }

        const navigationResult = await settlePromise(() =>
          handleNewThread(scopeProjectRef(input.environmentId, projectId)),
        );
        if (navigationResult._tag === "Failure") {
          const error = squashAtomCommandFailure(navigationResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to add project",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return "added";
        }
        return "opened";
      };

      // A copy of a project on another machine is suggested for linking first.
      // Without a match, or with no machine that can link, nothing changes.
      if (checkingFolderCopiesRef.current) return;
      checkingFolderCopiesRef.current = true;
      setIsCheckingFolderCopies(true);
      const folder = { environmentId: input.environmentId, workspaceRoot: cwd, title };
      const matches = await findFolderCopies(folder).catch(() => []);
      checkingFolderCopiesRef.current = false;
      setIsCheckingFolderCopies(false);
      if (matches.length > 0) {
        setOpen(false);
        onFolderCopies({
          folder,
          matches,
          addProject: async () => {
            if ((await addFolder()) === "failed") return null;
            return waitForProject(scopeProjectRef(input.environmentId, projectId), 10_000).catch(
              () => null,
            );
          },
        });
        return;
      }

      if ((await addFolder()) === "opened") setOpen(false);
    },
    [
      handleNewThread,
      createProject,
      environments,
      findFolderCopies,
      navigate,
      onFolderCopies,
      primaryEnvironmentId,
      projects,
      providers,
      setOpen,
      clientSettings.sidebarThreadSortOrder,
      threads,
    ],
  );

  const handleAddProject = useCallback(
    async (rawCwd: string) => {
      if (!browseEnvironmentId) return;
      await handleAddProjectForEnvironment({
        environmentId: browseEnvironmentId,
        rawCwd,
        platform: browseEnvironmentPlatform,
        currentProjectCwd: currentProjectCwdForBrowse,
      });
    },
    [
      browseEnvironmentId,
      browseEnvironmentPlatform,
      currentProjectCwdForBrowse,
      handleAddProjectForEnvironment,
    ],
  );

  const newProjectGitHubTarget =
    newProjectFlow === null ? null : getNewProjectGitHubTarget(sourceControlDiscovery.data ?? null);
  // An assistant has a default name, so its name step can be submitted empty.
  const newProjectName =
    newProjectFlow === null ? query.trim() : resolveNewProjectName(newProjectFlow.kind, query);
  const canSubmitNewProject =
    newProjectFlow !== null &&
    newProjectName.length > 0 &&
    (newProjectFlow.kind === "personal" || folderChoice.path !== null) &&
    canCreateProject &&
    !isCreatingNewProject &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);

  async function submitNewProject(): Promise<void> {
    if (newProjectFlow === null || !canSubmitNewProject || newProjectSubmittingRef.current) {
      return;
    }
    if (newProjectFlow.kind === "personal") {
      // The machine already has its assistant: open it instead of a second one.
      const assistant = findMachineAssistant(projects, newProjectFlow.environmentId);
      if (assistant) {
        openMachineAssistant(assistant);
        return;
      }
    }
    newProjectSubmittingRef.current = true;
    setIsCreatingNewProject(true);
    try {
      const created = await createNewProject({
        environmentId: newProjectFlow.environmentId,
        name: newProjectName,
        kind: newProjectFlow.kind,
        ...(newProjectFlow.kind === "code" && folderChoice.path
          ? { parentPath: folderChoice.path }
          : {}),
        github:
          newProjectFlow.kind === "code" && newProjectPublishesToGitHub
            ? newProjectGitHubTarget
            : null,
      });
      if (created) {
        if (newProjectFlow.kind === "code") newProjectDraft.keep("");
        setOpen(false);
      }
    } finally {
      newProjectSubmittingRef.current = false;
      setIsCreatingNewProject(false);
    }
  }

  async function submitAddProjectCloneFlow(_destinationPathInput?: string): Promise<void> {
    if (!addProjectCloneFlow) {
      return;
    }
    if (!canCreateProjectInEnvironment(browseEnvironment?.connection.phase)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Environment unavailable",
          description: `${browseEnvironment?.label ?? "The selected environment"} is not connected.`,
        }),
      );
      return;
    }

    if (addProjectCloneFlow.step === "repository") {
      const rawRepository = query.trim();
      if (rawRepository.length === 0 || isRemoteProjectLookingUp) {
        return;
      }

      const provider = remoteProjectSourceProvider(addProjectCloneFlow.source);
      if (!provider) {
        setAddProjectCloneFlow({
          step: "confirm",
          environmentId: addProjectCloneFlow.environmentId,
          source: addProjectCloneFlow.source,
          repositoryInput: rawRepository,
          repository: null,
          remoteUrl: normalizePastedCloneUrl(rawRepository),
        });
        setHighlightedItemValue(null);
        setQuery("");
        setBrowseGeneration((generation) => generation + 1);
        return;
      }

      setIsRemoteProjectLookingUp(true);
      const lookupGeneration = ++cloneLookupGeneration.current;
      const lookupResult = await lookupRepository({
        environmentId: addProjectCloneFlow.environmentId,
        input: {
          provider,
          repository: rawRepository,
        },
      });
      if (lookupGeneration !== cloneLookupGeneration.current) return;
      setIsRemoteProjectLookingUp(false);
      if (lookupResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(lookupResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Repository lookup failed",
              description: errorMessage(squashAtomCommandFailure(lookupResult)),
            }),
          );
        }
        return;
      }
      const repository = lookupResult.value;
      setAddProjectCloneFlow({
        step: "confirm",
        environmentId: addProjectCloneFlow.environmentId,
        source: addProjectCloneFlow.source,
        repositoryInput: rawRepository,
        repository,
        remoteUrl: getDefaultCloneUrl(repository),
      });
      setHighlightedItemValue(null);
      setQuery("");
      setBrowseGeneration((generation) => generation + 1);
      return;
    }

    if (cloneFolderChoice.path === null) return;
    const rawDestination = getCloneDestinationPath(
      cloneFolderChoice.path,
      getCloneDirectoryName(
        addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.remoteUrl,
      ),
    );
    if (
      !readEnvironmentScope(addProjectCloneFlow.environmentId, AuthSourceControlWriteScope) ||
      !readEnvironmentScope(addProjectCloneFlow.environmentId, AuthOrchestrationOperateScope)
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone unavailable",
          description: "This connection needs permission to write source control and add projects.",
        }),
      );
      return;
    }
    if (rawDestination.length === 0 || isRemoteProjectCloning) return;

    if (isUnsupportedWindowsProjectPath(rawDestination, browseEnvironmentPlatform)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone failed",
          description: "Windows-style paths are only supported on Windows.",
        }),
      );
      return;
    }

    if (isExplicitRelativeProjectPath(rawDestination) && !currentProjectCwdForBrowse) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone failed",
          description: "Relative paths require an active project.",
        }),
      );
      return;
    }

    const destinationPath = resolveProjectPathForDispatch(
      rawDestination,
      currentProjectCwdForBrowse,
    );
    if (destinationPath.length === 0) {
      return;
    }

    // Older servers only offer the blocking clone: the palette has to wait
    // for git so it can add the project afterwards.
    if (browseEnvironment?.serverConfig?.environment.capabilities.projectCloneTracking !== true) {
      setIsRemoteProjectCloning(true);
      const cloneResult = await cloneRepository({
        environmentId: addProjectCloneFlow.environmentId,
        input: {
          remoteUrl: addProjectCloneFlow.remoteUrl,
          destinationPath,
        },
      });
      setIsRemoteProjectCloning(false);
      if (cloneResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(cloneResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Clone failed",
              description: errorMessage(squashAtomCommandFailure(cloneResult)),
            }),
          );
        }
        return;
      }
      await handleAddProject(cloneResult.value.cwd);
      return;
    }

    // The server creates the project and clones in the background; progress
    // shows in a toast and in the draft's composer banner, so the palette
    // closes as soon as the clone is under way. Only problems found before
    // git runs (bad destination, unknown repository) come back here.
    const projectId = newProjectId();
    setIsRemoteProjectCloning(true);
    const startResult = await startProjectClone({
      environmentId: addProjectCloneFlow.environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(destinationPath),
        createdAt: new Date().toISOString(),
        remoteUrl: addProjectCloneFlow.remoteUrl,
        destinationPath,
      },
    });
    setIsRemoteProjectCloning(false);
    if (startResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(startResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Clone failed",
            description: errorMessage(squashAtomCommandFailure(startResult)),
          }),
        );
      }
      return;
    }
    setOpen(false);
    const projectRef = scopeProjectRef(addProjectCloneFlow.environmentId, projectId);
    // The create event usually lands before this call returns; give the shell
    // stream a moment so the draft opens with its project resolved instead of
    // flashing the project picker.
    await waitForProject(projectRef, 3_000).catch(() => null);
    const navigationResult = await settlePromise(() => handleNewThread(projectRef));
    if (navigationResult._tag === "Failure") {
      const error = squashAtomCommandFailure(navigationResult);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to open project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }

  const browseTo = useCallback(
    async (name: string): Promise<void> => {
      const nextQuery = pinnedCloneDirectoryName
        ? getCloneDestinationBrowsePath({
            browseDirectoryPath: browsePath.directoryPath,
            selectedDirectoryName: name,
            cloneDirectoryName: pinnedCloneDirectoryName,
            caseSensitive: !isWindowsPlatform(browseEnvironmentPlatform),
          })
        : appendBrowsePathSegment(query, name);
      await browseNavigation.run(
        () => prefetchBrowsePath(getBrowseDirectoryPath(nextQuery)),
        () => {
          setHighlightedItemValue(null);
          setQuery(nextQuery);
          setBrowseGeneration((generation) => generation + 1);
        },
      );
    },
    [
      browseNavigation,
      browseEnvironmentPlatform,
      browsePath.directoryPath,
      pinnedCloneDirectoryName,
      prefetchBrowsePath,
      query,
    ],
  );

  const browseUp = useCallback(async (): Promise<void> => {
    const parentPath = browsePath.parentPath;
    if (parentPath === null) {
      return;
    }

    const nextQuery = getCloneDestinationPath(parentPath, pinnedCloneDirectoryName);
    await browseNavigation.run(
      () => prefetchBrowsePath(parentPath),
      () => {
        setHighlightedItemValue(null);
        setQuery(nextQuery);
        setBrowseGeneration((generation) => generation + 1);
      },
    );
  }, [browseNavigation, browsePath.parentPath, pinnedCloneDirectoryName, prefetchBrowsePath]);

  // Resolve the add-project path from browse data when available. When the
  // query has a trailing separator (e.g. "~/projects/foo/"), parentPath is the
  // directory itself. Otherwise the user typed a partial leaf name, so we need
  // the exact browse entry's fullPath or fall back to the raw query.
  const resolvedAddProjectPath = hasTrailingPathSeparator(query)
    ? (browseResult?.parentPath ?? query.trim())
    : (exactBrowseEntry?.fullPath ?? query.trim());

  const canBrowseUp = !relativePathNeedsActiveProject && browsePath.canBrowseUp;

  const browseGroups = buildBrowseGroups({
    browseEntries: visibleBrowseEntries,
    browseQuery: query,
    canBrowseUp,
    upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
    directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
    browseUp,
    browseTo,
  });
  const remoteProjectContext = useMemo(() => {
    if (addProjectCloneFlow?.step !== "confirm") {
      return null;
    }

    return {
      title: addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.repositoryInput,
      description: addProjectCloneFlow.repository?.url ?? addProjectCloneFlow.remoteUrl,
      icon: remoteProjectSourceIcon(addProjectCloneFlow.source, ITEM_ICON_CLASS),
    };
  }, [addProjectCloneFlow]);

  const newProjectsRoot = folderChoice.path;
  const newProjectPathPreview =
    newProjectsRoot === null ? null : getNewProjectPathPreview(newProjectsRoot, newProjectName);
  const newProjectGitHubToggleValue = "new-project:github";
  const showExistingProjectSources = (environmentId: EnvironmentId) => {
    const sourcesEnvironmentId = newProjectFlow?.sourcesEnvironmentId ?? null;
    if (sourcesEnvironmentId === environmentId) {
      popView();
      return;
    }
    if (sourcesEnvironmentId !== null) {
      setViewStack((previousViews) => previousViews.slice(0, -1));
    }
    popView();
    startAddProjectSourceSelection(environmentId);
  };
  // Each machine keeps its own chosen folder, so switching back restores it.
  const switchNewProjectEnvironment = (environmentId: EnvironmentId) => {
    setNewProjectFlow((flow) => (flow === null ? flow : { ...flow, environmentId }));
    setAddProjectEnvironmentId(environmentId);
  };
  const selectedNewProjectEnvironment =
    newProjectFlow === null
      ? undefined
      : newProjectEnvironmentOptions.find(
          (option) => option.environmentId === newProjectFlow.environmentId,
        );
  const newProjectEnvironmentLabel =
    newProjectFlow === null
      ? null
      : (selectedNewProjectEnvironment?.label ??
        environmentLabelById.get(newProjectFlow.environmentId) ??
        null);
  let displayedGroups: CommandPaletteView["groups"] = filteredGroups;
  if (newProjectFlow !== null) {
    displayedGroups = projectCreationGroups({
      kind: newProjectFlow.kind,
      busy: isCreatingNewProject,
      machines: addProjectEnvironmentOptions
        .filter(
          (option) =>
            newProjectFlow.kind === "code" || option.environmentId === newProjectFlow.environmentId,
        )
        .map((option) => ({
          item: buildEnvironmentItem(
            option,
            `new-project:environment:${option.environmentId}`,
            switchNewProjectEnvironment,
          ),
          selected: option.environmentId === newProjectFlow.environmentId,
        })),
      github:
        newProjectGitHubTarget && newProjectPathPreview
          ? {
              description: newProjectName
                ? getNewProjectGitHubRepository(newProjectGitHubTarget, newProjectPathPreview)
                : (newProjectGitHubTarget.account ?? "Your GitHub account"),
              checked: newProjectPublishesToGitHub,
              toggle: () => setNewProjectPublishesToGitHub((value) => !value),
            }
          : null,
      addExisting: () => showExistingProjectSources(newProjectFlow.environmentId),
    });
  } else if (addProjectCloneFlow?.step === "repository") {
    displayedGroups = [];
  } else if (addProjectCloneFlow?.step === "confirm") {
    displayedGroups = [
      projectMachineGroup(
        addProjectEnvironmentOptions.map((option) => ({
          item: buildEnvironmentItem(
            option,
            `clone-machine:${option.environmentId}`,
            (environmentId) => {
              cloneFolderChoice.reset();
              setAddProjectEnvironmentId(environmentId);
              setAddProjectCloneFlow((flow) => (flow === null ? null : { ...flow, environmentId }));
            },
          ),
          selected: option.environmentId === addProjectCloneFlow.environmentId,
        })),
        isRemoteProjectCloning,
      ),
    ];
  } else if (isBrowsing) {
    displayedGroups = relativePathNeedsActiveProject ? [] : browseGroups;
  }
  const resultRows = buildCommandPaletteRows(displayedGroups);
  const autoHighlightsFirstRow =
    !isBrowsing && !isRemoteProjectCloneFlow && newProjectFlow === null;

  const inputPlaceholder =
    addProjectCloneFlow?.step === "confirm"
      ? "Choose a clone location below"
      : newProjectFlow !== null
        ? newProjectFlow.kind === "personal"
          ? `Name your assistant, or keep ${DEFAULT_PERSONAL_ASSISTANT_NAME}`
          : "Project name"
        : (remoteProjectInputPlaceholder(addProjectCloneFlow) ??
          getCommandPaletteInputPlaceholder(paletteMode));
  const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";
  const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
  const canWriteSourceControl = useEnvironmentScope(
    addProjectCloneFlow?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const canCreateClonedProject = useEnvironmentScope(
    addProjectCloneFlow?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canCloneProject = canWriteSourceControl && canCreateClonedProject;
  const isCloneDestinationStep = addProjectCloneFlow?.step === "confirm";
  const canSubmitBrowsePath =
    isBrowsing &&
    !relativePathNeedsActiveProject &&
    canCreateProject &&
    (!isCloneDestinationStep || canCloneProject) &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);
  const willCreateProjectPath =
    canSubmitBrowsePath &&
    !isBrowsePending &&
    browseAccessError === null &&
    query.trim().length > 0 &&
    !hasHighlightedBrowseItem &&
    (hasTrailingPathSeparator(query) ? !browseResult : exactBrowseEntry === null);
  const useMetaForMod = isMacPlatform(navigator.platform);
  const submitModifierLabel = useMetaForMod ? "\u2318" : "Ctrl";
  const submitActionLabel = isCloneDestinationStep
    ? willCreateProjectPath
      ? "Create & Clone"
      : "Clone"
    : willCreateProjectPath
      ? "Create & Add"
      : "Add";
  const addShortcutLabel = hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter";
  const remoteProjectButtonLabel = addProjectCloneFlow
    ? addProjectCloneFlow.source === "url"
      ? "Continue"
      : "Lookup"
    : null;
  const isRemoteProjectPending = isRemoteProjectLookingUp || isRemoteProjectCloning;
  const canSubmitRemoteProjectFlow =
    addProjectCloneFlow?.step === "repository" &&
    query.trim().length > 0 &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase) &&
    !isRemoteProjectPending;
  const fileManagerName = getLocalFileManagerName(navigator.platform);
  const canOpenProjectFromFileManager =
    isBrowsing &&
    browseEnvironmentId !== null &&
    // For a desktop-local (WSL) env, only offer the picker once we have resolved
    // its desktop pool instance id. Without it pickFolder can't be routed to the
    // WSL filesystem and would open the primary (Windows) picker, then add the
    // chosen Windows path against the WSL env -- a wrong-path footgun. Stay
    // hidden until the bootstrap mapping is available rather than mis-routing.
    (browseEnvironmentId === primaryEnvironmentId ||
      (browseEnvironmentIsDesktopLocal && browseDesktopInstanceId !== null)) &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;
  const fileManagerInitialPath = useMemo(() => {
    if (!canOpenProjectFromFileManager) {
      return undefined;
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return undefined;
    }

    const initialPath = hasTrailingPathSeparator(query)
      ? (browseResult?.parentPath ?? trimmedQuery)
      : browseDirectoryPath || trimmedQuery;

    const resolvedPath = resolveProjectPathForDispatch(initialPath, currentProjectCwdForBrowse);
    return resolvedPath.length > 0 ? resolvedPath : undefined;
  }, [
    browseDirectoryPath,
    browseResult?.parentPath,
    canOpenProjectFromFileManager,
    currentProjectCwdForBrowse,
    query,
  ]);

  function isPrimaryModifierPressed(event: KeyboardEvent<HTMLInputElement>): boolean {
    return useMetaForMod ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: { modelPickerOpen: false },
    });
    if (threadJumpIndexFromCommand(command ?? "") !== null) {
      event.preventDefault();
      event.stopPropagation();
      const matchingItem = displayedGroups
        .flatMap((group) => group.items)
        .find((item) => item.shortcutCommand === command);
      if (matchingItem) {
        executeItem(matchingItem);
      }
      return;
    }
    if (command === "thread.copyReference") {
      event.preventDefault();
      event.stopPropagation();
      if (activeThreadReferenceCopyTarget === null) return;
      setOpen(false);
      void copyActiveThreadReference();
      return;
    }

    if (
      addProjectCloneFlow &&
      (addProjectCloneFlow.step === "repository" || highlightedItemValue === null) &&
      event.key === "Enter" &&
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      void submitAddProjectCloneFlow();
      return;
    }

    // Enter creates the project unless an item below the name is
    // highlighted, in which case it runs that item.
    if (
      newProjectFlow !== null &&
      event.key === "Enter" &&
      highlightedItemValue === null &&
      // Enter that confirms an IME composition is part of typing the name.
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      void submitNewProject();
      return;
    }

    const shouldSubmitBrowsePath =
      canSubmitBrowsePath &&
      event.key === "Enter" &&
      (!hasHighlightedBrowseItem || isPrimaryModifierPressed(event));

    if (shouldSubmitBrowsePath) {
      event.preventDefault();
      if (isCloneDestinationStep) {
        void submitAddProjectCloneFlow(resolvedAddProjectPath);
      } else {
        void handleAddProject(resolvedAddProjectPath);
      }
      return;
    }

    // Clearing the name with a held Backspace must not leave New project.
    if (event.key === "Backspace" && query === "" && isSubmenu && newProjectFlow === null) {
      event.preventDefault();
      popView();
      return;
    }

    // Base UI ignores navigation keys with modifiers, so these fallbacks do too.
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    // Base UI only keeps a hidden highlight on the first row when it auto-highlights.
    const firstItemValue = autoHighlightsFirstRow ? resultRows.itemValues[0] : undefined;
    if (
      event.key === "ArrowDown" &&
      highlightClearedRef.current &&
      firstItemValue &&
      !event.nativeEvent.isComposing
    ) {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      highlightClearedRef.current = false;
      setHighlightedItemValue(firstItemValue);
      scrollCommandPaletteRowIntoView(
        resultListRef.current,
        resultRows.rowIndexByItemIndex[0] ?? 0,
      );
      return;
    }

    // Base UI clicks the highlighted row on Enter, which does nothing once the
    // virtualized list has unmounted it, so run the tracked highlight directly.
    if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      const highlightedItem = findHighlightedCommandPaletteItem(
        displayedGroups,
        highlightedItemValue ?? firstItemValue ?? null,
      );
      if (highlightedItem) {
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        event.preventDefault();
        event.stopPropagation();
        executeItem(highlightedItem);
      }
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }

    if (item.kind === "submenu") {
      pushView(item);
      return;
    }

    if (!item.keepOpen) {
      setOpen(false);
    }

    void item.run().catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to run command",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  }

  const handleOpenProjectFromFileManager = useCallback(async () => {
    if (!canOpenProjectFromFileManager || isPickingProjectFolder) {
      return;
    }
    const api = readLocalApi();
    if (!api) {
      return;
    }

    setIsPickingProjectFolder(true);
    let pickedPath: string | null = null;
    let desktopWslState: DesktopWslState | null = null;
    try {
      desktopWslState =
        browseEnvironmentId === primaryEnvironmentId && browseEnvironmentPlatform === "Linux"
          ? ((await window.desktopBridge?.getWslState().catch(() => null)) ?? null)
          : null;
      // Route the picker to the browsed env's backend filesystem. The desktop
      // only resolves a "wsl:*" pool instance id, so for a desktop-local env we
      // pass the bootstrap-mapped instance id (not the catalog environmentId).
      // A WSL-only primary has no secondary bootstrap, so resolve its instance
      // id from desktop settings. Windows and combo-mode primaries still omit
      // the target to preserve the native primary picker. The desktop converts
      // a WSL UNC selection back to a Linux path before returning.
      const pickerTargetEnvironmentId = resolveProjectPickerTarget({
        browseEnvironmentId,
        primaryEnvironmentId,
        desktopInstanceId: browseDesktopInstanceId,
        wslConfiguration: desktopWslState,
      });
      const pickerOptions = {
        ...(fileManagerInitialPath ? { initialPath: fileManagerInitialPath } : {}),
        ...(pickerTargetEnvironmentId ? { targetEnvironmentId: pickerTargetEnvironmentId } : {}),
      };
      pickedPath = await api.dialogs.pickFolder(
        Object.keys(pickerOptions).length > 0 ? pickerOptions : undefined,
      );
    } catch {
      // Ignore picker failures and leave the palette open.
      setIsPickingProjectFolder(false);
      return;
    }
    setIsPickingProjectFolder(false);
    if (!pickedPath) {
      return;
    }
    if (parseWslUncPath(pickedPath)) {
      desktopWslState ??= (await window.desktopBridge?.getWslState().catch(() => null)) ?? null;
      let primaryRunningDistro: string | null = null;
      try {
        primaryRunningDistro =
          window.desktopBridge
            ?.getLocalEnvironmentBootstraps()
            .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ??
          null;
      } catch {
        // Keep UNC routing strict when the live primary identity cannot be read.
      }
      const selection = resolveWslProjectSelection(
        pickedPath,
        applyWslEnvironmentConfiguration(
          environments.flatMap((environment) => {
            const backendId = desktopLocalBackendId(environment.entry.target);
            if (!backendId) {
              return [];
            }

            const bootstrap = desktopLocalBootstraps.find(
              (candidate) => candidate.httpBaseUrl === environment.displayUrl,
            );
            const runningDistro = bootstrap?.runningDistro ?? null;
            return [{ environmentId: environment.environmentId, backendId, runningDistro }];
          }),
          primaryEnvironmentId,
          desktopWslState ?? null,
          primaryRunningDistro,
        ),
      );
      if (!selection) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not add WSL project",
            description: "Start the matching WSL backend, then choose the folder again.",
          }),
        );
        return;
      }
      await handleAddProjectForEnvironment({
        environmentId: selection.environmentId,
        rawCwd: selection.linuxPath,
        platform: "Linux",
        currentProjectCwd: null,
      });
      return;
    }
    await handleAddProject(pickedPath);
  }, [
    browseDesktopInstanceId,
    browseEnvironmentId,
    browseEnvironmentPlatform,
    canOpenProjectFromFileManager,
    desktopLocalBootstraps,
    environments,
    fileManagerInitialPath,
    handleAddProject,
    handleAddProjectForEnvironment,
    isPickingProjectFolder,
    primaryEnvironmentId,
  ]);

  const inputAccessory =
    newProjectFlow !== null ? null : addProjectCloneFlow?.step === "repository" ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
              aria-label={`${remoteProjectButtonLabel ?? "Continue"} (Enter)`}
              disabled={!canSubmitRemoteProjectFlow}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                void submitAddProjectCloneFlow();
              }}
            />
          }
        >
          <span>{isRemoteProjectPending ? "Working" : remoteProjectButtonLabel}</span>
          <KbdGroup className="pointer-events-none -me-0.5">
            <Kbd>Enter</Kbd>
          </KbdGroup>
        </TooltipTrigger>
        <TooltipPopup side="top">{remoteProjectButtonLabel ?? "Continue"} (Enter)</TooltipPopup>
      </Tooltip>
    ) : isCloneDestinationStep ? null : isBrowsing ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
              aria-label={`${submitActionLabel} (${addShortcutLabel})`}
              disabled={
                !canCreateProject ||
                !canCreateProjectInEnvironment(browseEnvironment?.connection.phase) ||
                relativePathNeedsActiveProject ||
                (isCloneDestinationStep && (!canCloneProject || isRemoteProjectPending))
              }
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                if (relativePathNeedsActiveProject) {
                  return;
                }
                if (isCloneDestinationStep) {
                  void submitAddProjectCloneFlow(resolvedAddProjectPath);
                } else {
                  void handleAddProject(resolvedAddProjectPath);
                }
              }}
            />
          }
        >
          <span>
            {isCloneDestinationStep && isRemoteProjectPending ? "Cloning" : submitActionLabel}
          </span>
          <KbdGroup className="pointer-events-none -me-0.5">
            <Kbd>{hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter"}</Kbd>
          </KbdGroup>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {isCloneDestinationStep && !canCloneProject
            ? "This connection needs permission to write source control and add projects."
            : canCreateProject
              ? `${submitActionLabel} (${addShortcutLabel})`
              : "This connection cannot add projects."}
        </TooltipPopup>
      </Tooltip>
    ) : null;

  const footerActionLabel =
    newProjectFlow !== null
      ? highlightedItemValue === null
        ? "Create"
        : highlightedItemValue === newProjectGitHubToggleValue
          ? "Toggle"
          : "Select"
      : addProjectCloneFlow?.step === "repository"
        ? (remoteProjectButtonLabel ?? "Continue")
        : !canSubmitBrowsePath || hasHighlightedBrowseItem
          ? "Select"
          : undefined;

  const footerTrailing = canOpenProjectFromFileManager ? (
    <CommandFooterAction
      disabled={isPickingProjectFolder}
      onClick={() => {
        void handleOpenProjectFromFileManager();
      }}
    >
      {`Open in ${fileManagerName}`}
    </CommandFooterAction>
  ) : null;

  return (
    <CommandPaletteContent
      key={`${viewStack.length}-${browseGeneration}-${isBrowsing}-${newProjectFlow ? "new-project" : (addProjectCloneFlow?.step ?? "none")}`}
      aria-label="Command palette"
      autoHighlight={autoHighlightsFirstRow ? "always" : false}
      footerActionLabel={footerActionLabel}
      footerTrailing={footerTrailing}
      inputAccessory={inputAccessory}
      primaryAction={
        newProjectFlow !== null ? (
          <ProjectCreationAction
            kind={newProjectFlow.kind}
            hasName={newProjectName.length > 0}
            hasFolder={folderChoice.path !== null}
            canCreate={canCreateProject}
            connected={canCreateProjectInEnvironment(browseEnvironment?.connection.phase)}
            busy={isCreatingNewProject}
            onCreate={() => void submitNewProject()}
          />
        ) : null
      }
      inputProps={{
        // The submit button is absolutely positioned over the field, so the
        // inner input must reserve enough room for the full action label.
        className:
          addProjectCloneFlow?.step === "repository"
            ? "*:data-[slot=autocomplete-input]:pe-32!"
            : isBrowsing
              ? browseInputEndPaddingClass({
                  willCreateProjectPath,
                  hasHighlightedBrowseItem,
                })
              : undefined,
        placeholder: inputPlaceholder,
        ...(newProjectFlow !== null
          ? {
              "aria-label": "Project name",
              onClick: clearTypedHighlight,
              onFocus: clearTypedHighlight,
            }
          : {}),
        ...(isSubmenu
          ? {
              startAddon: (
                <button
                  type="button"
                  className="flex cursor-pointer items-center"
                  aria-label="Back"
                  onClick={popView}
                >
                  <ArrowLeftIcon />
                </button>
              ),
            }
          : isBrowsing
            ? { startAddon: <FolderPlusIcon /> }
            : {}),
        onKeyDown: handleKeyDown,
      }}
      mode="none"
      {...(newProjectFlow === null ? { items: resultRows.itemValues } : {})}
      virtualized={newProjectFlow === null && !isCloneDestinationStep}
      panelSize={newProjectFlow === null && !isCloneDestinationStep ? "list" : "form"}
      onItemHighlighted={(value, eventDetails) => {
        if (eventDetails.reason === "none" && highlightClearedRef.current) return;
        highlightClearedRef.current = false;
        setHighlightedItemValue(typeof value === "string" ? value : null);
        const rowIndex = resultRows.rowIndexByItemIndex[eventDetails.index];
        if (eventDetails.reason === "keyboard" && rowIndex !== undefined) {
          scrollCommandPaletteRowIntoView(resultListRef.current, rowIndex);
        }
      }}
      onValueChange={handleQueryChange}
      showBackHint={isSubmenu && newProjectFlow === null}
      value={query}
    >
      {newProjectFlow !== null ? (
        <ProjectCreationPreview
          kind={newProjectFlow.kind}
          name={query.trim()}
          path={newProjectPathPreview}
          root={newProjectsRoot}
          machine={newProjectEnvironmentLabel}
        />
      ) : null}
      {newProjectFlow?.kind === "code" ? folderChoice.picker : null}
      {remoteProjectContext ? (
        <div className="p-2 pb-0">
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Repository</div>
          <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
            {remoteProjectContext.icon}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-foreground text-sm">{remoteProjectContext.title}</span>
              <span className="truncate text-muted-foreground text-xs">
                {remoteProjectContext.description}
              </span>
            </span>
          </div>
        </div>
      ) : null}
      {isCloneDestinationStep ? (
        <CloneProjectDestination
          machine={browseEnvironment?.label ?? "Selected machine"}
          path={
            cloneFolderChoice.path === null
              ? null
              : getCloneDestinationPath(cloneFolderChoice.path, pinnedCloneDirectoryName)
          }
          picker={cloneFolderChoice.picker}
          busy={isRemoteProjectPending}
          allowed={
            canCloneProject && canCreateProjectInEnvironment(browseEnvironment?.connection.phase)
          }
          onClone={() => void submitAddProjectCloneFlow()}
        />
      ) : null}
      {!isCloneDestinationStep && browseAccessError ? (
        <div role="alert" className="px-4 py-3 text-sm text-muted-foreground">
          {browseAccessError}
        </div>
      ) : isCheckingFolderCopies ? (
        <div role="status" className="px-4 py-3 text-sm text-muted-foreground">
          Looking for copies on other machines...
        </div>
      ) : isBrowsePending && browseResult === null ? (
        <div role="status" className="px-4 py-3 text-sm text-muted-foreground">
          Loading folders...
        </div>
      ) : null}
      {isCloneDestinationStep || newProjectFlow !== null ? (
        <CommandPaletteResults
          groups={displayedGroups}
          highlightedItemValue={highlightedItemValue}
          isActionsOnly={false}
          keybindings={keybindings}
          onExecuteItem={executeItem}
        />
      ) : (
        <CommandPaletteVirtualizedResults
          rows={resultRows.rows}
          listRef={resultListRef}
          highlightedItemValue={highlightedItemValue}
          isActionsOnly={isActionsOnly}
          keybindings={keybindings}
          onExecuteItem={executeItem}
          {...(addProjectCloneFlow?.step === "repository"
            ? {
                emptyStateMessage:
                  addProjectCloneFlow.source === "url"
                    ? "Enter a Git clone URL and press Enter to continue."
                    : "Enter a repository path and press Enter to look it up.",
              }
            : relativePathNeedsActiveProject
              ? { emptyStateMessage: "Relative paths require an active project." }
              : willCreateProjectPath
                ? {
                    emptyStateMessage: "Press Enter to create this folder and add it as a project.",
                  }
                : threadSearch.isPending
                  ? { emptyStateMessage: "Searching thread messages…" }
                  : {})}
        />
      )}
    </CommandPaletteContent>
  );
}

function ProjectSearchDescription(props: {
  readonly environmentLabels: ReadonlyArray<string>;
  readonly grouped: boolean;
  readonly location: {
    readonly kind: "local" | "remote";
    readonly label: string;
    readonly machine: EnvironmentMachineKind;
  };
  readonly workspaceRoot: string;
}) {
  if (!props.grouped) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="inline-flex min-w-0 items-center gap-1">
          {props.location.kind === "remote" ? (
            <EnvironmentMachineIcon
              aria-hidden
              kind={props.location.machine}
              className={COMMAND_PALETTE_META_ICON_CLASS}
            />
          ) : null}
          <span className="truncate">{props.location.label}</span>
        </span>
        <CommandPaletteMetaDot />
        <span className="truncate">{props.workspaceRoot}</span>
      </span>
    );
  }

  return <span className="truncate">{props.environmentLabels.join(" · ")}</span>;
}
