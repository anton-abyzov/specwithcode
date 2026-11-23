import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

export interface MigrationMemoryFileSummary {
  readonly name: string;
  readonly sha256: string;
  readonly updatedAt: string;
  readonly byteLength: number;
  readonly localOnly?: boolean | undefined;
  readonly secretDetected?: boolean | undefined;
}

export interface MigrationSeatInput {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly createdAt: string;
  readonly supportsPersonalLink: boolean;
  readonly existingLogicalProjectId: string | null;
  readonly memoryFiles: ReadonlyArray<MigrationMemoryFileSummary>;
}

export interface MemoryFileClashVariant {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly projectId: ProjectId;
  readonly sha256: string;
  readonly updatedAt: string;
  readonly byteLength: number;
}

export interface MemoryFileClash {
  readonly name: string;
  readonly variants: ReadonlyArray<MemoryFileClashVariant>;
}

export type MemoryClashResolution =
  | { readonly strategy: "keep-from"; readonly environmentId: EnvironmentId }
  | { readonly strategy: "keep-both" };

export interface PersonalAssistantMigrationPlan {
  readonly canonicalSeats: ReadonlyArray<MigrationSeatInput>;
  readonly staleExtraSeats: ReadonlyArray<MigrationSeatInput>;
  readonly copiedUserdataProjectIds: ReadonlyArray<ProjectId>;
  readonly unsupportedPeers: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly machineLabel: string;
  }>;
  readonly clashes: ReadonlyArray<MemoryFileClash>;
  readonly excludedLocalOnlyCount: number;
  readonly excludedSecretCount: number;
  readonly alreadyLinkedLogicalId: string | null;
  readonly canProceed: boolean;
}

export interface PersonalAssistantMigrationError {
  readonly code:
    | "owner_approval_required"
    | "peer_unsupported_version"
    | "unresolved_clashes"
    | "insufficient_seats"
    | "snapshot_failed";
  readonly message: string;
  readonly details?: ReadonlyArray<string>;
}

export interface PersonalAssistantMigrationResult {
  readonly ok: boolean;
  readonly alreadyLinked: boolean;
  readonly logicalProjectId: string | null;
  readonly routineOwnerEnvironmentId: EnvironmentId | null;
  readonly snapshots: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly snapshotPath: string;
  }>;
  readonly error?: PersonalAssistantMigrationError;
}

/**
 * Inspect existing separate personal assistants (`Percy`, `PercyAnton`, `PercyM1`, etc.)
 * and compute a deterministic, side-effect-free migration plan before any write occurs.
 */
export function planPersonalAssistantMigration(
  seats: ReadonlyArray<MigrationSeatInput>,
): PersonalAssistantMigrationPlan {
  // Group by environmentId: earliest created seat is canonical; additional rows on the same machine are stale extras.
  const byEnv = new Map<string, MigrationSeatInput[]>();
  for (const seat of seats) {
    const list = byEnv.get(seat.environmentId) ?? [];
    list.push(seat);
    byEnv.set(seat.environmentId, list);
  }

  const canonicalSeats: MigrationSeatInput[] = [];
  const staleExtraSeats: MigrationSeatInput[] = [];
  for (const list of byEnv.values()) {
    const sorted = [...list].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.projectId.localeCompare(b.projectId),
    );
    canonicalSeats.push(sorted[0]!);
    staleExtraSeats.push(...sorted.slice(1));
  }

  // Detect copied userdata: the same ProjectId appearing on multiple machines.
  const projectEnvCounts = new Map<ProjectId, Set<EnvironmentId>>();
  for (const seat of canonicalSeats) {
    const envs = projectEnvCounts.get(seat.projectId) ?? new Set<EnvironmentId>();
    envs.add(seat.environmentId);
    projectEnvCounts.set(seat.projectId, envs);
  }
  const copiedUserdataProjectIds = [...projectEnvCounts.entries()]
    .filter(([, envs]) => envs.size > 1)
    .map(([projectId]) => projectId);

  // Detect mixed-version peers that lack `personalLink`.
  const unsupportedPeers = canonicalSeats
    .filter((seat) => !seat.supportsPersonalLink)
    .map((seat) => ({
      environmentId: seat.environmentId,
      machineLabel: seat.machineLabel,
    }));

  // Preview same-name memory file clashes across canonical seats (excluding localOnly and secretDetected).
  const byFilename = new Map<string, MemoryFileClashVariant[]>();
  let excludedLocalOnlyCount = 0;
  let excludedSecretCount = 0;
  for (const seat of canonicalSeats) {
    for (const file of seat.memoryFiles) {
      if (file.localOnly) {
        excludedLocalOnlyCount += 1;
        continue;
      }
      if (file.secretDetected) {
        excludedSecretCount += 1;
        continue;
      }
      const variants = byFilename.get(file.name) ?? [];
      variants.push({
        environmentId: seat.environmentId,
        machineLabel: seat.machineLabel,
        projectId: seat.projectId,
        sha256: file.sha256,
        updatedAt: file.updatedAt,
        byteLength: file.byteLength,
      });
      byFilename.set(file.name, variants);
    }
  }

  const clashes: MemoryFileClash[] = [];
  for (const [name, variants] of byFilename.entries()) {
    const distinctHashes = new Set(variants.map((v) => v.sha256));
    if (variants.length > 1 && distinctHashes.size > 1) {
      clashes.push({ name, variants });
    }
  }
  clashes.sort((a, b) => a.name.localeCompare(b.name));

  // Check if all canonical seats are already linked under one logicalProjectId (idempotency).
  const logicalIds = new Set(
    canonicalSeats
      .map((s) => s.existingLogicalProjectId)
      .filter((id): id is string => id !== null && id.length > 0),
  );
  const alreadyLinkedLogicalId =
    canonicalSeats.length > 1 &&
    logicalIds.size === 1 &&
    canonicalSeats.every((s) => s.existingLogicalProjectId !== null)
      ? [...logicalIds][0]!
      : null;

  const canProceed = canonicalSeats.length >= 2 && unsupportedPeers.length === 0;

  return {
    canonicalSeats,
    staleExtraSeats,
    copiedUserdataProjectIds,
    unsupportedPeers,
    clashes,
    excludedLocalOnlyCount,
    excludedSecretCount,
    alreadyLinkedLogicalId,
    canProceed,
  };
}

