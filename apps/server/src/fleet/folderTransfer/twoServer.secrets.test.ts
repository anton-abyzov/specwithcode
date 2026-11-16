// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - disposable real Git fixtures only.
/**
 * Secrets of a copy run from a window that is signed in to the source from
 * another machine. Two isolated sides talk over loopback HTTP, as in
 * twoServer.verify.test.ts; the source is driven through the real folder copy
 * RPC group with the real scope check, by a session holding the standard
 * client scopes and no `access:write`. The source reaches the destination
 * through the live sealed-secrets peer, over a stand-in for the fleet link that
 * calls the destination's own studio_folder_copy_receive handler.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  EnvironmentId,
  OrchestratorMcpFailure,
  WS_METHODS,
  WsFolderCopyRpcGroup,
  type AuthEnvironmentScope,
  type AuthPrincipal,
  type OrchestratorMcpMachineRef,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Authorization from "../../auth/RpcAuthorization.ts";
import * as ServerConfig from "../../config.ts";
import { rpcInstrumentationLayer } from "../../observability/RpcInstrumentation.ts";
import * as ProjectLink from "../../project/ProjectLink.ts";
import { TeamRules, teamRulesOf } from "../../teamRules/TeamRules.ts";
import * as WorkspaceSensitivePaths from "../../workspace/WorkspaceSensitivePaths.ts";
import { attempt, sourceStatus } from "../FolderCopyHandoff.ts";
import * as MachineHandoff from "../MachineHandoff.ts";
import * as RemoteWorkers from "../RemoteWorkers.ts";
import { newReceivingKey } from "../fileTransfer/seal.ts";
import { AgentCopyReceiveInput, receiveAgentCopy } from "./agentCopy.ts";
import { DestinationCopies, type DestinationRecord } from "./destinationService.ts";
import { makeUmbrella, write, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import { platformHomePath } from "./secretLocations.ts";
import { SECRETS_KEY_FILE } from "./secretsKey.ts";
import * as SealedSecretsPeer from "./sealedSecretsPeer.ts";
import { SourceTransfers, type SourceOperationRecord } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";
import { SEALED_SECRET_CONTENT_TYPE } from "./wire.ts";

const SOURCE = "env-source";
const DESTINATION = "env-destination";
const HOME_SECRET = "~/.microsoft/usersecrets/api-77/secrets.json";

const canary = (name: string) => `SWC_CANARY_${name}_${NodeCrypto.randomBytes(12).toString("hex")}`;

/** Secret files at the root, one, three and four folders down, and inside a nested repository. */
const FOLDER_SECRETS: Record<string, string> = {
  ".env": `ROOT_TOKEN=${canary("root")}\n`,
  "apps/.env": `APPS_TOKEN=${canary("one")}\n`,
  "services/api/worker/.env.production": `WORKER_TOKEN=${canary("three")}\n`,
  "repositories/svc-a/workers/edge/deploy/.env": `EDGE_TOKEN=${canary("four")}\n`,
};
const HOME_SECRET_TEXT = `{"Db":"${canary("home")}"}`;
const ALL_SECRETS: Record<string, string> = { ...FOLDER_SECRETS, [HOME_SECRET]: HOME_SECRET_TEXT };
const CANARIES = Object.values(ALL_SECRETS).map(
  (text) => /SWC_CANARY_[a-z]+_[a-f0-9]+/.exec(text)![0],
);

let base: string;
let fixture: UmbrellaFixture;
let transfers: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;
let sourceHome: string;
let destinationHome: string;

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-sealed-")));
  fixture = makeUmbrella(NodePath.join(base, "source-machine"));
  sourceHome = NodePath.join(base, "source-machine", "home");
  destinationHome = NodePath.join(base, "destination-machine", "home");
  NodeFS.mkdirSync(sourceHome, { recursive: true });
  NodeFS.mkdirSync(destinationHome, { recursive: true });
  for (const [path, text] of Object.entries(FOLDER_SECRETS))
    write(NodePath.join(fixture.root, path), text);
  write(
    NodePath.join(fixture.root, "src/Api/Api.csproj"),
    "<Project><PropertyGroup><UserSecretsId>api-77</UserSecretsId></PropertyGroup></Project>",
  );
  write(
    NodePath.join(
      sourceHome,
      platformHomePath(".microsoft/usersecrets/api-77/secrets.json", process.platform),
    ),
    HOME_SECRET_TEXT,
  );
  transfers = new SourceTransfers(NodePath.join(base, "source-machine", "state"), {
    release: async (_record: SourceOperationRecord, _reason: string) => undefined,
    home: () => sourceHome,
  });
  served = await serveSource(transfers, SOURCE);
}, 60_000);

