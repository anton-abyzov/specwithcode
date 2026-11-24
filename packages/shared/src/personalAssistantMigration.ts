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
  /**
   * Why this seat's preview could not be read (offline, refused, timed out).
   * Such a seat is unreachable, not out of date: it never counts as needing an update.
   */
  readonly previewError?: string | null | undefined;
  /** `environmentId:projectId` of every member of the seat's multi-machine link. */
  readonly existingMembers?: ReadonlyArray<string> | undefined;
  /** The seat's current identity id, one-member ones included (never reused as a new link id). */
  readonly identityId?: string | null | undefined;
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
  /** Seats whose preview failed; linking waits until they answer or are left out. */
  readonly unreachableSeats: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly machineLabel: string;
    readonly message: string;
  }>;
  /** The one multi-machine link some seats already belong to: every join reuses it. */
  readonly existingLinkId: string | null;
  /** Two or more different multi-machine links among the seats: linking is refused. */
  readonly conflictingLinkIds: ReadonlyArray<string>;
  /**
   * Members of the existing link that are not taking part (unreachable and left
   * out, or not listed here): they would never accept the new members, so
   * linking is refused until they answer or leave the link.
   */
  readonly missingLinkMembers: ReadonlyArray<string>;
  readonly canProceed: boolean;
}

export interface PersonalAssistantMigrationError {
  readonly code:
    | "owner_approval_required"
    | "peer_unsupported_version"
    | "unresolved_clashes"
    | "insufficient_seats"
    | "snapshot_failed"
    | "seat_unreachable"
    | "conflicting_links"
    | "link_member_missing";
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

  // A failed preview is an unreachable seat, never a version problem.
  const unreachableSeats = canonicalSeats
    .filter((seat) => typeof seat.previewError === "string")
    .map((seat) => ({
      environmentId: seat.environmentId,
      machineLabel: seat.machineLabel,
      message: seat.previewError as string,
    }));

  // Detect mixed-version peers that lack `personalLink`.
  const unsupportedPeers = canonicalSeats
    .filter((seat) => !seat.supportsPersonalLink && typeof seat.previewError !== "string")
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
  const conflictingLinkIds = logicalIds.size > 1 ? [...logicalIds].sort() : [];
  const existingLinkId = logicalIds.size === 1 ? [...logicalIds][0]! : null;
  // A half-finished link shares the id but some seat does not list the others yet.
  const seatKeys = canonicalSeats.map(seatKeyOf);
  const alreadyLinkedLogicalId =
    canonicalSeats.length > 1 &&
    logicalIds.size === 1 &&
    canonicalSeats.every(
      (s) =>
        s.existingLogicalProjectId !== null &&
        (s.existingMembers === undefined ||
          seatKeys.every((key) => s.existingMembers!.includes(key))),
    )
      ? existingLinkId
      : null;

  const presentKeys = new Set(seatKeys);
  const missingLinkMembers =
    existingLinkId === null
      ? []
      : [
          ...new Set(
            canonicalSeats
              .filter((s) => s.existingLogicalProjectId === existingLinkId)
              .flatMap((s) => s.existingMembers ?? []),
          ),
        ]
          .filter((key) => !presentKeys.has(key))
          .sort();

  const canProceed =
    canonicalSeats.length >= 2 &&
    unsupportedPeers.length === 0 &&
    unreachableSeats.length === 0 &&
    conflictingLinkIds.length === 0 &&
    missingLinkMembers.length === 0;

  return {
    canonicalSeats,
    staleExtraSeats,
    copiedUserdataProjectIds,
    unsupportedPeers,
    clashes,
    excludedLocalOnlyCount,
    excludedSecretCount,
    alreadyLinkedLogicalId,
    unreachableSeats,
    existingLinkId,
    conflictingLinkIds,
    missingLinkMembers,
    canProceed,
  };
}

function seatKeyOf(seat: { readonly environmentId: string; readonly projectId: string }): string {
  return `${seat.environmentId}:${seat.projectId}`;
}

/**
 * A short fragment that tells two machines apart when their labels match.
 * Hashes the whole id, so ids that share a prefix still differ.
 */
export function environmentFragment(environmentId: string): string {
  return stableHash(environmentId).slice(0, 8);
}

/** A short, stable hash (two FNV-1a passes) for deriving ids without randomness. */
function stableHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193 ^ 0x9e3779b9) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/**
 * The link id and operation id for one link attempt (1448 C2). A link some
 * seats already belong to is reused, so a retry, a reopened dialog or a third
 * machine finishes that link instead of starting another. A new link takes an
 * id derived from the seats' current identities, so it is the same on every
 * opening until a seat's identity changes (an unlink mints a new one, so a
 * relink after leaving never reuses a left link's id). The operation id covers
 * the member set too, so extending a link gets a new pre-merge copy name.
 */
export function personalLinkIdsFor(input: {
  readonly canonicalSeats: ReadonlyArray<MigrationSeatInput>;
  readonly existingLinkId: string | null;
  readonly memberKeys: ReadonlyArray<string>;
}): { readonly logicalProjectId: string; readonly operationId: string } {
  const taken = new Set(
    input.canonicalSeats
      .map((seat) => seat.identityId)
      .filter((id): id is string => typeof id === "string"),
  );
  let logicalProjectId = input.existingLinkId;
  if (logicalProjectId === null) {
    const tokens = input.canonicalSeats
      .map((seat) => seat.identityId ?? seatKeyOf(seat))
      .sort()
      .join("|");
    for (let salt = 0; logicalProjectId === null || taken.has(logicalProjectId); salt += 1) {
      logicalProjectId = `logical:personal-${stableHash(`${salt}|${tokens}`)}`;
    }
  }
  const members = [...input.memberKeys].sort().join("|");
  return {
    logicalProjectId,
    operationId: `personal-link:${stableHash(`${logicalProjectId}|${members}`)}`,
  };
}

