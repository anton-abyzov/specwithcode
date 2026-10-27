/**
 * The reconcile planner: given what the source sends and what the destination
 * already holds, decide per repository and per file what Apply does. Pure: no
 * file system, no Git. The rule is that nothing on the destination is destroyed
 * without a backup and nothing ambiguous is decided automatically; a diverged
 * repository never loses a commit on either side.
 */
import type { FileClass } from "./classify.ts";
import type { ManifestEntry, RepositoryInfo } from "./manifest.ts";
import { ancestorsOf, foldedPathKey } from "./paths.ts";

export type RowStatus =
  | "same"
  | "fast-forward"
  | "ahead"
  | "diverged"
  | "dirty"
  | "conflict"
  | "new"
  | "only-here"
  | "skipped";
export type Choice = "keep-mine" | "take-theirs" | "leave-both" | "keep-both";
/** Destination HEAD compared with the source HEAD. */
export type Relation = "same" | "destination-behind" | "destination-ahead" | "diverged" | "unknown";

export interface DestinationFile {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink";
  readonly size: number;
  readonly sha256: string | null;
  readonly target?: string;
  readonly class: FileClass;
  readonly repo: string | null;
}

export interface DestinationRepository {
  readonly path: string;
  readonly kind: RepositoryInfo["kind"];
  readonly head: string | null;
  readonly branch: string | null;
  readonly branches: Readonly<Record<string, string>>;
  readonly identity: string | null;
  readonly status: ReadonlyArray<string>;
}

export interface PlanInput {
  /** Short machine name used in imported branch names: `swc/from-<machine>/<branch>`. */
  readonly sourceMachine: string;
  readonly repositories: ReadonlyArray<RepositoryInfo>;
  readonly entries: ReadonlyArray<ManifestEntry>;
  /** Absolute target folder, for local-copy sources. */
  readonly targetRoot: string;
  readonly destination: {
    readonly files: ReadonlyArray<DestinationFile>;
    readonly repositories: ReadonlyArray<DestinationRepository>;
  };
  readonly relations: Readonly<Record<string, Relation>>;
  readonly caseInsensitive: boolean;
  /** Repository rows (by id) the person chose to clone from origin instead of copying. */
  readonly clone?: ReadonlyArray<string>;
  /**
   * Repository rows (by id) the person left out: nothing of them, their nested
   * repositories or their linked worktrees is copied, and what is here stays.
   */
  readonly skip?: ReadonlyArray<string>;
  /**
   * For repository rows chosen to clone: the origin address this machine can read,
   * or null when it reached none, in which case the repository is copied whole.
   * Rows not listed were not checked and clone from the source's origin.
   */
  readonly cloneOrigins?: Readonly<Record<string, string | null>>;
  /** "Mirror exactly": destination-only files outside repositories move to the backup. */
  readonly mirror?: boolean;
  readonly decisions?: Readonly<Record<string, Choice>>;
}

export interface FileConflict {
  readonly id: string;
  readonly path: string;
  readonly reason: "differs" | "type-differs";
  readonly choices: ReadonlyArray<Choice>;
  readonly decision: Choice | null;
}

export interface PlanRow {
  readonly id: string;
  readonly kind: "repository" | "files";
  readonly path: string;
  readonly status: RowStatus;
  readonly detail: string;
  readonly filesToMove: number;
  readonly bytesToMove: number;
  readonly bytesPresent: number;
  readonly choices: ReadonlyArray<Choice>;
  readonly decision: Choice | null;
  readonly needsDecision: boolean;
  readonly conflicts: ReadonlyArray<FileConflict>;
  readonly cloneAvailable: boolean;
  readonly clone: boolean;
  /**
   * Destination files this row's plan overwrites or moves to the backup folder
   * (actions with `replaces`, including mirror removals), even when no decision
   * is needed. Always set by `planReconcile`.
   */
  readonly replacing?: number;
}

/**
 * write: place the source entry at its path (backing up what is there).
 * stage: fetch into staging only (Git data Apply fetches from).
 * mkdir / link: create a folder or a link.
 * keep-both: write beside the existing file as `<name>.from-<machine>`.
 * remove: move a destination-only file to the backup ("mirror exactly").
 */
export interface FileAction {
  readonly path: string;
  readonly kind: "write" | "stage" | "mkdir" | "link" | "keep-both" | "remove";
  readonly entry: ManifestEntry | null;
  /** True when something exists at the destination path and must be backed up first. */
  readonly replaces: boolean;
  readonly localSource: string | null;
  readonly row: string;
  readonly writePath: string;
}

export interface GitStep {
  readonly repo: string;
  readonly row: string;
  /** copy: repository arrives with the files. clone: from origin. existing: refs reconciled. */
  readonly kind: "copy" | "clone" | "existing" | "replace" | "add-worktree";
  readonly sourceHead: string | null;
  readonly sourceBranch: string | null;
  readonly identity: string | null;
  /** Credential-free origin URL for clone steps. */
  readonly origin: string | null;
  /** Source branch tips, for importing and verification. */
  readonly sourceBranches: Readonly<Record<string, string>>;
  readonly sourceStashCount: number;
  /** Fetch from the staged copy of the source repository. */
  readonly fetch: boolean;
  /** Move the destination's checked-out branch to the source HEAD. */
  readonly moveHead: "none" | "fast-forward" | "take-theirs";
  /** Save destination changes as a backup stash before moving HEAD. */
  readonly stashDestination: boolean;
  /** Import source branches that cannot fast-forward as swc/from-<machine>/<branch>. */
  readonly importBranches: boolean;
  readonly importPrefix: string;
  /** For linked worktrees: the main repository relative to the root. */
  readonly mainRepository: string | null;
}

export interface Plan {
  /** Inventory reviewed on the destination, including resolved conflict contents. */
  readonly destinationFingerprint?: string;
  readonly rows: ReadonlyArray<PlanRow>;
  readonly actions: ReadonlyArray<FileAction>;
  readonly git: ReadonlyArray<GitStep>;
  readonly totals: {
    readonly filesToMove: number;
    readonly bytesToMove: number;
    readonly bytesPresent: number;
    readonly decisionsNeeded: number;
    /** Sum of the rows' `replacing`. */
    readonly replacing: number;
  };
  readonly warnings: ReadonlyArray<string>;
}

const FILES_ROW = "files";
export const repoRowId = (path: string) => `repo:${path}`;
const conflictId = (path: string) => `file:${path}`;

export function machineSlug(label: string): string {
  return (
    label
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 40) || "source"
  );
}

/** Lines of `git status --porcelain` that change tracked files (untracked lines excluded). */
const trackedChanges = (status: ReadonlyArray<string>) =>
  status.filter((line) => !line.startsWith("??"));
const statusPaths = (status: ReadonlyArray<string>) => new Set(status.map((line) => line.slice(3)));

function keepBothPath(path: string, machine: string) {
  return `${path}.from-${machine}`;
}

