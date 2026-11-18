// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over one small state file, like launchIncrement and ThreadIncrementProgress.
/**
 * SpecweaveSetupRequests - what the server remembers about SpecWeave per
 * project (1396), in `<stateDir>/specweave-setup.json`:
 *
 * - `declined`: the person chose "Plan without it" on the card, "Not now" on
 *   the Board, or dismissed the line above the composer. Launches then raise
 *   no card. A successful setup clears it.
 * - `adviceSeen`: the line above the composer was acted on; it never returns.
 * - `failure`: the last setup that failed, with its reason and whether Node.js
 *   is missing, until the next success.
 * - `request`: the one open "Set up SpecWeave" card of the project, in the
 *   thread that asked for a plan, and its state.
 *
 * Plain functions over the file system, so the services that call them need
 * no new dependency. Writes go through one queue per file and a rename, so a
 * reader never sees half a file.
 *
 * @module SpecweaveSetupRequests
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import {
  SPECWEAVE_DECLINED_WAKE,
  SPECWEAVE_SET_UP_WAKE,
  ThreadId,
  type SpecweaveSetupFailure,
  type SpecweaveSetupRequest,
  type SpecweaveSetupRequestState,
} from "@specweave-studio/contracts";

import { nodePath as NodePath } from "../nodePath.ts";

export const SPECWEAVE_SETUP_FILE = "specweave-setup.json";

export interface ProjectSpecweaveFacts {
  readonly declined?: true;
  readonly adviceSeen?: true;
  readonly failure?: SpecweaveSetupFailure;
  readonly request?: SpecweaveSetupRequest;
}

interface StoreFile {
  readonly version: 1;
  readonly projects: Readonly<Record<string, ProjectSpecweaveFacts>>;
}

const EMPTY: StoreFile = { version: 1, projects: {} };
const queues = new Map<string, Promise<unknown>>();

export function specweaveSetupFile(stateDir: string): string {
  return NodePath.join(stateDir, SPECWEAVE_SETUP_FILE);
}

async function readStore(file: string): Promise<StoreFile> {
  const text = await NodeFSP.readFile(file, "utf8").catch(() => null);
  if (text === null) return EMPTY;
  try {
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    return parsed.version === 1 && parsed.projects !== null && typeof parsed.projects === "object"
      ? { version: 1, projects: parsed.projects }
      : EMPTY;
  } catch {
    return EMPTY;
  }
}

async function writeStore(file: string, store: StoreFile): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await NodeFSP.rename(temp, file).catch(async (error: unknown) => {
    await NodeFSP.rm(temp, { force: true });
    throw error;
  });
}

/** Runs `change` on one project's facts under the file's queue; returns the new facts. */
export function updateProjectFacts(
  file: string,
  projectId: string,
  change: (facts: ProjectSpecweaveFacts) => ProjectSpecweaveFacts,
): Promise<ProjectSpecweaveFacts> {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const store = await readStore(file);
      const facts = change(store.projects[projectId] ?? {});
      const projects = { ...store.projects };
      if (Object.keys(facts).length === 0) delete projects[projectId];
      else projects[projectId] = facts;
      await writeStore(file, { version: 1, projects });
      return facts;
    });
  queues.set(file, next);
  void next.finally(() => {
    if (queues.get(file) === next) queues.delete(file);
  });
  return next;
}

/** One project's facts; empty when the file is missing or unreadable. */
export async function readProjectFacts(
  file: string,
  projectId: string,
): Promise<ProjectSpecweaveFacts> {
  await (queues.get(file) ?? Promise.resolve()).catch(() => undefined);
  return (await readStore(file)).projects[projectId] ?? {};
}

function without<K extends keyof ProjectSpecweaveFacts>(
  facts: ProjectSpecweaveFacts,
  ...keys: K[]
): ProjectSpecweaveFacts {
  const copy: Record<string, unknown> = { ...facts };
  for (const key of keys) delete copy[key];
  return copy as ProjectSpecweaveFacts;
}

