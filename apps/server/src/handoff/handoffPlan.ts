/**
 * The per-thread plan of a hand off (1390), one for both starts: a hand off a
 * person asks for and the automatic one when a track is out here. Per thread
 * it holds whether it is in the plan, what the target confirmed about its own
 * track, account and usage, what the checkpoint that would travel measures,
 * and what the thread does on arrival: Resume, Ready, or Stays with a reason.
 * A plan has thread rows and project folder work. It has no coordinator row
 * and no routine row: a hand off moves neither.
 *
 * The target is asked by `check`, a call that needs no copy of the thread
 * there. It is this feature's own wire addition, so it has its own capability:
 * a machine that does not name `handoff.plan` reads "Needs update" and its
 * rows stay, whatever else it can do.
 */
import {
  EnvironmentId,
  HANDOFF_MAX_BUNDLE_BYTES,
  HANDOFF_MAX_SNAPSHOT_FILE_BYTES,
  HANDOFF_MAX_SNAPSHOT_FILES,
  HandoffCapabilities,
  HandoffPreflightFailure,
  type HandoffRunEnding,
  type HandoffTransferDisposition,
  IsoDateTime,
  isResumableHandoffEnding,
  MODEL_TRACK_LABELS,
  MODEL_TRACKS,
  ModelSelection,
  type ModelTrack,
  NonNegativeInt,
  type OrchestratorMcpProviderUsage,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { judgeAccountEvidence } from "@specweave-studio/shared/machineFallback";
import * as Schema from "effect/Schema";

import { runGit } from "../fleet/folderTransfer/git.ts";
import { createBundle, measureCommitRange, negotiationCandidates } from "./bundleGit.ts";
import { refComponent, writeCheckpoint } from "./checkpointGit.ts";
import {
  type CheckFacts,
  checkFailures,
  type PreflightProvider,
  providerFailures,
  providerName,
} from "./handoffPreflight.ts";

/**
 * Named by a machine that answers `check` and plans from its answer. It says
 * nothing about transfer records (`handoff.v2`), and they say nothing about it.
 */
export const HANDOFF_PLAN_CAPABILITY = "handoff.plan";

export function hasHandoffPlan(capabilities: ReadonlyArray<string> | undefined): boolean {
  return capabilities?.includes(HANDOFF_PLAN_CAPABILITY) === true;
}

/** The check a plan fails for a machine that does not plan hand offs: its rows stay. */
export function planCapabilityFailure(input: {
  readonly peerLabel: string;
  readonly capabilities: ReadonlyArray<string> | undefined;
}): HandoffPreflightFailure | null {
  if (hasHandoffPlan(input.capabilities)) return null;
  return { check: "version", message: needsUpdate(input.peerLabel) };
}

const needsUpdate = (label: string) =>
  `Needs update: ${label} runs a SpecWithCode from before hand off plans, so nothing is planned between it and this machine. Update SpecWithCode on ${label} first.`;

/** What the peer client makes of a 404 for `check`: the machine is from before it and changed nothing. */
export function unknownCheckPath(label: string) {
  return {
    code: "invalid" as const,
    check: "version" as const,
    message: needsUpdate(label),
    uncertain: false,
    needsUpdate: true,
  };
}

export const HandoffPlanStart = Schema.Literals(["manual", "automatic"]);
export type HandoffPlanStart = typeof HandoffPlanStart.Type;

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const fingerprint = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
const percent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

export const PeerCheckRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceLabel: text(120),
  protocolVersion: Schema.optional(NonNegativeInt),
  appVersion: Schema.optional(text(40)),
  capabilities: Schema.optional(HandoffCapabilities),
  /** An automatic start is confirmed only on a fresh reading with room; by hand a line is enough. */
  start: HandoffPlanStart,
  /** The source's switch threshold; null means "only at the limit". */
  thresholdPercent: Schema.NullOr(percent),
  threads: Schema.Array(
    Schema.Struct({
      sourceThreadId: ThreadId,
      sourceProjectId: ProjectId,
      /** The model the thread uses now. */
      modelSelection: ModelSelection,
      /** The thread's track at the source; null when its project is not on tracks. */
      track: Schema.NullOr(Schema.Literals(MODEL_TRACKS)),
      /** The provider the thread ran out on, and the account pools its track is out on. */
      driverKind: text(64),
      accountFingerprints: Schema.Array(fingerprint).check(Schema.isMaxLength(16)),
    }),
  ).check(Schema.isMaxLength(100)),
});
export type PeerCheckRequest = typeof PeerCheckRequest.Type;

