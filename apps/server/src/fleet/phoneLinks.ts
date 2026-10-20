// @effect-diagnostics-next-line nodeBuiltinImport:off - the link file needs mode 0600 and an atomic rename, like the fleet file.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - random suffix for the temporary file.
import * as NodeCrypto from "node:crypto";
import {
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import {
  StudioFleetPhoneLinksResult,
  StudioFleetPhoneMintResult,
  type StudioFleetPhoneMachine,
  type StudioFleetPhoneProblem,
  type StudioFleetPhoneRoster,
  type StudioFleetPhoneRoute,
} from "@specweave-studio/contracts/studioFleet";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { join } from "../nodePath.ts";
import {
  checkIdentity,
  FleetError,
  type FleetConfig,
  type FleetFetch,
  type FleetTarget,
  readBoundedJson,
} from "../studioFleet.ts";
import * as FleetTargets from "./FleetTargets.ts";

/**
 * Phone fleet links (0970). A phone paired with one machine, the hub, asks it
 * for the other machines in its fleet. The hub asks each of them, with its
 * management token, for a phone-only pairing code; the phone redeems it there
 * itself, so every machine holds its own token for the phone and none holds
 * the phone's token for another. The session a code opens carries the hub's
 * phone session in its subject, which is how revoking the phone anywhere
 * reaches every machine: the hub's sweep tells each machine which of its phone
 * sessions are still active, and a machine that revoked the phone shows up as
 * a link the hub no longer sees there.
 */
export const PHONE_LINK_SUBJECT_PREFIX = "phone-link:";
/** How long a phone code stays redeemable; the phone redeems it right away. */
export const PHONE_CODE_TTL = Duration.minutes(10);
const SWEEP_INTERVAL = Duration.seconds(60);
const REQUEST_TIMEOUT_MS = 8_000;
/** A mint the hub never saw redeemed is forgotten after this. */
const PENDING_TTL_MS = 60 * 60 * 1000;
/** A stored link that vanished this close to its expiry ended on its own, not by revocation. */
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;
const PHONE_DEVICE_TYPES: ReadonlySet<string> = new Set(["mobile", "tablet"]);
const STORE_FILE = "phone-links.json";
const MAX_ACTIVE_SESSIONS = 256;

export const phoneLinkSubject = (hubEnvironmentId: string, hubSessionId: string) =>
  `${PHONE_LINK_SUBJECT_PREFIX}${hubEnvironmentId}:${hubSessionId}`;

/** The hub phone session a session here was linked from, or null when it is not that hub's link. */
export const phoneLinkHubSession = (subject: string, hubEnvironmentId: string): string | null => {
  const prefix = `${PHONE_LINK_SUBJECT_PREFIX}${hubEnvironmentId}:`;
  if (!subject.startsWith(prefix)) return null;
  const rest = subject.slice(prefix.length);
  return rest.length > 0 ? rest : null;
};

export const isPhoneDevice = (deviceType: string | undefined) =>
  deviceType !== undefined && PHONE_DEVICE_TYPES.has(deviceType);

/**
 * The scopes a phone code may carry: only standard client scopes, each held by
 * the caller, with no repeats and at least read access. Null when refused.
 */
export function phoneCodeScopes(
  requested: ReadonlyArray<string>,
  callerScopes: ReadonlySet<string>,
): ReadonlyArray<AuthEnvironmentScope> | null {
  const standard = new Set<string>(AuthStandardClientScopes);
  if (requested.length === 0 || new Set(requested).size !== requested.length) return null;
  if (!requested.every((scope) => standard.has(scope) && callerScopes.has(scope))) return null;
  if (!requested.includes(AuthOrchestrationReadScope)) return null;
  return requested as ReadonlyArray<AuthEnvironmentScope>;
}

/** The scopes the hub asks a machine for: what the phone holds here, the machine allows, and a client may hold. */
export function phoneMintScopes(
  phoneScopes: ReadonlySet<string>,
  target: Pick<FleetTarget, "scopes">,
): ReadonlyArray<AuthEnvironmentScope> {
  const allowed = new Set<string>(target.scopes);
  return AuthStandardClientScopes.filter((scope) => phoneScopes.has(scope) && allowed.has(scope));
}

// ---------------------------------------------------------------------------
// The hub's record of where it linked phones. No secrets: session ids only.

export interface PhoneLinkRecord {
  readonly environmentId: string;
  readonly hubSessionId: string;
  readonly peerSessionId: string;
  readonly expiresAt: string;
}
export interface PhonePendingRecord {
  readonly environmentId: string;
  readonly hubSessionId: string;
  readonly mintedAt: string;
}
export interface PhoneLinkStore {
  readonly version: 1;
  readonly links: ReadonlyArray<PhoneLinkRecord>;
  readonly pending: ReadonlyArray<PhonePendingRecord>;
}

const PhoneLinkStoreSchema = Schema.Struct({
  version: Schema.Literal(1),
  links: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      hubSessionId: Schema.String,
      peerSessionId: Schema.String,
      expiresAt: Schema.String,
    }),
  ),
  pending: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      hubSessionId: Schema.String,
      mintedAt: Schema.String,
    }),
  ),
});
const decodeStore = Schema.decodeUnknownOption(PhoneLinkStoreSchema);
const decodeMintResult = Schema.decodeUnknownOption(StudioFleetPhoneMintResult);
const decodeLinksResult = Schema.decodeUnknownOption(StudioFleetPhoneLinksResult);
const EMPTY_STORE: PhoneLinkStore = { version: 1, links: [], pending: [] };

