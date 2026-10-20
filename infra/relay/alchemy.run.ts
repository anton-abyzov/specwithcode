// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PublishClientConfig } from "./src/clientConfig.ts";
import * as RelayDb from "./src/db.ts";
import { ManagedEndpointZone, RelayApiZone } from "./src/zone.ts";
import * as RelayWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "SpecWeaveStudioRelay",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Drizzle.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayD1Database;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const api = yield* RelayWorker.Api;
    yield* PublishClientConfig({ url: api.url });

    return {
      databaseName: db.databaseName,
      databaseId: db.databaseId,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
    };
  }).pipe(Effect.provide(RelayWorker.layer)),
);
