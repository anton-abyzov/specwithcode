// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off - the destination's local-network generations and their watchdog.
import type {
  FolderCopyLanCheck,
  FolderCopyLanCheckAnswer,
  FolderCopyLanOffer,
  FolderCopyLanProbe,
  FolderCopyLanRetire,
} from "@specweave-studio/contracts";

import * as NodeFSP from "node:fs/promises";

import { createLanCertificate, type LanCertificate } from "./lanCertificate.ts";
import { LanConnector } from "./lanConnector.ts";
import { directlyAttached, type LanPolicy } from "./lanInterfaces.ts";
import {
  LAN_CLIENT_LIMITS,
  LAN_SOURCE_LIMITS,
  lanBindingSha256,
  lanCeilingOf,
  lanPurposeOfDestination,
  lanScopeSha256,
  lanTargetSha256,
  sameSha256,
  type LanClientLimits,
  type LanEndCause,
  type LanFailureKind,
} from "./lanWire.ts";
import { readManifestFile, type ManifestEntry } from "./manifest.ts";
import type { LanPath } from "./sourceClient.ts";

/**
 * The destination half of the local-network path (1334 S-1, S-3, S-4, S-9).
 *
 * It answers `lanCheck` and `lanOffer`, which arrive only on the authenticated
 * machine-to-machine control channel, and it refuses any offer it cannot
 * recompute from its own record of the copy. The recipient key never leaves
 * this process: the answer carries its certificate and that certificate's hash.
 *
 * One copy's check, offer, latch and end run one at a time, and a generation is
 * taken by a compare-and-set inside the record's own lock, so two checks can
 * never both win and a lower one can never follow a higher one.
 *
 * What is saved, in the copy's own 0600 record: the highest generation seen,
 * which generation's block was accepted, the path latch with its class, and
 * the bytes per path. Keys, the token and addresses live in memory only.
 */
export type LanLatch = Exclude<LanFailureKind, "denied">;

export interface DestinationLanState {
  /** The highest generation seen; a check at or below it is refused, also after a restart. */
  readonly generation: number;
  /**
   * The generation whose block was accepted. It stays after that generation ends:
   * the first Connect request after it is the copy's one switch, and it latches.
   */
  readonly accepted: number | null;
  /** Set once: the copy moved to Connect and stays there. */
  readonly latch: LanLatch | null;
  /** After a wrong pin or identity: the manifest is read again over Connect before more is staged. */
  readonly recheck?: boolean;
  readonly bytesLan: number;
  readonly bytesConnect: number;
}

export const NO_LAN_STATE: DestinationLanState = {
  generation: 0,
  accepted: null,
  latch: null,
  bytesLan: 0,
  bytesConnect: 0,
};

export interface DestinationLanRecord {
  readonly operationId: string;
  readonly sourceEnvironmentId: string;
  readonly sourceProjectId: string;
  readonly copyRoot?: string | undefined;
  readonly projectRelativePath?: string | undefined;
  readonly mode: string;
  readonly purpose?: string | undefined;
  readonly targetFolder: string;
  /** The file classes the person approved for this copy, from this machine's own record. */
  readonly selection?: ReadonlyArray<string> | undefined;
  /** Applied, undone, failed or cancelled: never a generation again. */
  readonly terminal: boolean;
  readonly lan?: DestinationLanState | undefined;
}

export interface LanDestinationAccess {
  readonly lanRecord: (operationId: string) => Promise<DestinationLanRecord | null>;
  /** Applies the change under the record's lock and resolves once it is on disk. */
  readonly lanSave: (
    operationId: string,
    change: (current: DestinationLanState) => DestinationLanState,
  ) => Promise<void>;
  /**
   * Tells the source, over Connect with the copy's own grant, that this side of a
   * generation ended. It can only end; a failure changes nothing here.
   */
  readonly lanRetire?: (operationId: string, generation: number) => Promise<void>;
}

interface Generation {
  readonly generation: number;
  readonly recipient: LanCertificate;
  readonly targetSha256: string;
  /** The candidates this machine said it can reach; an offer may name no other host. */
  readonly hosts: ReadonlyMap<string, string>;
  connector: LanConnector | null;
  lastUsedAt: number;
  expiresAt: number;
}

const NONE: FolderCopyLanCheckAnswer = { lan: null };

/** What stands at the approved target now: nothing or an empty folder, or a folder with content. */
const targetKindOf = (folder: string): Promise<"empty" | "reviewed"> =>
  NodeFSP.readdir(folder).then(
    (names) => (names.length === 0 ? "empty" : "reviewed"),
    () => "empty",
  );