/**
 * The order seats join (1448 C2): seats already on the link first, so they
 * accept the new members before a new seat lists them; within each group the
 * routine runner first, so a stop partway never leaves a linked seat holding
 * its routines for a runner that never joined.
 */
export function personalLinkJoinOrder<S extends MigrationSeatInput>(
  canonicalSeats: ReadonlyArray<S>,
  existingLinkId: string | null,
  routineOwnerEnvironmentId: EnvironmentId,
): S[] {
  const rank = (seat: S) =>
    (existingLinkId !== null && seat.existingLogicalProjectId === existingLinkId ? 0 : 2) +
    (seat.environmentId === routineOwnerEnvironmentId ? 0 : 1);
  return canonicalSeats
    .map((seat, index) => ({ seat, index }))
    .sort((a, b) => rank(a.seat) - rank(b.seat) || a.index - b.index)
    .map(({ seat }) => seat);
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
    readonly existingLinkId?: string | null;
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

  if (plan.unreachableSeats.length > 0) {
    return {
      ok: false,
      alreadyLinked: false,
      logicalProjectId: null,
      routineOwnerEnvironmentId: null,
      snapshots: [],
      error: {
        code: "seat_unreachable",
        message: `Could not read ${plan.unreachableSeats.map((seat) => `${seat.machineLabel} (${seat.message})`).join(", ")}. Try again, or leave that machine out.`,
        details: plan.unreachableSeats.map((seat) => seat.environmentId),
      },
    };
  }

  if (plan.conflictingLinkIds.length > 0) {
    return {
      ok: false,
      alreadyLinked: false,
      logicalProjectId: null,
      routineOwnerEnvironmentId: null,
      snapshots: [],
      error: {
        code: "conflicting_links",
        message:
          "These machines belong to two different linked assistants. Unlink one group first, then link again.",
        details: plan.conflictingLinkIds,
      },
    };
  }

  if (plan.missingLinkMembers.length > 0) {
    return {
      ok: false,
      alreadyLinked: false,
      logicalProjectId: null,
      routineOwnerEnvironmentId: null,
      snapshots: [],
      error: {
        code: "link_member_missing",
        message: `A machine on the existing link is not taking part (${plan.missingLinkMembers.map((key) => key.split(":")[0]).join(", ")}). Connect it, or remove it from the link, then link again.`,
        details: plan.missingLinkMembers,
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
    existingLinkId: plan.existingLinkId,
  });

  return {
    ok: true,
    alreadyLinked: false,
    logicalProjectId: linked.logicalProjectId,
    routineOwnerEnvironmentId: input.routineOwnerEnvironmentId,
    snapshots,
  };
}

/** One seat's action for a clashing memory file; mirrors `PersonalLinkMemoryResolution`. */
export interface SeatMemoryResolution {
  readonly name: string;
  readonly action: "keep" | "rename-shared" | "rename-local";
}

/**
 * Turns the owner's clash choices into what one seat does before its first
 * sync. "Keep version from X": X keeps the name, every other seat renames its
 * copy and keeps it on that machine only. "Keep both": the most recently edited
 * copy keeps the name and the others rename theirs, which then sync too.
 * Nothing is deleted on any machine.
 */
export function memoryResolutionsForSeat(
  clashes: ReadonlyArray<MemoryFileClash>,
  resolutions: Readonly<Record<string, MemoryClashResolution>>,
  environmentId: EnvironmentId,
): ReadonlyArray<SeatMemoryResolution> {
  const out: SeatMemoryResolution[] = [];
  for (const clash of clashes) {
    if (!clash.variants.some((variant) => variant.environmentId === environmentId)) continue;
    const choice = resolutions[clash.name];
    if (choice === undefined) continue;
    if (choice.strategy === "keep-from") {
      out.push({
        name: clash.name,
        action: choice.environmentId === environmentId ? "keep" : "rename-local",
      });
      continue;
    }
    const newest = [...clash.variants].sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.environmentId.localeCompare(b.environmentId),
    )[0];
    out.push({
      name: clash.name,
      action: newest?.environmentId === environmentId ? "keep" : "rename-shared",
    });
  }
  return out;
}

/**
 * The name a renamed clash copy takes: `notes.md` from `m4` becomes
 * `notes.from-m4.md`. Stays a valid memory name (letters, digits, `_`, `-`,
 * dots between parts, `.md`, at most 128 characters). Pass the machine's
 * environment id so two machines with the same label rename to different names.
 */
export function renamedMemoryName(
  name: string,
  machineLabel: string,
  environmentId?: string,
): string {
  const stem = name.replace(/\.md$/, "");
  const label =
    machineLabel
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "machine";
  // Two machines can share a label ("MacBook Pro"): a fragment of the machine's
  // id keeps their renamed copies apart.
  const fragment =
    environmentId === undefined || environmentId.length === 0
      ? ""
      : environmentFragment(environmentId);
  const machine = fragment.length > 0 ? `${label}-${fragment}` : label;
  const suffix = `.from-${machine}.md`;
  // A cut can land just after a dot or leave nothing: trim trailing dots so no
  // ".." or leading "." reaches ProjectMemoryName.
  const kept = stem.slice(0, 128 - suffix.length).replace(/\.+$/, "");
  return `${kept.length > 0 ? kept : "memory"}${suffix}`;
}
