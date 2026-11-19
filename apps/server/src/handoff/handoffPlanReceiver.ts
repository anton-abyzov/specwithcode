/**
 * The receiving side of a hand off plan: what this machine answers when another
 * asks what it would run a thread on, before anything is copied here.
 */
import type {
  HandoffModeErrorCode,
  ModelSelection,
  Project,
  ProjectId,
  ServerProvider,
} from "@specweave-studio/contracts";
import { launchTrackLanes, TRACK_LANES } from "@specweave-studio/shared/modelTracks";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { accountInGrant } from "../fleet/workGrantPolicy.ts";
import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { providerUsageSummary } from "../usage/providerUsageSummary.ts";
import {
  confirmTarget,
  type PeerCheckRequest,
  type PeerCheckResponse,
  planCapabilityFailure,
} from "./handoffPlan.ts";
import type { PreflightProvider } from "./handoffPreflight.ts";
import type { HandoffRefusal, ReceiverCaller } from "./HandoffReceiver.ts";
import { findIncoming, type HandoffDocument } from "./handoffState.ts";
import {
  capabilityFailure,
  HANDOFF_APP_VERSION,
  HANDOFF_CAPABILITIES,
  HANDOFF_PROTOCOL_VERSION,
  versionFailure,
} from "./handoffWire.ts";

/**
 * What this machine would run each thread on, asked before anything is
 * copied here: no replica is needed, and the usage is read for this call.
 */
export type PeerCheck = (
  caller: ReceiverCaller,
  request: PeerCheckRequest,
) => Effect.Effect<PeerCheckResponse, HandoffRefusal>;

export function toPreflightProvider(provider: ServerProvider): PreflightProvider {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName,
    enabled: provider.enabled,
    installed: provider.installed,
    authStatus: provider.auth.status,
    models: provider.models.map((model) => ({
      slug: model.slug,
      ...(model.aliases === undefined ? {} : { aliases: model.aliases }),
    })),
  };
}

/** Why the grant does not let the source run on this sign-in, or null when it does. */
export const makeAccountRefusal =
  (at: (message: string) => string) =>
  (caller: ReceiverCaller, sourceLabel: string, instanceId: ModelSelection["instanceId"]) => {
    if (caller.grant === null || accountInGrant(caller.grant.accounts, instanceId)) return null;
    const allowed =
      caller.grant.accounts.kind === "listed" ? caller.grant.accounts.instanceIds : [];
    return at(
      allowed.length === 0
        ? `this machine lets ${sourceLabel} use none of its sign-ins, so it cannot continue work here. The user can allow sign-ins in Settings > Machines > Who can run work here.`
        : `this machine lets ${sourceLabel} use only these sign-ins: ${allowed.join(", ")}. The user can allow ${instanceId} in Settings > Machines > Who can run work here.`,
    );
  };

/** What the receiver lends the check: its own lookups, so both read one way. */
export interface PeerCheckDeps {
  readonly label: string;
  readonly at: (message: string) => string;
  readonly environmentId: string;
  readonly sameSource: (
    caller: ReceiverCaller,
    sourceEnvironmentId: string,
  ) => Effect.Effect<void, HandoffRefusal>;
  readonly document: Effect.Effect<HandoffDocument, HandoffRefusal>;
  readonly localProject: (
    sourceEnvironmentId: string,
    sourceProjectId: ProjectId,
  ) => Effect.Effect<Project | null, HandoffRefusal>;
  readonly inGrant: (caller: ReceiverCaller, project: Project) => boolean;
  readonly accountRefusal: ReturnType<typeof makeAccountRefusal>;
  readonly getProviders: ProviderRegistry.ProviderRegistry["Service"]["getProviders"];
  readonly getSettings: ServerSettings.ServerSettingsService["Service"]["getSettings"];
  readonly refuse: (status: number, code: HandoffModeErrorCode, message: string) => HandoffRefusal;
}

export const makePeerCheck =
  ({
    label,
    at,
    environmentId,
    sameSource,
    document,
    localProject,
    inGrant,
    accountRefusal,
    getProviders,
    getSettings,
    refuse,
  }: PeerCheckDeps): PeerCheck =>
  (caller: ReceiverCaller, request: PeerCheckRequest) =>
    Effect.gen(function* () {
      yield* sameSource(caller, request.sourceEnvironmentId);
      const answer = (results: PeerCheckResponse["results"]) =>
        ({
          machineLabel: label,
          protocolVersion: HANDOFF_PROTOCOL_VERSION,
          appVersion: HANDOFF_APP_VERSION,
          capabilities: HANDOFF_CAPABILITIES,
          results,
        }) satisfies PeerCheckResponse;
      const source = { peerLabel: "The source machine", capabilities: request.capabilities };
      // A source that does not plan cannot read what this answers; nothing is confirmed for it.
      const unfit =
        versionFailure({
          peerLabel: source.peerLabel,
          peerProtocolVersion: request.protocolVersion,
          peerAppVersion: request.appVersion,
          selfLabel: label,
        }) ??
        capabilityFailure(source) ??
        planCapabilityFailure(source);
      if (unfit !== null) {
        return answer(
          request.threads.map((thread) => ({
            sourceThreadId: thread.sourceThreadId,
            failures: [unfit],
            evidence: null,
          })),
        );
      }
      const list = yield* getProviders;
      const settings = yield* getSettings.pipe(
        Effect.mapError(() => refuse(500, "failed", at("could not read its settings"))),
      );
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      // Read now, for this call: the reading the source shows is this machine's own.
      const signIns = list.map((provider) => ({
        provider: toPreflightProvider(provider),
        usage: providerUsageSummary(provider, nowMs),
      }));
      const current = yield* document;
      const results = yield* Effect.forEach(request.threads, (thread) =>
        Effect.gen(function* () {
          const project = yield* localProject(caller.sourceEnvironmentId, thread.sourceProjectId);
          const replica = findIncoming(current, caller.sourceEnvironmentId, thread.sourceThreadId);
          const holder = replica?.lease;
          const resolved =
            project === null
              ? null
              : resolveProjectSettings(settings, project.id, project).settings;
          // Null says this copy of the project has no such track, and then it is no
          // target for a thread on one. The Review list is the reviewer's own, so
          // the named reviewer is what is checked.
          const trackEntries =
            resolved === null || thread.track === null || resolved.threadModelMode !== "tracks"
              ? null
              : thread.track === "review"
                ? [thread.modelSelection]
                : launchTrackLanes(
                    resolved.modelLanes,
                    list,
                    resolved.defaultModelProviders,
                    nowMs,
                  )[TRACK_LANES[thread.track]];
          const confirmed = confirmTarget({
            machineLabel: label,
            sourceLabel: request.sourceLabel,
            start: request.start,
            thresholdPercent: request.thresholdPercent,
            nowMs,
            project:
              project === null ? null : { title: project.title, inGrant: inGrant(caller, project) },
            otherHolder:
              holder !== undefined &&
              holder.holderEnvironmentId !== caller.sourceEnvironmentId &&
              holder.holderEnvironmentId !== environmentId
                ? holder.holderLabel
                : null,
            thread,
            trackEntries,
            signIns,
            accountRefusal: (instanceId) => accountRefusal(caller, request.sourceLabel, instanceId),
          });
          return {
            sourceThreadId: thread.sourceThreadId,
            failures:
              replica?.continuedThreadId != null
                ? [
                    ...confirmed.failures,
                    { check: "lease" as const, message: at("already continues this thread") },
                  ]
                : confirmed.failures,
            evidence: confirmed.evidence,
          };
        }),
      );
      return answer(results);
    });