/** What the target confirmed for one thread: the sign-in it would run on, and that account's reading. */
export const PeerCheckEvidence = Schema.Struct({
  modelSelection: ModelSelection,
  providerName: text(120),
  kind: Schema.Literals(["different-account", "same-account", "usage-unknown"]),
  /** "Different Claude account · 60% left". */
  line: text(200),
  percentLeft: Schema.NullOr(percent),
  /** The reading qualifies an automatic move. */
  automatic: Schema.Boolean,
  accountFingerprint: Schema.NullOr(fingerprint),
  usedPercent: Schema.NullOr(percent),
  resetsAt: Schema.NullOr(IsoDateTime),
  observedAt: Schema.NullOr(IsoDateTime),
});
export type PeerCheckEvidence = typeof PeerCheckEvidence.Type;

export const PeerCheckResponse = Schema.Struct({
  machineLabel: text(120),
  protocolVersion: Schema.optional(NonNegativeInt),
  appVersion: Schema.optional(text(40)),
  capabilities: Schema.optional(HandoffCapabilities),
  results: Schema.Array(
    Schema.Struct({
      sourceThreadId: ThreadId,
      failures: Schema.Array(HandoffPreflightFailure),
      evidence: Schema.NullOr(PeerCheckEvidence),
    }),
  ),
});
export type PeerCheckResponse = typeof PeerCheckResponse.Type;

/** One sign-in of the receiving machine with its own usage reading, taken for this call. */
export interface CheckSignIn {
  readonly provider: PreflightProvider;
  readonly usage: OrchestratorMcpProviderUsage;
}

/**
 * The receiver's answer for one thread. A machine is a target only for the
 * thread's own track: its entries for that track, in its own order, on the
 * sign-ins the grant allows. The first sign-in whose reading qualifies is
 * confirmed; one on the same depleted pool adds nothing and the next is tried,
 * never another track. By hand a sign-in that adds nothing or whose usage is
 * unknown is confirmed too, with its line, after every one that has room.
 */