export interface ExecutePersonalAssistantMigrationInput {
  readonly seats: ReadonlyArray<MigrationSeatInput>;
  readonly ownerApproved: boolean;
  readonly routineOwnerEnvironmentId: EnvironmentId;
  readonly resolutions: Readonly<Record<string, MemoryClashResolution>>;
  readonly createSnapshot: (seat: MigrationSeatInput) => Promise<string>;
  readonly linkSeats: (input: {
    readonly canonicalSeats: ReadonlyArray<MigrationSeatInput>;
    readonly staleExtraSeats: ReadonlyArray<MigrationSeatInput>;
    readonly routineOwnerEnvironmentId: EnvironmentId;
    readonly resolutions: Readonly<Record<string, MemoryClashResolution>>;
  }) => Promise<{ readonly logicalProjectId: string }>;
}

/**
 * Execute an owner-approved migration of separate personal assistants into one
 * linked personal assistant:
 * 1. Requires explicit owner approval.
 * 2. Refuses mixed-version peers lacking `personalLink`.
 * 3. Refuses unresolved same-name memory clashes (no silent overwrite).
 * 4. Idempotent when seats are already linked under one logicalProjectId.
 * 5. Creates a pre-merge DB snapshot on every participating machine before linking.
 */
export async function executePersonalAssistantMigration(
  input: ExecutePersonalAssistantMigrationInput,
): Promise<PersonalAssistantMigrationResult> {
  const plan = planPersonalAssistantMigration(input.seats);

  if (plan.canonicalSeats.length < 2) {
    return {
      ok: false,
      alreadyLinked: false,
      logicalProjectId: null,
      routineOwnerEnvironmentId: null,
      snapshots: [],
      error: {
        code: "insufficient_seats",
        message: "At least two machines with personal assistants are required to link.",
      },
    };
  }

  if (plan.alreadyLinkedLogicalId !== null) {
    return {
      ok: true,
      alreadyLinked: true,
      logicalProjectId: plan.alreadyLinkedLogicalId,
      routineOwnerEnvironmentId: input.routineOwnerEnvironmentId,
      snapshots: [],
    };
  }

  if (!input.ownerApproved) {
    return {
      ok: false,
      alreadyLinked: false,
      logicalProjectId: null,
      routineOwnerEnvironmentId: null,
      snapshots: [],
      error: {
        code: "owner_approval_required",
        message: "Merging separate personal assistants requires explicit owner approval.",
      },
    };
  }

  if (plan.unsupportedPeers.length > 0) {
    return {
      ok: false,
      alreadyLinked: false,
      logicalProjectId: null,
      routineOwnerEnvironmentId: null,
      snapshots: [],
      error: {
        code: "peer_unsupported_version",
        message: `Update these machines before linking personal assistants: ${plan.unsupportedPeers.map((p) => p.machineLabel).join(", ")}.`,
        details: plan.unsupportedPeers.map((p) => p.environmentId),
      },
    };
  }

  const unresolved = plan.clashes.filter((clash) => input.resolutions[clash.name] === undefined);
  if (unresolved.length > 0) {
    return {
      ok: false,
      alreadyLinked: false,
      logicalProjectId: null,
      routineOwnerEnvironmentId: null,
      snapshots: [],
      error: {
        code: "unresolved_clashes",
        message: `Resolve ${unresolved.length} same-name memory file clash(es) before linking.`,
        details: unresolved.map((c) => c.name),
      },
    };
  }

  // Create a pre-merge DB snapshot on EVERY participating machine before mutating anything.
  const snapshots: Array<{ readonly environmentId: EnvironmentId; readonly snapshotPath: string }> =
    [];
  for (const seat of plan.canonicalSeats) {
    try {
      const snapshotPath = await input.createSnapshot(seat);
      snapshots.push({ environmentId: seat.environmentId, snapshotPath });
    } catch (cause) {
      return {
        ok: false,
        alreadyLinked: false,
        logicalProjectId: null,
        routineOwnerEnvironmentId: null,
        snapshots,
        error: {
          code: "snapshot_failed",
          message: `Pre-merge DB snapshot failed on ${seat.machineLabel}: ${cause instanceof Error ? cause.message : String(cause)}`,
          details: [seat.environmentId],
        },
      };
    }
  }

  const linked = await input.linkSeats({
    canonicalSeats: plan.canonicalSeats,
    staleExtraSeats: plan.staleExtraSeats,
    routineOwnerEnvironmentId: input.routineOwnerEnvironmentId,
    resolutions: input.resolutions,
  });

  return {
    ok: true,
    alreadyLinked: false,
    logicalProjectId: linked.logicalProjectId,
    routineOwnerEnvironmentId: input.routineOwnerEnvironmentId,
    snapshots,
  };
}
