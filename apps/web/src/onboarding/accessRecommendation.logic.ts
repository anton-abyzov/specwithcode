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

/**
 * Saves a mode on each machine, all or nothing: when any save fails, the
 * machines that did save get `rollback`'s mode back, so a failed accept leaves
 * no machine on Full access without a recorded answer, and a failed Undo
 * leaves none half restored. Resolves true only when every save went through.
 */
export async function writeModesAllOrNothing<Id extends string>(
  modes: ReadonlyMap<Id, RuntimeMode>,
  rollback: ReadonlyMap<Id, RuntimeMode>,
  write: (id: Id, mode: RuntimeMode) => Promise<boolean>,
): Promise<boolean> {
  const attempt = (id: Id, mode: RuntimeMode) => write(id, mode).catch(() => false);
  const entries = [...modes];
  const saved = await Promise.all(entries.map(([id, mode]) => attempt(id, mode)));
  if (saved.every(Boolean)) return true;
  await Promise.all(
    entries.flatMap(([id], index) => {
      const earlier = rollback.get(id);
      return saved[index] && earlier !== undefined ? [attempt(id, earlier)] : [];
    }),
  );
  return false;
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
