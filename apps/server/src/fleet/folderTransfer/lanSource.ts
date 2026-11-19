// @effect-diagnostics globalDate:off nodeBuiltinImport:off globalTimers:off - the source's local-network generations and their watchdog.
import * as NodeFSP from "node:fs/promises";

import type {
  FolderCopyLanCheck,
  FolderCopyLanCheckAnswer,
  FolderCopyLanOffer,
  FolderCopyLanPurpose,
} from "@specweave-studio/contracts";

import { createLanCertificate } from "./lanCertificate.ts";
import type { LanInterface, LanPolicy } from "./lanInterfaces.ts";
import { LanGenerationListener, LanSourceBudgets } from "./lanListener.ts";
import {
  LAN_SOURCE_LIMITS,
  lanBindingSha256,
  lanScopeSha256,
  mintLanToken,
  type LanDenial,
  type LanEndCause,
  type LanSourceLimits,
} from "./lanWire.ts";
import { MAX_BATCH_CHUNKS_LARGE } from "./wire.ts";

/**
 * The source half of the local-network path (1334 S-1, S-7, S-9).
 *
 * Only this module creates a LAN offer, and it sends it only over the
 * machine-to-machine control channel (`LanControlPeer`). Nothing a listener
 * receives can create, renew or extend an offer, a generation, a token, an
 * address or a deadline: the listener has no route that reaches this module.
 *
 * A generation is one attempt for one copy, with its own key, certificate,
 * token, sockets and lifetime. The counter only goes up and is saved before it
 * is used, so a restart cannot bring an old number back.
 */
export interface LanSourceState {
  readonly operationId: string;
  readonly projectId: string;
  readonly folder: string;
  readonly projectRelativePath: string;
  readonly mode: string;
  readonly destinationEnvironmentId: string;
  /** The copy the person started; null for any copy that never gets a LAN path. */
  readonly purpose: FolderCopyLanPurpose | null;
  /** Committed, released or cancelled: never a listener again. */
  readonly terminal: boolean;
  readonly denial: LanDenial | null;
  readonly generation: number;
  /** When recent generations were issued, for the hourly budget. */
  readonly issued: ReadonlyArray<number>;
}

/** What the source's copy service gives this module; nothing else of it is reachable. */
export interface LanSourceAccess {
  readonly lanState: (operationId: string) => Promise<LanSourceState | null>;
  /** Saves the counter durably; resolves only after it is on disk. */
  readonly lanSaveGeneration: (
    operationId: string,
    generation: number,
    issued: ReadonlyArray<number>,
  ) => Promise<void>;
  readonly lanManifest: (
    operationId: string,
  ) => Promise<
    | { readonly ready: true; readonly bytes: Uint8Array }
    | { readonly ready: false; readonly body: unknown }
  >;
  readonly lanChunks: (
    operationId: string,
    hashes: ReadonlyArray<string>,
    zstd: boolean,
  ) => Promise<Uint8Array>;
  /** Records the denial on the operation, durably, where Connect reads it too. */
  readonly lanDeny: (operationId: string, denial: LanDenial) => Promise<void>;
}

/** The authenticated machine-to-machine call to the copy's destination. Any failure means Connect. */
export interface LanControlPeer {
  readonly check: (
    destinationEnvironmentId: string,
    body: FolderCopyLanCheck,
  ) => Promise<FolderCopyLanCheckAnswer>;
  readonly offer: (
    destinationEnvironmentId: string,
    body: { readonly operationId: string; readonly lan: FolderCopyLanOffer },
  ) => Promise<boolean>;
}

interface Live {
  readonly listener: LanGenerationListener;
  readonly rootIdentity: string | null;
}

const identityOf = (folder: string) =>
  NodeFSP.stat(folder).then(
    (stat) => `${stat.dev}:${stat.ino}`,
    () => null,
  );

export class LanSource {
  private readonly access: LanSourceAccess;
  private readonly environmentId: () => string;
  private readonly enabled: () => boolean;
  private readonly policy: LanPolicy;
  private readonly peer: LanControlPeer;
  private readonly limits: LanSourceLimits;
  private readonly now: () => number;
  private readonly updating: () => boolean;
  private readonly budgets: LanSourceBudgets;
  private readonly live = new Map<string, Live>();
  private readonly running = new Map<string, Promise<boolean>>();
  /** Copies whose destination answered no; they are not asked again. */
  private readonly declined = new Set<string>();
  private readonly watchdog: ReturnType<typeof setInterval>;
  private signature: string;
  private lastTick: number;
  private closed = false;

