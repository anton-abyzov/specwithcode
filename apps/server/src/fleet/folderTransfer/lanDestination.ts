// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off - the destination's local-network generations and their watchdog.
import type {
  FolderCopyLanCheck,
  FolderCopyLanCheckAnswer,
  FolderCopyLanOffer,
} from "@specweave-studio/contracts";

import * as NodeFSP from "node:fs/promises";

import { createLanCertificate, type LanCertificate } from "./lanCertificate.ts";
import { LanConnector } from "./lanConnector.ts";
import { directlyAttached, type LanPolicy } from "./lanInterfaces.ts";
import {
  LAN_CLIENT_LIMITS,
  LAN_SOURCE_LIMITS,
  lanBindingSha256,
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
 * this process: only the hash of its certificate is answered.
 *
 * What is saved, in the copy's own 0600 record: the highest generation seen,
 * which generation's block was accepted, the path latch with its class, and
 * the bytes per path. Keys, the token and addresses live in memory only.
 */
export type LanLatch = Exclude<LanFailureKind, "denied">;

export interface DestinationLanState {
  /** The highest generation seen; a check at or below it is refused, also after a restart. */
  readonly generation: number;
  /** The generation whose block was accepted and may still be in use; null when none. */
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
}

interface Generation {
  readonly generation: number;
  readonly recipient: LanCertificate;
  readonly targetSha256: string;
  connector: LanConnector | null;
  lastUsedAt: number;
  expiresAt: number;
}

const NONE: FolderCopyLanCheckAnswer = { lan: null };

export class LanDestination {
  private readonly access: LanDestinationAccess;
  private readonly environmentId: () => string;
  private readonly enabled: () => boolean;
  private readonly policy: LanPolicy;
  private readonly limits: LanClientLimits;
  private readonly now: () => number;
  private readonly generations = new Map<string, Generation>();
  private readonly pendingBytes = new Map<string, { lan: number; connect: number }>();
  private readonly watchdog: ReturnType<typeof setInterval>;
  private signature: string;
  private lastTick: number;
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
  }

  liveGenerations(): number {
    return this.generations.size;
  }

  endAll(cause: LanEndCause) {
    for (const operationId of [...this.generations.keys()]) void this.end(operationId, cause);
  }

  /**
   * Ends this side of a generation: the pool is destroyed and the key dropped.
   * It is not a latch. A later generation may be offered on the control channel.
   */
  async end(operationId: string, _cause: LanEndCause): Promise<void> {
    const generation = this.generations.get(operationId);
    await this.flush(operationId);
    if (!generation) return;
    this.generations.delete(operationId);
    generation.connector?.destroy();
    await this.access
      .lanSave(operationId, (current) => ({ ...current, accepted: null }))
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.watchdog);
    // A shutdown keeps `accepted`: after the restart the key is gone, and the copy latches.
    for (const [operationId, generation] of this.generations) {
      generation.connector?.destroy();
      await this.flush(operationId);
    }
    this.generations.clear();
  }

  /** `lanCheck`: opt in, save the generation, make the one-time key, answer its hash. */
  async check(
    callerEnvironmentId: string,
    body: FolderCopyLanCheck,
  ): Promise<FolderCopyLanCheckAnswer> {
    if (this.closed || !this.enabled()) return NONE;
    const record = await this.access.lanRecord(body.operationId);
    if (
      record === null ||
      record.terminal ||
      record.sourceEnvironmentId !== callerEnvironmentId ||
      lanPurposeOfDestination(record) !== body.purpose ||
      record.lan?.latch
    )
      return NONE;
    if (body.generation <= (record.lan?.generation ?? 0)) return NONE;
    if (body.candidates.length > LAN_SOURCE_LIMITS.addressesPerOffer) return NONE;
    // The new highest generation is saved before anything is made for it.
    await this.access.lanSave(body.operationId, (current) => ({
      ...current,
      generation: Math.max(current.generation, body.generation),
      accepted: null,
    }));
    const previous = this.generations.get(body.operationId);
    previous?.connector?.destroy();
    this.generations.delete(body.operationId);
    const usable: Array<number> = [];
    for (const [index, candidate] of body.candidates.entries())
      if ((await directlyAttached(this.policy, candidate.host)) !== null) usable.push(index);
    if (usable.length === 0) return NONE;
    const now = this.now();
    const recipient = createLanCertificate({
      role: "recipient",
      notBefore: new Date(now - 5 * 60_000),
      notAfter: new Date(now + LAN_SOURCE_LIMITS.absoluteMs + 5 * 60_000),
    });
    const targetSha256 = lanTargetSha256({
      targetPath: record.targetFolder,
      kind: body.purpose === "add-whole-folder" ? "empty" : "reviewed",
    });
    this.generations.set(body.operationId, {
      generation: body.generation,
      recipient,
      targetSha256,
      connector: null,
      lastUsedAt: now,
      expiresAt: now + LAN_SOURCE_LIMITS.absoluteMs,
    });
    return {
      lan: {
        version: 1,
        generation: body.generation,
        recipientCertificateSha256: recipient.sha256,
        targetSha256,
        usable,
      },
    };
  }

  /** `lanOffer`: accepted only when every bound field matches this machine's own record. */
  async offer(
    callerEnvironmentId: string,
    body: { readonly operationId: string; readonly lan: FolderCopyLanOffer },
  ): Promise<boolean> {
    if (this.closed || !this.enabled()) return false;
    const { operationId, lan } = body;
    const record = await this.access.lanRecord(operationId);
    const mine = this.generations.get(operationId);
    const now = this.now();
    const purpose = record === null ? null : lanPurposeOfDestination(record);
    if (
      record === null ||
      mine === undefined ||
      mine.connector !== null ||
      record.terminal ||
      record.lan?.latch ||
      record.sourceEnvironmentId !== callerEnvironmentId ||
      purpose === null ||
      lan.version !== 1 ||
      lan.purpose !== purpose ||
      lan.generation !== mine.generation ||
      lan.generation !== record.lan?.generation ||
      record.copyRoot === undefined ||
      lan.expiresAt <= now ||
      lan.expiresAt > now + LAN_SOURCE_LIMITS.absoluteMs + 60_000 ||
      lan.addresses.length === 0 ||
      lan.addresses.length > LAN_SOURCE_LIMITS.addressesPerOffer ||
      lan.addresses.some((address) => !this.policy.admit(address.host)) ||
      !sameSha256(lan.recipientCertificateSha256, mine.recipient.sha256) ||
      !sameSha256(lan.targetSha256, mine.targetSha256)
    )
      return false;
    const scopeSha256 = lanScopeSha256({
      sourceProjectId: record.sourceProjectId,
      copyRoot: record.copyRoot,
      projectRelativePath: record.projectRelativePath ?? ".",
      mode: record.mode,
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
    await this.access.lanSave(operationId, (current) =>
      current.generation === mine.generation && !current.latch
        ? { ...current, accepted: mine.generation }
        : current,
    );
    if (this.generations.get(operationId) !== mine) return false;
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
   * The connector of the copy's live, accepted generation, or null: Connect.
   * A block accepted before a restart whose key is gone latches the copy once.
   */
  async connector(operationId: string): Promise<LanConnector | null> {
    if (this.closed) return null;
    const record = await this.access.lanRecord(operationId);
    if (record === null || record.lan?.latch) return null;
    const mine = this.generations.get(operationId);
    if (!this.enabled()) {
      if (mine) await this.end(operationId, "setting_off");
      return null;
    }
    if (mine === undefined) {
      if (
        record.lan &&
        record.lan.accepted !== null &&
        record.lan.accepted === record.lan.generation
      )
        await this.latch(operationId, "unreachable");
      return null;
    }
    if (mine.connector === null) return null;
    const now = this.now();
    if (now >= mine.expiresAt || now - mine.lastUsedAt >= this.limits.idleGenerationMs) {
      await this.end(operationId, "idle");
      return null;
    }
    mine.lastUsedAt = now;
    return mine.connector;
  }

  /**
   * Switch once: the latch is on disk before this resolves, so the first Connect
   * request can only follow it. The copy never tries the local network again.
   */
  async latch(operationId: string, kind: LanLatch): Promise<void> {
    const mine = this.generations.get(operationId);
    this.generations.delete(operationId);
    mine?.connector?.destroy();
    const pending = this.pendingBytes.get(operationId);
    this.pendingBytes.delete(operationId);
    await this.access.lanSave(operationId, (current) => ({
      ...current,
      accepted: null,
      latch: current.latch ?? kind,
      ...(kind === "wrong_pin" || kind === "wrong_identity" ? { recheck: true } : {}),
      bytesLan: current.bytesLan + (pending?.lan ?? 0),
      bytesConnect: current.bytesConnect + (pending?.connect ?? 0),
    }));
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
    .map((entry) => `${entry.path}\u0000${entry.type}\u0000${entry.sha256 ?? entry.target ?? ""}`)
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
