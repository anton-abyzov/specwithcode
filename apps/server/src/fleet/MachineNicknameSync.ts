import {
  AuthSettingsWriteScope,
  MachineNicknames,
  type MachineNicknames as MachineNicknamesType,
} from "@specweave-studio/contracts";
import {
  mergeMachineNicknames,
  sameMachineNicknames,
} from "@specweave-studio/shared/machineNicknames";
import * as ByteSize from "effect/ByteSize";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import { type FleetFetch, type FleetTarget, readBoundedJson } from "../studioFleet.ts";
import * as FleetTargets from "./FleetTargets.ts";

/** Paired servers swap their whole nickname map here and both keep the newest entries. */
export const MACHINE_NICKNAMES_PATH = "/api/studio/machine-nicknames";
const MAX_BODY_BYTES = 65_536;
const EXCHANGE_INTERVAL = Duration.minutes(1);

const decodeNicknames = Schema.decodeUnknownOption(MachineNicknames);

export type NicknamePeer = Pick<FleetTarget, "id" | "url"> & { readonly managementToken: string };

/**
 * Sends this server's map to one peer, which merges it and answers with its
 * own merged map. Null when the peer is offline or refuses, so the next
 * exchange retries and a rename made meanwhile still lands on reconnect.
 */
export async function exchangeMachineNicknames(
  fetcher: FleetFetch,
  peer: NicknamePeer,
  local: MachineNicknamesType,
): Promise<MachineNicknamesType | null> {
  try {
    const response = await fetcher(`${peer.url}${MACHINE_NICKNAMES_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${peer.managementToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ nicknames: local }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = (await readBoundedJson(response, MAX_BODY_BYTES)) as { nicknames?: unknown };
    return Option.getOrNull(decodeNicknames(body?.nicknames));
  } catch {
    return null;
  }
}

export interface NicknameStore {
  readonly read: Effect.Effect<MachineNicknamesType>;
  /** Merges newest-wins and returns the result; a no-op merge must not write. */
  readonly merge: (incoming: MachineNicknamesType) => Effect.Effect<MachineNicknamesType>;
}

/** One round with every peer that has a management token. Returns the peers reached. */
export const syncMachineNicknames = (input: {
  readonly fetcher: FleetFetch;
  readonly peers: ReadonlyArray<NicknamePeer>;
  readonly store: NicknameStore;
}): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const reached: Array<string> = [];
    for (const peer of input.peers) {
      const local = yield* input.store.read;
      const reply = yield* Effect.promise(() =>
        exchangeMachineNicknames(input.fetcher, peer, local),
      );
      if (reply === null) continue;
      reached.push(peer.id);
      yield* input.store.merge(reply);
    }
    return reached;
  });

export const peersFrom = (
  machines: ReadonlyArray<FleetTarget> | undefined,
): ReadonlyArray<NicknamePeer> =>
  (machines ?? []).flatMap((machine) =>
    machine.managementToken
      ? [{ id: machine.id, url: machine.url, managementToken: machine.managementToken }]
      : [],
  );

/** A store over server settings. Settings errors surface as defects of this round only. */
export const settingsStore = (
  settings: ServerSettings.ServerSettingsService["Service"],
): NicknameStore => {
  const read = settings.getSettings.pipe(
    Effect.map((current) => current.machineNicknames),
    Effect.orDie,
  );
  return {
    read,
    merge: (incoming) =>
      read.pipe(
        Effect.flatMap((current) =>
          sameMachineNicknames(current, mergeMachineNicknames(current, incoming))
            ? Effect.succeed(current)
            : settings.updateSettings({ machineNicknames: incoming }).pipe(
                Effect.map((next) => next.machineNicknames),
                Effect.orDie,
              ),
        ),
      ),
  };
};

const refusal = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers: { "cache-control": "no-store" } });

/** The receiving half: a paired server's management token holds settings write here. */
export const routeLayer = HttpRouter.add(
  "POST",
  MACHINE_NICKNAMES_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (Option.isNone(session)) return refusal(401, "unauthorized");
    if (!session.value.scopes.includes(AuthSettingsWriteScope)) return refusal(403, "forbidden");
    const body = yield* request.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
      Effect.option,
    );
    const incoming = Option.flatMap(body, (value) =>
      decodeNicknames((value as { nicknames?: unknown } | null)?.nicknames),
    );
    if (Option.isNone(incoming)) return refusal(400, "invalid_request");
    const store = settingsStore(yield* ServerSettings.ServerSettingsService);
    const merged = yield* store.merge(incoming.value).pipe(Effect.exit);
    if (merged._tag === "Failure") return refusal(500, "internal_error");
    return HttpServerResponse.jsonUnsafe(
      { nicknames: merged.value },
      { headers: { "cache-control": "no-store" } },
    );
  }),
);

/**
 * The sending half: exchange after every local change (a rename here or one a
 * peer brought in) and once a minute, so a machine that was offline catches
 * up when it is reachable again. Failures wait for the next round.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const targets = yield* FleetTargets.FleetTargets;
    const store = settingsStore(settings);
    const round = targets.load.pipe(
      Effect.flatMap((config) =>
        syncMachineNicknames({ fetcher: targets.fetch, peers: peersFrom(config?.machines), store }),
      ),
      Effect.catchCause(() => Effect.void),
    );
    yield* round.pipe(Effect.repeat(Schedule.spaced(EXCHANGE_INTERVAL)), Effect.forkScoped);
    // The change stream starts with the next write, so seed it with today's map
    // and react only when the nicknames themselves differ.
    const initial = yield* store.read.pipe(
      Effect.catchCause(() => Effect.succeed<MachineNicknamesType>({})),
    );
    yield* Stream.concat(
      Stream.succeed(initial),
      settings.streamChanges.pipe(Stream.map((current) => current.machineNicknames)),
    ).pipe(
      Stream.changesWith(sameMachineNicknames),
      Stream.drop(1),
      Stream.debounce(Duration.seconds(1)),
      Stream.runForEach(() => round),
      Effect.forkScoped,
    );
  }),
);