export async function readPhoneLinkStore(stateDir: string): Promise<PhoneLinkStore> {
  let text: string;
  try {
    text = await NodeFSP.readFile(join(stateDir, STORE_FILE), "utf8");
  } catch {
    return EMPTY_STORE;
  }
  try {
    const decoded = decodeStore(JSON.parse(text));
    return decoded._tag === "Some" ? decoded.value : EMPTY_STORE;
  } catch {
    return EMPTY_STORE;
  }
}

async function writePhoneLinkStore(stateDir: string, store: PhoneLinkStore): Promise<void> {
  await NodeFSP.mkdir(stateDir, { recursive: true });
  const target = join(stateDir, STORE_FILE);
  const temp = join(stateDir, `.${STORE_FILE}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    const file = await NodeFSP.open(temp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(store)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await NodeFSP.rename(temp, target);
  } catch (error) {
    await NodeFSP.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

const storeLocks = new Map<string, Promise<unknown>>();
/** Serializes changes to one link file within this process. */
export function modifyPhoneLinkStore<A>(
  stateDir: string,
  change: (store: PhoneLinkStore) => Promise<{ readonly next: PhoneLinkStore; readonly value: A }>,
): Promise<A> {
  const previous = storeLocks.get(stateDir) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readPhoneLinkStore(stateDir);
      const { next, value } = await change(current);
      if (JSON.stringify(next) !== JSON.stringify(current))
        await writePhoneLinkStore(stateDir, next);
      return value;
    });
  storeLocks.set(stateDir, run);
  void run.finally(() => {
    if (storeLocks.get(stateDir) === run) storeLocks.delete(stateDir);
  });
  return run;
}

export const recordPhoneMint = (
  stateDir: string,
  entry: { readonly environmentId: string; readonly hubSessionId: string; readonly now: number },
) =>
  modifyPhoneLinkStore(stateDir, async (store) => ({
    next: {
      ...store,
      pending: [
        ...store.pending.filter(
          (pending) =>
            !(
              pending.environmentId === entry.environmentId &&
              pending.hubSessionId === entry.hubSessionId
            ),
        ),
        {
          environmentId: entry.environmentId,
          hubSessionId: entry.hubSessionId,
          mintedAt: DateTime.formatIso(DateTime.makeUnsafe(entry.now)),
        },
      ],
    },
    value: undefined,
  }));

// ---------------------------------------------------------------------------
// Requests the hub sends to a machine with its management token.

type MintAnswer =
  | {
      readonly ok: true;
      readonly code: string;
      readonly expiresAt: string;
      readonly routes: ReadonlyArray<StudioFleetPhoneRoute>;
    }
  | { readonly ok: false; readonly problem: StudioFleetPhoneProblem };

async function postJson(
  fetcher: FleetFetch,
  target: FleetTarget,
  path: string,
  body: unknown,
): Promise<{ readonly status: number; readonly body: unknown } | null> {
  if (!target.managementToken) return null;
  let response: Response;
  try {
    response = await fetcher(`${target.url}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.managementToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, body: undefined };
  }
  const parsed = await readBoundedJson(response).catch(() => undefined);
  return { status: response.status, body: parsed };
}

