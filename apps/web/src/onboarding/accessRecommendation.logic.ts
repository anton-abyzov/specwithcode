import {
  DEFAULT_RUNTIME_MODE,
  type FullAccessRecommendationAnswer,
  type OnboardingMachineRole,
  type RuntimeMode,
} from "@specweave-studio/contracts";

export interface FullAccessRecommendationInput {
  /** The recorded answer; null until the person answers once. */
  readonly answer: FullAccessRecommendationAnswer | null;
  /** The saved client settings and the machine's settings have loaded. */
  readonly settingsKnown: boolean;
  /** The saved first-run role. A joined machine takes access from the main one. */
  readonly machineRole: OnboardingMachineRole | null;
  /** The access a new chat would start with. */
  readonly mode: RuntimeMode;
  /** The project has its own permissions setting, which wins over the machine's. */
  readonly projectSetsMode: boolean;
  /** Team rules allow Full access here. */
  readonly fullAccessAllowed: boolean;
  /** The chat's provider offers Full access. */
  readonly fullAccessOffered: boolean;
  /** The chat has started; its access is its own from then on. */
  readonly chatStarted: boolean;
}

/**
 * Whether to recommend Full access: once, to someone whose new chats would
 * start below it, where nothing else has decided their access already.
 */
export function shouldRecommendFullAccess(input: FullAccessRecommendationInput): boolean {
  if (input.answer !== null || !input.settingsKnown) return false;
  if (input.machineRole === "joined") return false;
  if (input.mode === "full-access") return false;
  if (input.projectSetsMode || input.chatStarted) return false;
  return input.fullAccessAllowed && input.fullAccessOffered;
}

/** The machines an accept writes, and the mode each had: only those not already on Full access. */
export function machinesToSwitch<Id extends string>(
  machines: readonly { readonly id: Id; readonly mode: RuntimeMode | null }[],
): ReadonlyMap<Id, RuntimeMode> {
  const previous = new Map<Id, RuntimeMode>();
  for (const machine of machines) {
    // A machine whose settings have not loaded yet still starts on the product default.
    const mode = machine.mode ?? DEFAULT_RUNTIME_MODE;
    if (mode !== "full-access") previous.set(machine.id, mode);
  }
  return previous;
}
