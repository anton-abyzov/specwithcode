/**
 * Which app shows a thread's desktop notification. The thread's own server
 * elects one client from the activity every app reports to it (see
 * BackgroundPolicy.electNotificationTarget); this module reads that choice,
 * caches it briefly, and turns it into what this app does with an alert.
 *
 * @module notificationTarget
 */
import { raisesAttention } from "@specweave-studio/client-runtime/state/projectAttention";
import type {
  BackgroundPolicySnapshot,
  EnvironmentId,
  NotificationTarget,
} from "@specweave-studio/contracts";

import { appClientId } from "./lib/backgroundActivityReporter";

/** A read is reused for this long, so a burst of alerts asks the server once. */
export const NOTIFICATION_TARGET_CACHE_MS = 5_000;
/** A server that has not answered by then is treated like one too old to answer. */
export const NOTIFICATION_TARGET_TIMEOUT_MS = 1_500;

export type NotificationTargetRead =
  | {
      /** The server named its target, or said nobody qualifies (null). */
      readonly status: "known";
      readonly target: NotificationTarget | null;
      readonly ownerAppConnected: boolean;
    }
  | {
      /** Too old to name a target, or the read failed or timed out. */
      readonly status: "unknown";
      /** Whether the app on the serving machine itself reports to it. */
      readonly ownerAppConnected: boolean;
    };

const UNKNOWN: NotificationTargetRead = { status: "unknown", ownerAppConnected: false };

/** What one app does with one alert. */
export type NotificationDelivery = "post" | "badge" | "none";

export function notificationTargetFromSnapshot(
  environmentId: EnvironmentId,
  snapshot: Pick<BackgroundPolicySnapshot, "leases"> &
    Partial<Pick<BackgroundPolicySnapshot, "notificationTarget">>,
): NotificationTargetRead {
  const ownerAppConnected = snapshot.leases.some(
    (lease) => lease.clientKind !== "mobile" && lease.hostEnvironmentId === environmentId,
  );
  return snapshot.notificationTarget === undefined
    ? { status: "unknown", ownerAppConnected }
    : { status: "known", target: snapshot.notificationTarget, ownerAppConnected };
}

/** True or false when the server named a target; null when it did not. */
export function isNotificationTarget(
  read: NotificationTargetRead | undefined,
  ownClientId: string,
): boolean | null {
  if (read?.status !== "known" || read.target === null) return null;
  return appClientId(read.target.clientId) === appClientId(ownClientId);
}

/**
 * Whether this app can reach an item's owner machine, the one predicate for
 * popups and counts alike. A machine this app does not know, or one the
 * catalog judges unreachable (see isEnvironmentUnreachable), cannot raise the
 * item itself, so this app does.
 */
export function ownerMachineReachable(
  ownerMachineId: string,
  knownEnvironmentIds: readonly string[],
  unreachableEnvironmentIds: ReadonlySet<string>,
): boolean {
  return (
    knownEnvironmentIds.includes(ownerMachineId) && !unreachableEnvironmentIds.has(ownerMachineId)
  );
}

/**
 * Only the target pops up and plays a sound. The owner machine's app still
 * badges, and so does any app when the target is unknown. Without a target,
 * the app on the serving machine pops up, or every app does when that app is
 * not connected to it (a headless server, an older one).
 */
export function decideNotificationDelivery(input: {
  readonly read: NotificationTargetRead | undefined;
  readonly ownClientId: string;
  readonly ownEnvironmentId: string | null;
  readonly servingEnvironmentId: string;
  readonly ownerMachineId: string;
  readonly ownerReachable: boolean;
}): NotificationDelivery {
  const isTarget = isNotificationTarget(input.read, input.ownClientId);
  if (isTarget === true) return "post";
  if (isTarget === false)
    return raisesAttention({
      ownEnvironmentId: input.ownEnvironmentId,
      ownerMachineId: input.ownerMachineId,
      isTarget,
      ownerReachable: input.ownerReachable,
    })
      ? "badge"
      : "none";
  const read = input.read ?? UNKNOWN;
  return input.ownEnvironmentId === input.servingEnvironmentId || !read.ownerAppConnected
    ? "post"
    : "badge";
}

type Fetcher = (environmentId: EnvironmentId) => Promise<BackgroundPolicySnapshot>;

async function fetchBackgroundPolicy(
  environmentId: EnvironmentId,
): Promise<BackgroundPolicySnapshot> {
  // Loaded on first use: the connection runtime is heavy and this module is
  // imported where it is not needed.
  const [
    { executeAtomQuery },
    { connectionAtomRuntime },
    { appAtomRegistry },
    { EnvironmentRegistry },
    { request },
    { WS_METHODS },
    Effect,
  ] = await Promise.all([
    import("@specweave-studio/client-runtime/state/runtime"),
    import("./connection/runtime"),
    import("./rpc/atomRegistry"),
    import("@specweave-studio/client-runtime/connection"),
    import("@specweave-studio/client-runtime/rpc"),
    import("@specweave-studio/contracts"),
    import("effect/Effect"),
  ]);
  const result = await executeAtomQuery(
    appAtomRegistry,
    connectionAtomRuntime.atom(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) =>
          registry.run(environmentId, request(WS_METHODS.serverGetBackgroundPolicy, {})),
        ),
      ),
    ),
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag === "Failure") throw new Error("Could not read the notification target.");
  return result.value;
}

let fetcher: Fetcher = fetchBackgroundPolicy;
const reads = new Map<
  EnvironmentId,
  { readonly read: NotificationTargetRead; readonly atMs: number }
>();
const inFlight = new Map<EnvironmentId, Promise<NotificationTargetRead>>();
const listeners = new Set<() => void>();
let version = 0;

function store(environmentId: EnvironmentId, read: NotificationTargetRead, atMs: number) {
  const previous = reads.get(environmentId)?.read;
  reads.set(environmentId, { read, atMs });
  if (JSON.stringify(previous) === JSON.stringify(read)) return;
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * The serving machine's target, from a read under five seconds old or a fresh
 * one. Never rejects: a failure or a slow answer reads as unknown.
 */
export function readNotificationTarget(
  environmentId: EnvironmentId,
  nowMs: number = Date.now(),
): Promise<NotificationTargetRead> {
  const cached = reads.get(environmentId);
  if (cached && nowMs - cached.atMs < NOTIFICATION_TARGET_CACHE_MS)
    return Promise.resolve(cached.read);
  const pending = inFlight.get(environmentId);
  if (pending) return pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = Promise.race([
    fetcher(environmentId).then(
      (snapshot) => notificationTargetFromSnapshot(environmentId, snapshot),
      () => UNKNOWN,
    ),
    new Promise<NotificationTargetRead>((resolve) => {
      timer = setTimeout(() => resolve(UNKNOWN), NOTIFICATION_TARGET_TIMEOUT_MS);
    }),
  ]).then((result) => {
    clearTimeout(timer);
    inFlight.delete(environmentId);
    store(environmentId, result, Date.now());
    return result;
  });
  inFlight.set(environmentId, read);
  return read;
}

/** The last read of a machine's target, if any, without asking again. */
export function cachedNotificationTarget(
  environmentId: EnvironmentId,
): NotificationTargetRead | undefined {
  return reads.get(environmentId)?.read;
}

export function subscribeNotificationTargets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes whenever a read changes what a machine's target is. */
export function notificationTargetsVersion(): number {
  return version;
}

export function __setNotificationTargetFetcherForTests(next: Fetcher | null): void {
  fetcher = next ?? fetchBackgroundPolicy;
  reads.clear();
  inFlight.clear();
  version = 0;
}
