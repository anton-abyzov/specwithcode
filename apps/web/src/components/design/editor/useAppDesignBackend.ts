import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  DesignError,
  type DesignAddress,
  type DesignAssetPutInput,
  type DesignSystem,
  type DesignThreadBinding,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useScratchProject } from "~/hooks/useScratchProject";
import { newMessageId, newThreadId } from "~/lib/utils";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { authEnvironment } from "~/state/auth";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { design } from "~/studio/design";
import { scheduledTaskDefaultModel } from "../../settings/scheduledTasksSettings.logic";
import { designLink } from "../gallery/designLinks";
import { useCopyDesignSystem } from "../systems/DesignSystemPicker";
import { useOwnerProjects } from "../systems/useOwnerProjects";
import type { DesignEditorBackend, DesignEditorData, DesignMessage } from "./backend";
import type { DesignApplyResponse } from "./designSession";
import { designTurnRuntimeMode } from "./turnMode";

const isDesignError = Schema.is(DesignError);

function failureText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "detail" in cause) return String(cause.detail);
  return String(cause);
}

/** The design document, its live updates and its design system, from the `design` atoms. */
export function useAppDesignDocument(
  environmentId: EnvironmentId | null,
  address: DesignAddress | null,
) {
  const target =
    environmentId === null || address === null ? null : { environmentId, input: address };
  const get = useEnvironmentQuery(target === null ? null : design.get(target));
  const watch = useEnvironmentQuery(target === null ? null : design.watch(target));
  const live = watch.data?.document ?? null;
  const document = live ?? get.data?.document ?? null;
  const systemId = document?.designSystem ?? null;
  const system = useEnvironmentQuery(
    environmentId === null || address === null || systemId === null
      ? null
      : design.systemGet({ environmentId, input: { owner: address.owner, systemId } }),
  );
  const notFound =
    isDesignError(get.failure) &&
    (get.failure.code === "not_found" || get.failure.code === "not_on_this_machine");
  return {
    initial: get.data?.document ?? null,
    live,
    system: (system.data?.system ?? null) as DesignSystem | null,
    error: get.error,
    notFound,
    notFoundDetail: isDesignError(get.failure) ? get.failure.detail : null,
    isPending: get.isPending || (get.data === null && get.error === null),
  };
}