afterAll(async () => {
  await served?.close();
  if (base) NodeFS.rmSync(base, { recursive: true, force: true });
});

const fast = {
  allowLoopback: true,
  sleep: async () => undefined,
  pollMs: 20,
  maxBatchChunks: 32,
} as const;

async function settle(
  copies: DestinationCopies,
  operationId: string,
  until: ReadonlyArray<string>,
): Promise<DestinationRecord> {
  for (let attempts = 0; attempts < 1500; attempts += 1) {
    await copies.waitFor(operationId);
    const record = await copies.read(operationId);
    if (record && until.includes(record.state)) return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`copy ${operationId} never reached ${until.join(", ")}`);
}

/** Records what the source answers on the secret routes, as anyone holding the token would see it. */
function wire() {
  const secrets: Array<{ contentType: string; body: Buffer }> = [];
  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const response = await fetch(input, init);
    if (url.endsWith("/secret"))
      secrets.push({
        contentType: response.headers.get("content-type") ?? "",
        body: Buffer.from(await response.clone().arrayBuffer()),
      });
    return response;
  };
  return { fetch: wrapped, secrets };
}

/** One destination machine with its own state, and one copy the source offered to it. */
async function begin(name: string) {
  const state = NodePath.join(base, "destination-machine", name);
  const folder = NodePath.join(base, "destination-machine", "targets", name);
  const seen = wire();
  const copies = new DestinationCopies(state, {
    ...fast,
    fetch: seen.fetch,
    home: () => destinationHome,
  });
  const operationId = NodeCrypto.randomUUID();
  const offered = await transfers.offer({
    operationId,
    projectId: "project-source",
    folder: fixture.root,
    mode: "copy-only",
    destinationEnvironmentId: DESTINATION,
  });
  await copies.start({
    operationId,
    sourceUrl: served.url,
    token: offered.token,
    sourceEnvironmentId: SOURCE,
    sourceProjectId: "project-source",
    sourceMachine: "M4MAX",
    mode: "copy-only",
    targetFolder: folder,
    title: "Umbrella",
  });
  const previewed = await settle(copies, operationId, ["previewed", "failed"]);
  expect(previewed.error).toBeNull();
  const listed = ((await transfers.read(operationId))?.summary?.secretFiles ?? []).map(
    (file) => file.path,
  );
  return { state, folder, copies, operationId, seen, listed };
}

const config = ServerConfig.layerTest(process.cwd(), { prefix: "sealed-secrets-config-" }).pipe(
  Layer.provide(NodeServices.layer),
  Layer.orDie,
);
const decodeReceive = Schema.decodeUnknownEffect(AgentCopyReceiveInput);
const M3: OrchestratorMcpMachineRef = {
  id: "m3",
  label: "M3",
  environmentId: EnvironmentId.make(DESTINATION),
};

/**
 * The fleet link, standing in for the MCP call between the machines: the tool
 * arguments reach the destination's real handler, with what its grant for the
 * source says (`mayCarrySecrets`).
 */
