/**
 * Per-project notification levels, as the project menu offers them. A project
 * has a main conversation (its coordinator, and any thread the person started
 * or forked) and the threads its agents delegate work to. The level decides
 * which of their events become alerts: a sound, a toast, a desktop
 * notification or a phone push. Every level but "none" alerts on what needs
 * the person (an approval, an answer, a sign-in, a plan or a held queue), and
 * the project row's waiting count counts exactly those, so "none" hides it too.
 */

export type ProjectNotificationLevel = "all" | "coordinator" | "requests" | "none";

export const PROJECT_NOTIFICATION_LEVELS: ReadonlyArray<ProjectNotificationLevel> = [
  "all",
  "coordinator",
  "requests",
  "none",
];

export const DEFAULT_PROJECT_NOTIFICATION_LEVEL: ProjectNotificationLevel = "coordinator";

export const PROJECT_NOTIFICATION_LEVEL_COPY: Record<
  ProjectNotificationLevel,
  { readonly label: string; readonly short: string; readonly description: string }
> = {
  all: {
    label: "All new messages",
    short: "All",
    description: "Includes replies in every thread",
  },
  coordinator: {
    label: "Coordinator and requests",
    short: "Coordinator",
    description: "The main chat and anything waiting on you",
  },
  requests: {
    label: "Only requests",
    short: "Requests",
    description: "Approvals, questions, plans and sign-ins",
  },
  none: { label: "Nothing", short: "Off", description: "No alerts and no waiting count" },
};

export interface ProjectNotificationSettings {
  readonly workspaceSettings?:
    | {
        /** A string on the wire; a value this version does not know reads as unset. */
        readonly notifications?: string | undefined;
      }
    | null
    | undefined;
}

/** The project's saved level, or the default when none is saved or it is unknown. */
export function projectNotificationLevel(
  project: ProjectNotificationSettings | null | undefined,
): ProjectNotificationLevel {
  const saved = project?.workspaceSettings?.notifications;
  return (PROJECT_NOTIFICATION_LEVELS as ReadonlyArray<string>).includes(saved ?? "")
    ? (saved as ProjectNotificationLevel)
    : DEFAULT_PROJECT_NOTIFICATION_LEVEL;
}

/**
 * A thread an agent delegated work to: a worker its coordinator started, or a
 * worker's own helper. Forks and threads the person started are main threads.
 */
export function isDelegatedThread(thread: {
  readonly lineage: { readonly relationshipToParent: string | null };
}): boolean {
  return thread.lineage.relationshipToParent === "subagent";
}

/**
 * Whether an event of a project's thread may alert the person.
 * `needsYou`: the thread is stopped until the person approves, answers, signs
 * in, reviews a plan or decides on a held queue. Anything else (finished,
 * failed, out of usage, gone quiet) is news, not a request.
 */
export function projectAlertAllowed(
  level: ProjectNotificationLevel,
  event: { readonly delegated: boolean; readonly needsYou: boolean },
): boolean {
  switch (level) {
    case "all":
      return true;
    case "coordinator":
      return event.needsYou || !event.delegated;
    case "requests":
      return event.needsYou;
    case "none":
      return false;
  }
}

/** Whether the project's row counts the threads waiting on the person. */
export function projectShowsWaitingCount(level: ProjectNotificationLevel): boolean {
  return level !== "none";
}