export function useAppDesignBackend(input: {
  environmentId: EnvironmentId;
  address: DesignAddress;
  designKey: string;
  ownerLabel: string;
  title: string;
}): DesignEditorBackend {
  const { environmentId, address, designKey } = input;
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const threads = useThreadShells();
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const { openScratchProject } = useScratchProject();
  // The design's own machine, so a design opened from another machine offers that machine's systems.
  const systemList = useEnvironmentQuery(
    design.systemList({ environmentId, input: { filter: { kind: "all" } } }),
  );
  const ownerProjects = useOwnerProjects(environmentId);
  const copySystem = useCopyDesignSystem(environmentId, systemList.refresh);
  const apply = useAtomCommand(design.apply, { reportFailure: false });
  const get = useAtomQueryRunner(design.get, { reportFailure: false, refresh: true });
  const exportFile = useAtomCommand(design.exportFile, { reportFailure: false });
  const assetPut = useAtomCommand(design.assetPut, { reportFailure: false });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const access = useEnvironmentQuery(
    primaryEnvironmentId === null
      ? null
      : authEnvironment.accessChanges({ environmentId: primaryEnvironmentId, input: null }),
  );

  const projectId = address.owner.kind === "project" ? address.owner.projectId : null;
  const project =
    projects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
    ) ?? null;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const defaultModel: ModelSelection | null = useMemo(
    () => scheduledTaskDefaultModel(settings, project, entries),
    [entries, project, settings],
  );

  const transport = useMemo(
    () => ({
      apply: async (
        expectedRevision: number,
        operations: DesignOperationList,
      ): Promise<DesignApplyResponse> => {
        const result = await apply({
          environmentId,
          input: { ...address, expectedRevision, operations: [...operations] },
        });
        if (result._tag === "Success") return { ok: true, document: result.value.document };
        const cause = squashAtomCommandFailure(result);
        if (isDesignError(cause) && cause.code === "conflict")
          return {
            ok: false,
            reason: "conflict",
            ...(cause.currentRevision === undefined
              ? {}
              : { currentRevision: cause.currentRevision }),
          };
        return { ok: false, reason: "error", detail: failureText(cause) };
      },
      get: async () => {
        const result = await get({ environmentId, input: address });
        if (result._tag === "Success") return result.value.document;
        throw new Error(failureText(squashAtomCommandFailure(result)));
      },
    }),
    [address, apply, environmentId, get],
  );

  const send = useCallback(
    async (
      thread: DesignThreadBinding,
      message: DesignMessage,
      extra: Record<string, unknown> = {},
    ) => {
      const shell = threads.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.threadId,
      );
      const result = await startTurn({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: message.text,
            attachments: message.images.map((image) => ({ type: "image" as const, ...image })),
          },
          runtimeMode: designTurnRuntimeMode(
            shell?.runtimeMode,
            resolveProjectSettings(settings, shell?.projectId ?? projectId, project).settings
              .defaultRuntimeMode,
          ),
          interactionMode: shell?.interactionMode ?? "default",
          dispatchMode: "queue",
          ...extra,
        },
      });
      if (result._tag === "Failure") throw new Error(failureText(squashAtomCommandFailure(result)));
    },
    [project, projectId, settings, startTurn, threads],
  );

  const createThread = useCallback(
    async (
      message: DesignMessage,
      title: string,
      owningProjectId: ProjectId,
    ): Promise<DesignThreadBinding> => {
      if (defaultModel === null)
        throw new Error(
          "No provider is ready. Sign in to a provider in Settings > Providers, then try again.",
        );
      const projectSettings = resolveProjectSettings(settings, owningProjectId, project).settings;
      const runtimeMode = designTurnRuntimeMode(undefined, projectSettings.defaultRuntimeMode);
      const threadId = newThreadId();
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: message.text,
            attachments: message.images.map((image) => ({ type: "image" as const, ...image })),
          },
          modelSelection: defaultModel,
          titleSeed: title,
          runtimeMode,
          interactionMode: "default",
          dispatchMode: "start",
          bootstrap: {
            createThread: {
              projectId: owningProjectId,
              title,
              modelSelection: defaultModel,
              runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: new Date().toISOString(),
            },
          },
        },
      });
      if (result._tag === "Failure") throw new Error(failureText(squashAtomCommandFailure(result)));
      return { environmentId, threadId };
    },
    [defaultModel, environmentId, project, settings, startTurn],
  );

  const designBrief = useCallback(
    (first: DesignMessage | null): DesignMessage => ({
      text: [
        `You are working on the design ${designKey} with the user. Read it with design_get and change it with design_apply; the user sees every change on the canvas live.`,
        "Use the design's design system tokens instead of literal colors and sizes where one fits. Keep each change small and say what you changed.",
        first === null ? "Start by reading the design and asking what the user wants." : "",
        first?.text ?? "",
      ]
        .filter((line) => line !== "")
        .join("\n\n"),
      images: first?.images ?? [],
    }),
    [designKey],
  );

  const machine = useCallback(
    (id: EnvironmentId) => {
      const entry = environments.find((candidate) => candidate.environmentId === id);
      if (entry === undefined) return null;
      return {
        environmentId: id,
        label: entry.label,
        linked: entry.connection.phase === "connected",
      };
    },
    [environments],
  );

  const thisMachine = machine(environmentId)?.label ?? "this machine";
  const devices = (access.data?.type === "snapshot" ? access.data.payload.clientSessions : [])
    .filter((session) => !session.current)
    .map((session) => {
      // oxlint-disable-next-line studio/no-rpc-permission-bypass -- Session metadata from accessChanges, not an RPC client.
      const device = session.client;
      return (
        device.label ??
        ([device.browser, device.os].filter(Boolean).join(" on ") || device.deviceType)
      );
    });
  const machines = environments
    .filter((entry) => entry.environmentId !== environmentId)
    .map((entry) => entry.label);

  return {
    environmentId,
    address,
    transport,
    audience:
      primaryEnvironmentId === null || primaryEnvironmentId === environmentId ? "owner" : "member",
    exportFile: async (request) => {
      const result = await exportFile({ environmentId, input: { ...address, ...request } });
      if (result._tag === "Success") return result.value;
      throw new Error(failureText(squashAtomCommandFailure(result)));
    },
    assetPut: async (mimeType, data) => {
      const result = await assetPut({
        environmentId,
        input: { ...address, mimeType: mimeType as DesignAssetPutInput["mimeType"], data },
      });
      if (result._tag === "Success") return result.value.asset;
      throw new Error(failureText(squashAtomCommandFailure(result)));
    },
    sendToThread: (thread, message) => send(thread, message),
    startThread: async (first) => {
      const owning =
        projectId ??
        (await openScratchProject(environmentId, "Could not start a thread for this design"))?.id ??
        null;
      if (owning === null)
        throw new Error("This machine offers no place for a thread without a project.");
      return createThread(designBrief(first), `Design: ${input.title}`, owning);
    },
    codingThreads: threads
      .filter(
        (thread) =>
          projectId !== null &&
          thread.projectId === projectId &&
          thread.environmentId === environmentId &&
          thread.movedTo === null,
      )
      .map((thread) => ({
        binding: { environmentId: thread.environmentId, threadId: thread.id },
        title: thread.title,
      })),
    startCodingThread:
      projectId === null ? null : (message, title) => createThread(message, title, projectId),
    openThread: (thread) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: thread.environmentId, threadId: thread.threadId },
      });
    },
    machine,
    share: {
      ownerLabel: input.ownerLabel,
      thisMachine,
      devices,
      machines,
      link: designLink(input.address.owner, input.address.designId),
    },
    designSystems: {
      systems: systemList.data?.systems ?? (systemList.error ? [] : null),
      projects: ownerProjects,
      copy: (system) => copySystem(system, address.owner),
    },
  };
}

type DesignOperationList = Parameters<DesignEditorBackend["transport"]["apply"]>[1];

export type { DesignEditorData };