export class LanDestination {
  private readonly access: LanDestinationAccess;
  private readonly environmentId: () => string;
  private readonly enabled: () => boolean;
  private readonly policy: LanPolicy;
  private readonly limits: LanClientLimits;
  private readonly now: () => number;
  private readonly generations = new Map<string, Generation>();
  /** Copies whose generation ended in this process; a restart is told apart by its absence. */
  private readonly endedHere = new Set<string>();
  private readonly settled = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pendingBytes = new Map<string, { lan: number; connect: number }>();
  private readonly watchdog: ReturnType<typeof setInterval>;
  private signature: string;
  private lastTick: number;
  private auditing = false;
  private closed = false;

  constructor(input: {
    readonly access: LanDestinationAccess;
    readonly environmentId: () => string;
    /** The stored setting and the review gate together. Off: no key, no answer with data. */
    readonly enabled: () => boolean;
    readonly policy: LanPolicy;
    readonly limits?: LanClientLimits;
    readonly now?: () => number;
    readonly watchMs?: number;
  }) {
    this.access = input.access;
    this.environmentId = input.environmentId;
    this.enabled = input.enabled;
    this.policy = input.policy;
    this.limits = input.limits ?? LAN_CLIENT_LIMITS;
    this.now = input.now ?? Date.now;
    this.signature = this.policy.signature();
    this.lastTick = Date.now();
    this.watchdog = setInterval(() => this.watch(), input.watchMs ?? 500);
    this.watchdog.unref();
  }