export async function requestPhoneCode(
  fetcher: FleetFetch,
  target: FleetTarget,
  body: {
    readonly hubEnvironmentId: string;
    readonly hubSessionId: string;
    readonly label: string;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  },
  now: number,
): Promise<MintAnswer> {
  if (!target.managementToken) return { ok: false, problem: "pairing_unavailable" };
  const answer = await postJson(fetcher, target, "/api/studio/fleet/phone/mint", body);
  if (answer === null) return { ok: false, problem: "unreachable" };
  // An older machine has no phone mint; it needs the update, not a retry.
  if (answer.status === 404 || answer.status === 405)
    return { ok: false, problem: "update_required" };
  if (answer.status !== 200) return { ok: false, problem: "pairing_unavailable" };
  const decoded = decodeMintResult(answer.body);
  if (decoded._tag === "None") return { ok: false, problem: "pairing_unavailable" };
  const expiresAt = Date.parse(decoded.value.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || decoded.value.code.length === 0)
    return { ok: false, problem: "pairing_unavailable" };
  return {
    ok: true,
    code: decoded.value.code,
    expiresAt: decoded.value.expiresAt,
    routes: decoded.value.routes.filter((route) => isHttpBase(route.httpBaseUrl)),
  };
}

export async function requestPhoneLinks(
  fetcher: FleetFetch,
  target: FleetTarget,
  body: { readonly hubEnvironmentId: string; readonly activeHubSessionIds: ReadonlyArray<string> },
): Promise<StudioFleetPhoneLinksResult | null> {
  if (!target.managementToken) return null;
  // The management token only goes to the machine it was made for.
  const identified = await checkIdentity(fetcher, target).then(
    () => true,
    () => false,
  );
  if (!identified) return null;
  const answer = await postJson(fetcher, target, "/api/studio/fleet/phone/links", body);
  if (answer === null || answer.status !== 200) return null;
  const decoded = decodeLinksResult(answer.body);
  return decoded._tag === "Some" ? decoded.value : null;
}

const isHttpBase = (value: string) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// The roster the hub answers a phone with.

export async function buildPhoneRoster(input: {
  readonly config: FleetConfig | null;
  readonly fetcher: FleetFetch;
  readonly hub: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly phone: {
    readonly sessionId: string;
    readonly label: string;
    readonly scopes: ReadonlySet<string>;
  };
  readonly mint: ReadonlySet<string>;
  readonly recordMint: (environmentId: string) => Promise<void>;
  readonly now: number;
}): Promise<StudioFleetPhoneRoster> {
  const seen = new Set<string>([input.hub.environmentId]);
  const targets = (input.config?.machines ?? []).filter((target) => {
    if (seen.has(target.environmentId)) return false;
    seen.add(target.environmentId);
    return true;
  });
  const machines = await Promise.all(
    targets.map(async (target): Promise<StudioFleetPhoneMachine> => {
      const routes: Array<StudioFleetPhoneRoute> = [{ kind: "fleet", httpBaseUrl: target.url }];
      const base = { environmentId: target.environmentId, label: target.label };
      try {
        await checkIdentity(input.fetcher, target);
      } catch (error) {
        return {
          ...base,
          routes,
          problem:
            error instanceof FleetError && error.kind === "identity-mismatch"
              ? "identity_mismatch"
              : "unreachable",
        };
      }
      if (!input.mint.has(target.environmentId)) return { ...base, routes };
      const scopes = phoneMintScopes(input.phone.scopes, target);
      if (!scopes.includes(AuthOrchestrationReadScope))
        return { ...base, routes, problem: "pairing_unavailable" };
      const answer = await requestPhoneCode(
        input.fetcher,
        target,
        {
          hubEnvironmentId: input.hub.environmentId,
          hubSessionId: input.phone.sessionId,
          label: `${input.phone.label} via ${input.hub.label}`.slice(0, 120),
          scopes,
        },
        input.now,
      );
      if (!answer.ok) return { ...base, routes, problem: answer.problem };
      await input.recordMint(target.environmentId).catch(() => undefined);
      for (const route of answer.routes)
        if (!routes.some((known) => known.httpBaseUrl === route.httpBaseUrl)) routes.push(route);
      return { ...base, routes, pairing: { code: answer.code, expiresAt: answer.expiresAt } };
    }),
  );
  return { hub: { environmentId: input.hub.environmentId, label: input.hub.label }, machines };
}

