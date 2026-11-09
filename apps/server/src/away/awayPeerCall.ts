/**
 * The machine-to-machine half of Away mode's coordinator handover and away
 * intent: both ends authenticate with the work grant, like the handoff peer
 * route (`/api/handoff/v1/*`). The caller sends its worker credential for the
 * target; the target reads which machine called from the grant it issued,
 * never from the body.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as FleetTargets from "../fleet/FleetTargets.ts";
import { fleetAuthorization, reachFleetMachine } from "../fleet/fleetTransport.ts";
import * as FleetWorkerGrants from "../fleet/FleetWorkerGrants.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { stringifyJson } from "../json.ts";
import { clientRuntimeModeCeiling } from "../mcp/McpInvocationContext.ts";
import { readBoundedJson } from "../studioFleet.ts";
import { currentTeamRules } from "../teamRules/TeamRules.ts";
import { callerFingerprint, teamRulesSessionRefusal } from "../teamRules/TeamRulesReach.ts";

const ANSWER_MAX_BYTES = 256 * 1024;

export class AwayPeerError extends Data.TaggedError("AwayPeerError")<{
  readonly message: string;
  /** The target answered: nothing changed there for this call. */
  readonly refused: boolean;
  /** The call may have reached the target, which may have acted. */
  readonly uncertain: boolean;
  readonly status?: number | undefined;
}> {}

export interface AwayPeerAnswer {
  readonly status: number;
  readonly json: unknown;
}

/** What `post` needs; the live one is `makeAwayPeerPost`. */
export type AwayPeerPost = (
  targetEnvironmentId: EnvironmentId,
  path: string,
  body: unknown,
  timeoutMs: number,
) => Effect.Effect<AwayPeerAnswer, AwayPeerError>;

/** The `error` our routes answer with, or undefined for any other body. */
const errorText = (json: unknown): string | undefined =>
  typeof json === "object" &&
  json !== null &&
  "error" in json &&
  typeof (json as { error: unknown }).error === "string"
    ? (json as { error: string }).error
    : undefined;

/**
 * Posts JSON to the target with this machine's worker credential there. A
 * failure before the request left (no such machine, no grant, no address
 * answered) is definite; a call sent without an answer, or a 5xx without our
 * body, is uncertain. A 2xx is returned; any other answer is a refusal.
 */
export const makeAwayPeerPost = Effect.gen(function* () {
  const fleet = yield* FleetTargets.FleetTargets;
  const link = FleetTargets.linkOf(fleet);
  const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
  const post: AwayPeerPost = (targetEnvironmentId, path, body, timeoutMs) =>
    Effect.gen(function* () {
      const machines = yield* fleet.load.pipe(
        Effect.map((config) => config?.machines ?? []),
        Effect.orElseSucceed(() => []),
      );
      const target = machines.find((machine) => machine.environmentId === targetEnvironmentId);
      if (target === undefined)
        return yield* new AwayPeerError({
          message: "That machine is not one of your machines.",
          refused: false,
          uncertain: false,
        });
      const credential = yield* grants.credential(target.id).pipe(
        Effect.mapError(
          (error) =>
            new AwayPeerError({
              message: `This machine has no work grant on ${target.label} (${error.message}).`,
              refused: false,
              uncertain: false,
            }),
        ),
      );
      const address = yield* Effect.tryPromise({
        try: () => reachFleetMachine(link, target, { token: credential.accessToken }),
        catch: () =>
          new AwayPeerError({
            message: `${target.label} did not answer.`,
            refused: false,
            uncertain: false,
          }),
      });
      const url = `${address.origin}${path}`;
      const answer = yield* Effect.tryPromise({
        try: async (signal) => {
          const authorization = await fleetAuthorization(
            link,
            address,
            "POST",
            url,
            credential.accessToken,
          );
          const response = await link.fetch(url, {
            method: "POST",
            redirect: "error",
            headers: { ...authorization, "content-type": "application/json" },
            body: stringifyJson(body),
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
          });
          const json = await readBoundedJson(response, ANSWER_MAX_BYTES).catch(() => null);
          return { status: response.status, ok: response.ok, json };
        },
        catch: () =>
          new AwayPeerError({
            message: `${target.label} did not answer.`,
            refused: false,
            uncertain: true,
          }),
      });
      if (!answer.ok) {
        const said = errorText(answer.json);
        if (said === undefined && answer.status === 404)
          return yield* new AwayPeerError({
            message: `${target.label} runs an older SpecWithCode. Update it, then try again.`,
            refused: true,
            uncertain: false,
            status: 404,
          });
        // A proxy's 5xx without our body may come after the target acted.
        const uncertain = said === undefined && answer.status >= 500;
        return yield* new AwayPeerError({
          message: `${target.label}: ${said ?? `HTTP ${answer.status}`}`,
          refused: !uncertain,
          uncertain,
          status: answer.status,
        });
      }
      return { status: answer.status, json: answer.json };
    });
  return post;
});

const refusal = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers: { "cache-control": "no-store" } });

/**
 * The calling machine on the target's side: a worker credential whose work
 * grant here is live and team rules allow. Otherwise the response to send.
 */
export const awayPeerCaller = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const client = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
  if (Option.isNone(client)) return { refused: refusal(401, "unauthorized") } as const;
  const grants = yield* WorkGrants.WorkGrants;
  const grant = yield* grants.forClient(client.value).pipe(Effect.option);
  if (Option.isNone(grant) || grant.value === undefined)
    return {
      refused: refusal(403, "Only another of your machines with a work grant here may ask this."),
    } as const;
  if (grant.value.revoked)
    return { refused: refusal(403, "This machine revoked that machine's work here.") } as const;
  const ruled = teamRulesSessionRefusal(
    yield* currentTeamRules,
    { subject: EnvironmentAuth.MCP_CLIENT_SUBJECT, coordinator: true },
    callerFingerprint(request.headers),
  );
  if (ruled !== null) return { refused: refusal(403, ruled.message) } as const;
  const caller: ReceiverCaller = {
    sourceEnvironmentId: grant.value.coordinatorEnvironmentId,
    grant: grant.value,
    runtimeCeiling: clientRuntimeModeCeiling(client.value),
  };
  return { caller } as const;
});

export const answerJson = (status: number, body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });
