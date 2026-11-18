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