// ---------------------------------------------------------------------------
// The machine side: the links a hub's phone sessions opened here.

/**
 * Revokes this machine's phone sessions linked from `hubEnvironmentId`
 * through a hub session no longer in `activeHubSessionIds`; answers the rest.
 */
export const syncPhoneLinksHere = (input: {
  readonly hubEnvironmentId: string;
  readonly activeHubSessionIds: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const active = new Set(input.activeHubSessionIds);
    const sessions = yield* auth.listSessions();
    const links: Array<StudioFleetPhoneLinksResult["links"][number]> = [];
    let revoked = 0;
    for (const session of sessions) {
      const hubSessionId = phoneLinkHubSession(session.subject, input.hubEnvironmentId);
      if (hubSessionId === null) continue;
      if (active.has(hubSessionId)) {
        links.push({
          sessionId: session.sessionId,
          hubSessionId:
            hubSessionId as StudioFleetPhoneLinksResult["links"][number]["hubSessionId"],
          expiresAt: DateTime.formatIso(session.expiresAt),
        });
        continue;
      }
      if (yield* auth.revokeSession(session.sessionId)) revoked += 1;
    }
    if (revoked > 0)
      yield* Effect.logInfo("Revoked phone sessions whose pairing ended on the main machine.", {
        hubEnvironmentId: input.hubEnvironmentId,
        revoked,
      });
    return { links, revoked } satisfies StudioFleetPhoneLinksResult;
  });

// ---------------------------------------------------------------------------
// The hub's sweep.

export interface PhoneSweepResult {
  /** Phone sessions revoked here because a linked machine revoked the phone. */
  readonly revokedHere: number;
  /** Phone sessions the linked machines revoked because the hub's session ended. */
  readonly revokedThere: number;
}

export async function sweepPhoneLinks(input: {
  readonly stateDir: string;
  readonly config: FleetConfig | null;
  readonly fetcher: FleetFetch;
  readonly hubEnvironmentId: string;
  /** This machine's active phone sessions, or null when they cannot be read. */
  readonly activePhoneSessions: () => Promise<ReadonlySet<string> | null>;
  readonly revokeHubSession: (sessionId: string) => Promise<boolean>;
  readonly now: number;
}): Promise<PhoneSweepResult> {
  return modifyPhoneLinkStore(input.stateDir, async (store) => {
    const idle = { next: store, value: { revokedHere: 0, revokedThere: 0 } };
    if (store.links.length === 0 && store.pending.length === 0) return idle;
    const activeNow = await input.activePhoneSessions();
    if (activeNow === null) return idle;
    const active = new Set(activeNow);
    const known = new Set([
      ...store.links.map((link) => link.environmentId),
      ...store.pending.map((pending) => pending.environmentId),
    ]);
    const targets = (input.config?.machines ?? []).filter(
      (target) => known.has(target.environmentId) && Boolean(target.managementToken),
    );
    const activeIds = () => [...active].slice(0, MAX_ACTIVE_SESSIONS);
    const ask = async () =>
      new Map<string, StudioFleetPhoneLinksResult | null>(
        await Promise.all(
          targets.map(
            async (target) =>
              [
                target.environmentId,
                await requestPhoneLinks(input.fetcher, target, {
                  hubEnvironmentId: input.hubEnvironmentId,
                  activeHubSessionIds: activeIds(),
                }),
              ] as const,
          ),
        ),
      );
    const answers = await ask();
    let revokedThere = 0;
    for (const answer of answers.values()) revokedThere += answer?.revoked ?? 0;

    // A link a machine stopped listing before its expiry, while its hub
    // session is still active here, was revoked on that machine.
    let revokedHere = 0;
    for (const link of store.links) {
      const answer = answers.get(link.environmentId);
      if (!answer || !active.has(link.hubSessionId)) continue;
      if (Date.parse(link.expiresAt) - input.now <= EXPIRY_MARGIN_MS) continue;
      if (answer.links.some((entry) => entry.sessionId === link.peerSessionId)) continue;
      active.delete(link.hubSessionId);
      if (await input.revokeHubSession(link.hubSessionId).catch(() => false)) revokedHere += 1;
    }
    // The same sweep carries that revocation to the other machines.
    if (revokedHere > 0) {
      const again = await ask();
      for (const [environmentId, answer] of again) {
        if (answer === null) continue;
        revokedThere += answer.revoked;
        answers.set(environmentId, answer);
      }
    }

    const links: Array<PhoneLinkRecord> = [];
    for (const link of store.links)
      if (!answers.get(link.environmentId) && Date.parse(link.expiresAt) > input.now)
        links.push(link);
    for (const [environmentId, answer] of answers)
      for (const entry of answer?.links ?? [])
        links.push({
          environmentId,
          hubSessionId: entry.hubSessionId,
          peerSessionId: entry.sessionId,
          expiresAt: entry.expiresAt,
        });
    const observed = new Set(links.map((link) => `${link.environmentId}\n${link.hubSessionId}`));
    const pending = store.pending.filter(
      (entry) =>
        input.now - Date.parse(entry.mintedAt) < PENDING_TTL_MS &&
        !observed.has(`${entry.environmentId}\n${entry.hubSessionId}`) &&
        active.has(entry.hubSessionId),
    );
    return {
      next: { version: 1, links, pending },
      value: { revokedHere, revokedThere },
    };
  });
}