  constructor(input: {
    readonly access: LanSourceAccess;
    readonly environmentId: () => string;
    /** The stored setting and the review gate together; off means no key, no socket, no offer. */
    readonly enabled: () => boolean;
    readonly policy: LanPolicy;
    readonly peer: LanControlPeer;
    readonly limits?: LanSourceLimits;
    readonly now?: () => number;
    readonly updating?: () => boolean;
    readonly watchMs?: number;
  }) {
    this.access = input.access;
    this.environmentId = input.environmentId;
    this.enabled = input.enabled;
    this.policy = input.policy;
    this.peer = input.peer;
    this.limits = input.limits ?? LAN_SOURCE_LIMITS;
    this.now = input.now ?? Date.now;
    this.updating = input.updating ?? (() => false);
    this.budgets = new LanSourceBudgets(this.limits, this.now);
    this.signature = this.policy.signature();
    this.lastTick = Date.now();
    this.watchdog = setInterval(() => this.watch(), input.watchMs ?? 500);
    this.watchdog.unref();
  }

  /** Opt-out, a network change or a wake ends every generation; nothing rebinds by itself. */
  private watch() {
    const tick = Date.now();
    const slept = tick - this.lastTick > 5_000;
    this.lastTick = tick;
    if (this.live.size === 0) {
      this.signature = this.policy.signature();
      return;
    }
    if (!this.enabled()) return this.endAll("setting_off");
    if (slept) return this.endAll("woke");
    const signature = this.policy.signature();
    if (signature !== this.signature) {
      this.signature = signature;
      this.endAll("network_changed");
    }
  }

  liveGenerations(): number {
    return this.live.size;
  }

  listenerOf(operationId: string): LanGenerationListener | null {
    return this.live.get(operationId)?.listener ?? null;
  }

  /** Resolves when no exchange is running for the copy. */
  async settled(operationId: string): Promise<void> {
    await this.running.get(operationId);
  }

  /** The destination pulled over Connect: a prompt to try, never an offer by itself. */
  pulled(operationId: string): void {
    if (this.closed || !this.enabled() || this.live.has(operationId)) return;
    if (this.declined.has(operationId) || this.running.has(operationId)) return;
    void this.exchange(operationId).catch(() => false);
  }

  /** The copy ended or was denied on the source: its generation ends with it. */
  ended(operationId: string, cause: LanEndCause = "terminal"): void {
    this.live.get(operationId)?.listener.end(cause);
  }

  endAll(cause: LanEndCause): void {
    for (const { listener } of [...this.live.values()]) listener.end(cause);
  }

  /** Saves the denial first, then ends the generation, so a lost answer changes nothing. */
  async deny(operationId: string, denial: LanDenial): Promise<void> {
    await this.access.lanDeny(operationId, denial);
    this.ended(operationId, "denied");
  }

  close(): void {
    this.closed = true;
    clearInterval(this.watchdog);
    this.endAll("shutdown");
  }

  /** Runs `lanCheck` and `lanOffer` for one copy. False means the copy stays on Connect. */
  exchange(operationId: string): Promise<boolean> {
    const running = this.running.get(operationId);
    if (running) return running;
    const started = this.run(operationId)
      .catch(() => false)
      .finally(() => this.running.delete(operationId));
    this.running.set(operationId, started);
    return started;
  }

  private async usable(operationId: string): Promise<LanSourceState | null> {
    const state = await this.access.lanState(operationId);
    if (
      state === null ||
      state.terminal ||
      state.denial !== null ||
      state.purpose === null ||
      state.mode !== "copy-only"
    )
      return null;
    return state;
  }

