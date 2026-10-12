import { resolveAgentInstructions, type ServerSettings } from "@specweave-studio/contracts";

import type { ScopedSettingsTarget } from "./scopedSettings";

interface InstructionEnvironment {
  readonly environmentId: string;
  readonly serverConfig: { readonly settings: ServerSettings } | null;
}

export interface AgentInstructionPreview {
  readonly key: string;
  readonly label: string;
  readonly projectId: string | null;
  readonly globalInstructions: string;
  readonly projectInstructions: string;
  readonly editableInstructions: string;
}

/** Read the two saved layers independently: a project addition never replaces global rules. */
export function agentInstructionPreviews(
  targets: readonly Pick<ScopedSettingsTarget, "environmentId" | "label" | "projectId">[],
  environments: readonly InstructionEnvironment[],
): readonly AgentInstructionPreview[] {
  return targets.map((target) => {
    const settings = environments.find(
      (environment) => environment.environmentId === target.environmentId,
    )?.serverConfig?.settings;
    const globalInstructions = settings?.agentInstructions ?? "";
    const projectInstructions =
      target.projectId === null
        ? ""
        : (settings?.projectSettingsOverrides[target.projectId]?.agentInstructions ?? "");
    return {
      key: `${target.environmentId}:${target.projectId ?? "all"}`,
      label: target.label,
      projectId: target.projectId,
      globalInstructions,
      projectInstructions,
      editableInstructions: target.projectId === null ? globalInstructions : projectInstructions,
    };
  });
}

export function previewAgentInstructions(preview: AgentInstructionPreview, draft?: string): string {
  return resolveAgentInstructions({
    globalInstructions:
      preview.projectId === null
        ? (draft ?? preview.globalInstructions)
        : preview.globalInstructions,
    projectInstructions: preview.projectId === null ? "" : (draft ?? preview.projectInstructions),
  });
}

export function instructionValuesAreMixed(previews: readonly AgentInstructionPreview[]): boolean {
  return previews.some(
    (preview) => preview.editableInstructions !== previews[0]?.editableInstructions,
  );
}
