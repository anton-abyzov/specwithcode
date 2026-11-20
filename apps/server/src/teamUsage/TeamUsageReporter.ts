/**
 * TeamUsageReporter (0898): sends this machine's daily usage summary to the
 * member's team once they opt in on this machine. The logic is in
 * `teamUsageReporterCore`; this module runs it on the server's services:
 * provider snapshots, the quota history, the projection counts, the state
 * file `<stateDir>/team-usage.json` and the secret store.
 *
 * @module teamUsage/TeamUsageReporter
 */
import {
  TEAM_USAGE_HOSTED_ORIGIN,
  type TeamUsageOrgsResult,
  TeamUsageError,
  type TeamUsageStatus,
  type TeamUsageUpdateInput,
  WS_METHODS,
  WsTeamUsageRpcGroup,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { sha256 } from "../nodeCrypto.ts";
import * as ProcessRunner from "../processRunner.ts";
import { readVskillApiToken } from "../project/vskillApiToken.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { UsageLimitHistory } from "../usage/UsageLimitHistory.ts";
import { readTeamUsageCounts } from "./teamUsageCounts.ts";
import {
  initialTeamUsageState,
  makeTeamUsageReporter,
  TEAM_USAGE_FILE,
  TEAM_USAGE_SECRET,
  type TeamUsageState,
} from "./teamUsageReporterCore.ts";
import { buildTeamUsageSummary } from "./teamUsageSummary.ts";
import type { TeamUsageRequest } from "./teamUsageTransport.ts";
import * as SqlClient from "effect/sql/SqlClient";

const TICK = "5 minutes";

/** One secret per self-hosted address, so a credential is only ever read for its own endpoint. */
const credentialName = (url: string) => `${TEAM_USAGE_SECRET}-${sha256([url], "hex").slice(0, 32)}`;

export class TeamUsageReporter extends Context.Service<
  TeamUsageReporter,
  {
    readonly status: Effect.Effect<TeamUsageStatus>;
    readonly update: (
      input: TeamUsageUpdateInput,
    ) => Effect.Effect<TeamUsageStatus, TeamUsageError>;
    readonly orgs: Effect.Effect<TeamUsageOrgsResult>;
  }
>()("specweave-studio/teamUsage/TeamUsageReporter") {}

const decodeState = (raw: string): TeamUsageState => {
  try {
    const parsed = JSON.parse(raw) as Partial<TeamUsageState>;
    if (parsed === null || typeof parsed !== "object" || typeof parsed.config !== "object")
      return initialTeamUsageState;
    return {
      ...initialTeamUsageState,
      ...parsed,
      config: { ...parsed.config, enabled: parsed.config?.enabled === true },
      removals: Array.isArray(parsed.removals) ? parsed.removals : [],
      reported: Array.isArray(parsed.reported) ? parsed.reported : [],
    } as TeamUsageState;
  } catch {
    return initialTeamUsageState;
  }
};

const OrgsResponse = Schema.Struct({
  orgs: Schema.Array(Schema.Struct({ tenantId: Schema.String, label: Schema.String })),
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const history = yield* UsageLimitHistory;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment;
  const http = yield* HttpClient.HttpClient;
  const sql = yield* SqlClient.SqlClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const filePath = path.join(config.stateDir, TEAM_USAGE_FILE);

  const hostedToken = readVskillApiToken.pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(HostProcessPlatform, platform),
  );

  const send = (request: TeamUsageRequest) =>
    Effect.gen(function* () {
      const base =
        request.method === "POST"
          ? HttpClientRequest.post(request.url)
          : HttpClientRequest.delete(request.url);
      const withHeaders = base.pipe(HttpClientRequest.setHeaders(request.headers));
      const req =
        request.body === undefined
          ? withHeaders
          : withHeaders.pipe(HttpClientRequest.bodyText(request.body, "application/json"));
      const response = yield* http.execute(req).pipe(
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        // A redirect could move the summary to another host or to plain http.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.timeout("30 seconds"),
      );
      return response.status;
    }).pipe(Effect.orElseSucceed(() => 0));

  const core = makeTeamUsageReporter({
    loadState: fs.readFileString(filePath).pipe(
      Effect.map(decodeState),
      Effect.orElseSucceed(() => initialTeamUsageState),
    ),
    saveState: (state) =>
      writeFileStringAtomically({ filePath, contents: `${JSON.stringify(state, null, 2)}\n` }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("could not save team usage state", { cause }).pipe(Effect.as(false)),
        ),
      ),
    buildSummary: (teamConfig) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const descriptor = yield* environment.getDescriptor;
        const counts = yield* readTeamUsageCounts(nowMs).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.orElseSucceed(() => new Map()),
        );
        const series = (yield* history.read({ sinceHours: 24 })).series;
        return buildTeamUsageSummary({
          providers: yield* providers.getProviders,
          config: teamConfig,
          defaultMachineLabel: descriptor.label,
          history: series,
          counts,
          nowMs,
        });
      }),
    readHostedToken: hostedToken,
    readSelfHostedCredential: (url) =>
      secrets.get(credentialName(url)).pipe(
        Effect.map((value) =>
          Option.isSome(value) && value.value.length > 0
            ? new TextDecoder().decode(value.value)
            : undefined,
        ),
        Effect.orElseSucceed(() => undefined),
      ),
    writeSelfHostedCredential: (url, value) =>
      (value === undefined || value.trim() === ""
        ? secrets.remove(credentialName(url))
        : secrets.set(credentialName(url), new TextEncoder().encode(value.trim()))
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not store team credential", { cause }),
        ),
      ),
    send,
    nowMs: Clock.currentTimeMillis,
  });

  yield* Effect.forever(core.tick.pipe(Effect.andThen(Effect.sleep(TICK)))).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  const orgs = Effect.gen(function* () {
    const token = yield* hostedToken;
    if (token === undefined)
      return {
        orgs: [],
        error: "Sign in with `vskill auth login` first.",
      } satisfies TeamUsageOrgsResult;
    const response = yield* http
      .execute(
        HttpClientRequest.get(`${TEAM_USAGE_HOSTED_ORIGIN}/api/v1/tenants/usage-orgs`).pipe(
          HttpClientRequest.setHeaders({ Authorization: `Bearer ${token}` }),
        ),
      )
      .pipe(
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.timeout("30 seconds"),
        Effect.option,
      );
    if (Option.isNone(response) || response.value.status !== 200)
      return {
        orgs: [],
        error: "Could not list your orgs on verified-skill.com.",
      } satisfies TeamUsageOrgsResult;
    const body = yield* response.value.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OrgsResponse)),
      Effect.option,
    );
    if (Option.isNone(body))
      return {
        orgs: [],
        error: "verified-skill.com sent an unexpected answer.",
      } satisfies TeamUsageOrgsResult;
    return {
      orgs: body.value.orgs.filter((org) => org.tenantId.trim() !== "" && org.label.trim() !== ""),
    } satisfies TeamUsageOrgsResult;
  });

  return {
    status: core.status,
    update: (input) =>
      core
        .update(input)
        .pipe(
          Effect.flatMap((result) =>
            result.ok ? core.status : Effect.fail(new TeamUsageError({ message: result.reason })),
          ),
        ),
    orgs,
  } satisfies TeamUsageReporter["Service"];
});

// The vsk_ token lookup runs `security` on macOS; the runner is not a server-wide service.
export const layer = Layer.effect(TeamUsageReporter, make).pipe(Layer.provide(ProcessRunner.layer));

export const layerRpcHandlers = WsTeamUsageRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const reporter = yield* TeamUsageReporter;
    return {
      [WS_METHODS.teamUsageStatus]: () => reporter.status,
      [WS_METHODS.teamUsageUpdate]: (input) => reporter.update(input),
      [WS_METHODS.teamUsageOrgs]: () => reporter.orgs,
    };
  }),
);