export function planReconcile(input: PlanInput): Plan {
  const machine = machineSlug(input.sourceMachine);
  const decisions = input.decisions ?? {};
  const clone = new Set(input.clone ?? []);
  const skipRows = new Set(input.skip ?? []);
  const skippedRepos = new Set<string>();
  const key = (path: string) => (input.caseInsensitive ? foldedPathKey(path) : path);
  const destinationFiles = new Map(input.destination.files.map((file) => [key(file.path), file]));
  const destinationRepos = new Map(
    input.destination.repositories.map((repo) => [key(repo.path), repo]),
  );
  const sourceRepos = new Map(input.repositories.map((repo) => [repo.path, repo]));
  const bySha = new Map<string, string>();
  for (const file of input.destination.files)
    if (file.type === "file" && file.sha256 && !bySha.has(file.sha256))
      bySha.set(file.sha256, file.path);
  const localSource = (entry: ManifestEntry) => {
    const found = entry.sha256 ? bySha.get(entry.sha256) : undefined;
    return found ? `${input.targetRoot}/${found}` : null;
  };
  const warnings: Array<string> = [];
  // Repositories this machine cannot clone: said once, with how to give it access.
  const unreadable: Array<string> = [];

  // Repository rows first: file actions depend on whether HEAD moves.
  interface RepoPlan {
    row: PlanRow;
    step: GitStep | null;
    /** Files of this repository are copied whole (new repository or replaced folder). */
    copyWhole: boolean;
    headMoves: boolean;
    /** Both HEADs are the same commit, so a clean file here is the source's base. */
    sameHead: boolean;
    sourceDirty: Set<string>;
    destinationDirty: Set<string>;
    skipGitData: boolean;
    cloned: boolean;
  }
  const repoPlans = new Map<string, RepoPlan>();
  const occupied = (path: string) =>
    input.destination.files.some(
      (file) => key(file.path) === key(path) || key(file.path).startsWith(`${key(path)}/`),
    );
  const sortedRepos = [...input.repositories].sort((a, b) => a.path.length - b.path.length);
  for (const source of sortedRepos) {
    const id = repoRowId(source.path);
    const destination = destinationRepos.get(key(source.path)) ?? null;
    const sourceDirty = statusPaths(source.status);
    const destinationDirty = destination ? statusPaths(destination.status) : new Set<string>();
    const decision = decisions[id] ?? null;
    const base = {
      id,
      kind: "repository" as const,
      path: source.path,
      filesToMove: 0,
      bytesToMove: 0,
      bytesPresent: 0,
      conflicts: [] as Array<FileConflict>,
    };
    const step = (patch: Partial<GitStep>): GitStep => ({
      repo: source.path,
      row: id,
      kind: "existing",
      sourceHead: source.head,
      sourceBranch: source.branch,
      identity: source.identity,
      origin: source.origin,
      sourceBranches: source.branches,
      sourceStashCount: source.stashCount,
      fetch: false,
      moveHead: "none",
      stashDestination: false,
      importBranches: false,
      importPrefix: `swc/from-${machine}`,
      mainRepository: source.mainRepository,
      ...patch,
    });
    const mainPlan = source.mainRepository ? repoPlans.get(source.mainRepository) : undefined;
    const insideSkipped = [...skippedRepos].some((path) => source.path.startsWith(`${path}/`));
    if (
      source.path !== "." &&
      (skipRows.has(id) ||
        insideSkipped ||
        (source.mainRepository !== null && skippedRepos.has(source.mainRepository)))
    ) {
      skippedRepos.add(source.path);
      // Kept so the clone choice survives skipping a repository and taking it back.
      const cloneAvailable =
        !destination &&
        !insideSkipped &&
        source.kind === "main" &&
        source.identity !== null &&
        !source.identity.startsWith("file://");
      repoPlans.set(source.path, {
        row: {
          ...base,
          status: "skipped",
          detail: destination
            ? "Not copied; the copy here stays as it is."
            : "Not copied; it stays on the source machine only.",
          choices: [],
          decision: null,
          needsDecision: false,
          cloneAvailable,
          clone: cloneAvailable && clone.has(id),
        },
        step: null,
        copyWhole: false,
        headMoves: false,
        sameHead: false,
        sourceDirty,
        destinationDirty,
        skipGitData: true,
        cloned: false,
      });
      continue;
    }
    if (!destination) {
      const blocked = source.path !== "." && occupied(source.path);
      const cloneOrigin = input.cloneOrigins?.[id];
      // Chosen, but this machine cannot read the origin: copied whole instead of failing late.
      const unreachable = clone.has(id) && cloneOrigin === null;
      const cloneAvailable =
        source.kind === "main" &&
        source.identity !== null &&
        !source.identity.startsWith("file://") &&
        !unreachable;
      const cloned = cloneAvailable && clone.has(id);
      const cloneStep = () =>
        step({ kind: "clone", ...(cloneOrigin ? { origin: cloneOrigin } : {}) });
      if (unreachable) unreadable.push(source.path === "." ? "the root repository" : source.path);
      if (blocked) {
        const choices: Array<Choice> = ["keep-mine", "take-theirs"];
        repoPlans.set(source.path, {
          row: {
            ...base,
            status: "conflict",
            detail: "A folder with other files is already here, not this repository.",
            choices,
            decision,
            needsDecision: decision === null,
            cloneAvailable,
            clone: cloned,
          },
          step:
            decision === "take-theirs" ? (cloned ? cloneStep() : step({ kind: "replace" })) : null,
          copyWhole: decision === "take-theirs",
          headMoves: false,
          sameHead: false,
          sourceDirty,
          destinationDirty,
          skipGitData: cloned,
          cloned,
        });
        continue;
      }
      // A linked worktree whose main repository already exists here is re-created with `git worktree add`.
      const viaWorktreeAdd =
        source.kind === "linked" && mainPlan !== undefined && !mainPlan.copyWhole;
      if (source.kind === "linked" && source.mainRepository === null)
        warnings.push(
          `${source.path} is a worktree of a repository outside this folder; its files are copied without its Git link.`,
        );
      repoPlans.set(source.path, {
        row: {
          ...base,
          status: "new",
          detail: cloned
            ? "Not on this machine yet; cloned from origin, then local work copied."
            : viaWorktreeAdd
              ? "A worktree not on this machine yet; added to the existing repository."
              : unreachable
                ? "Not on this machine yet; copied with its history, because this machine cannot read its origin."
                : "Not on this machine yet; copied with its history, branches and stashes.",
          choices: [],
          decision: null,
          needsDecision: false,
          cloneAvailable,
          clone: cloned,
        },
        step: viaWorktreeAdd
          ? step({ kind: "add-worktree", fetch: true })
          : cloned
            ? cloneStep()
            : step({ kind: "copy" }),
        copyWhole: true,
        headMoves: false,
        sameHead: false,
        sourceDirty,
        destinationDirty,
        skipGitData:
          cloned || viaWorktreeAdd || (source.kind === "linked" && source.mainRepository === null),
        cloned: cloned || viaWorktreeAdd,
      });
      continue;
    }
    if (source.identity && destination.identity && source.identity !== destination.identity) {
      const choices: Array<Choice> = ["keep-mine", "take-theirs"];
      repoPlans.set(source.path, {
        row: {
          ...base,
          status: "conflict",
          detail: "A different repository is at this path here.",
          choices,
          decision,
          needsDecision: decision === null,
          cloneAvailable: false,
          clone: false,
        },
        step: decision === "take-theirs" ? step({ kind: "replace" }) : null,
        copyWhole: decision === "take-theirs",
        headMoves: false,
        sameHead: false,
        sourceDirty,
        destinationDirty,
        skipGitData: false,
        cloned: false,
      });
      continue;
    }
    const relation =
      input.relations[source.path] ?? (source.head === destination.head ? "same" : "unknown");
    const destinationChanged = trackedChanges(destination.status).length > 0;
    const branchesDiffer =
      Object.entries(source.branches).some(([name, sha]) => destination.branches[name] !== sha) ||
      source.stashCount > 0 ||
      relation !== "same";
    let status: RowStatus;
    let detail: string;
    let choices: Array<Choice> = [];
    let moveHead: GitStep["moveHead"] = "none";
    let stash = false;
    let effective = decision;
    switch (relation) {
      case "same":
        status = "same";
        detail = "Same commit on both machines.";
        break;
      case "destination-behind":
        if (destinationChanged) {
          status = "dirty";
          detail = "Behind the source, with uncommitted changes here.";
          choices = ["keep-mine", "take-theirs"];
          if (decision === "take-theirs") {
            moveHead = "fast-forward";
            stash = true;
          }
        } else {
          status = "fast-forward";
          detail = "Behind the source; moves forward to its commit.";
          moveHead = "fast-forward";
          effective = null;
        }
        break;
      case "destination-ahead":
        status = "ahead";
        detail = `Ahead of the source; kept. Source branches arrive as swc/from-${machine}/….`;
        break;
      default:
        status = "diverged";
        detail = "Both machines have commits the other lacks. Nothing is lost either way.";
        choices = ["keep-mine", "take-theirs", "leave-both"];
        if (decision === "take-theirs") {
          moveHead = "take-theirs";
          stash = destinationChanged;
        }
    }
    if (!choices.includes(effective as Choice)) effective = null;
    const headMoves = moveHead !== "none";
    repoPlans.set(source.path, {
      row: {
        ...base,
        status,
        detail,
        choices,
        decision: effective,
        needsDecision: choices.length > 0 && effective === null,
        cloneAvailable: false,
        clone: false,
      },
      step: step({
        kind: "existing",
        fetch: branchesDiffer,
        moveHead,
        stashDestination: stash,
        importBranches: branchesDiffer,
      }),
      copyWhole: false,
      headMoves,
      sameHead: relation === "same",
      sourceDirty,
      destinationDirty,
      skipGitData: !branchesDiffer,
      cloned: false,
    });
  }

  // Destination repositories the source does not have are kept as they are.
  const onlyHere: Array<PlanRow> = input.destination.repositories
    .filter((repo) => !input.repositories.some((source) => key(source.path) === key(repo.path)))
    .map((repo) => ({
      id: repoRowId(repo.path),
      kind: "repository" as const,
      path: repo.path,
      status: "only-here" as const,
      detail: "Only on this machine; kept.",
      filesToMove: 0,
      bytesToMove: 0,
      bytesPresent: 0,
      choices: [],
      decision: null,
      needsDecision: false,
      conflicts: [],
      cloneAvailable: false,
      clone: false,
    }));

  const actions: Array<FileAction> = [];
  const counts = new Map<
    string,
    { files: number; bytes: number; present: number; conflicts: Array<FileConflict> }
  >();
  const countFor = (row: string) => {
    let value = counts.get(row);
    if (!value) counts.set(row, (value = { files: 0, bytes: 0, present: 0, conflicts: [] }));
    return value;
  };
  const seenKeys = new Map<string, string>();
  const sourcePaths = new Set<string>();
  const skippedPrefixes: Array<string> = [];

  for (const repo of skippedRepos) skippedPrefixes.push(`${repo}/`);
  for (const entry of input.entries) {
    if (skippedPrefixes.some((prefix) => entry.path.startsWith(prefix))) continue;
    // The skipped repository's own folder is not created either.
    if (skippedRepos.has(entry.path)) continue;
    sourcePaths.add(key(entry.path));
    const folded = key(entry.path);
    const earlier = seenKeys.get(folded);
    if (earlier !== undefined) {
      warnings.push(
        `${entry.path} and ${earlier} differ only by case; this machine keeps ${earlier}.`,
      );
      continue;
    }
    seenKeys.set(folded, entry.path);
    const repoPlan = entry.repo !== null ? repoPlans.get(entry.repo) : undefined;
    const rowId = repoPlan ? repoPlan.row.id : FILES_ROW;
    const count = countFor(rowId);
    const destination = destinationFiles.get(folded) ?? null;
    const inner =
      entry.repo === null || entry.repo === "."
        ? entry.path
        : entry.path.slice(entry.repo.length + 1);

    if (repoPlan && !repoPlan.copyWhole && repoPlan.step === null) {
      // keep-mine on a conflicting repository row: nothing of it moves.
      continue;
    }
    if (entry.class === "repository") {
      if (!repoPlan || repoPlan.skipGitData) continue;
      if (repoPlan.copyWhole) {
        // New repository: Git data is copied like any file.
      } else {
        if (entry.type === "file") {
          const local = localSource(entry);
          actions.push({
            path: entry.path,
            kind: "stage",
            entry,
            replaces: false,
            localSource: local,
            row: rowId,
            writePath: entry.path,
          });
          if (local) count.present += entry.size;
          else count.bytes += entry.size;
          count.files += 1;
        } else if (entry.type === "directory") {
          actions.push({
            path: entry.path,
            kind: "stage",
            entry,
            replaces: false,
            localSource: null,
            row: rowId,
            writePath: entry.path,
          });
        }
        continue;
      }
    }
    if (
      repoPlan &&
      !repoPlan.copyWhole &&
      entry.class === "tracked" &&
      !repoPlan.sourceDirty.has(inner)
    ) {
      // Clean tracked content arrives through Git, never as a file copy.
      continue;
    }
    if (repoPlan?.cloned && entry.class === "tracked" && !repoPlan.sourceDirty.has(inner)) continue;

    if (entry.type === "directory") {
      if (!destination)
        actions.push({
          path: entry.path,
          kind: "mkdir",
          entry,
          replaces: false,
          localSource: null,
          row: rowId,
          writePath: entry.path,
        });
      else if (destination.type !== "directory") {
        const id = conflictId(entry.path);
        const decision = decisions[id] ?? null;
        const conflict: FileConflict = {
          id,
          path: entry.path,
          reason: "type-differs",
          choices: ["keep-mine", "take-theirs"],
          decision: decision === "keep-both" || decision === "leave-both" ? null : decision,
        };
        count.conflicts.push(conflict);
        if (conflict.decision === "take-theirs")
          actions.push({
            path: entry.path,
            kind: "mkdir",
            entry,
            replaces: true,
            localSource: null,
            row: rowId,
            writePath: entry.path,
          });
        else skippedPrefixes.push(`${entry.path}/`);
      }
      continue;
    }

    const sameContent =
      destination !== null &&
      destination.type === entry.type &&
      (entry.type === "symlink"
        ? destination.target === entry.target
        : destination.size === entry.size &&
          destination.sha256 !== null &&
          destination.sha256 === entry.sha256);
    if (sameContent) {
      count.present += entry.size;
      continue;
    }
    const kind = entry.type === "symlink" ? "link" : "write";
    if (!destination) {
      const local = kind === "write" ? localSource(entry) : null;
      actions.push({
        path: entry.path,
        kind,
        entry,
        replaces: false,
        localSource: local,
        row: rowId,
        writePath: entry.path,
      });
      count.files += 1;
      if (local) count.present += entry.size;
      else count.bytes += entry.size;
      continue;
    }
    // Something different is here. A clean tracked file of a repository whose HEAD
    // moves to the source's commit takes the source version: that is the source's
    // uncommitted work applied on top, and Git still has the old content.
    const destinationRepo = destination.repo !== null ? repoPlans.get(destination.repo) : undefined;
    const destinationInner =
      destination.repo === null || destination.repo === "."
        ? destination.path
        : destination.path.slice(destination.repo.length + 1);
    const cleanTracked =
      destination.class === "tracked" &&
      destination.type === entry.type &&
      destinationRepo !== undefined &&
      !destinationRepo.destinationDirty.has(destinationInner);
    if (
      repoPlan?.step?.kind === "replace" ||
      (cleanTracked && (repoPlan?.headMoves || repoPlan?.sameHead))
    ) {
      const local = kind === "write" ? localSource(entry) : null;
      actions.push({
        path: entry.path,
        kind,
        entry,
        replaces: true,
        localSource: local,
        row: rowId,
        writePath: destination.path,
      });
      count.files += 1;
      if (local) count.present += entry.size;
      else count.bytes += entry.size;
      continue;
    }
    const id = conflictId(entry.path);
    const typeDiffers = destination.type !== entry.type;
    const choices: Array<Choice> = typeDiffers
      ? ["keep-mine", "take-theirs"]
      : ["keep-mine", "take-theirs", "keep-both"];
    const raw = decisions[id] ?? null;
    const decision = raw && choices.includes(raw) ? raw : null;
    count.conflicts.push({
      id,
      path: entry.path,
      reason: typeDiffers ? "type-differs" : "differs",
      choices,
      decision,
    });
    if (decision === "take-theirs" || decision === "keep-both") {
      const local = kind === "write" ? localSource(entry) : null;
      const writePath =
        decision === "keep-both" ? keepBothPath(destination.path, machine) : destination.path;
      actions.push({
        path: entry.path,
        kind: decision === "keep-both" ? "keep-both" : kind,
        entry,
        replaces: decision === "take-theirs",
        localSource: local,
        row: rowId,
        writePath,
      });
      count.files += 1;
      if (local) count.present += entry.size;
      else count.bytes += entry.size;
    }
  }

  if (input.mirror) {
    for (const file of input.destination.files) {
      if (file.repo !== null || file.type === "directory" || sourcePaths.has(key(file.path)))
        continue;
      if (ancestorsOf(file.path).some((ancestor) => destinationRepos.has(key(ancestor)))) continue;
      // What is here under a skipped repository's folder stays untouched.
      if ([...skippedRepos].some((repo) => key(file.path).startsWith(`${key(repo)}/`))) continue;
      actions.push({
        path: file.path,
        kind: "remove",
        entry: null,
        replaces: true,
        localSource: null,
        row: FILES_ROW,
        writePath: file.path,
      });
      countFor(FILES_ROW).files += 1;
    }
  }

  const rows: Array<PlanRow> = [];
  for (const plan of repoPlans.values()) {
    const count = countFor(plan.row.id);
    const conflictsOpen = count.conflicts.some((conflict) => conflict.decision === null);
    rows.push({
      ...plan.row,
      status:
        plan.row.status === "same" && count.conflicts.length > 0 ? "conflict" : plan.row.status,
      filesToMove: count.files,
      bytesToMove: count.bytes,
      bytesPresent: count.present,
      conflicts: count.conflicts,
      needsDecision: plan.row.needsDecision || conflictsOpen,
    });
  }
  const other = countFor(FILES_ROW);
  if (
    input.entries.some((entry) => entry.repo === null) ||
    other.files > 0 ||
    other.conflicts.length > 0
  )
    rows.push({
      id: FILES_ROW,
      kind: "files",
      path: ".",
      status: other.conflicts.length > 0 ? "conflict" : other.files > 0 ? "new" : "same",
      detail: "Files outside any repository.",
      filesToMove: other.files,
      bytesToMove: other.bytes,
      bytesPresent: other.present,
      choices: [],
      decision: null,
      needsDecision: other.conflicts.some((conflict) => conflict.decision === null),
      conflicts: other.conflicts,
      cloneAvailable: false,
      clone: false,
    });
  rows.push(...onlyHere);
  // What Apply overwrites or backs up, per row: a row can need no decision and
  // still replace clean tracked files with the source's uncommitted versions.
  const replacing = new Map<string, number>();
  for (const action of actions)
    if (action.replaces) replacing.set(action.row, (replacing.get(action.row) ?? 0) + 1);
  for (const [index, row] of rows.entries())
    rows[index] = { ...row, replacing: replacing.get(row.id) ?? 0 };
  const git = [...repoPlans.values()].flatMap((plan) => (plan.step ? [plan.step] : []));
  return {
    rows,
    actions,
    git,
    totals: {
      filesToMove: rows.reduce((sum, row) => sum + row.filesToMove, 0),
      bytesToMove: rows.reduce((sum, row) => sum + row.bytesToMove, 0),
      bytesPresent: rows.reduce((sum, row) => sum + row.bytesPresent, 0),
      decisionsNeeded:
        rows.filter((row) => row.choices.length > 0 && row.decision === null).length +
        rows.reduce(
          (sum, row) => sum + row.conflicts.filter((conflict) => conflict.decision === null).length,
          0,
        ),
      replacing: rows.reduce((sum, row) => sum + (row.replacing ?? 0), 0),
    },
    warnings: unreadable.length > 0 ? [gitAccessWarning(unreadable), ...warnings] : warnings,
  };
}

