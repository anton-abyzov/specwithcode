// @effect-diagnostics globalDate:off nodeBuiltinImport:off globalTimers:off - the source's local-network generations and their watchdog.
import * as NodeFSP from "node:fs/promises";

import type {
  FolderCopyLanCheck,
  FolderCopyLanCheckAnswer,
  FolderCopyLanOffer,
  FolderCopyLanProbe,
  FolderCopyLanPurpose,
  FolderCopyLanRetire,
} from "@specweave-studio/contracts";

import { createLanCertificate, recipientAnchorPem } from "./lanCertificate.ts";
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
  /** The approved file classes, saved at the copy's first selection; null before it. */
  readonly ceiling: ReadonlyArray<string> | null;
  /** The source root's identity, saved when the offer was made; null when it was unreadable. */
  readonly rootIdentity: string | null;
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
  /**
   * The decision Connect makes on every request, made here for every local-network
   * read: team rules, the offering device's approval, and the grant's revocation and
   * expiry as they stand now. Null means the read may go on.
   */
  readonly lanAuthorize: (operationId: string, used: boolean) => Promise<LanDenial | null>;
  readonly lanManifest: (
    operationId: string,
  ) => Promise<
    | { readonly ready: true; readonly bytes: Uint8Array }
    | { readonly ready: false; readonly body: unknown }
  >;
  /** Frames for hashes the published manifest names; a hash a later refresh added is unknown. */
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
  /** Support and consent, asked before any address is named. */
  readonly probe: (destinationEnvironmentId: string, body: FolderCopyLanProbe) => Promise<boolean>;
  readonly check: (
    destinationEnvironmentId: string,
    body: FolderCopyLanCheck,
  ) => Promise<FolderCopyLanCheckAnswer>;
  readonly offer: (
    destinationEnvironmentId: string,
    body: { readonly operationId: string; readonly lan: FolderCopyLanOffer },
  ) => Promise<boolean>;
  /** This side's generation ended: the destination ends its own. */
  readonly retire: (destinationEnvironmentId: string, body: FolderCopyLanRetire) => Promise<void>;
}

/** The source root's identity: device and inode. Null when it cannot be read. */
export const lanRootIdentity = (folder: string): Promise<string | null> =>
  NodeFSP.stat(folder).then(
    (stat) => `${stat.dev}:${stat.ino}`,
    () => null,
  );

