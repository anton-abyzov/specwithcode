/**
 * Moving a limited thread to another device: the other device runs its own
 * providers on its own accounts, so a thread stopped by one account's limit
 * can continue there. Nothing native crosses devices, so the new thread
 * starts from a written handoff of the conversation.
 *
 * @module deviceHandoff
 */
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2TurnItem,
  ProjectId,
  ServerProvider,
} from "@specweave-studio/contracts";
import {
  canTakeTurn,
  isClaudeApiKeyProvider,
  providerUsedPercent,
} from "@specweave-studio/shared/providerFallback";

const MESSAGE_CHARS = 1_500;
const RECENT_MESSAGES = 8;
const TOTAL_CHARS = 12_000;

function defaultModel(provider: ServerProvider): string | undefined {
  return (
    provider.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    provider.models.find((model) => !model.isCustom)?.slug ??
    provider.models[0]?.slug
  );
}

/**
 * The model the thread continues on over there: the same driver and model
 * when that device has it ready, else any ready subscription provider on its
 * default model. A provider at or past `belowPercent` is skipped, so a
 * device signed in to the same full account is never offered. API-key
 * instances are never picked: their turns cost money.
 */
export function pickDeviceModel(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly currentDriver: string | null;
  readonly belowPercent: number | null;
  readonly nowMs: number;
}): ModelSelection | null {
  const limit = input.belowPercent ?? 100;
  const ready = input.providers.filter((provider) => {
    if (!canTakeTurn(provider) || isClaudeApiKeyProvider(provider)) return false;
    const used = providerUsedPercent(provider, input.nowMs, input.current.model);
    return used === null || used < limit;
  });
  const same = ready.find(
    (provider) =>
      provider.driver === input.currentDriver &&
      provider.models.some((model) => model.slug === input.current.model),
  );
  if (same) return { instanceId: same.instanceId, model: input.current.model };
  for (const provider of ready) {
    const model = defaultModel(provider);
    if (model !== undefined) return { instanceId: provider.instanceId, model };
  }
  return null;
}

export interface ContinueCandidate {
  readonly environmentId: EnvironmentId;
  /** Null for a machine whose own chat folder project is made on first use. */
  readonly projectId: ProjectId | null;
  readonly label: string;
  readonly connected: boolean;
  readonly canOperate: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
}

export interface ContinueTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly label: string;
  readonly selection: ModelSelection;
  readonly model: string;
}

/**
 * Where a thread whose machine can't be reached can carry on: the first other
 * machine, in the order given, that is connected, lets this client start
 * threads and has a ready subscription provider. A project thread needs the
 * project on that machine; a chat without a project uses that machine's own
 * chat folder, which may not exist yet.
 */
export function pickContinueTarget(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly candidates: ReadonlyArray<ContinueCandidate>;
  readonly chatFolder: boolean;
  readonly current: ModelSelection;
  readonly currentDriver: string | null;
  readonly nowMs: number;
}): ContinueTarget | null {
  for (const candidate of input.candidates) {
    if (candidate.environmentId === input.sourceEnvironmentId) continue;
    if (!candidate.connected || !candidate.canOperate) continue;
    if (candidate.projectId === null && !input.chatFolder) continue;
    const selection = pickDeviceModel({
      providers: candidate.providers,
      current: input.current,
      currentDriver: input.currentDriver,
      belowPercent: null,
      nowMs: input.nowMs,
    });
    if (selection === null) continue;
    const provider = candidate.providers.find((entry) => entry.instanceId === selection.instanceId);
    return {
      environmentId: candidate.environmentId,
      projectId: candidate.projectId,
      label: candidate.label,
      selection,
      model:
        provider?.models.find((model) => model.slug === selection.model)?.name ?? selection.model,
    };
  }
  return null;
}

const clip = (text: string, max: number): string => {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()} [...]`;
};

/**
 * The first message of the thread on the other device: what the work is,
 * where its code is, and the conversation so far (the first request and
 * the latest messages, each clipped), so a fresh session can pick it up.
 * `reason` says why it moved: the source's provider hit its limit, or the
 * source machine can't be reached. A chat without a project gets a new chat
 * folder over there; the old one's files stay on the source.
 */
export function deviceHandoffText(input: {
  readonly title: string;
  readonly sourceLabel: string;
  readonly branch: string | null;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly reason?: "usage_limit" | "unreachable";
  readonly chatFolder?: boolean;
}): string {
  const messages = input.turnItems.flatMap((item) =>
    (item.type === "user_message" || item.type === "assistant_message") &&
    item.text.trim().length > 0
      ? [
          `${item.type === "user_message" ? "User" : "Assistant"}: ${clip(item.text, MESSAGE_CHARS)}`,
        ]
      : [],
  );
  const first = messages[0];
  let recent = messages.slice(1).slice(-RECENT_MESSAGES);
  const why =
    input.reason === "unreachable"
      ? "which can't be reached right now"
      : "where the provider reached its usage limit";
  const header = [
    `Continue work started on ${input.sourceLabel}, ${why}. Pick up where it stopped.`,
    "",
    `Thread: ${input.title}`,
    input.chatFolder
      ? `Requested workspace: a new chat folder on this device. Files in the chat folder on ${input.sourceLabel} stay there and are not available here; ask for anything the work needs from them.`
      : input.branch
        ? `Branch: ${input.branch}. Requested workspace: a worktree based on this branch as pushed. Verify the destination checkout before continuing; changes ${input.sourceLabel} had not pushed may be missing.`
        : `Requested workspace: the project's own checkout on the destination device. Verify it before continuing; changes ${input.sourceLabel} had not pushed may be missing.`,
  ];
  const body = () => [
    "",
    "Conversation so far, oldest first:",
    ...(first ? [first] : []),
    ...(first && recent.length < messages.length - 1 ? ["[earlier messages left out]"] : []),
    ...recent,
    "",
    "Continue the task from where it stopped.",
  ];
  while (recent.length > 1 && [...header, ...body()].join("\n").length > TOTAL_CHARS) {
    recent = recent.slice(1);
  }
  return messages.length === 0
    ? [...header, "", "Continue the task from where it stopped."].join("\n")
    : [...header, ...body()].join("\n");
}