/**
 * Before a machine leaves the fleet: revoke the phone sessions this hub linked
 * there (best effort), and forget them here. Without the hub's sweep they
 * would outlive a revocation of the phone.
 */
export async function unlinkPhonesFrom(input: {
  readonly stateDir: string;
  readonly fetcher: FleetFetch;
  readonly target: FleetTarget;
  readonly hubEnvironmentId: string | undefined;
}): Promise<void> {
  if (input.hubEnvironmentId !== undefined)
    await requestPhoneLinks(input.fetcher, input.target, {
      hubEnvironmentId: input.hubEnvironmentId,
      activeHubSessionIds: [],
    }).catch(() => null);
  await modifyPhoneLinkStore(input.stateDir, async (store) => ({
    next: {
      version: 1,
      links: store.links.filter((link) => link.environmentId !== input.target.environmentId),
      pending: store.pending.filter(
        (pending) => pending.environmentId !== input.target.environmentId,
      ),
    },
    value: undefined,
  })).catch(() => undefined);
}

/** Every minute, carries phone revocations between this machine and the machines it linked. */
export const layerSweep = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const targets = yield* FleetTargets.FleetTargets;
    const sweep = Effect.gen(function* () {
      const hubEnvironmentId = yield* serverEnvironment.getEnvironmentId;
      const now = yield* Clock.currentTimeMillis;
      const fleet = yield* targets.load;
      const result = yield* Effect.tryPromise(() =>
        sweepPhoneLinks({
          stateDir: config.stateDir,
          config: fleet,
          fetcher: targets.fetch,
          hubEnvironmentId,
          activePhoneSessions: () =>
            Effect.runPromise(
              auth.listSessions().pipe(
                Effect.map(
                  (sessions): ReadonlySet<string> =>
                    new Set(
                      sessions
                        .filter((session) => isPhoneDevice(session.client.deviceType))
                        .map((session) => session.sessionId as string),
                    ),
                ),
                Effect.orElseSucceed(() => null),
              ),
            ),
          revokeHubSession: (sessionId) =>
            Effect.runPromise(
              auth
                .revokeSession(sessionId as Parameters<typeof auth.revokeSession>[0])
                .pipe(Effect.orElseSucceed(() => false)),
            ),
          now,
        }),
      );
      if (result.revokedHere > 0 || result.revokedThere > 0)
        yield* Effect.logInfo("Carried a phone revocation across machines.", { ...result });
    });
    yield* sweep.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Phone link sweep failed.", { cause })),
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
      Effect.forkScoped,
    );
  }),
);