const fleetLink = (copies: DestinationCopies, grant: { readonly mayCarrySecrets: boolean }) => {
  const asked: Array<Record<string, unknown>> = [];
  const destination = Layer.mergeAll(
    Layer.mock(MachineHandoff.MachineHandoff)({
      copySecretsKey: (input) =>
        attempt(() => copies.secretsKey(input.operationId, input.sourceEnvironmentId)),
    }),
    Layer.mock(ProjectLink.ProjectLink)({}),
    NodeServices.layer,
    config,
  );
  const link: RemoteWorkers.RemoteWorkersShape = {
    ...RemoteWorkers.RemoteWorkers.defaultValue(),
    enabled: true,
    resolveMachine: (target) =>
      target === DESTINATION
        ? Effect.succeed({ kind: "remote", machine: M3 } as const)
        : Effect.fail(
            new OrchestratorMcpFailure({ code: "unknown_machine", message: "No such machine." }),
          ),
    proxy: (input) =>
      Effect.gen(function* () {
        asked.push(input.arguments);
        expect(input.tool).toBe("studio_folder_copy_receive");
        expect(input.machine.environmentId).toBe(DESTINATION);
        const args = yield* decodeReceive(input.arguments).pipe(Effect.orDie);
        const answer = yield* receiveAgentCopy(args, {
          environmentId: SOURCE,
          label: "M4MAX",
          mayCarrySecrets: grant.mayCarrySecrets,
        }).pipe(
          Effect.provide(destination),
          Effect.provideService(TeamRules, teamRulesOf({ status: "none" })),
          Effect.provideService(
            WorkspaceSensitivePaths.SensitivePathsHomeDirectory,
            destinationHome,
          ),
        );
        return answer as Record<string, unknown>;
      }),
  };
  return { asked, layer: Layer.succeed(RemoteWorkers.RemoteWorkers, link) };
};

const connectDevice: AuthPrincipal = { kind: "device", id: "device-on-m3" };

/** The source's folder copy RPCs as one session sees them, with the real scope and owner checks. */
const sourceRpc = (
  link: ReturnType<typeof fleetLink>,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  principal: AuthPrincipal = connectDevice,
) => {
  const source = Layer.mock(MachineHandoff.MachineHandoff)({
    copyDestination: (operationId) =>
      attempt(() => transfers.read(operationId)).pipe(
        Effect.map((record) => record?.destinationEnvironmentId ?? ""),
      ),
    copySecrets: (input) =>
      attempt(() => transfers.approveSecrets(input)).pipe(Effect.map(sourceStatus)),
    copySecretsSealedTo: (input, sealTo) =>
      attempt(() => transfers.approveSecrets({ ...input, sealTo })).pipe(Effect.map(sourceStatus)),
  });
  return RpcTest.makeClient(WsFolderCopyRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        MachineHandoff.layerFolderCopyRpcHandlers,
        Authorization.layer(scopes, principal),
      ).pipe(
        Layer.provide(rpcInstrumentationLayer),
        Layer.provide(source),
        Layer.provide(SealedSecretsPeer.layer.pipe(Layer.provide(link.layer))),
      ),
    ),
  );
};

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect);
const failureText = (exit: Exit.Exit<unknown, unknown>) => JSON.stringify(exit);

const stagedOn = async (operationId: string) => (await transfers.read(operationId))?.secrets;

const readDestination = (folder: string, path: string) =>
  path === HOME_SECRET
    ? NodePath.join(
        destinationHome,
        platformHomePath(".microsoft/usersecrets/api-77/secrets.json", process.platform),
      )
    : NodePath.join(folder, path);

/** Where the destination keeps a copy's receiving key while it waits for secrets. */
const keyFileOf = (copy: { readonly state: string; readonly operationId: string }) =>
  NodePath.join(copy.state, "folder-copies", copy.operationId, SECRETS_KEY_FILE);

const filesUnder = (root: string) =>
  NodeFS.existsSync(root)
    ? NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => NodePath.join(entry.parentPath, entry.name))
    : [];