export function confirmTarget(input: {
  readonly machineLabel: string;
  readonly sourceLabel: string;
  readonly start: HandoffPlanStart;
  readonly thresholdPercent: number | null;
  readonly nowMs: number;
  readonly project: CheckFacts["project"];
  readonly otherHolder: string | null;
  readonly thread: Pick<
    PeerCheckRequest["threads"][number],
    "modelSelection" | "track" | "driverKind" | "accountFingerprints"
  >;
  /**
   * This machine's entries for the thread's track, in order. Null when its copy
   * of the project has no such track (it runs one fixed model): then it is no
   * target for a thread on a track.
   */
  readonly trackEntries: ReadonlyArray<ModelSelection> | null;
  readonly signIns: ReadonlyArray<CheckSignIn>;
  /** Why the grant does not let the source run on a sign-in, worded with this machine's name. */
  readonly accountRefusal: (instanceId: ModelSelection["instanceId"]) => string | null;
}): {
  readonly failures: Array<HandoffPreflightFailure>;
  readonly evidence: PeerCheckEvidence | null;
} {
  const at = (message: string) => `${input.machineLabel}: ${message}`;
  const { thread } = input;
  // The link, the grant for the project and the lease do not depend on the sign-in,
  // which is judged per candidate below: a provider that passes stands in here.
  const base = checkFailures({
    machineLabel: input.machineLabel,
    project: input.project,
    modelSelection: thread.modelSelection,
    provider: {
      instanceId: thread.modelSelection.instanceId,
      driver: thread.driverKind,
      enabled: true,
      installed: true,
      authStatus: "unknown",
      models: [],
    },
    otherHolder: input.otherHolder,
  });

  // Without the project here nothing else can be said about its tracks.
  if (input.project === null) return { failures: base, evidence: null };
  let candidates: ReadonlyArray<ModelSelection>;
  if (thread.track === null) {
    // Only a thread with no track at the source is checked on the model it names.
    candidates = [thread.modelSelection];
  } else if (input.trackEntries === null) {
    return {
      failures: [
        ...base,
        {
          check: "model",
          message: at(
            `${input.project.title} does not use the ${MODEL_TRACK_LABELS[thread.track]} track here`,
          ),
        },
      ],
      evidence: null,
    };
  } else if (input.trackEntries.length === 0) {
    return {
      failures: [
        ...base,
        {
          check: "model",
          message: at(`nothing on the ${MODEL_TRACK_LABELS[thread.track]} track is set up here`),
        },
      ],
      evidence: null,
    };
  } else {
    candidates = input.trackEntries;
  }

  const unusable: Array<HandoffPreflightFailure> = [];
  const read: Array<PeerCheckEvidence & { readonly byHand: boolean }> = [];
  for (const selection of candidates) {
    const refusal = input.accountRefusal(selection.instanceId);
    if (refusal !== null) {
      unusable.push({ check: "grant", message: refusal });
      continue;
    }
    const signIn = input.signIns.find(
      (entry) => entry.provider.instanceId === selection.instanceId,
    );
    const provider = signIn?.provider ?? null;
    const failed = providerFailures({
      machineLabel: input.machineLabel,
      modelSelection: selection,
      provider,
    });
    if (signIn === undefined || provider === null || failed.length > 0) {
      unusable.push(...failed);
      continue;
    }
    const name = providerName(provider);
    const evidence = judgeAccountEvidence({
      providerName: name,
      sourceLabel: input.sourceLabel,
      sameDriver: provider.driver === thread.driverKind,
      sourceFingerprints: thread.accountFingerprints,
      usage: signIn.usage,
      thresholdPercent: input.thresholdPercent,
      nowMs: input.nowMs,
    });
    read.push({
      modelSelection: selection,
      providerName: name,
      kind: evidence.kind,
      line: evidence.line,
      percentLeft: evidence.percentLeft,
      automatic: evidence.automatic,
      accountFingerprint: signIn.usage.accountFingerprint,
      usedPercent: signIn.usage.usedPercent,
      resetsAt: signIn.usage.resetsAt,
      observedAt: signIn.usage.observedAt,
      byHand: evidence.byHand,
    });
  }

  const wire = ({ byHand: _byHand, ...evidence }: (typeof read)[number]): PeerCheckEvidence =>
    evidence;
  const confirmed =
    read.find((entry) => entry.automatic) ??
    (input.start === "manual" ? read.find((entry) => entry.byHand) : undefined);
  if (confirmed !== undefined) return { failures: base, evidence: wire(confirmed) };
  const first = read[0];
  if (first !== undefined) {
    return {
      failures: [...base, { check: "provider", message: at(first.line) }],
      evidence: wire(first),
    };
  }
  return {
    failures: [
      ...base,
      unusable[0] ?? { check: "provider", message: at("no sign-in here can run this thread") },
    ],
    evidence: null,
  };
}

/** What the source knows about the target for one thread. */
export type HandoffTargetCheck =
  | {
      readonly kind: "checked";
      readonly failures: ReadonlyArray<HandoffPreflightFailure>;
      readonly evidence: PeerCheckEvidence | null;
    }
  /** The target does not plan hand offs, or the source's request was refused for that. */
  | { readonly kind: "needs-update"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "skipped" };

/**
 * One thread's check from what the `check` call returned. An answer from a
 * machine that does not name the plan's capability is not read at all.
 */
