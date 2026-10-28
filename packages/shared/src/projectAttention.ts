/** User action is independent of activity, failures, unread history and availability. */
export type AttentionReason = "approval" | "input" | "signin" | "plan" | "held";
export type AttentionFreshness =
  | "empty"
  | "cached"
  | "synchronizing"
  | "live"
  | "offline"
  | "unauthorized";
export interface AttentionIdentity {
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
}
export const attentionIdentity = (identity: AttentionIdentity): string =>
  JSON.stringify([identity.environmentId, identity.projectId, identity.threadId]);
export interface AttentionObservation extends AttentionIdentity {
  readonly generation: string;
  readonly revision: string;
  readonly title?: string | undefined;
  readonly freshness: AttentionFreshness;
  readonly excluded: boolean;
  readonly settledAt: number | null;
  readonly settled: boolean;
  readonly active: boolean;
  readonly requests: readonly { reason: AttentionReason; id: string; createdAt: number | null }[];
}
export interface ProjectAction extends AttentionIdentity {
  readonly key: string;
  readonly reason: AttentionReason;
  readonly requestId?: string;
  readonly generation: string;
  readonly revision: string;
  readonly title?: string | undefined;
  readonly freshness: AttentionFreshness;
}
export function classifyProjectActions(observation: AttentionObservation): ProjectAction[] {
  if (observation.excluded) return [];
  return observation.requests
    .filter((request) => {
      if (request.reason === "held") return !observation.active;
      // A fresh request can reopen a resolved conversation. Legacy flags cannot.
      return (
        !observation.settled ||
        (observation.settledAt !== null &&
          request.createdAt !== null &&
          request.createdAt > observation.settledAt)
      );
    })
    .map((request) => ({
      environmentId: observation.environmentId,
      projectId: observation.projectId,
      threadId: observation.threadId,
      key: JSON.stringify([attentionIdentity(observation), observation.generation, request.id]),
      reason: request.reason,
      requestId: request.id,
      generation: observation.generation,
      revision: observation.revision,
      title: observation.title,
      freshness: observation.freshness,
    }));
}
/** Re-read immediately before delivery; an old notification is never action evidence. */
export function projectActionIsCurrent(
  action: ProjectAction,
  observation: AttentionObservation,
): boolean {
  return (
    observation.freshness === "live" &&
    classifyProjectActions(observation).some((current) => current.key === action.key)
  );
}

/** Forced updates may restore a card repeatedly; all copies keep one identity. */
export const runtimeRequestFamilyId = (id: string): string =>
  id.replace(/^(?:update-reopen(?:-approval)?:)+/, "");

export function runtimeRequestWasAnswered(request: {
  readonly status: string;
  readonly decision?: string | undefined;
  readonly answers?: Readonly<Record<string, unknown>> | undefined;
}): boolean {
  return (
    request.status === "resolved" &&
    ((request.decision !== undefined && request.decision !== "cancel") ||
      (request.answers !== undefined && Object.keys(request.answers).length > 0))
  );
}

export function answeredRuntimeRequestCopy(
  request: { readonly id: string },
  requests: readonly ({ readonly id: string } & Parameters<typeof runtimeRequestWasAnswered>[0])[],
): boolean {
  const family = runtimeRequestFamilyId(request.id);
  return requests.some(
    (candidate) =>
      runtimeRequestFamilyId(candidate.id) === family && runtimeRequestWasAnswered(candidate),
  );
}