  /** One copy's generation changes, one after another. */
  private serial<T>(operationId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(operationId) ?? Promise.resolve()).then(run, run);
    const settled = next.catch(() => undefined);
    this.queues.set(operationId, settled);
    void settled.then(() => {
      if (this.queues.get(operationId) === settled) this.queues.delete(operationId);
    });
    return next;
  }

  private watch() {
    const tick = Date.now();
    const slept = tick - this.lastTick > 5_000;
    this.lastTick = tick;
    if (this.generations.size === 0) {
      this.signature = this.policy.signature();
      return;
    }
    if (!this.enabled()) return this.endAll("setting_off");
    if (slept) return this.endAll("woke");
    const signature = this.policy.signature();
    if (signature !== this.signature) {
      this.signature = signature;
      return this.endAll("network_changed");
    }
    const now = this.now();
    for (const [operationId, generation] of this.generations)
      if (
        now >= generation.expiresAt ||
        now - generation.lastUsedAt >= this.limits.idleGenerationMs
      )
        void this.end(operationId, "idle");
    void this.audit();
  }

  /** A route that no longer leaves by the interface it did when the offer was taken. */
  private async audit(): Promise<void> {
    if (this.auditing) return;
    this.auditing = true;
    try {
      for (const [operationId, generation] of [...this.generations]) {
        if (generation.connector === null) continue;
        for (const [host, name] of generation.hosts)
          if ((await this.policy.routeInterface(host).catch(() => null)) !== name) {
            if (this.generations.get(operationId) === generation)
              await this.end(operationId, "network_changed");
            break;
          }
      }
    } finally {
      this.auditing = false;
    }
  }

  liveGenerations(): number {
    return this.generations.size;
  }

  endAll(cause: LanEndCause) {
    for (const operationId of [...this.generations.keys()]) void this.end(operationId, cause);
  }

  /** Drops the generation from memory: the pool is destroyed and the key with it. */
  private drop(operationId: string): Generation | null {
    const generation = this.generations.get(operationId) ?? null;
    if (generation === null) return null;
    this.generations.delete(operationId);
    this.endedHere.add(operationId);
    generation.connector?.destroy();
    return generation;
  }

  private tell(operationId: string, generation: Generation | null, cause: LanEndCause | "latch") {
    // The source ended it, or replaced it: it needs no word back.
    if (generation === null || cause === "retired" || cause === "rotated" || cause === "denied")
      return;
    void this.access.lanRetire?.(operationId, generation.generation).catch(() => undefined);
  }

  /**
   * Ends this side of a generation: the pool is destroyed and the key dropped, and
   * the source is told. The saved `accepted` stays, so the copy's next Connect read
   * is its one switch. A newer generation may still be offered before that read.
   */
  end(operationId: string, cause: LanEndCause): Promise<void> {
    return this.serial(operationId, async () => {
      const generation = this.drop(operationId);
      await this.flush(operationId);
      this.tell(operationId, generation, cause);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.watchdog);
    for (const [operationId, generation] of this.generations) {
      generation.connector?.destroy();
      await this.flush(operationId);
    }
    this.generations.clear();
  }

  /**
   * `lanProbe`: yes or no, and nothing else. No key is made, nothing is saved,
   * and the answer names no hash and no address.
   */
  async probe(callerEnvironmentId: string, body: FolderCopyLanProbe): Promise<boolean> {
    if (this.closed || !this.enabled()) return false;
    const record = await this.access.lanRecord(body.operationId).catch(() => null);
    return (
      record !== null &&
      !record.terminal &&
      record.sourceEnvironmentId === callerEnvironmentId &&
      lanPurposeOfDestination(record) === body.purpose &&
      !record.lan?.latch
    );
  }

  /** `lanRetire`: the source's generation ended, so this side's ends too. Nothing else can follow. */
  async retired(callerEnvironmentId: string, body: FolderCopyLanRetire): Promise<void> {
    const record = await this.access.lanRecord(body.operationId).catch(() => null);
    if (record === null || record.sourceEnvironmentId !== callerEnvironmentId) return;
    if (this.generations.get(body.operationId)?.generation !== body.generation) return;
    await this.end(body.operationId, "retired");
  }

  /** `lanCheck`: opt in, save the generation, make the one-time key, answer its certificate. */
  check(callerEnvironmentId: string, body: FolderCopyLanCheck): Promise<FolderCopyLanCheckAnswer> {
    return this.serial(body.operationId, () => this.checked(callerEnvironmentId, body));
  }

  private async checked(
    callerEnvironmentId: string,
    body: FolderCopyLanCheck,
  ): Promise<FolderCopyLanCheckAnswer> {
    if (this.closed || !this.enabled()) return NONE;
    const { operationId } = body;
    const record = await this.access.lanRecord(operationId);
    if (
      record === null ||
      record.terminal ||
      record.sourceEnvironmentId !== callerEnvironmentId ||
      lanPurposeOfDestination(record) !== body.purpose ||
      record.lan?.latch
    )
      return NONE;
    if (body.candidates.length > LAN_SOURCE_LIMITS.addressesPerOffer) return NONE;
    // A block accepted before a restart: its key is gone, so the copy switches now,
    // before any higher generation can be taken.
    if (await this.recovered(operationId, record)) return NONE;
    // Taken only if still the highest, decided where the record is written. An earlier
    // acceptance stays on the record until this generation's block is accepted, so a
    // read that goes to Connect in between is still the copy's one switch.
    let won = false;
    await this.access.lanSave(operationId, (current) => {
      won = !current.latch && body.generation > current.generation;
      return won ? { ...current, generation: body.generation } : current;
    });
    if (!won) return NONE;
    this.drop(operationId);
    this.endedHere.delete(operationId);
    const usable: Array<number> = [];
    const hosts = new Map<string, string>();
    for (const [index, candidate] of body.candidates.entries()) {
      const attached = await directlyAttached(this.policy, candidate.host);
      if (attached === null) continue;
      usable.push(index);
      hosts.set(candidate.host, attached.name);
    }
    if (usable.length === 0) return NONE;
    const now = this.now();
    const recipient = createLanCertificate({
      role: "recipient",
      notBefore: new Date(now - 5 * 60_000),
      notAfter: new Date(now + LAN_SOURCE_LIMITS.absoluteMs + 5 * 60_000),
    });
    const targetSha256 = lanTargetSha256({
      targetPath: record.targetFolder,
      kind: await targetKindOf(record.targetFolder),
    });
    this.generations.set(operationId, {
      generation: body.generation,
      recipient,
      targetSha256,
      hosts,
      connector: null,
      lastUsedAt: now,
      expiresAt: now + LAN_SOURCE_LIMITS.absoluteMs,
    });
    return {
      lan: {
        version: 1,
        generation: body.generation,
        recipientCertificateSha256: recipient.sha256,
        recipientCertificate: recipient.certificateDer.toString("base64"),
        targetSha256,
        usable,
      },
    };
  }

  /** `lanOffer`: accepted only when every bound field matches this machine's own record. */
  offer(
    callerEnvironmentId: string,
    body: { readonly operationId: string; readonly lan: FolderCopyLanOffer },
  ): Promise<boolean> {
    return this.serial(body.operationId, () => this.offered(callerEnvironmentId, body));
  }

  private async offered(
    callerEnvironmentId: string,
    body: { readonly operationId: string; readonly lan: FolderCopyLanOffer },
  ): Promise<boolean> {
    if (this.closed || !this.enabled()) return false;
    const { operationId, lan } = body;
    const record = await this.access.lanRecord(operationId);
    const mine = this.generations.get(operationId);
    const now = this.now();
    const purpose = record === null ? null : lanPurposeOfDestination(record);
    const ceiling = record?.selection ? lanCeilingOf(record.selection) : null;
    if (
      record === null ||
      mine === undefined ||
      mine.connector !== null ||
      record.terminal ||
      record.lan?.latch ||
      record.sourceEnvironmentId !== callerEnvironmentId ||
      purpose === null ||
      ceiling === null ||
      lan.version !== 1 ||
      lan.purpose !== purpose ||
      lan.generation !== mine.generation ||
      lan.generation !== record.lan?.generation ||
      record.copyRoot === undefined ||
      lan.expiresAt <= now ||
      lan.expiresAt > now + LAN_SOURCE_LIMITS.absoluteMs + 60_000 ||
      lan.addresses.length === 0 ||
      lan.addresses.length > LAN_SOURCE_LIMITS.addressesPerOffer ||
      // Only a host this machine checked and answered for, never one named later.
      lan.addresses.some(
        (address) => !this.policy.admit(address.host) || !mine.hosts.has(address.host),
      ) ||
      !sameSha256(lan.recipientCertificateSha256, mine.recipient.sha256) ||
      !sameSha256(lan.targetSha256, mine.targetSha256)
    )
      return false;
    // The classes are the ones approved here. A source that froze any other set
    // made a different hash, and its block is refused before any connection.
    const scopeSha256 = lanScopeSha256({
      sourceProjectId: record.sourceProjectId,
      copyRoot: record.copyRoot,
      projectRelativePath: record.projectRelativePath ?? ".",
      mode: record.mode,
      ceiling,
    });
    const bindingSha256 = lanBindingSha256({
      sourceEnvironmentId: record.sourceEnvironmentId,
      destinationEnvironmentId: this.environmentId(),
      operationId,
      purpose,
      scopeSha256,
      targetSha256: mine.targetSha256,
      generation: mine.generation,
      expiresAt: lan.expiresAt,
      sourceCertificateSha256: lan.sourceCertificateSha256,
      recipientCertificateSha256: mine.recipient.sha256,
    });
    if (!sameSha256(lan.scopeSha256, scopeSha256) || !sameSha256(lan.bindingSha256, bindingSha256))
      return false;
    let won = false;
    await this.access.lanSave(operationId, (current) => {
      won =
        current.generation === mine.generation &&
        !current.latch &&
        current.accepted !== mine.generation;
      return won ? { ...current, accepted: mine.generation } : current;
    });
    if (!won || this.generations.get(operationId) !== mine) return false;
    mine.expiresAt = lan.expiresAt;
    mine.lastUsedAt = now;
    mine.connector = new LanConnector(
      {
        operationId,
        generation: mine.generation,
        addresses: lan.addresses,
        sourceCertificateSha256: lan.sourceCertificateSha256,
        lanToken: lan.lanToken,
        recipient: mine.recipient,
        expected: {
          environmentId: record.sourceEnvironmentId,
          operationId,
          generation: mine.generation,
          bindingSha256,
        },
      },
      this.policy,
      this.limits,
    );
    return true;
  }

  /**
   * An accepted block with no live generation behind it: ended here, or lost to a
   * restart. The copy latches, once. True when it did.
   */
  private async recovered(
    operationId: string,
    record: DestinationLanRecord,
    restartOnly = true,
  ): Promise<boolean> {
    if (record.terminal || !record.lan || record.lan.latch || record.lan.accepted === null)
      return false;
    if (this.generations.get(operationId)?.connector) return false;
    // A generation known to this process, live or ended, is not one a restart lost.
    if (restartOnly && (this.endedHere.has(operationId) || this.generations.has(operationId)))
      return false;
    await this.latched(operationId, "unreachable");
    return true;
  }

  /**
   * Run before any request of this copy goes to Connect. A copy whose accepted
   * generation was lost to a restart switches here, on disk, first.
   */
  beforeConnect(operationId: string): Promise<void> {
    // Once per copy in a process: what a restart lost is settled by the first look.
    if (this.settled.has(operationId)) return Promise.resolve();
    return this.serial(operationId, async () => {
      const record = await this.access.lanRecord(operationId).catch(() => null);
      if (record !== null) await this.recovered(operationId, record);
      this.settled.add(operationId);
    });
  }

  /** The connector of the copy's live, accepted generation, or null: Connect. */
  connector(operationId: string): Promise<LanConnector | null> {
    return this.serial(operationId, async () => {
      if (this.closed) return null;
      const record = await this.access.lanRecord(operationId);
      if (record === null || record.lan?.latch) return null;
      const mine = this.generations.get(operationId);
      if (mine?.connector) {
        const now = this.now();
        const over = now >= mine.expiresAt || now - mine.lastUsedAt >= this.limits.idleGenerationMs;
        if (this.enabled() && !over) {
          mine.lastUsedAt = now;
          return mine.connector;
        }
        this.tell(operationId, this.drop(operationId), this.enabled() ? "idle" : "setting_off");
      }
      await this.recovered(operationId, record, false);
      return null;
    });
  }

  /**
   * Switch once: the latch is on disk before this resolves, so the first Connect
   * request can only follow it. The copy never tries the local network again.
   */
  latch(operationId: string, kind: LanLatch): Promise<void> {
    return this.serial(operationId, () => this.latched(operationId, kind));
  }

  private async latched(operationId: string, kind: LanLatch): Promise<void> {
    const mine = this.drop(operationId);
    const pending = this.pendingBytes.get(operationId);
    this.pendingBytes.delete(operationId);
    await this.access.lanSave(operationId, (current) => ({
      ...current,
      latch: current.latch ?? kind,
      ...(kind === "wrong_pin" || kind === "wrong_identity" ? { recheck: true } : {}),
      bytesLan: current.bytesLan + (pending?.lan ?? 0),
      bytesConnect: current.bytesConnect + (pending?.connect ?? 0),
    }));
    this.tell(operationId, mine, "latch");
  }

  /** A denial stops the copy on both paths; this side only drops its generation. */
  async stopped(operationId: string): Promise<void> {
    await this.end(operationId, "denied");
  }

  async rechecked(operationId: string): Promise<void> {
    await this.access.lanSave(operationId, ({ recheck: _recheck, ...current }) => current);
  }

  /** Bytes per path, for the path line. Kept in memory and saved with the next write. */
  count(operationId: string, path: "lan" | "connect", bytes: number): void {
    const known = this.pendingBytes.get(operationId);
    // With the setting off nothing about this path is kept, not even a count.
    if (!known && !this.enabled()) return;
    const pending = known ?? { lan: 0, connect: 0 };
    pending[path] += bytes;
    this.pendingBytes.set(operationId, pending);
  }

  async flush(operationId: string): Promise<void> {
    const pending = this.pendingBytes.get(operationId);
    if (!pending || (pending.lan === 0 && pending.connect === 0)) return;
    this.pendingBytes.delete(operationId);
    await this.access
      .lanSave(operationId, (current) => ({
        ...current,
        bytesLan: current.bytesLan + pending.lan,
        bytesConnect: current.bytesConnect + pending.connect,
      }))
      .catch(() => undefined);
  }
}

