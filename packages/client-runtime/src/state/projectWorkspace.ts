import { WS_METHODS } from "@specweave-studio/contracts";
import type * as Crypto from "effect/Crypto";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Project identity always travels with the destination environment. No mount starts a worker. */
export function createProjectWorkspaceAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  return {
    connections: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-connections:read",
      tag: WS_METHODS.projectsConnectionsRead,
      staleTimeMs: 0,
      idleTtlMs: 30_000,
    }),
    connectionSave: createEnvironmentRpcCommand(runtime, {
      label: "project-connections:save",
      tag: WS_METHODS.projectsConnectionSave,
    }),
    connectionCheck: createEnvironmentRpcCommand(runtime, {
      label: "project-connections:check",
      tag: WS_METHODS.projectsConnectionCheck,
    }),
    connectionRevoke: createEnvironmentRpcCommand(runtime, {
      label: "project-connections:revoke",
      tag: WS_METHODS.projectsConnectionRevoke,
    }),
    environmentRead: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-environment:read",
      tag: WS_METHODS.projectsEnvironmentRead,
      staleTimeMs: 0,
      idleTtlMs: 30_000,
    }),
    environmentPrepare: createEnvironmentRpcCommand(runtime, {
      label: "project-environment:prepare",
      tag: WS_METHODS.projectsEnvironmentPrepare,
    }),
    planAuthority: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-plan:authority",
      tag: WS_METHODS.projectsPlanAuthorityRead,
      staleTimeMs: 0,
      idleTtlMs: 30_000,
    }),
    plan: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-plan:read",
      tag: WS_METHODS.projectsPlanRead,
      staleTimeMs: 0,
      idleTtlMs: 30_000,
    }),
    planReplace: createEnvironmentRpcCommand(runtime, {
      label: "project-plan:replace",
      tag: WS_METHODS.projectsPlanReplace,
    }),
    planConfigure: createEnvironmentRpcCommand(runtime, {
      label: "project-plan:configure",
      tag: WS_METHODS.projectsPlanConfigure,
    }),
    planClaim: createEnvironmentRpcCommand(runtime, {
      label: "project-plan:claim",
      tag: WS_METHODS.projectsPlanClaim,
    }),
    planRelease: createEnvironmentRpcCommand(runtime, {
      label: "project-plan:release",
      tag: WS_METHODS.projectsPlanRelease,
    }),
    planReport: createEnvironmentRpcCommand(runtime, {
      label: "project-plan:report",
      tag: WS_METHODS.projectsPlanReport,
    }),
    planVerify: createEnvironmentRpcCommand(runtime, {
      label: "project-plan:verify",
      tag: WS_METHODS.projectsPlanVerify,
    }),
    planExport: createEnvironmentRpcCommand(runtime, {
      label: "project-plan:export",
      tag: WS_METHODS.projectsPlanExport,
    }),
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-workspace:read",
      tag: WS_METHODS.projectsWorkspaceRead,
      staleTimeMs: 10_000,
      idleTtlMs: 30_000,
    }),
    starterSuggestions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-workspace:starter-suggestions",
      tag: WS_METHODS.projectsStarterSuggestions,
      staleTimeMs: 60_000,
      idleTtlMs: 60_000,
    }),
    memoryRead: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-workspace:memory",
      tag: WS_METHODS.projectsMemoryRead,
      staleTimeMs: 0,
      idleTtlMs: 30_000,
    }),
    usage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-workspace:usage",
      tag: WS_METHODS.projectsUsageRead,
      staleTimeMs: 10_000,
      idleTtlMs: 30_000,
    }),
    skills: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-workspace:skills",
      tag: WS_METHODS.projectsSkillsRead,
      staleTimeMs: 10_000,
      idleTtlMs: 30_000,
    }),
    library: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-workspace:library",
      tag: WS_METHODS.projectsLibraryRead,
      staleTimeMs: 5_000,
      idleTtlMs: 30_000,
    }),
    libraryAddArtifact: createEnvironmentRpcCommand(runtime, {
      label: "project-workspace:library-add-artifact",
      tag: WS_METHODS.projectsLibraryAddArtifact,
    }),
    threadReports: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-workspace:thread-reports",
      tag: WS_METHODS.projectsThreadReportsRead,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    threadReportSave: createEnvironmentRpcCommand(runtime, {
      label: "project-workspace:thread-report-save",
      tag: WS_METHODS.projectsThreadReportSave,
    }),
    memoryWrite: createEnvironmentRpcCommand(runtime, {
      label: "project-workspace:memory-write",
      tag: WS_METHODS.projectsMemoryWrite,
    }),
    memoryDelete: createEnvironmentRpcCommand(runtime, {
      label: "project-workspace:memory-delete",
      tag: WS_METHODS.projectsMemoryDelete,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "project-workspace:start",
      tag: WS_METHODS.projectsCoordinatorStart,
    }),
    send: createEnvironmentRpcCommand(runtime, {
      label: "project-workspace:send",
      tag: WS_METHODS.projectsCoordinatorSend,
    }),
  };
}