/** How long a copy that cannot get a listener now is left alone before it is tried again. */
const RETRY_AFTER_MS = 60_000;

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
  private readonly live = new Map<string, LanGenerationListener>();
  private readonly running = new Map<string, Promise<boolean>>();
  /** Copies whose destination answered no; they are not asked again. */
  private readonly declined = new Set<string>();
  /** Copies with no interface or no budget left: not looked at again until this time. */
  private readonly retryAt = new Map<string, number>();
  private readonly denying = new Set<string>();
  private readonly watchdog: ReturnType<typeof setInterval>;
  private signature: string;
  private lastTick: number;
  private auditing = false;
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
      return this.endAll("network_changed");
    }
    void this.audit();
  }

  /**
   * What no event announces, looked at on every tick for each live generation: authority
   * that was withdrawn (team rules, a removed device, an expired grant), a replaced source
   * root, and a route that no longer leaves by the interface a peer came in on.
   */
  private async audit(): Promise<void> {
    if (this.auditing) return;
    this.auditing = true;
    try {
      for (const [operationId, listener] of [...this.live]) {
        if (listener.ended !== null) continue;
        if ((await this.denialOf(operationId, false).catch(() => null)) !== null) continue;
        for (const peer of listener.routes)
          if ((await this.policy.routeInterface(peer.host).catch(() => null)) !== peer.name) {
            listener.end("network_changed");
            break;
          }
      }
    } finally {
      this.auditing = false;
    }
  }

  liveGenerations(): number {
    return this.live.size;
  }

  listenerOf(operationId: string): LanGenerationListener | null {
    return this.live.get(operationId) ?? null;
  }

  /** Addresses remembered for failed handshakes; pruned and capped. */
  get trackedAddresses(): number {
    return this.budgets.tracked;
  }

  /** Resolves when no exchange is running for the copy. */
  async settled(operationId: string): Promise<void> {
    await this.running.get(operationId);
  }

  /** The destination pulled over Connect: a prompt to try, never an offer by itself. */
  pulled(operationId: string): void {
    if (this.closed || !this.enabled() || this.live.has(operationId)) return;
    if (this.declined.has(operationId) || this.running.has(operationId)) return;
    if (this.now() < (this.retryAt.get(operationId) ?? 0)) return;
    void this.exchange(operationId).catch(() => false);
  }

  /** The copy ended or was denied on the source: its generation ends with it. */
  ended(operationId: string, cause: LanEndCause = "terminal"): void {
    // Saving a denial ends the copy; the generation ends for the denial, not for that.
    this.live.get(operationId)?.end(this.denying.has(operationId) ? "denied" : cause);
  }

  /**
   * The destination said its side of this generation ended (a latch, an opt-out, a route
   * change). It can only end the generation it names; it never makes or extends one.
   */
  retired(operationId: string, generation: number): void {
    const listener = this.live.get(operationId);
    if (listener?.generation !== generation) return;
    this.retryAt.set(operationId, this.now() + RETRY_AFTER_MS);
    listener.end("retired");
  }

  endAll(cause: LanEndCause): void {
    for (const listener of [...this.live.values()]) listener.end(cause);
  }

  /** Saves the denial first, then ends the generation, so a lost answer changes nothing. */
  async deny(operationId: string, denial: LanDenial): Promise<void> {
    this.denying.add(operationId);
    try {
      await this.access.lanDeny(operationId, denial);
    } finally {
      this.denying.delete(operationId);
    }
    this.ended(operationId, "denied");
  }

  close(): void {
    this.closed = true;
    clearInterval(this.watchdog);
    this.endAll("shutdown");
  }

  /** Runs `lanProbe`, `lanCheck` and `lanOffer` for one copy. False means the copy stays on Connect. */
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
      state.mode !== "copy-only" ||
      // Nothing is offered before the scope is frozen: the root at the offer, the
      // ceiling at the copy's first selection.
      state.ceiling === null ||
      state.rootIdentity === null
    )
      return null;
    return state;
  }

  private later(operationId: string): false {
    this.retryAt.set(operationId, this.now() + RETRY_AFTER_MS);
    return false;
  }

  private decline(operationId: string): false {
    this.declined.add(operationId);
    return false;
  }

  private async run(operationId: string): Promise<boolean> {
    if (this.closed || !this.enabled()) return false;
    if (this.declined.has(operationId)) return false;
    const state = await this.usable(operationId);
    if (state === null) return false;
    const interfaces = (await this.policy.eligible())
      .filter((entry) => this.policy.admit(entry.address))
      .slice(0, this.limits.addressesPerOffer);
    // No interface, no room and no budget are not asked about again on every pull.
    if (interfaces.length === 0) return this.later(operationId);
    const others = [...this.live.entries()].filter(([id]) => id !== operationId);
    if (others.length >= this.limits.liveGenerations) return this.later(operationId);
    if (
      others.filter(
        ([, listener]) => listener.destinationEnvironmentId === state.destinationEnvironmentId,
      ).length >= this.limits.liveGenerationsPerDestination
    )
      return this.later(operationId);
    const now = this.now();
    const issued = state.issued.filter((at) => now - at < 60 * 60_000);
    if (issued.length >= this.limits.generationsPerOperationPerHour) return this.later(operationId);
    const purpose = state.purpose!;
    const ceiling = state.ceiling!;
    // Support and consent first. No address leaves this machine before a yes.
    let ready = false;
    try {
      ready = await this.peer.probe(state.destinationEnvironmentId, { operationId, purpose });
    } catch {
      // An older or unreachable destination, or no control route: Connect.
      ready = false;
    }
    if (ready !== true) return this.decline(operationId);
    if (this.closed || !this.enabled()) return false;
    // The counter goes up and is saved before anything is sent. The one before it ends now.
    const generation = state.generation + 1;
    await this.access.lanSaveGeneration(operationId, generation, [...issued, now]);
    this.ended(operationId, "rotated");
    let answer: FolderCopyLanCheckAnswer;
    try {
      answer = await this.peer.check(state.destinationEnvironmentId, {
        operationId,
        generation,
        purpose,
        candidates: interfaces.map((entry) => ({ host: entry.address })),
      });
    } catch {
      return this.decline(operationId);
    }
    const accepted = answer.lan;
    if (accepted === null || accepted.generation !== generation) return this.decline(operationId);
    // From here the destination holds a key for this generation. If no listener comes
    // of it, it is told, so the key does not wait out its own idle limit.
    const destination = state.destinationEnvironmentId;
    const abandon = (): false => {
      void this.peer.retire(destination, { operationId, generation }).catch(() => undefined);
      return false;
    };
    const anchor = recipientAnchorPem({
      derBase64: accepted.recipientCertificate,
      sha256: accepted.recipientCertificateSha256,
      now: Date.now(),
      generationMs: this.limits.absoluteMs,
    });
    if (anchor === null) {
      abandon();
      return this.decline(operationId);
    }
    const bound: Array<LanInterface> = [];
    for (const index of new Set(accepted.usable)) {
      const entry = interfaces[index];
      if (entry) bound.push(entry);
    }
    if (bound.length === 0 || this.closed || !this.enabled()) return abandon();
    // Authority and the frozen root as they stand now, before a socket is bound.
    if ((await this.usable(operationId)) === null) return abandon();
    if ((await this.denialOf(operationId, false)) !== null) return abandon();
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
      ceiling,
    });
    const environmentId = this.environmentId();
    let bindingSha256 = "";
    let listener: LanGenerationListener;
    try {
      listener = await LanGenerationListener.open({
        operationId,
        generation,
        destinationEnvironmentId: destination,
        interfaces: bound,
        certificate,
        recipientCertificateSha256: accepted.recipientCertificateSha256,
        recipientCertificatePem: anchor,
        tokenSha256: minted.sha256,
        budgets: this.budgets,
        now: this.now,
        onEnd: (cause) => {
          if (this.live.get(operationId) === listener) this.live.delete(operationId);
          // Both ends close within a second: the destination is told, unless it told us
          // or a newer generation of ours already took this one's place there.
          if (cause !== "rotated" && cause !== "retired")
            void this.peer.retire(destination, { operationId, generation }).catch(() => undefined);
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
          denial: () => this.denialOf(operationId, true),
          updating: this.updating,
        },
      });
    } catch {
      // A bind that fails (or a firewall that refuses it) means no offer.
      abandon();
      return this.later(operationId);
    }
    // Registered before anything else is awaited, so every end signal finds it.
    this.live.set(operationId, listener);
    if (this.closed || !this.enabled()) {
      listener.end("shutdown");
      return false;
    }
    const expiresAt = listener.expiresAt;
    bindingSha256 = lanBindingSha256({
      sourceEnvironmentId: environmentId,
      destinationEnvironmentId: destination,
      operationId,
      purpose,
      scopeSha256,
      targetSha256: accepted.targetSha256,
      generation,
      expiresAt,
      sourceCertificateSha256: certificate.sha256,
      recipientCertificateSha256: accepted.recipientCertificateSha256,
    });
    let taken = false;
    try {
      taken = await this.peer.offer(destination, {
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

  private readonly deciding = new Map<string, Promise<LanDenial | null>>();

  /**
   * Whether this copy may be read now. A denial is saved on the operation first, where
   * Connect reads it too; only then does the generation end and its sockets close.
   */
  private denialOf(operationId: string, used: boolean): Promise<LanDenial | null> {
    const running = this.deciding.get(operationId);
    if (running) return running;
    const decided = this.decide(operationId, used).finally(() => this.deciding.delete(operationId));
    this.deciding.set(operationId, decided);
    return decided;
  }

  private async decide(operationId: string, used: boolean): Promise<LanDenial | null> {
    const state = await this.access.lanState(operationId);
    if (state === null || state.terminal) return state?.denial ?? "revoked";
    if (state.denial !== null) return state.denial;
    const refused =
      (await this.access.lanAuthorize(operationId, used)) ??
      // The root the offer was made for, not whatever stands at its path now.
      (state.rootIdentity === null || state.rootIdentity !== (await lanRootIdentity(state.folder))
        ? "scope_changed"
        : null);
    if (refused === null) return null;
    await this.deny(operationId, refused);
    return refused;
  }
}