export function checkAnswer(input: {
  readonly peerLabel: string;
  readonly threadId: ThreadId;
  readonly answer:
    | { readonly kind: "answered"; readonly response: PeerCheckResponse }
    | {
        readonly kind: "failed";
        readonly error: { readonly message: string; readonly needsUpdate?: boolean | undefined };
      };
}): HandoffTargetCheck {
  if (input.answer.kind === "failed") {
    return input.answer.error.needsUpdate === true
      ? { kind: "needs-update", message: input.answer.error.message }
      : { kind: "error", message: input.answer.error.message };
  }
  const { response } = input.answer;
  const unfit = planCapabilityFailure({
    peerLabel: response.machineLabel || input.peerLabel,
    capabilities: response.capabilities,
  });
  if (unfit !== null) return { kind: "needs-update", message: unfit.message };
  const result = response.results.find((entry) => entry.sourceThreadId === input.threadId);
  if (result === undefined) {
    return { kind: "error", message: `${input.peerLabel} did not answer for this thread.` };
  }
  const update = result.failures.find(
    (failure) => failure.check === "version" && failure.message.startsWith("Needs update: "),
  );
  if (update !== undefined) return { kind: "needs-update", message: update.message };
  return { kind: "checked", failures: result.failures, evidence: result.evidence };
}

/** What the checkpoint or bundle that would travel measures, per repository. */
export interface HandoffMeasure {
  /** The bundle's size, without the commits the target already holds. */
  readonly bytes: number;
  /** Files the bundle's commits touch. */
  readonly files: number;
  readonly over: HandoffOverLimit | null;
}

export type HandoffOverLimit =
  | { readonly limit: "file"; readonly path: string; readonly bytes: number }
  | { readonly limit: "files"; readonly count: number }
  | { readonly limit: "bundle"; readonly bytes: number };

export interface HandoffLimits {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxBundleBytes: number;
}

export const HANDOFF_LIMITS: HandoffLimits = {
  maxFileBytes: HANDOFF_MAX_SNAPSHOT_FILE_BYTES,
  maxFiles: HANDOFF_MAX_SNAPSHOT_FILES,
  maxBundleBytes: HANDOFF_MAX_BUNDLE_BYTES,
};

const megabytes = (bytes: number) => Math.ceil(bytes / 1_048_576);

/** "data/dump.bin is 12 MB, over the 10 MB limit for one file". */
export function overLimitText(over: HandoffOverLimit, limits: HandoffLimits = HANDOFF_LIMITS) {
  switch (over.limit) {
    case "file":
      return `${over.path} is ${megabytes(over.bytes)} MB, over the ${megabytes(limits.maxFileBytes)} MB limit for one file`;
    case "files":
      return `${over.count.toLocaleString("en-US")} files, over the ${limits.maxFiles.toLocaleString("en-US")} file limit`;
    case "bundle":
      return `${megabytes(over.bytes)} MB to send, over the ${megabytes(limits.maxBundleBytes)} MB limit`;
  }
}

/** Why an item that passed the check stays at the run, or null when it still fits. */
export function grewPastLimit(_checked: HandoffMeasure, atRun: HandoffMeasure): string | null {
  return atRun.over === null
    ? null
    : `It grew past a limit after the check: ${overLimitText(atRun.over)}`;
}

/** The scratch ref of one operation's check for one thread; never the thread's hand off ref. */
export function checkRef(operationId: string, threadId: string): string {
  return `refs/specwithcode/check/${refComponent(operationId)}/${refComponent(threadId)}`;
}

/**
 * Measures what a hand off of the thread's folder would send, without sending
 * it: the folder is written as a checkpoint on a scratch ref of this operation,
 * the target is asked which of its commits it already holds (commit ids only),
 * and the bundle that would travel is built and weighed. The scratch ref is
 * deleted whatever happens. The thread's own hand off ref, its checkpoint
 * sequence, HEAD, the index and the working tree are not touched.
 */
