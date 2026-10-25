import { createElement } from "react";
import type {
  EnvironmentId,
  ProjectId,
  ProjectEnvironmentSettings,
  ServerSettings,
  ServerProvider,
  ModelSelection,
} from "@specweave-studio/contracts";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@specweave-studio/shared/projectSettings";
import { CoordinatorModelPicker } from "./shell/CoordinatorModelPicker";
import {
  coordinatorRequiresFolderGrants,
  coordinatorFolderCompatibility,
  type CoordinatorFolderPolicy,
} from "./coordinatorRecovery";
import { resolveAssetUrl } from "@specweave-studio/client-runtime/state/assets";
import { assetEnvironment } from "../../state/assets";
import { readPreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useCoordinatorMessageRecovery } from "./coordinatorRecovery";

type RecoveryInput = Parameters<typeof useCoordinatorMessageRecovery>[0];
/** Keep signed asset reads and the retry identity in the project's existing host scope. */
export function useProjectCoordinatorRecovery(
  input: Omit<RecoveryInput, "read" | "send"> & {
    send: (
      ...args: [
        ...Parameters<RecoveryInput["send"]>,
        retryIdentity: readonly [string | null, string],
      ]
    ) => Promise<void>;
  },
) {
  const readAsset = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCoordinatorMessageRecovery({
    ...input,
    send: (text, source, attachments, onConfirmed) =>
      input.send(text, source, attachments, onConfirmed, [
        input.failureRunId,
        input.message?.id ?? "",
      ]),
    read: async (attachment, signal) => {
      const result = await readAsset({
        environmentId: input.environmentId,
        input: {
          resource: {
            _tag: "attachment",
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
            disposition: "inline",
          },
        },
      });
      signal?.throwIfAborted();
      const connection = readPreparedConnection(input.environmentId);
      if (result._tag === "Failure" || !connection) throw new Error("Saved attachment unavailable");
      const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
      if (!url) throw new Error("Saved attachment unavailable");
      const response = await fetch(url, signal ? { signal } : undefined);
      if (!response.ok) throw new Error("Saved attachment unavailable");
      return response.blob();
    },
  });
}
/** Keep the saved model, actual running-thread policy and startup defaults in one assembly. */
export function useProjectCoordinatorModelControls(input: {
  project: LegacyProjectSettingsFields & {
    id: ProjectId;
    environmentId: EnvironmentId;
    workspaceRoot: string;
  };
  environmentSettings: ServerSettings | null | undefined;
  folderSettings: ProjectEnvironmentSettings | null | undefined;
  coordinator:
    | {
        runtimeMode: CoordinatorFolderPolicy["runtimeMode"];
        interactionMode: CoordinatorFolderPolicy["interactionMode"];
      }
    | null
    | undefined;
  providers: ReadonlyArray<ServerProvider> | null | undefined;
  model: ModelSelection | null | undefined;
  /** Actual displayed selection; a return hint exists only while the saved provider is limited. */
  running?: {
    value: ModelSelection;
    returnsTo: string | null;
    offPick?: boolean;
    /** Why the saved pick is out, with its reset time; the picker header names it. */
    reason?: string | null;
    onSwitchBack?: (() => void) | null;
    switching?: boolean;
  } | null;
  canOperate: boolean;
  connected: boolean;
  revision: number | null;
  loading: boolean;
  saving: boolean;
  retrying: boolean;
  onChange: (value: ModelSelection) => void;
  onOpenSettings: () => void;
  onOpenProjectUsage?: () => void;
}) {
  const defaults = input.environmentSettings
    ? resolveProjectSettings(input.environmentSettings, input.project.id, input.project).settings
    : null;
  const folderPolicy: CoordinatorFolderPolicy = {
    runtimeMode:
      input.coordinator?.runtimeMode ?? defaults?.defaultRuntimeMode ?? "approval-required",
    interactionMode: input.coordinator?.interactionMode ?? "default",
  };
  const requiresFolderGrants = coordinatorRequiresFolderGrants(
    input.folderSettings,
    input.project.workspaceRoot,
  );
  const selected = input.model
    ? input.providers?.find((provider) => provider.instanceId === input.model!.instanceId)
    : undefined;
  const compatibility =
    requiresFolderGrants && !selected
      ? "Coordinator provider details are still loading. Wait for the host before sending with additional folder access."
      : coordinatorFolderCompatibility(
          requiresFolderGrants,
          selected?.driver,
          folderPolicy,
          selected?.supportedRuntimeModes,
        );
  return {
    compatibility,
    controls: createElement(CoordinatorModelPicker, {
      environmentId: input.project.environmentId,
      value: input.model ?? null,
      running: input.running ?? null,
      requiresFolderGrants,
      folderPolicy,
      disabled:
        input.retrying ||
        !input.canOperate ||
        !input.connected ||
        input.revision === null ||
        input.loading,
      saving: input.saving,
      onChange: input.onChange,
      onOpenSettings: input.onOpenSettings,
      ...(input.onOpenProjectUsage ? { onOpenProjectUsage: input.onOpenProjectUsage } : {}),
    }),
  };
}
