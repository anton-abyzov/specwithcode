/**
 * The "Design from code" sequence: create the design once, already bound to
 * the thread about to start, then start that thread. When this window may not
 * bind it, the thread still starts and binds itself (an agent may always bind
 * its own thread), so creation never stops at a permission. A failed start
 * keeps the design, and a retry reuses it instead of creating another one.
 */
import type {
  DesignApplyInput,
  DesignCreateInput,
  DesignGetResult,
  DesignOperation,
  DesignRef,
  DesignReuse,
  DesignSystemId,
  DesignSystemSummary,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";

import { designFromCodePrompt } from "./designFromCode";
import type { FoundSystem } from "./foundSystems";
import { systemsOwnedBy } from "./SystemSelect";

export type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  /**
   * `code` is the server's error code (`forbidden`, `conflict`), when it sent one;
   * `currentRevision` is the revision on disk, with a conflict.
   */
  | {
      readonly ok: false;
      readonly message: string;
      readonly code?: string;
      readonly currentRevision?: number;
    };

export interface DesignFromCodeDeps {
  readonly create: (input: DesignCreateInput) => Promise<Outcome<DesignGetResult>>;
  readonly apply: (input: DesignApplyInput) => Promise<Outcome<DesignGetResult>>;
  readonly startThread: (input: {
    readonly threadId: ThreadId;
    readonly title: string;
    readonly prompt: string;
  }) => Promise<Outcome<unknown>>;
  readonly newThreadId: () => ThreadId;
  /**
   * Makes the review proposal for a system found in the repository (in memory
   * on the server; nothing is written until the user confirms it in Settings).
   */
  readonly propose?: (found: FoundSystem) => Promise<Outcome<{ readonly id: string }>>;
  readonly now?: () => string;
}

/** A design an earlier attempt created, kept so a retry does not create another. */
export interface PendingDesign {
  readonly projectId: ProjectId;
  readonly ref: DesignRef;
  /** The head revision after this dialog's last write. */
  readonly revision: number;
  readonly title: string;
  readonly designSystem: DesignSystemId | null;
  readonly reuse: DesignReuse | null;
  /** The found system's scan key, so a retry reuses its proposal. */
  readonly foundKey?: string | null;
  /** This window was refused binding the design; a retry leaves binding to the agent. */
  readonly bindRefused?: boolean;
}

export type DesignFromCodeResult =
  | {
      readonly ok: true;
      readonly ref: DesignRef;
      readonly threadId: ThreadId;
      /** The agent attaches the thread itself: this window was not allowed to. */
      readonly selfBind: boolean;
    }
  | {
      readonly ok: false;
      readonly message: string;
      /** The design that exists after this attempt, if any; pass it to the next attempt. */
      readonly pending: PendingDesign | null;
    };

const TITLE_MAX = 60;

/**
 * The brief's first line, trimmed and cut at a word near 60 characters, so a
 * sentence-long brief still reads as a title; "Untitled design" when empty.
 * The agent may retitle it.
 */
export function designTitleFromBrief(brief: string): string {
  const line = brief.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (line === "") return "Untitled design";
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
}

/** What the design records about a system found in its repository: its files, strongest first. */
export function reuseOf(found: FoundSystem, proposalId: string | null, now: string): DesignReuse {
  const paths = [...new Set([...found.sources.map((source) => source.path), ...found.paths])];
  return {
    name: found.name.slice(0, 180),
    paths: paths.slice(0, 24),
    tokens: found.tokens,
    components: found.components,
    modes: found.modes.slice(0, 12),
    ...(proposalId === null ? {} : { proposalId }),
    foundAt: now,
  };
}

const sameReuse = (left: DesignReuse | null, right: DesignReuse | null) =>
  left === null || right === null
    ? left === right
    : left.name === right.name && left.paths.join("\n") === right.paths.join("\n");

export async function startDesignFromCode(
  deps: DesignFromCodeDeps,
  input: {
    readonly environmentId: EnvironmentId;
    readonly project: { readonly id: ProjectId; readonly title: string };
    readonly designSystem: DesignSystemId | null;
    /** Its name, for a system the list does not show yet (a copy made at Start). */
    readonly designSystemName?: string | null;
    /** A system found in the repository, followed until someone imports it. */
    readonly found?: FoundSystem | null;
    readonly brief: string;
    readonly systems: readonly DesignSystemSummary[];
    readonly pending: PendingDesign | null;
  },
): Promise<DesignFromCodeResult> {
  const { environmentId, project } = input;
  const owner = { kind: "project", projectId: project.id } as const;
  const title = designTitleFromBrief(input.brief);
  const found = input.designSystem === null ? (input.found ?? null) : null;
  let reused = input.pending?.projectId === project.id ? input.pending : null;
  const thread = { environmentId, threadId: deps.newThreadId() };

  // The proposal is what the user reviews and imports; failing to make one never stops the design.
  let proposalId: string | null =
    found !== null && reused?.foundKey === found.key ? (reused.reuse?.proposalId ?? null) : null;
  if (found !== null && proposalId === null && deps.propose !== undefined) {
    const proposed = await deps.propose(found);
    if (proposed.ok) proposalId = proposed.value.id;
  }
  const reuse = found === null ? null : reuseOf(found, proposalId, (deps.now ?? isoNow)());

  // 2. A retry: bind the next thread, and bring the title, system and provenance up to date.
  // A design deleted since then is created again; one edited since then takes the changes on top.
  let pending: PendingDesign | null = null;
  let bound = false;
  if (reused !== null) {
    const prior = reused;
    const changes: DesignOperation[] = [];
    if (prior.title !== title) changes.push({ op: "set_title", title });
    if (prior.designSystem !== input.designSystem)
      changes.push({ op: "set_design_system", systemId: input.designSystem });
    if (!sameReuse(prior.reuse, reuse)) changes.push({ op: "set_reuse", reuse });
    const write = async (operations: DesignOperation[]) => {
      if (operations.length === 0) return null;
      const attempt = (expectedRevision: number) =>
        deps.apply({ owner, designId: prior.ref.designId, expectedRevision, operations });
      const first = await attempt(prior.revision);
      return !first.ok && first.code === "conflict" && first.currentRevision !== undefined
        ? attempt(first.currentRevision)
        : first;
    };
    // Refused binding is never retried: the rest still lands, and the agent binds itself.
    let refused = prior.bindRefused === true;
    let applied = await write(refused ? changes : [{ op: "set_thread", thread }, ...changes]);
    if (applied !== null && !applied.ok && applied.code === "forbidden" && !refused) {
      refused = true;
      applied = await write(changes);
    }
    if (applied !== null && !applied.ok && applied.code === "not_found") reused = null;
    else {
      pending = {
        ...(applied?.ok ? pendingOf(project.id, applied.value, found?.key) : prior),
        bindRefused: refused,
      };
      if (applied !== null && !applied.ok && applied.code !== "forbidden")
        return { ok: false, message: applied.message, pending };
      bound = !refused && applied?.ok === true;
    }
  }
  // 1. The design, created once per project, bound in the same write when this window may.
  if (pending === null) {
    const base = {
      owner,
      kind: "design" as const,
      title,
      designSystem: input.designSystem,
      ...(reuse === null ? {} : { reuse }),
    };
    let created = await deps.create({ ...base, thread });
    const refused = !created.ok && created.code === "forbidden";
    if (refused) created = await deps.create(base);
    if (!created.ok) return { ok: false, message: created.message, pending: reused };
    const foundKey = found?.key ?? null;
    pending = { ...pendingOf(project.id, created.value, foundKey), bindRefused: refused };
    bound = sameThread(created.value.document.thread, thread);
    // A server older than create-time binding ignores `thread`: bind in a write of its own.
    if (!bound && !refused && created.value.document.thread === undefined) {
      const attached = await deps.apply({
        owner,
        designId: pending.ref.designId,
        expectedRevision: pending.revision,
        operations: [{ op: "set_thread", thread }],
      });
      if (attached.ok) pending = pendingOf(project.id, attached.value, foundKey);
      else if (attached.code === "forbidden") pending = { ...pending, bindRefused: true };
      else return { ok: false, message: attached.message, pending };
      bound = attached.ok;
    }
  }
  const { ref } = pending;

  // 3. The thread. A system is used only when this project owns it.
  const listed =
    input.designSystem === null
      ? null
      : (systemsOwnedBy(input.systems, owner).find(
          (candidate) => candidate.ref.systemId === input.designSystem,
        ) ?? null);
  const system =
    listed ??
    (input.designSystem === null || input.designSystemName == null
      ? null
      : { name: input.designSystemName, ref: { systemId: input.designSystem } });
  const started = await deps.startThread({
    threadId: thread.threadId,
    title,
    prompt: designFromCodePrompt({
      projectTitle: project.title,
      ref,
      title,
      system,
      found: found === null ? null : { ...found, proposalId },
      brief: input.brief,
      selfBind: bound ? null : thread,
    }),
  });
  if (started.ok) return { ok: true, ref, threadId: thread.threadId, selfBind: !bound };
  if (bound) {
    // No thread to point at: drop the binding. A retry binds the next one.
    const unbound = await deps.apply({
      owner,
      designId: ref.designId,
      expectedRevision: pending.revision,
      operations: [{ op: "set_thread", thread: null }],
    });
    if (unbound.ok) pending = pendingOf(project.id, unbound.value, pending.foundKey);
  }
  return { ok: false, message: started.message, pending };
}

const isoNow = () => new Date().toISOString();

const sameThread = (
  left: { readonly environmentId: string; readonly threadId: string } | undefined,
  right: { readonly environmentId: string; readonly threadId: string },
) => left?.environmentId === right.environmentId && left.threadId === right.threadId;

function pendingOf(
  projectId: ProjectId,
  head: DesignGetResult,
  foundKey: string | null | undefined,
): PendingDesign {
  return {
    projectId,
    ref: head.ref,
    revision: head.document.revision,
    title: head.document.title,
    designSystem: head.document.designSystem,
    reuse: head.document.reuse ?? null,
    foundKey: head.document.reuse === undefined ? null : (foundKey ?? null),
  };
}