export async function measureTravel(input: {
  readonly cwd: string;
  readonly threadId: string;
  readonly operationId: string;
  /** Which of these commits the target holds; a failure here fails the measure. */
  readonly known: (candidates: ReadonlyArray<string>) => Promise<ReadonlyArray<string>>;
  readonly limits?: HandoffLimits;
}): Promise<HandoffMeasure> {
  const limits = input.limits ?? HANDOFF_LIMITS;
  const ref = checkRef(input.operationId, input.threadId);
  // Exclusive: a second measure of the same operation and thread fails here, before
  // it holds anything, and so never deletes the ref of the one that runs.
  const checkpoint = await writeCheckpoint({
    cwd: input.cwd,
    threadId: input.threadId,
    ref,
    exclusive: true,
  });
  const root = checkpoint.root;
  try {
    const known = await input.known(await negotiationCandidates(root, checkpoint.baseCommit));
    const range = await measureCommitRange({
      root,
      commit: checkpoint.commit,
      exclude: known,
      maxFileBytes: limits.maxFileBytes,
    });
    const bundle = await createBundle({
      root,
      ref,
      commit: checkpoint.commit,
      exclude: known,
      maxBytes: Number.POSITIVE_INFINITY,
    });
    const bytes = bundle.bytes;
    await bundle.dispose();

    // The checkpoint leaves out what is over its own limits, so a skip is an item over a limit.
    const skipped = checkpoint.overLimit;
    let over: HandoffOverLimit | null = null;
    if (skipped?.reason === "too-large") {
      over = { limit: "file", path: skipped.path, bytes: skipped.bytes };
    } else if (skipped?.reason === "too-many-files") {
      over = { limit: "files", count: await changedFileCount(root) };
    } else {
      const large = await largestOver(root, checkpoint.commit, checkpoint.baseCommit, limits);
      if (large !== null) over = large;
      else if (range.oversizedFile !== null) {
        over = {
          limit: "file",
          path: range.oversizedFile,
          bytes:
            (await blobBytes(root, checkpoint.commit, known, range.oversizedFile)) ??
            limits.maxFileBytes + 1,
        };
      } else if (range.files > limits.maxFiles) over = { limit: "files", count: range.files };
      else if (bytes > limits.maxBundleBytes) over = { limit: "bundle", bytes };
    }
    return { bytes, files: range.files, over };
  } finally {
    // Only the ref this call wrote, and only while it still points at its commit.
    await runGit(root, ["update-ref", "-d", ref, checkpoint.commit], { allowFailure: true }).catch(
      () => undefined,
    );
  }
}

/** Every changed and untracked file of the folder; the checkpoint's own list of skips is capped. */
async function changedFileCount(root: string): Promise<number> {
  const status = await runGit(root, [
    "status",
    "--porcelain",
    "-z",
    "--no-renames",
    "--untracked-files=all",
  ]);
  return status.stdout.split("\0").filter(Boolean).length;
}

/** The size of the largest blob that travels under `path`, or null when it cannot be read. */
async function blobBytes(
  root: string,
  commit: string,
  exclude: ReadonlyArray<string>,
  path: string,
): Promise<number | null> {
  const objects = await runGit(
    root,
    [
      "rev-list",
      "--objects",
      commit,
      ...exclude
        .filter((sha) => /^[0-9a-f]{40,64}$/.test(sha) && sha !== commit)
        .map((sha) => `^${sha}`),
    ],
    { allowFailure: true },
  );
  let largest: number | null = null;
  for (const line of objects.stdout.split("\n")) {
    if (line.slice(line.indexOf(" ") + 1) !== path) continue;
    const size = await runGit(root, ["cat-file", "-s", line.slice(0, line.indexOf(" "))], {
      allowFailure: true,
    });
    const bytes = Number(size.stdout.trim());
    if (size.code === 0 && Number.isFinite(bytes) && (largest === null || bytes > largest)) {
      largest = bytes;
    }
  }
  return largest;
}

/** The first file of the snapshot commit itself that is over the per-file limit, with its size. */
async function largestOver(
  root: string,
  commit: string,
  baseCommit: string,
  limits: HandoffLimits,
): Promise<HandoffOverLimit | null> {
  const changed = await runGit(root, [
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    "--diff-filter=d",
    "--name-only",
    baseCommit,
    commit,
  ]);
  const paths = changed.stdout.split("\0").filter(Boolean);
  for (const path of paths) {
    const size = await runGit(root, ["cat-file", "-s", `${commit}:${path}`], {
      allowFailure: true,
    });
    const bytes = Number(size.stdout.trim());
    if (size.code === 0 && Number.isFinite(bytes) && bytes > limits.maxFileBytes) {
      return { limit: "file", path, bytes };
    }
  }
  return null;
}

