import * as MachineHandoff from "../fleet/MachineHandoff.ts";
import * as ProjectConnectionRpc from "./ProjectConnectionRpc.ts";
import * as ProjectEnvironmentService from "./ProjectEnvironmentService.ts";
import { WS_METHODS } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";
import * as ProjectStarterSuggestions from "./ProjectStarterSuggestions.ts";
import * as ProjectCoordinatorService from "./ProjectCoordinatorService.ts";
import * as ProjectUsageService from "../usage/ProjectUsageService.ts";
import * as ProjectPlanRpc from "./ProjectPlanRpc.ts";
import * as ProjectSkillsService from "./ProjectSkillsService.ts";
import * as ThreadReportService from "./ThreadReportService.ts";
export const handlers = Effect.gen(function* () {
  const handoff = yield* MachineHandoff.MachineHandoff;
  const environment = yield* ProjectEnvironmentService.ProjectEnvironmentService;
  const usage = yield* ProjectUsageService.ProjectUsageService;
  const skills = yield* ProjectSkillsService.ProjectSkillsService;
  const workspace = yield* ProjectWorkspaceService.ProjectWorkspaceService;
  const coordinator = yield* ProjectCoordinatorService.ProjectCoordinatorService;
  const starters = yield* ProjectStarterSuggestions.ProjectStarterSuggestionsService;
  const reports = yield* ThreadReportService.ThreadReportService;
  return {
    [WS_METHODS.machineHandoffPrepare]: handoff.prepare,
    [WS_METHODS.machineHandoffReceive]: handoff.receive,
    ...(yield* ProjectPlanRpc.handlers),
    ...(yield* ProjectConnectionRpc.handlers),
    [WS_METHODS.projectsEnvironmentRead]: environment.read,
    [WS_METHODS.projectsEnvironmentPrepare]: environment.prepare,
    [WS_METHODS.projectsUsageRead]: usage.read,
    [WS_METHODS.projectsSkillsRead]: skills.read,
    [WS_METHODS.projectsWorkspaceRead]: workspace.readWorkspace,
    [WS_METHODS.projectsStarterSuggestions]: starters.read,
    [WS_METHODS.projectsMemoryRead]: workspace.readMemory,
    [WS_METHODS.projectsMemoryWrite]: workspace.writeMemory,
    [WS_METHODS.projectsMemoryDelete]: workspace.deleteMemory,
    [WS_METHODS.projectsLibraryRead]: workspace.readLibrary,
    [WS_METHODS.projectsLibraryAddArtifact]: workspace.addLibraryArtifact,
    [WS_METHODS.projectsThreadReportsRead]: reports.read,
    [WS_METHODS.projectsThreadReportSave]: reports.save,
    [WS_METHODS.projectsCoordinatorStart]: coordinator.start,
    [WS_METHODS.projectsCoordinatorSend]: coordinator.send,
  };
});
