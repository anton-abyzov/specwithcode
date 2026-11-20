// @effect-diagnostics nodeBuiltinImport:off - Plain promises over the project folder and the setup state file.
/**
 * request_specweave_setup, and the card the launch tools raise (1396 AC-06):
 * one "Set up SpecWeave" card per project, in the thread that asked for a
 * plan. The user's answer wakes that thread (SpecweaveSetupRequests).
 *
 * @module requestSpecweaveSetup
 */
import {
  SPECWEAVE_NEEDED_MESSAGE,
  type RequestSpecweaveSetupResult,
  type SpecweaveNeededLaunchResult,
  type SpecweaveSetupRequest,
} from "@specweave-studio/contracts";

import {
  openSetupRequest,
  readProjectFacts,
  specweaveSetupFile,
} from "../../../project/SpecweaveSetupRequests.ts";
import { insideGitWorkTree, specweaveState } from "../../../project/ThreadIncrementProgress.ts";

export const SPECWEAVE_ALREADY_ON_MESSAGE =
  'SpecWeave is already set up in this project, so no card was raised. Plan the work: launch it with increment "new".';
export const SPECWEAVE_PERSONAL_MESSAGE =
  "A personal assistant does not use SpecWeave, so no card was raised. Plan the work in your reply.";
export const SPECWEAVE_DECLINED_MESSAGE =
  "The user chose to plan without SpecWeave in this project, so no card was raised. Plan the work in your reply before you edit code. Call again with askedByUser: true only when the user asks for a plan, a spec or an increment.";
export const SPECWEAVE_CARD_OPEN_MESSAGE =
  "The user has a card in this thread to set up SpecWeave. End your turn; their answer wakes you.";
export const SPECWEAVE_CARD_ELSEWHERE_MESSAGE =
  "The user already has a card to set up SpecWeave in another thread of this project. End your turn.";

export interface SpecweaveSetupTarget {
  readonly stateDir: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly personal: boolean;
  /** The thread the card shows in; null when the caller is outside a thread. */
  readonly threadId: string | null;
}

/** Where a launch's card goes: the caller's thread in that project, else its coordinator. */
export function setupTargetOf(
  project: {
    readonly id: string;
    readonly workspaceRoot: string;
    readonly workspaceSettings?:
      | { readonly kind?: string; readonly coordinatorThreadId?: string | null }
      | null
      | undefined;
  },
  caller: { readonly id: string; readonly projectId: string } | null | undefined,
  stateDir: string,
): SpecweaveSetupTarget {
  return {
    stateDir,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    personal: project.workspaceSettings?.kind === "personal",
    threadId:
      caller !== undefined && caller !== null && caller.projectId === project.id
        ? caller.id
        : (project.workspaceSettings?.coordinatorThreadId ?? null),
  };
}

/**
 * Whether a launch in this project plans in the worker's reply instead of
 * raising the card: the user declined SpecWeave, or it is a personal assistant.
 */
export async function launchPlansWithoutSpecweave(target: {
  readonly stateDir: string;
  readonly projectId: string;
  readonly personal: boolean;
}): Promise<boolean> {
  return target.personal || (await specweaveDeclinedFor(target.stateDir, target.projectId));
}

/** Whether the user chose "Plan without it" or "Not now" for the project. Never rejects. */
export async function specweaveDeclinedFor(stateDir: string, projectId: string): Promise<boolean> {
  const facts = await readProjectFacts(specweaveSetupFile(stateDir), projectId).catch(() => ({}));
  return "declined" in facts && facts.declined === true;
}

/** Opens the project's card in the target thread, or returns the one already open. */
async function openCard(
  target: SpecweaveSetupTarget | null,
): Promise<SpecweaveSetupRequest | undefined> {
  if (target === null || target.threadId === null) return undefined;
  const gitRepository = await insideGitWorkTree(target.workspaceRoot).catch(() => true);
  const { request } = await openSetupRequest(specweaveSetupFile(target.stateDir), {
    projectId: target.projectId,
    threadId: target.threadId,
    gitRepository,
  });
  return request;
}

/** request_specweave_setup. In a project that is on it raises nothing and says so. */
export async function requestSpecweaveSetup(
  target: SpecweaveSetupTarget,
  options: { readonly askedByUser?: boolean | undefined } = {},
): Promise<RequestSpecweaveSetupResult> {
  const state = await specweaveState(target.workspaceRoot, { personal: target.personal });
  if (target.personal) return { raised: false, state, message: SPECWEAVE_PERSONAL_MESSAGE };
  if (state === "on") return { raised: false, state, message: SPECWEAVE_ALREADY_ON_MESSAGE };
  if (
    options.askedByUser !== true &&
    (await specweaveDeclinedFor(target.stateDir, target.projectId))
  ) {
    return { raised: false, state, message: SPECWEAVE_DECLINED_MESSAGE };
  }
  const request = await openCard(target);
  if (request === undefined) {
    return {
      raised: false,
      state,
      message: "No card was raised: call this from a thread in the project.",
    };
  }
  return {
    raised: true,
    state,
    message:
      request.threadId === target.threadId
        ? SPECWEAVE_CARD_OPEN_MESSAGE
        : SPECWEAVE_CARD_ELSEWHERE_MESSAGE,
    specweaveSetupRequest: request,
  };
}

/**
 * A launch with increment "new" in a project without SpecWeave: no thread,
 * the card instead. A card that cannot be stored still stops the launch.
 */
export async function specweaveNeededLaunch(
  /** Null when no state folder is known: the launch still stops, with no card. */
  target: SpecweaveSetupTarget | null,
): Promise<SpecweaveNeededLaunchResult> {
  const request = await openCard(target).catch(() => undefined);
  return {
    launched: false,
    needs: "specweave",
    message: SPECWEAVE_NEEDED_MESSAGE,
    ...(request === undefined ? {} : { specweaveSetupRequest: request }),
  };
}

/** An explicit increment in an unfinished project: the launch goes on and the card is raised. */
export async function raiseSetupCardBeside(target: SpecweaveSetupTarget): Promise<void> {
  if (await launchPlansWithoutSpecweave(target)) return;
  await openCard(target).catch(() => undefined);
}

/** Whether a launch tool's result is the "needs SpecWeave" answer instead of a launch. */
export function isSpecweaveNeeded(result: object): result is SpecweaveNeededLaunchResult {
  return "needs" in result && result.needs === "specweave" && "launched" in result;
}

/** A launch tool's result that did launch; throws on the "needs SpecWeave" answer (tests). */
export function launchedOrThrow<T extends object>(
  result: T,
): Exclude<T, SpecweaveNeededLaunchResult> {
  if (isSpecweaveNeeded(result)) throw new Error(result.message);
  return result as Exclude<T, SpecweaveNeededLaunchResult>;
}