export type HandoffThreadActivity = "running" | "queued" | "waiting" | "settled";

export type HandoffStay =
  | "personal"
  | "question"
  | "approval"
  | "sign-in"
  | "user-stop"
  | "settled"
  | "review"
  | "worktree-set"
  | "broken-folder"
  | "limit"
  | "unmeasured"
  | "track"
  | "needs-update"
  | "target";

export interface HandoffThreadFact {
  readonly id: ThreadId;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly personal: boolean;
  readonly activity: HandoffThreadActivity;
  /** Its folder holds uncommitted files or commits on no remote. */
  readonly unsaved: boolean;
  readonly pending: "question" | "approval" | "sign-in" | null;
  /** How its last run ended; `active` while one runs. */
  readonly runEnding: HandoffRunEnding;
  readonly lastTurnEndedAt: string | null;
  /** Why a review thread cannot go to this target, worded for its row; null when it can. */
  readonly reviewStay: string | null;
  /** It works in a worktree set, which moves whole or not at all, once that exists. */
  readonly worktreeSet: boolean;
  /** The path of a folder whose Git data cannot be read. */
  readonly brokenFolder: string | null;
  /**
   * Its model is on more than one track and no routing decision says which one
   * it runs on (`trackOfThread`): the row stays, in both starts, until it is known.
   */
  readonly trackAmbiguous: boolean;
  readonly check: HandoffTargetCheck;
  /** Null until it was measured: such a row cannot be ticked. */
  readonly measure: HandoffMeasure | null;
  /** Its sign-in's usage here, for the automatic start. */
  readonly usage: {
    readonly usedPercent: number | null;
    /** The usage window this reading belongs to; null when its reset is unknown. */
    readonly windowKey: string | null;
    /** An automatic move already took this thread in this window. */
    readonly movedInWindow: boolean;
  } | null;
}

export interface HandoffFolderWorkFact {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly uncommittedFiles: number;
  /** Branches that exist only on the source. */
  readonly branches: ReadonlyArray<string>;
  readonly brokenFolder: string | null;
  readonly measure: HandoffMeasure | null;
}

export interface HandoffPlanFacts {
  readonly start: HandoffPlanStart;
  readonly self: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly target: { readonly environmentId: EnvironmentId; readonly label: string };
  /** The project's usage-limit rule; read by the automatic start only. */
  readonly rule: {
    readonly action: string;
    readonly hasTargets: boolean;
    /** Null when the threshold is turned off: only a limit stop moves. */
    readonly thresholdPercent: number | null;
  } | null;
  readonly threads: ReadonlyArray<HandoffThreadFact>;
  readonly folderWork: ReadonlyArray<HandoffFolderWorkFact>;
  readonly nowMs: number;
}

export type HandoffPlanGroup =
  | "running"
  | "queued"
  | "waiting"
  | "unsaved"
  | "folder-work"
  | "stays";

export interface HandoffPlanItem {
  readonly kind: "thread" | "folder-work";
  /** The thread, or the project whose folder work this is. */
  readonly id: string;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly group: HandoffPlanGroup;
  readonly ticked: boolean;
  /** False for a Stays row. */
  readonly canTick: boolean;
  readonly disposition: HandoffTransferDisposition | "stays";
  readonly stay: HandoffStay | null;
  /** Why it stays, or what the row carries. */
  readonly reason: string | null;
  readonly evidence: PeerCheckEvidence | null;
  readonly measure: HandoffMeasure | null;
}

export interface HandoffPlan {
  readonly start: HandoffPlanStart;
  readonly target: HandoffPlanFacts["target"];
  readonly items: ReadonlyArray<HandoffPlanItem>;
}

const UNMEASURED = "Not measured yet.";

/** An idle thread at the threshold moves only this soon after its last turn. */
export const AUTOMATIC_IDLE_WINDOW_MS = 10 * 60_000;

/** "Resumed on Minis" or "Ready on Minis". */
export function outcomeLine(disposition: HandoffTransferDisposition, machineLabel: string) {
  return `${disposition === "resume" ? "Resumed" : "Ready"} on ${machineLabel}`;
}

