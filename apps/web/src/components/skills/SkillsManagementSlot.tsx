import type { EnvironmentId, ProjectId, ProjectSkillsSnapshot } from "@specweave-studio/contracts";

export interface SkillsManagementSlotProps {
  /** The one machine the page is set up for. */
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly userLevel: boolean;
  readonly machineName: string;
  /** That machine's skills, as the page shows them; null while it scans. */
  readonly snapshot: ProjectSkillsSnapshot | null;
  /** Ask the page to read the machine again after an install or update. */
  readonly onChanged: () => void;
  /** Open a skill's detail sheet. */
  readonly onOpen: (name: string) => void;
}

/**
 * The one mount point on the Skills page for local management: the unified
 * search, "Connect a skill repo" and the update controls render here, above the
 * installed list. The page passes everything they need, so adding them does
 * not touch `ProjectSkillsSettings.tsx`.
 */
export function SkillsManagementSlot(_props: SkillsManagementSlotProps) {
  return null;
}
