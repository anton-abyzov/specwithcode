import type { EnvironmentId, VcsRef as ContractVcsRef } from "@specweave-studio/contracts";

export interface VcsRefTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query?: string | null;
}

export type VcsRef = ContractVcsRef;