/** One notice for every repository the destination cannot clone, and how to fix it. */
export function gitAccessWarning(paths: ReadonlyArray<string>): string {
  const shown = paths.slice(0, 4).join(", ");
  const more = paths.length > 4 ? ` and ${paths.length - 4} more` : "";
  const subject = paths.length === 1 ? "it is" : "they are";
  return `The destination machine cannot read ${paths.length === 1 ? "the origin of" : "the origins of"} ${shown}${more} (no GitHub sign-in or SSH key there), so ${subject} copied whole with ${paths.length === 1 ? "its" : "their"} history instead of cloned. To clone next time, install the GitHub CLI on it and run gh auth login, then gh auth setup-git.`;
}

/** Apply is allowed only when no row or file still needs a decision. */
export function planReady(plan: Plan): boolean {
  return plan.totals.decisionsNeeded === 0;
}

/** What the pull must fetch for a plan: files to write or stage, and staged Git folders. */
export function pullRequirements(plan: Plan): {
  readonly files: Array<{
    path: string;
    sha256: string;
    chunks: Array<string>;
    size: number;
    mode: number;
    mtimeMs: number;
    localSource: string | null;
  }>;
  readonly directories: Array<string>;
} {
  const files = [];
  const directories: Array<string> = [];
  for (const action of plan.actions) {
    const entry = action.entry;
    if (!entry) continue;
    if (entry.type === "directory" && action.kind === "stage") directories.push(entry.path);
    if (entry.type !== "file" || !entry.sha256 || !entry.chunks) continue;
    if (action.kind !== "write" && action.kind !== "stage" && action.kind !== "keep-both") continue;
    files.push({
      path: entry.path,
      sha256: entry.sha256,
      chunks: [...entry.chunks],
      size: entry.size,
      mode: entry.mode,
      mtimeMs: entry.mtimeMs,
      localSource: action.localSource,
    });
  }
  return { files, directories };
}
