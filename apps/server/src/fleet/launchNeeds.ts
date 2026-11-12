/**
 * Placing work that needs a particular kind of machine, such as an iOS
 * Simulator, on one that has it. Pure: the caller gathers what each machine
 * reported and launches where this says; the machine chosen still authorizes
 * the launch itself.
 */
import type {
  ExecutionEnvironmentPlatform,
  OrchestratorMcpLaunchNeed,
  OrchestratorMcpMachinePlatform,
} from "@specweave-studio/contracts";

/** Whether a machine meets a need: "unknown" when it has not said (an older version). */
export type NeedFit = "yes" | "no" | "unknown";

const OS_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux", windows: "Windows" };
const OS_VALUES = new Set(["darwin", "linux", "windows", "unknown"]);
const ARCH_VALUES = new Set(["arm64", "x64", "other"]);

const NEED_TEXT: Record<OrchestratorMcpLaunchNeed, string> = {
  ios_simulator: "an iOS Simulator (a Mac with Xcode)",
  macos: "macOS (a Mac, for Xcode)",
};

/** This machine's own report, from its descriptor and the simulator and Xcode checks. */
export const localMachinePlatform = (
  platform: Pick<ExecutionEnvironmentPlatform, "os" | "arch">,
  iosSimulators: boolean | undefined,
  xcodeBuild?: boolean | undefined,
): OrchestratorMcpMachinePlatform => ({
  os: platform.os,
  arch: platform.arch,
  ...(iosSimulators === undefined
    ? {}
    : { iosSimulators: platform.os === "darwin" && iosSimulators }),
  ...(xcodeBuild === undefined ? {} : { xcodeBuild: platform.os === "darwin" && xcodeBuild }),
});

/**
 * What another machine reported in `orchestrator_capabilities`, read
 * leniently: missing or malformed means unknown, and an operating system this
 * build does not know is "unknown", never a "no".
 */
export const readMachinePlatform = (
  capabilities: unknown,
): OrchestratorMcpMachinePlatform | undefined => {
  if (typeof capabilities !== "object" || capabilities === null) return undefined;
  const platform = (capabilities as { readonly platform?: unknown }).platform;
  if (typeof platform !== "object" || platform === null) return undefined;
  const { os, arch, iosSimulators, xcodeBuild } = platform as Record<string, unknown>;
  if (typeof os !== "string") return undefined;
  return {
    os: OS_VALUES.has(os) ? (os as OrchestratorMcpMachinePlatform["os"]) : "unknown",
    arch:
      typeof arch === "string" && ARCH_VALUES.has(arch)
        ? (arch as OrchestratorMcpMachinePlatform["arch"])
        : "other",
    ...(typeof iosSimulators === "boolean" ? { iosSimulators } : {}),
    ...(typeof xcodeBuild === "boolean" ? { xcodeBuild } : {}),
  };
};

const fitOne = (
  need: OrchestratorMcpLaunchNeed,
  platform: OrchestratorMcpMachinePlatform | undefined,
): NeedFit => {
  if (platform === undefined || platform.os === "unknown") return "unknown";
  if (platform.os !== "darwin") return "no";
  if (need === "macos") return "yes";
  return platform.iosSimulators === undefined ? "unknown" : platform.iosSimulators ? "yes" : "no";
};

/**
 * How well a Mac that meets the needs suits Mac work: 0 with full Xcode, 1
 * when it has not said (an older version), 2 without it. A Mac without Xcode
 * still runs Mac-only work that is not an Xcode build, so it is used last, not
 * refused. Other needs do not care, so their machines are all 0.
 */
const xcodeRank = (
  needs: ReadonlyArray<OrchestratorMcpLaunchNeed>,
  platform: OrchestratorMcpMachinePlatform | undefined,
): number => {
  if (!needs.includes("macos") || platform?.os !== "darwin") return 0;
  return platform.xcodeBuild === undefined ? 1 : platform.xcodeBuild ? 0 : 2;
};

/** Added to the note of a chosen Mac that reported it has no full Xcode. */
export const NO_XCODE_NOTE = "This Mac has no full Xcode; an Xcode build will fail there.";