describe("secrets of a copy run from another machine's window", () => {
  it("lists every secret file, at any depth and in the home folder", async () => {
    const copy = await begin("listed");
    expect(copy.listed).toEqual(expect.arrayContaining(Object.keys(ALL_SECRETS)));
    await copy.copies.cancel(copy.operationId);
    await copy.copies.close();
  }, 120_000);

  it("sends them all after one approval, sealed to the destination, with no access:write", async () => {
    const copy = await begin("sealed");
    const link = fleetLink(copy.copies, { mayCarrySecrets: true });
    const paths = Object.keys(ALL_SECRETS);
    expect(AuthStandardClientScopes).not.toContain("access:write");

    const exit = await run(
      Effect.gen(function* () {
        const window = yield* sourceRpc(link, AuthStandardClientScopes);
        // The plain way stays closed to this session: the token it holds could pull the files.
        const plain = yield* Effect.exit(
          window[WS_METHODS.machineHandoffCopySecrets]({
            operationId: copy.operationId,
            paths,
            destinationLabel: "M3",
          }),
        );
        expect(Exit.isFailure(plain)).toBe(true);
        expect(yield* Effect.promise(() => stagedOn(copy.operationId))).toBeUndefined();

        const route = yield* window[WS_METHODS.machineHandoffCopySecretsRoute]({
          destinationEnvironmentId: EnvironmentId.make(DESTINATION),
        });
        expect(route).toEqual({ sealed: true });
        const status = yield* window[WS_METHODS.machineHandoffCopySealedSecrets]({
          operationId: copy.operationId,
          paths,
          destinationLabel: "M3",
        });
        expect(status.secrets?.sealed).toBe(true);
        expect((status.secrets?.files ?? []).map((file) => file.path).sort()).toEqual(
          [...paths].sort(),
        );
      }).pipe(Effect.scoped),
    );
    expect(failureText(exit)).not.toContain("Failure");
    expect(Exit.isSuccess(exit)).toBe(true);
    // One question and one key request crossed the fleet link, and no secret with them.
    expect(link.asked).toEqual([
      { action: "secretsCheck" },
      { action: "secretsKey", operationId: copy.operationId },
    ]);
    const keyFile = keyFileOf(copy);
    expect(NodeFS.existsSync(keyFile)).toBe(true);
    if (process.platform !== "win32") expect(NodeFS.statSync(keyFile).mode & 0o777).toBe(0o600);

    await copy.copies.approve(copy.operationId);
    const applied = await settle(copy.copies, copy.operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    for (const [path, text] of Object.entries(ALL_SECRETS)) {
      const received = readDestination(copy.folder, path);
      expect(NodeFS.readFileSync(received, "utf8"), path).toBe(text);
      if (process.platform !== "win32")
        expect(NodeFS.statSync(received).mode & 0o777, path).toBe(0o600);
    }
    expect((applied.secrets ?? []).map((secret) => secret.path).sort()).toEqual([...paths].sort());

    // What the token holder saw: one sealed body per file, none readable.
    expect(copy.seen.secrets).toHaveLength(paths.length);
    for (const answer of copy.seen.secrets) {
      expect(answer.contentType).toContain(SEALED_SECRET_CONTENT_TYPE);
      for (const value of CANARIES) expect(answer.body.includes(value)).toBe(false);
    }
    // The receiving key is gone, and no state file on either side holds a value.
    expect(NodeFS.existsSync(keyFile)).toBe(false);
    const leaking = [
      ...filesUnder(NodePath.join(base, "source-machine", "state")),
      ...filesUnder(copy.state),
    ].filter((file) => {
      const bytes = NodeFS.readFileSync(file);
      return CANARIES.some((value) => bytes.includes(value));
    });
    expect(leaking).toEqual([]);
    const sent = await transfers.sentSecrets.list(DESTINATION);
    expect(
      sent
        .filter((entry) => entry.operationId === copy.operationId)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([...paths].sort());
    await copy.copies.close();
  }, 180_000);

  it("refuses an agent session, even one holding every scope", async () => {
    const copy = await begin("agent");
    const link = fleetLink(copy.copies, { mayCarrySecrets: true });
    const exit = await run(
      Effect.gen(function* () {
        const agent = yield* sourceRpc(link, AuthAdministrativeScopes, {
          kind: "coordinator",
          environmentId: EnvironmentId.make("env-coordinator"),
        });
        return yield* agent[WS_METHODS.machineHandoffCopySealedSecrets]({
          operationId: copy.operationId,
          paths: [".env"],
          destinationLabel: "M3",
        });
      }).pipe(Effect.scoped),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureText(exit)).toContain("Only a person running the copy");
    expect(link.asked).toEqual([]);
    expect(await stagedOn(copy.operationId)).toBeUndefined();
    await copy.copies.cancel(copy.operationId);
    await copy.copies.close();
  }, 120_000);

  it("sends none when the destination's grant for the source is not the owner's full access", async () => {
    const copy = await begin("grant");
    const link = fleetLink(copy.copies, { mayCarrySecrets: false });
    const exit = await run(
      Effect.gen(function* () {
        const window = yield* sourceRpc(link, AuthStandardClientScopes);
        const route = yield* window[WS_METHODS.machineHandoffCopySecretsRoute]({
          destinationEnvironmentId: EnvironmentId.make(DESTINATION),
        });
        expect(route.sealed).toBe(false);
        expect(route.reason).toBe("not_allowed");
        return yield* window[WS_METHODS.machineHandoffCopySealedSecrets]({
          operationId: copy.operationId,
          paths: Object.keys(ALL_SECRETS),
          destinationLabel: "M3",
        });
      }).pipe(Effect.scoped),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureText(exit)).toContain("full-access grant");
    expect(await stagedOn(copy.operationId)).toBeUndefined();
    expect(NodeFS.existsSync(keyFileOf(copy))).toBe(false);

    await copy.copies.approve(copy.operationId, { withoutSecrets: true });
    const applied = await settle(copy.copies, copy.operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    for (const path of Object.keys(FOLDER_SECRETS))
      expect(NodeFS.existsSync(NodePath.join(copy.folder, path)), path).toBe(false);
    expect(copy.seen.secrets).toEqual([]);
    await copy.copies.close();
  }, 180_000);

  it("gives the receiving key only to the machine that offered the copy, and only while it runs", async () => {
    const copy = await begin("key");
    const first = await copy.copies.secretsKey(copy.operationId, SOURCE);
    // A retry seals to the same key.
    expect(await copy.copies.secretsKey(copy.operationId, SOURCE)).toBe(first);
    const other = await copy.copies
      .secretsKey(copy.operationId, "env-elsewhere")
      .catch((cause: unknown) => cause);
    const unknown = await copy.copies
      .secretsKey(NodeCrypto.randomUUID(), SOURCE)
      .catch((cause: unknown) => cause);
    expect(String((other as Error).message)).toBe("That copy came from another machine.");
    expect(String((unknown as Error).message)).toBe(String((other as Error).message));
    await copy.copies.cancel(copy.operationId);
    expect(NodeFS.existsSync(keyFileOf(copy))).toBe(false);
    const ended = await copy.copies
      .secretsKey(copy.operationId, SOURCE)
      .catch((cause: unknown) => cause);
    expect(String((ended as Error).message)).toBe("This copy no longer takes secret files.");
    await copy.copies.close();
  }, 120_000);

  it("writes nothing when a secret is sealed to a key this machine does not hold", async () => {
    const copy = await begin("stranger");
    await copy.copies.secretsKey(copy.operationId, SOURCE);
    await transfers.approveSecrets({
      operationId: copy.operationId,
      paths: Object.keys(FOLDER_SECRETS),
      destinationLabel: "M3",
      sealTo: newReceivingKey().publicKey,
    });
    await copy.copies.approve(copy.operationId);
    const ended = await settle(copy.copies, copy.operationId, ["applied", "failed"]);
    expect(ended.state).toBe("failed");
    expect(JSON.stringify(ended.error)).toContain("sealed to a key this machine does not hold");
    for (const path of Object.keys(FOLDER_SECRETS))
      expect(NodeFS.existsSync(NodePath.join(copy.folder, path)), path).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(copy.folder, "README.md"), "utf8")).toBe(
      "# Umbrella\n",
    );
    await copy.copies.close();
  }, 180_000);

  it("refuses a key that cannot seal, and stages nothing", async () => {
    const copy = await begin("badkey");
    const refused = await transfers
      .approveSecrets({
        operationId: copy.operationId,
        paths: [".env"],
        destinationLabel: "M3",
        sealTo: "not-a-key",
      })
      .catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(Error);
    expect(await stagedOn(copy.operationId)).toBeUndefined();
    await copy.copies.cancel(copy.operationId);
    await copy.copies.close();
  }, 120_000);
});