/** Remembers a failed setup (the card, the Board, or when the project was made). */
export function recordSetupFailure(
  file: string,
  projectId: string,
  failure: { readonly detail: string; readonly needsNode?: boolean },
  now = new Date(),
): Promise<ProjectSpecweaveFacts> {
  return updateProjectFacts(file, projectId, (facts) => ({
    ...facts,
    failure: {
      detail: failure.detail,
      ...(failure.needsNode === true ? { needsNode: true } : {}),
      failedAt: now.toISOString(),
    },
  }));
}

/** A successful setup clears the failure and the decline (AC-07, AC-08). */
export function recordSetupSuccess(file: string, projectId: string) {
  return updateProjectFacts(file, projectId, (facts) => without(facts, "failure", "declined"));
}

/** "Plan without it", "Not now" or the composer line's dismiss. */
export function recordDeclined(file: string, projectId: string) {
  return updateProjectFacts(file, projectId, (facts) => ({ ...facts, declined: true }));
}

/** Any of the composer line's three actions. */
export function recordAdviceSeen(file: string, projectId: string) {
  return updateProjectFacts(file, projectId, (facts) => ({ ...facts, adviceSeen: true }));
}

/** States in which a card still waits for the person. */
const OPEN_STATES: ReadonlySet<SpecweaveSetupRequestState> = new Set([
  "asking",
  "setting_up",
  "failed",
  "node_missing",
  "not_allowed",
]);

export function isOpenRequest(request: SpecweaveSetupRequest | undefined): boolean {
  return request !== undefined && OPEN_STATES.has(request.state);
}

/**
 * Opens the project's card in `threadId`, or returns the one already open
 * (one card per project, AC-05). `created` says which.
 */
export async function openSetupRequest(
  file: string,
  input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly gitRepository: boolean;
    readonly now?: Date;
  },
): Promise<{ readonly request: SpecweaveSetupRequest; readonly created: boolean }> {
  let created = false;
  const facts = await updateProjectFacts(file, input.projectId, (current) => {
    if (isOpenRequest(current.request)) return current;
    created = true;
    const at = (input.now ?? new Date()).toISOString();
    return {
      ...current,
      request: {
        requestId: NodeCrypto.randomUUID(),
        threadId: ThreadId.make(input.threadId),
        state: "asking",
        gitRepository: input.gitRepository,
        createdAt: at,
        updatedAt: at,
      },
    };
  });
  return { request: facts.request!, created };
}

/**
 * Moves the card to `state`, only when `requestId` is still the project's
 * card. Null when it is not (answered elsewhere, or replaced).
 */
export async function setRequestState(
  file: string,
  input: {
    readonly projectId: string;
    readonly requestId: string;
    readonly state: SpecweaveSetupRequestState;
    readonly detail?: string;
    readonly now?: Date;
  },
): Promise<SpecweaveSetupRequest | null> {
  let moved: SpecweaveSetupRequest | null = null;
  await updateProjectFacts(file, input.projectId, (facts) => {
    const request = facts.request;
    if (request === undefined || request.requestId !== input.requestId) return facts;
    const { detail: _previous, ...rest } = request;
    moved = {
      ...rest,
      state: input.state,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      updatedAt: (input.now ?? new Date()).toISOString(),
    };
    return { ...facts, request: moved };
  });
  return moved;
}

/** A thread to wake with an AC-07 sentence, once per card and outcome. */
export interface SpecweaveWake {
  readonly threadId: string;
  readonly requestId: string;
  readonly outcome: "set_up" | "declined";
}

/** The card a press answers: the project's open one, and the named one when an id is given. */
function answeredRequest(
  facts: ProjectSpecweaveFacts,
  requestId: string | undefined,
): SpecweaveSetupRequest | undefined {
  const request = facts.request;
  if (request === undefined || !isOpenRequest(request)) return undefined;
  if (requestId !== undefined && request.requestId !== requestId) return undefined;
  return request;
}