const withXcodeNote = <T>(
  needs: ReadonlyArray<OrchestratorMcpLaunchNeed>,
  choice: NeedsChoice<T>,
): NeedsChoice<T> =>
  xcodeRank(needs, choice.candidate.platform) === 2
    ? { ...choice, note: `${choice.note} ${NO_XCODE_NOTE}` }
    : choice;

export const needsFit = (
  needs: ReadonlyArray<OrchestratorMcpLaunchNeed>,
  platform: OrchestratorMcpMachinePlatform | undefined,
): NeedFit => {
  const fits = needs.map((need) => fitOne(need, platform));
  if (fits.includes("no")) return "no";
  return fits.every((fit) => fit === "yes") ? "yes" : "unknown";
};

/** "Linux", "macOS without a working Xcode simctl", or "an unknown system". */
export const platformDescription = (platform: OrchestratorMcpMachinePlatform | undefined) => {
  if (platform === undefined || platform.os === "unknown") return "an unknown system";
  const name = OS_NAMES[platform.os] ?? "an unknown system";
  if (platform.os !== "darwin") return name;
  return platform.iosSimulators === false ? `${name} without a working Xcode simctl` : name;
};

const needsText = (needs: ReadonlyArray<OrchestratorMcpLaunchNeed>) =>
  [...new Set(needs)].map((need) => NEED_TEXT[need]).join(" and ");

export interface NeedsCandidate<T> {
  /** Identifies one machine, so a machine listed twice is tried once. */
  readonly key: string;
  readonly label: string;
  readonly platform: OrchestratorMcpMachinePlatform | undefined;
  readonly value: T;
}

export interface NeedsChoice<T> {
  readonly candidate: NeedsCandidate<T>;
  readonly fit: NeedFit;
  /** Why this machine, for the launch result. */
  readonly note: string;
}

export type NeedsPlacement<T> =
  | {
      readonly ok: true;
      /** Best first: machines that meet the needs, then ones that have not said. */
      readonly chosen: ReadonlyArray<NeedsChoice<T>>;
      readonly skipped: ReadonlyArray<{ readonly machine: string; readonly reason: string }>;
    }
  | { readonly ok: false; readonly message: string };

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const listing = (labels: ReadonlyArray<string>) =>
  labels.length <= 1
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

/**
 * Where work with `needs` may run. A named machine runs it unless it is known
 * not to qualify; one that has not said is allowed. Without one, `preferred`
 * (the machines this launch would use anyway, in the usual order) is tried
 * first. `fallback` (other connected machines this one may start work on) is
 * used only when no preferred machine reports the need, and its choices say
 * so. Machines that qualify come before ones that have not said, and one known
 * not to is never chosen. When none is left the launch is refused with what is
 * missing.
 */
