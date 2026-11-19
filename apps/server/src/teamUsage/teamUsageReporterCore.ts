/**
 * The team usage reporter's logic (0898 AC-01, AC-04), apart from the
 * services it runs on so tests drive it with plain fakes.
 *
 * Off by default. While off it makes no request and does not look up any
 * token. On, it sends this machine's summary at most once an hour, and only
 * when its numbers changed or a new UTC day began. Turning it off, or moving
 * to another endpoint or machine label, stops sending and asks the old
 * endpoint to delete that machine's history, retried until it confirms.
 * Every label this machine reported under is remembered, so a rename of the
 * machine never leaves history behind. A self-hosted credential belongs to
 * its own endpoint address and is never sent anywhere else. Updates, sends
 * and removals run one at a time, so a send in flight cannot put back
 * history an opt-out just removed.
 *
 * @module teamUsage/teamUsageReporterCore
 */
import type {
  TeamUsageConfig,
  TeamUsageEndpoint,
  TeamUsageStatus,
  TeamUsageSummary,
  TeamUsageUpdateInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import {
  type TeamUsageCredentials,
  type TeamUsageRequest,
  teamUsageDeleteRequest,
  teamUsageEndpointUrl,
  teamUsageSendRequest,
} from "./teamUsageTransport.ts";
import { teamUsageLabel } from "./teamUsageSummary.ts";

export const TEAM_USAGE_FILE = "team-usage.json";
export const TEAM_USAGE_SECRET = "team-usage-self-hosted-credential";
export const SEND_INTERVAL_MS = 60 * 60_000;

export interface TeamUsageRemoval {
  readonly endpoint: TeamUsageEndpoint;
  readonly machineLabel: string;
}

export interface TeamUsageState {
  readonly config: TeamUsageConfig;
  /** Old endpoints that still hold this machine's history. */
  readonly removals: readonly TeamUsageRemoval[];
  /** Every endpoint and label a summary was accepted under and not removed since. */
  readonly reported?: readonly TeamUsageRemoval[];
  readonly lastSentAt?: string;
  /** The last sent body without its timestamp, to skip unchanged sends. */
  readonly lastSentBody?: string;
  readonly lastError?: string;
}

export const initialTeamUsageState: TeamUsageState = {
  config: { enabled: false },
  removals: [],
};

export interface TeamUsageDeps {
  readonly loadState: Effect.Effect<TeamUsageState>;
  readonly saveState: (state: TeamUsageState) => Effect.Effect<void>;
  readonly buildSummary: (config: TeamUsageConfig) => Effect.Effect<TeamUsageSummary>;
  readonly readHostedToken: Effect.Effect<string | undefined>;
  /** The bearer saved for this self-hosted endpoint address, and only for it. */
  readonly readSelfHostedCredential: (url: string) => Effect.Effect<string | undefined>;
  readonly writeSelfHostedCredential: (
    url: string,
    value: string | undefined,
  ) => Effect.Effect<void>;
  /** Sends one request; the HTTP status, or 0 when it never got an answer. */
  readonly send: (request: TeamUsageRequest) => Effect.Effect<number>;
  readonly nowMs: Effect.Effect<number>;
}

/** Same destination: the hosted tenant, or the self-hosted address. Labels do not count. */
const sameEndpoint = (a: TeamUsageEndpoint | undefined, b: TeamUsageEndpoint | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : a.kind === "hosted"
      ? b.kind === "hosted" && a.tenantId === b.tenantId
      : b.kind === "selfHosted" && a.url === b.url;

const sameRemoval = (a: TeamUsageRemoval, b: TeamUsageRemoval) =>
  sameEndpoint(a.endpoint, b.endpoint) && a.machineLabel === b.machineLabel;

const addRemovals = (list: readonly TeamUsageRemoval[], more: readonly TeamUsageRemoval[]) => {
  const out = [...list];
  for (const entry of more) if (!out.some((known) => sameRemoval(known, entry))) out.push(entry);
  return out;
};

const utcDay = (iso: string | undefined) => iso?.slice(0, 10);

/** What a summary says without its timestamp, for "did anything change". */
const bodyWithoutTime = (summary: TeamUsageSummary) =>
  JSON.stringify({ ...summary, at: undefined });

export function normalizeConfig(config: TeamUsageConfig): TeamUsageConfig {
  const machineLabel = teamUsageLabel(config.machineLabel);
  const labels = Object.entries(config.accountLabels ?? {}).flatMap(([id, label]) => {
    const clean = teamUsageLabel(label);
    return clean === null ? [] : [[id, clean] as const];
  });
  return {
    enabled: config.enabled,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(machineLabel === null ? {} : { machineLabel }),
    ...(labels.length === 0 ? {} : { accountLabels: Object.fromEntries(labels) }),
  } as TeamUsageConfig;
}

export const makeTeamUsageReporter = (deps: TeamUsageDeps) => {
  let state: TeamUsageState | undefined;
  // One operation at a time: an opt-out never races a send that already started.
  const lock = Semaphore.makeUnsafe(1);
  const serial = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);
  const current = Effect.gen(function* () {
    if (state === undefined) state = yield* deps.loadState;
    return state;
  });
  const commit = (next: TeamUsageState) =>
    Effect.gen(function* () {
      state = next;
      yield* deps.saveState(next);
    });

  const credentials = (endpoint: TeamUsageEndpoint) =>
    Effect.gen(function* () {
      // Only the credential this endpoint uses is looked up.
      if (endpoint.kind === "hosted")
        return {
          hostedToken: yield* deps.readHostedToken,
          selfHostedCredential: undefined,
        } satisfies TeamUsageCredentials;
      return {
        hostedToken: undefined,
        selfHostedCredential: yield* deps.readSelfHostedCredential(endpoint.url),
      } satisfies TeamUsageCredentials;
    });

  /** Deletes history at old endpoints; keeps the ones not confirmed yet. */
  const runRemovals = Effect.gen(function* () {
    const now = yield* current;
    if (now.removals.length === 0) return;
    const left: TeamUsageRemoval[] = [];
    let error: string | undefined;
    for (const removal of now.removals) {
      const request = teamUsageDeleteRequest(
        removal.endpoint,
        yield* credentials(removal.endpoint),
        removal.machineLabel,
      );
      if (!request.ok) {
        left.push(removal);
        error = request.reason;
        continue;
      }
      const status = yield* deps.send(request.request);
      // 404: nothing is stored there for this machine any more.
      if ((status >= 200 && status < 300) || status === 404) continue;
      left.push(removal);
      error =
        status === 0
          ? "The team endpoint did not answer."
          : `Removing history failed (HTTP ${status}).`;
    }
    const latest = yield* current;
    const done = now.removals.filter(
      (removal) => !left.some((entry) => sameRemoval(entry, removal)),
    );
    yield* commit({
      ...latest,
      removals: left,
      reported: (latest.reported ?? []).filter(
        (entry) => !done.some((gone) => sameRemoval(gone, entry)),
      ),
      ...(error === undefined ? {} : { lastError: error }),
    });
    // A self-hosted address nothing points at any more loses its saved credential.
    for (const removal of done) {
      const endpoint = removal.endpoint;
      if (endpoint.kind !== "selfHosted") continue;
      const stillUsed =
        sameEndpoint(latest.config.endpoint, endpoint) ||
        left.some((entry) => sameEndpoint(entry.endpoint, endpoint));
      if (!stillUsed) yield* deps.writeSelfHostedCredential(endpoint.url, undefined);
    }
  });

  const sendIfDue = (force: boolean) =>
    Effect.gen(function* () {
      const now = yield* current;
      const config = now.config;
      if (!config.enabled || config.endpoint === undefined) return;
      const nowMs = yield* deps.nowMs;
      const summary = yield* deps.buildSummary(config);
      // An opt-out's delete at this same place comes first; sending now would
      // put back what the member asked to remove.
      if (
        now.removals.some(
          (entry) =>
            sameEndpoint(entry.endpoint, config.endpoint) &&
            entry.machineLabel === summary.machineLabel,
        )
      )
        return;
      const body = bodyWithoutTime(summary);
      const lastMs = now.lastSentAt === undefined ? 0 : Date.parse(now.lastSentAt);
      const newDay = utcDay(now.lastSentAt) !== utcDay(summary.at);
      if (!force && !newDay) {
        if (nowMs - lastMs < SEND_INTERVAL_MS) return;
        if (body === now.lastSentBody) return;
      }
      const request = teamUsageSendRequest(
        config.endpoint,
        yield* credentials(config.endpoint),
        summary,
      );
      if (!request.ok) {
        yield* commit({ ...now, lastError: request.reason });
        return;
      }
      const status = yield* deps.send(request.request);
      const latest = yield* current;
      if (status >= 200 && status < 300) {
        const { lastError: _dropped, ...rest } = latest;
        const sent = { endpoint: config.endpoint, machineLabel: summary.machineLabel };
        const reported = latest.reported ?? [];
        // The machine was renamed since: its history under the old name goes.
        const renamed = reported.filter(
          (entry) =>
            sameEndpoint(entry.endpoint, sent.endpoint) && entry.machineLabel !== sent.machineLabel,
        );
        yield* commit({
          ...rest,
          lastSentAt: summary.at,
          lastSentBody: body,
          reported: addRemovals(
            reported.filter((entry) => !renamed.includes(entry)),
            [sent],
          ),
          removals: addRemovals(latest.removals, renamed),
        });
        return;
      }
      yield* commit({
        ...latest,
        lastError:
          status === 0
            ? "The team endpoint did not answer."
            : status === 401 || status === 403 || status === 404
              ? "The team refused this machine. Check your sign-in and that you are a member of the org."
              : `Sending failed (HTTP ${status}).`,
      });
    });

  /** One timer step: finish removals, then send if due. */
  const tick = serial(
    Effect.gen(function* () {
      yield* runRemovals;
      yield* sendIfDue(false);
    }),
  );

  const status = Effect.gen(function* () {
    const now = yield* current;
    const config = now.config;
    const preview = yield* deps.buildSummary(config);
    const selfHostedCredentialSet =
      config.endpoint?.kind === "selfHosted"
        ? (yield* deps.readSelfHostedCredential(config.endpoint.url)) !== undefined
        : false;
    // The sign-in is looked up only while the hosted view is chosen.
    const hostedSignedIn =
      config.endpoint?.kind === "hosted" ? (yield* deps.readHostedToken) !== undefined : undefined;
    return {
      config,
      selfHostedCredentialSet,
      ...(hostedSignedIn === undefined ? {} : { hostedSignedIn }),
      ...(now.lastSentAt === undefined ? {} : { lastSentAt: now.lastSentAt }),
      ...(now.lastError === undefined ? {} : { lastError: now.lastError }),
      ...(now.removals[0] === undefined ? {} : { removalPending: now.removals[0].machineLabel }),
      preview,
    } satisfies TeamUsageStatus;
  });

  const update = (input: TeamUsageUpdateInput) =>
    serial(
      Effect.gen(function* () {
        const config = normalizeConfig(input.config);
        if (config.endpoint !== undefined) {
          const target = teamUsageEndpointUrl(config.endpoint);
          if ("reason" in target) return { ok: false as const, reason: target.reason };
        }
        if (input.selfHostedCredential !== undefined) {
          // A credential is saved for the address it was typed for, never a slot others read.
          if (config.endpoint?.kind !== "selfHosted")
            return { ok: false as const, reason: "Enter the self-hosted endpoint first." };
          yield* deps.writeSelfHostedCredential(config.endpoint.url, input.selfHostedCredential);
        }
        const before = yield* current;
        const old = before.config;
        const wasSending = old.enabled && old.endpoint !== undefined;
        const moved =
          !config.enabled ||
          !sameEndpoint(old.endpoint, config.endpoint) ||
          teamUsageLabel(old.machineLabel) !== teamUsageLabel(config.machineLabel);
        let removals = [...before.removals];
        let reported = [...(before.reported ?? [])];
        // Whatever this machine sent under the old endpoint and labels is removed
        // there; a delete of nothing is answered 404 and counts as done.
        if (wasSending && moved && old.endpoint !== undefined) {
          const sentLabel = (yield* deps.buildSummary(old)).machineLabel;
          removals = addRemovals(removals, [
            ...reported,
            { endpoint: old.endpoint, machineLabel: sentLabel },
          ]);
          reported = [];
        }
        const restarted = moved || !wasSending;
        const { lastSentAt: _a, lastSentBody: _b, lastError: _c, ...rest } = before;
        yield* commit({
          ...(restarted ? rest : before),
          config,
          removals,
          reported,
        });
        yield* runRemovals;
        if (config.enabled) yield* sendIfDue(true);
        return { ok: true as const };
      }),
    );

  return {
    tick,
    status,
    update,
    sendIfDue: (force: boolean) => serial(sendIfDue(force)),
    runRemovals: serial(runRemovals),
  };
};

export type TeamUsageReporterCore = ReturnType<typeof makeTeamUsageReporter>;