/** The path line's word for a copy, from byte counts and the latch alone. */
export function lanPathOf(state: DestinationLanState | undefined):
  | {
      readonly path: "lan" | "connect" | "mixed";
      readonly bytesLan: number;
      readonly bytesConnect: number;
    }
  | undefined {
  if (state === undefined) return undefined;
  const { bytesLan, bytesConnect } = state;
  const path =
    bytesLan === 0 ? "connect" : bytesConnect > 0 || state.latch !== null ? "mixed" : "lan";
  return { path, bytesLan, bytesConnect };
}

const named = (entries: ReadonlyArray<ManifestEntry>) =>
  entries
    .map((entry) =>
      [
        entry.path,
        entry.type,
        entry.sha256 ?? entry.target ?? "",
        entry.size ?? "",
        (entry.chunks ?? []).join(","),
      ].join("\u0000"),
    )
    .sort()
    .join("\n");

/** The copy client's view of the local-network path for one copy. */
export function lanPathFor(
  lan: LanDestination,
  access: LanDestinationAccess,
  operationId: string,
  files: { readonly manifest: string; readonly staging: string },
): LanPath {
  return {
    connector: () => lan.connector(operationId),
    beforeConnect: () => lan.beforeConnect(operationId),
    latch: (kind) => lan.latch(operationId, kind),
    stopped: () => lan.stopped(operationId),
    count: (path, bytes) => lan.count(operationId, path, bytes),
    recheck: async (manifest) => {
      const record = await access.lanRecord(operationId);
      if (!record?.lan?.recheck) return true;
      // Read the manifest again over Connect; staged data stays only if it names the same content.
      const fresh = await manifest();
      const saved = await readManifestFile(files.manifest).catch(() => null);
      if (saved !== null && "entries" in fresh && named(fresh.entries) === named(saved.entries)) {
        await lan.rechecked(operationId);
        return true;
      }
      await NodeFSP.rm(files.staging, { recursive: true, force: true });
      return false;
    },
  };
}