export const chooseForNeeds = <T>(input: {
  readonly needs: ReadonlyArray<OrchestratorMcpLaunchNeed>;
  readonly explicit?: NeedsCandidate<T> | undefined;
  readonly preferred: ReadonlyArray<NeedsCandidate<T>>;
  readonly fallback?: ReadonlyArray<NeedsCandidate<T>> | undefined;
}): NeedsPlacement<T> => {
  const needs = input.needs;
  const wanted = needsText(needs);
  const seen = new Set<string>();
  const unique = (candidates: ReadonlyArray<NeedsCandidate<T>>) =>
    candidates.filter((candidate) => {
      if (seen.has(candidate.key)) return false;
      seen.add(candidate.key);
      return true;
    });
  const primary = unique(input.preferred);
  const extra = unique(input.fallback ?? []);
  const fits = (candidate: NeedsCandidate<T>, fit: NeedFit) =>
    needsFit(needs, candidate.platform) === fit;
  const qualifying = [...primary, ...extra].filter((candidate) => fits(candidate, "yes"));
  const others =
    qualifying.length === 0
      ? ""
      : ` Machines that can: ${listing(qualifying.map((candidate) => candidate.label))}.`;
  if (input.explicit !== undefined) {
    const explicit = input.explicit;
    const fit = needsFit(needs, explicit.platform);
    if (fit === "no")
      return {
        ok: false,
        message: `${sentence(explicit.label)} cannot run this work: it needs ${wanted}, and ${explicit.label} is ${platformDescription(explicit.platform)}.${others || " No connected machine reports it can. The user can add a Mac in Settings > Machines."}`,
      };
    return {
      ok: true,
      chosen: [
        withXcodeNote(needs, {
          candidate: explicit,
          fit,
          note:
            fit === "yes"
              ? `${sentence(explicit.label)} was named and has ${wanted}.`
              : `${sentence(explicit.label)} was named; it has not said whether it has ${wanted} (an older version), so it was used as asked.`,
        }),
      ],
      skipped: [],
    };
  }
  // The usual machines keep the work whenever one of them reports the need,
  // unless every Mac among them reports it has no full Xcode.
  const usualQualifies = primary.filter((candidate) => fits(candidate, "yes"));
  const outside = usualQualifies.some((candidate) => xcodeRank(needs, candidate.platform) < 2)
    ? []
    : extra;
  const usual = listing(primary.map((candidate) => candidate.label));
  const missing = usualQualifies.length > 0 ? "full Xcode" : wanted;
  const outsideNote = (candidate: NeedsCandidate<T>, has: string) =>
    `Chosen outside the usual machines (${usual || "none"}) because none of them reports ${missing}; ${candidate.label} ${has}.`;
  const skipped = [...primary, ...outside]
    .filter((candidate) => fits(candidate, "no"))
    .map((candidate) => ({
      machine: candidate.label,
      reason: `It is ${platformDescription(candidate.platform)}; this work needs ${wanted}.`,
    }));
  const unknownNote = (candidate: NeedsCandidate<T>) =>
    `Tried because no machine that reports ${wanted} could take it, and ${candidate.label} has not said whether it has it (an older version).`;
  // Among machines that qualify, a Mac with full Xcode comes first and one
  // without it last; the sort is stable, so the usual order holds otherwise.
  const qualified: Array<NeedsChoice<T>> = [
    ...usualQualifies.map((candidate) => ({
      candidate,
      fit: "yes" as const,
      note: `Chosen because this work needs ${wanted} and ${candidate.label} has it.`,
    })),
    ...outside
      .filter((candidate) => fits(candidate, "yes"))
      .map((candidate) => ({
        candidate,
        fit: "yes" as const,
        note: outsideNote(candidate, "has it"),
      })),
  ].toSorted(
    (left, right) =>
      xcodeRank(needs, left.candidate.platform) - xcodeRank(needs, right.candidate.platform),
  );
  const chosen: Array<NeedsChoice<T>> = [
    ...qualified.map((choice) => withXcodeNote(needs, choice)),
    ...primary
      .filter((candidate) => fits(candidate, "unknown"))
      .map((candidate) => ({ candidate, fit: "unknown" as const, note: unknownNote(candidate) })),
    ...outside
      .filter((candidate) => fits(candidate, "unknown"))
      .map((candidate) => ({
        candidate,
        fit: "unknown" as const,
        note: outsideNote(candidate, "has not said whether it has it (an older version)"),
      })),
  ];
  if (chosen.length > 0) return { ok: true, chosen, skipped };
  const described = [...primary, ...outside].map(
    (candidate) => `${candidate.label} is ${platformDescription(candidate.platform)}`,
  );
  return {
    ok: false,
    message: `No connected machine can run this work: it needs ${wanted}${described.length > 0 ? `, and ${listing(described)}` : ""}. Nothing was started. Tell the user: they can add a Mac in Settings > Machines > Add a machine, or allow one listed there, then launch again.`,
  };
};

/**
 * Added to a device tool's error on a machine that cannot run iOS Simulators
 * and has no device host: which connected Macs can, and how work gets there.
 */
export const iosSimulatorElsewhereHint = (macs: ReadonlyArray<string>) =>
  macs.length === 0
    ? "This machine cannot run iOS Simulators and has no device host set up, and no connected Mac reports that it can. The user can add a Mac in Settings > Machines, or set up a device host in the Device panel."
    : `This machine cannot run iOS Simulators and has no device host set up. Connected ${macs.length === 1 ? "Mac that can" : "Macs that can"}: ${listing(macs)}. Run this work there: start it with studio_thread_launch and needs:["ios_simulator"] (or machine:"${macs[0]}"), or move this thread with studio_thread_migrate. If this thread may not do either, end your turn and say which Mac to use.`;