/**
 * Whether the automatic start takes this thread at all. It needs `switch` with
 * targets, and takes a thread that stopped on the limit, or one idle at the
 * threshold within ten minutes of its last turn, once per usage window. A
 * thread that still works, or one on the same track with room, is not taken.
 */
function automaticPick(facts: HandoffPlanFacts, thread: HandoffThreadFact): boolean {
  const rule = facts.rule;
  if (rule === null || rule.action !== "switch" || !rule.hasTargets) return false;
  if (thread.activity === "running" || thread.activity === "settled") return false;
  if (thread.runEnding === "usage-limit") return true;
  if (rule.thresholdPercent === null || thread.activity !== "waiting") return false;
  const usage = thread.usage;
  if (usage === null || usage.usedPercent === null || usage.movedInWindow) return false;
  if (usage.usedPercent < rule.thresholdPercent) return false;
  const endedMs = thread.lastTurnEndedAt === null ? Number.NaN : Date.parse(thread.lastTurnEndedAt);
  return Number.isFinite(endedMs) && facts.nowMs - endedMs <= AUTOMATIC_IDLE_WINDOW_MS;
}

/** One thread's row, or null when this start does not take the thread. */
export function planThread(
  facts: HandoffPlanFacts,
  thread: HandoffThreadFact,
): HandoffPlanItem | null {
  const manual = facts.start === "manual";
  if (!manual && !automaticPick(facts, thread)) return null;
  const evidence = thread.check.kind === "checked" ? thread.check.evidence : null;
  const base = {
    kind: "thread" as const,
    id: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    evidence,
    measure: thread.measure,
  };
  const stays = (stay: HandoffStay, reason: string): HandoffPlanItem => ({
    ...base,
    group: "stays",
    ticked: false,
    canTick: false,
    disposition: "stays",
    stay,
    reason: reason.slice(0, 1000),
  });

  if (thread.personal) return stays("personal", "The personal assistant stays on this machine.");
  if (thread.pending !== null) return stays(thread.pending, "Answer it first");
  const idle = thread.activity === "waiting" || thread.activity === "settled";
  // A person moving unsaved work takes it along; nothing starts a turn for it there.
  const carriesWork = manual && idle && thread.unsaved;
  if (thread.runEnding === "user-stop" && !carriesWork)
    return stays("user-stop", "You stopped it.");
  if (thread.activity === "settled" && !carriesWork) {
    return stays("settled", "It is settled and holds no unsaved work.");
  }
  if (thread.reviewStay !== null) return stays("review", thread.reviewStay);
  if (thread.worktreeSet) {
    return stays("worktree-set", "It works in a worktree set across several repositories.");
  }
  if (thread.brokenFolder !== null) {
    return stays("broken-folder", `Its folder's Git data is broken: ${thread.brokenFolder}`);
  }
  // For both starts: by hand a person may accept an account that adds nothing or
  // whose usage is unknown, never a track nobody can name. The check for such a
  // thread names its model alone, and a target that can run the model proves no track.
  if (thread.trackAmbiguous) {
    return stays(
      "track",
      "Its model is on more than one track, and nothing says which one it runs on.",
    );
  }
  // A row is offered only with its size: what was not measured promises nothing.
  if (thread.measure === null) return stays("unmeasured", UNMEASURED);
  if (thread.measure.over !== null) return stays("limit", overLimitText(thread.measure.over));
  switch (thread.check.kind) {
    case "needs-update":
      return stays("needs-update", thread.check.message);
    case "error":
      return stays("target", thread.check.message);
    case "skipped":
      return stays("target", `Not checked against ${facts.target.label}.`);
    case "checked": {
      if (thread.check.failures.length > 0) {
        return stays("target", thread.check.failures.map((failure) => failure.message).join(" "));
      }
      // The target's word is not enough for an automatic move: it must name a sign-in with room.
      if (!manual && evidence?.automatic !== true) {
        return stays(
          "target",
          `${facts.target.label}: ${evidence?.line ?? "its usage could not be confirmed"}`,
        );
      }
    }
  }
  // A settled thread is here for its files: moving them never starts its turn again,
  // however its last run ended. Resume is for a thread that is being continued.
  const resume =
    thread.activity === "running" ||
    (thread.activity !== "settled" && isResumableHandoffEnding(thread.runEnding));
  return {
    ...base,
    group:
      thread.activity === "running"
        ? "running"
        : thread.activity === "queued"
          ? "queued"
          : thread.unsaved && manual
            ? "unsaved"
            : "waiting",
    ticked: true,
    canTick: true,
    disposition: resume ? "resume" : "ready",
    stay: null,
    reason: null,
  };
}