/**
 * A press on the card starts setup: the card reads Setting up on every device.
 * A press on a card that is already settled (a stale window) changes nothing.
 */
export async function markSettingUp(file: string, projectId: string, requestId: string) {
  const open = answeredRequest(await readProjectFacts(file, projectId), requestId);
  if (open === undefined) return null;
  return setRequestState(file, { projectId, requestId, state: "setting_up" });
}

/**
 * After any setup of the project (the card, the Board, Project settings): a
 * success settles the open card as On and wakes its thread; a failure moves
 * the card it answered to Failed or Node.js missing, with the reason.
 */
export async function settleAfterSetup(
  file: string,
  input: {
    readonly projectId: string;
    readonly requestId?: string | undefined;
    readonly result:
      | { readonly ok: true }
      | { readonly ok: false; readonly detail: string; readonly needsNode: boolean };
    readonly now?: Date;
  },
): Promise<{ readonly request?: SpecweaveSetupRequest; readonly wake?: SpecweaveWake }> {
  const request = answeredRequest(await readProjectFacts(file, input.projectId), input.requestId);
  if (request === undefined) return {};
  if (!input.result.ok && input.requestId === undefined) return {};
  const moved = await setRequestState(file, {
    projectId: input.projectId,
    requestId: request.requestId,
    ...(input.result.ok
      ? { state: "on" as const }
      : {
          state: input.result.needsNode ? ("node_missing" as const) : ("failed" as const),
          detail: input.result.detail,
        }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (moved === null) return {};
  return input.result.ok
    ? {
        request: moved,
        wake: { threadId: moved.threadId, requestId: moved.requestId, outcome: "set_up" },
      }
    : { request: moved };
}

/** "Plan without it", "Not now" and the composer line (AC-07). */
export async function answerSpecweave(
  file: string,
  input: {
    readonly projectId: string;
    readonly answer: "plan_without" | "not_now" | "advice_dismissed" | "advice_seen";
    readonly requestId?: string | undefined;
  },
): Promise<{
  readonly facts: ProjectSpecweaveFacts;
  readonly request?: SpecweaveSetupRequest;
  readonly wake?: SpecweaveWake;
}> {
  const declines = input.answer !== "advice_seen";
  const seen = input.answer === "advice_dismissed" || input.answer === "advice_seen";
  await updateProjectFacts(file, input.projectId, (facts) => ({
    ...facts,
    ...(declines ? { declined: true as const } : {}),
    ...(seen ? { adviceSeen: true as const } : {}),
  }));
  let request: SpecweaveSetupRequest | undefined;
  let wake: SpecweaveWake | undefined;
  if (input.answer === "plan_without") {
    const open = answeredRequest(await readProjectFacts(file, input.projectId), input.requestId);
    if (open !== undefined && isOpenRequest(open)) {
      const moved = await setRequestState(file, {
        projectId: input.projectId,
        requestId: open.requestId,
        state: "declined",
      });
      if (moved !== null) {
        request = moved;
        wake = { threadId: moved.threadId, requestId: moved.requestId, outcome: "declined" };
      }
    }
  }
  return {
    facts: await readProjectFacts(file, input.projectId),
    ...(request === undefined ? {} : { request }),
    ...(wake === undefined ? {} : { wake }),
  };
}

/** The wake's text and its ids: one command per card and outcome, so a repeat is ignored. */
export function specweaveWakeMessage(wake: SpecweaveWake): {
  readonly id: string;
  readonly text: string;
} {
  return {
    id: `specweave-setup:${wake.requestId}:${wake.outcome}`,
    text: wake.outcome === "set_up" ? SPECWEAVE_SET_UP_WAKE : SPECWEAVE_DECLINED_WAKE,
  };
}