  private async run(operationId: string): Promise<boolean> {
    if (this.closed || !this.enabled()) return false;
    const state = await this.usable(operationId);
    if (state === null) return false;
    const interfaces = (await this.policy.eligible())
      .filter((entry) => this.policy.admit(entry.address))
      .slice(0, this.limits.addressesPerOffer);
    if (interfaces.length === 0) return false;
    const others = [...this.live.entries()].filter(([id]) => id !== operationId);
    if (others.length >= this.limits.liveGenerations) return false;
    if (
      others.filter(
        ([, live]) => live.listener.destinationEnvironmentId === state.destinationEnvironmentId,
      ).length >= this.limits.liveGenerationsPerDestination
    )
      return false;
    const now = this.now();
    const issued = state.issued.filter((at) => now - at < 60 * 60_000);
    if (issued.length >= this.limits.generationsPerOperationPerHour) return false;
    // The counter goes up and is saved before anything is sent. The one before it ends now.
    const generation = state.generation + 1;
    await this.access.lanSaveGeneration(operationId, generation, [...issued, now]);
    this.ended(operationId, "rotated");
    const purpose = state.purpose!;
    let answer: FolderCopyLanCheckAnswer;
    try {
      answer = await this.peer.check(state.destinationEnvironmentId, {
        operationId,
        generation,
        purpose,
        candidates: interfaces.map((entry) => ({ host: entry.address })),
      });
    } catch {
      // An older or unreachable destination, or no control route: Connect.
      this.declined.add(operationId);
      return false;
    }
    const accepted = answer.lan;
    if (accepted === null || accepted.generation !== generation) {
      this.declined.add(operationId);
      return false;
    }
    const bound: Array<LanInterface> = [];
    for (const index of new Set(accepted.usable)) {
      const entry = interfaces[index];
      if (entry) bound.push(entry);
    }
    if (bound.length === 0 || this.closed || !this.enabled()) return false;
    if ((await this.usable(operationId)) === null) return false;
    const certificate = createLanCertificate({
      role: "source",
      addresses: bound.map((entry) => entry.address),
      notBefore: new Date(now - 5 * 60_000),
      notAfter: new Date(now + this.limits.absoluteMs + 5 * 60_000),
    });
    const minted = mintLanToken();
    const scopeSha256 = lanScopeSha256({
      sourceProjectId: state.projectId,
      copyRoot: state.folder,
      projectRelativePath: state.projectRelativePath,
      mode: state.mode,
    });
    const environmentId = this.environmentId();
    let bindingSha256 = "";
    let listener: LanGenerationListener;
    try {
      listener = await LanGenerationListener.open({
        operationId,
        generation,
        destinationEnvironmentId: state.destinationEnvironmentId,
        interfaces: bound,
        certificate,
        recipientCertificateSha256: accepted.recipientCertificateSha256,
        tokenSha256: minted.sha256,
        budgets: this.budgets,
        now: this.now,
        onEnd: () => {
          if (this.live.get(operationId)?.listener === listener) this.live.delete(operationId);
        },
        served: {
          hello: () => ({
            version: 1,
            environmentId,
            operationId,
            generation,
            bindingSha256,
            maxBatchChunks: MAX_BATCH_CHUNKS_LARGE,
          }),
          manifest: () => this.access.lanManifest(operationId),
          chunks: (hashes, zstd) => this.access.lanChunks(operationId, hashes, zstd),
          denial: () => this.denialOf(operationId),
          updating: this.updating,
        },
      });
    } catch {
      // A bind that fails (or a firewall that refuses it) means no offer.
      return false;
    }
    const expiresAt = listener.expiresAt;
    bindingSha256 = lanBindingSha256({
      sourceEnvironmentId: environmentId,
      destinationEnvironmentId: state.destinationEnvironmentId,
      operationId,
      purpose,
      scopeSha256,
      targetSha256: accepted.targetSha256,
      generation,
      expiresAt,
      sourceCertificateSha256: certificate.sha256,
      recipientCertificateSha256: accepted.recipientCertificateSha256,
    });
    this.live.set(operationId, { listener, rootIdentity: await identityOf(state.folder) });
    let taken = false;
    try {
      taken = await this.peer.offer(state.destinationEnvironmentId, {
        operationId,
        lan: {
          version: 1,
          generation,
          purpose,
          expiresAt,
          addresses: [...listener.addresses],
          sourceCertificateSha256: certificate.sha256,
          recipientCertificateSha256: accepted.recipientCertificateSha256,
          scopeSha256,
          targetSha256: accepted.targetSha256,
          lanToken: minted.token,
          bindingSha256,
        },
      });
    } catch {
      taken = false;
    }
    if (!taken || (await this.usable(operationId)) === null) {
      listener.end("terminal");
      return false;
    }
    return listener.ended === null;
  }

  /** The denial on the operation's record; a changed source root is recorded as one first. */
  private async denialOf(operationId: string): Promise<LanDenial | null> {
    const state = await this.access.lanState(operationId);
    if (state === null || state.terminal) return state?.denial ?? "revoked";
    if (state.denial !== null) return state.denial;
    const live = this.live.get(operationId);
    if (live && live.rootIdentity !== (await identityOf(state.folder))) {
      await this.deny(operationId, "scope_changed");
      return "scope_changed";
    }
    return null;
  }
}
