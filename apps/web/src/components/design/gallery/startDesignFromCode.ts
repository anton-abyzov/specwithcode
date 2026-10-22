/**
 * The "Design from code" sequence: create the design once, bind it to the
 * thread about to start, then start that thread. A failed start keeps the
 * design, and a retry reuses it instead of creating another one.
 */
import type {
  DesignApplyInput,
  DesignCreateInput,
  DesignGetResult,
  DesignOperation,
  DesignRef,
  DesignSystemId,
  DesignSystemSummary,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";

import { designFromCodePrompt } from "./designFromCode";
import { systemsOwnedBy } from "./SystemSelect";

export type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

export interface DesignFromCodeDeps {
  readonly create: (input: DesignCreateInput) => Promise<Outcome<DesignGetResult>>;
  readonly apply: (input: DesignApplyInput) => Promise<Outcome<DesignGetResult>>;
  readonly startThread: (input: {
    readonly threadId: ThreadId;
    readonly title: string;
    readonly prompt: string;
  }) => Promise<Outcome<unknown>>;
  readonly newThreadId: () => ThreadId;
}

/** A design an earlier attempt created, kept so a retry does not create another. */
export interface PendingDesign {
  readonly projectId: ProjectId;
  readonly ref: DesignRef;
  /** The head revision after this dialog's last write. */
  readonly revision: number;
  readonly title: string;
  readonly designSystem: DesignSystemId | null;
}

export type DesignFromCodeResult =
  | { readonly ok: true; readonly ref: DesignRef; readonly threadId: ThreadId }
  | {
      readonly ok: false;
      readonly message: string;
      /** The design that exists after this attempt, if any; pass it to the next attempt. */
      readonly pending: PendingDesign | null;
    };

const TITLE_MAX = 120;

/** The brief's first line, trimmed; "Untitled design" when there is none. */
export function designTitleFromBrief(brief: string): string {
  const line = brief.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (line === "") return "Untitled design";
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export async function startDesignFromCode(
  deps: DesignFromCodeDeps,
  input: {
    readonly environmentId: EnvironmentId;
    readonly project: { readonly id: ProjectId; readonly title: string };
    readonly designSystem: DesignSystemId | null;
    readonly brief: string;
    readonly systems: readonly DesignSystemSummary[];
    readonly pending: PendingDesign | null;
  },
): Promise<DesignFromCodeResult> {
  const { environmentId, project } = input;
  const owner = { kind: "project", projectId: project.id } as const;
  const title = designTitleFromBrief(input.brief);
  const reuse = input.pending?.projectId === project.id ? input.pending : null;

  // 1. The design, created once per dialog and project.
  let pending: PendingDesign;
  if (reuse === null) {
    const created = await deps.create({
      owner,
      kind: "design",
      title,
      designSystem: input.designSystem,
    });
    if (!created.ok) return { ok: false, message: created.message, pending: input.pending };
    pending = pendingOf(project.id, created.value);
  } else {
    pending = reuse;
  }
  const { ref } = pending;

  // 2. Bind the thread before it starts, so its first edit never races the binding.
  const threadId = deps.newThreadId();
  const operations: DesignOperation[] = [{ op: "set_thread", thread: { environmentId, threadId } }];
  if (pending.title !== title) operations.push({ op: "set_title", title });
  if (pending.designSystem !== input.designSystem)
    operations.push({ op: "set_design_system", systemId: input.designSystem });
  const bound = await deps.apply({
    owner,
    designId: ref.designId,
    expectedRevision: pending.revision,
    operations,
  });
  if (!bound.ok) return { ok: false, message: bound.message, pending };
  pending = pendingOf(project.id, bound.value);

  // 3. The thread. A system is used only when this project owns it.
  const system =
    input.designSystem === null
      ? null
      : (systemsOwnedBy(input.systems, owner).find(
          (candidate) => candidate.ref.systemId === input.designSystem,
        ) ?? null);
  const started = await deps.startThread({
    threadId,
    title,
    prompt: designFromCodePrompt({
      projectTitle: project.title,
      ref,
      title,
      system,
      brief: input.brief,
    }),
  });
  if (started.ok) return { ok: true, ref, threadId };
  // No thread to point at: drop the binding. A retry binds the next one.
  const unbound = await deps.apply({
    owner,
    designId: ref.designId,
    expectedRevision: pending.revision,
    operations: [{ op: "set_thread", thread: null }],
  });
  if (unbound.ok) pending = pendingOf(project.id, unbound.value);
  return { ok: false, message: started.message, pending };
}

function pendingOf(projectId: ProjectId, head: DesignGetResult): PendingDesign {
  return {
    projectId,
    ref: head.ref,
    revision: head.document.revision,
    title: head.document.title,
    designSystem: head.document.designSystem,
  };
}