/** The project folder's own work: uncommitted files and branches only on the source. By hand only. */
export function folderWorkItem(
  facts: HandoffPlanFacts,
  work: HandoffFolderWorkFact,
): HandoffPlanItem | null {
  if (facts.start !== "manual") return null;
  if (work.uncommittedFiles === 0 && work.branches.length === 0 && work.brokenFolder === null) {
    return null;
  }
  const base = {
    kind: "folder-work" as const,
    id: work.projectId,
    title: work.title,
    projectId: work.projectId,
    evidence: null,
    measure: work.measure,
  };
  const stay =
    work.brokenFolder !== null
      ? ({ stay: "broken-folder", reason: `Its Git data is broken: ${work.brokenFolder}` } as const)
      : work.measure === null
        ? ({ stay: "unmeasured", reason: UNMEASURED } as const)
        : work.measure.over !== null
          ? ({ stay: "limit", reason: overLimitText(work.measure.over) } as const)
          : null;
  if (stay !== null) {
    return {
      ...base,
      group: "stays",
      ticked: false,
      canTick: false,
      disposition: "stays",
      ...stay,
    };
  }
  const count = (n: number, one: string, many: string) =>
    `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  const parts = [
    ...(work.uncommittedFiles > 0
      ? [count(work.uncommittedFiles, "uncommitted file", "uncommitted files")]
      : []),
    ...(work.branches.length > 0 ? [count(work.branches.length, "branch", "branches")] : []),
  ];
  return {
    ...base,
    group: "folder-work",
    ticked: true,
    canTick: true,
    // Folder work is installed; it never starts a turn.
    disposition: "ready",
    stay: null,
    reason: `${parts.join(" and ")} only on ${facts.self.label}`,
  };
}

/** The plan of one hand off to one target: a row per thread this start takes, then folder work. */
export function buildHandoffPlan(facts: HandoffPlanFacts): HandoffPlan {
  const items: Array<HandoffPlanItem> = [];
  for (const thread of facts.threads) {
    const item = planThread(facts, thread);
    if (item !== null) items.push(item);
  }
  for (const work of facts.folderWork) {
    const item = folderWorkItem(facts, work);
    if (item !== null) items.push(item);
  }
  return { start: facts.start, target: facts.target, items };
}

/**
 * The thread's track at the source. The routing decision that chose its model
 * names the track; a model can sit on both, so its name alone does not. Without
 * a decision the track is the one list that names the model, and when both do
 * it is not guessed: `ambiguous`, and such a row stays in both starts. Null
 * when the project is not on tracks or neither list names the model.
 */
export function trackOfThread(input: {
  readonly review: boolean;
  readonly model: string;
  /** Null when the project is not on tracks. */
  readonly lanes: {
    readonly complex: ReadonlyArray<Pick<ModelSelection, "model">>;
    readonly routine: ReadonlyArray<Pick<ModelSelection, "model">>;
  } | null;
  /** The lane of the thread's routing decision, when it has one. */
  readonly routedLane: "complex" | "routine" | null;
}): { readonly track: ModelTrack | null; readonly ambiguous: boolean } {
  const known = (track: ModelTrack | null) => ({ track, ambiguous: false });
  if (input.lanes === null) return known(null);
  if (input.review) return known("review");
  if (input.routedLane !== null) return known(input.routedLane === "complex" ? "complex" : "daily");
  const complex = input.lanes.complex.some((entry) => entry.model === input.model);
  const daily = input.lanes.routine.some((entry) => entry.model === input.model);
  if (complex && daily) return { track: null, ambiguous: true };
  return known(complex ? "complex" : daily ? "daily" : null);
}
