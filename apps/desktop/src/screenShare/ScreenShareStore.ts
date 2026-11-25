// @effect-diagnostics globalDate:off -- A plain class outside any Effect fiber; its clock is handed in and only formatted here.
/**
 * What this machine's app keeps for screen sharing (1490): the switch, the
 * devices a person at this machine chose to always allow, the machine's
 * screen-sharing key and the list of past sessions.
 *
 * It lives in the app's main process and nowhere else. The file is sealed
 * (`screenShareSeal.ts`), so one that was edited, replaced or copied from
 * another machine does not open, and what does not open reads as: off, no
 * grants, a new key. Nothing here is reachable through the server, an RPC or a
 * settings file. A process running as this user can still delete the file or
 * put back an older one: the list of past sessions is a record of what remote
 * devices did, not proof against this machine's own programs.
 */
import {
  SCREEN_SHARE_AUDIT_LIMIT,
  SCREEN_SHARE_COOLDOWN_STRIKES,
  SCREEN_SHARE_COOLDOWN_WINDOW_MS,
  SCREEN_SHARE_GRANT_IDLE_MS,
  type ScreenShareAuditEntry,
  type ScreenShareGrant,
} from "@specweave-studio/contracts";
import {
  newScreenShareMachineKey,
  type ScreenShareMachineKey,
} from "@specweave-studio/shared/screenShareChannel";

export interface ScreenShareStoreIo {
  /** The file's bytes, or null when there is none. Throws when it cannot be read. */
  readonly read: () => Uint8Array | null;
  readonly write: (bytes: Uint8Array) => void;
  /** Whether the operating system's encryption is there at all. */
  readonly canSeal: () => boolean;
  readonly seal: (text: string) => Uint8Array;
  readonly unseal: (bytes: Uint8Array) => string;
  readonly now: () => number;
}

interface Stored {
  readonly v: 1;
  readonly enabled: boolean;
  readonly machineKey: ScreenShareMachineKey;
  readonly grants: ReadonlyArray<ScreenShareGrant>;
  readonly audit: ReadonlyArray<ScreenShareAuditEntry>;
  /** Per device thumbprint: when it was refused lately, and until when it is not asked about. */
  readonly strikes: Readonly<Record<string, Strikes>>;
}

interface Strikes {
  readonly at: ReadonlyArray<number>;
  readonly quietUntil: number;
}

const MAX_GRANTS = 50;
const MAX_STRIKE_DEVICES = 200;

const parseStrikes = (value: unknown): Record<string, Strikes> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, Strikes> = {};
  for (const [thumbprint, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { at, quietUntil } = entry as Record<string, unknown>;
    if (Array.isArray(at) && at.every(Number.isFinite) && Number.isFinite(quietUntil))
      out[thumbprint] = { at: at as Array<number>, quietUntil: quietUntil as number };
  }
  return out;
};
const isString = (value: unknown): value is string => typeof value === "string";

const parseGrant = (value: unknown): ScreenShareGrant | null => {
  if (typeof value !== "object" || value === null) return null;
  const grant = value as Record<string, unknown>;
  return isString(grant.thumbprint) &&
    isString(grant.label) &&
    isString(grant.shortId) &&
    isString(grant.grantedAt) &&
    isString(grant.lastUsedAt) &&
    Number.isFinite(Date.parse(grant.lastUsedAt))
    ? {
        thumbprint: grant.thumbprint,
        label: grant.label,
        shortId: grant.shortId,
        grantedAt: grant.grantedAt,
        lastUsedAt: grant.lastUsedAt,
      }
    : null;
};

const parseStored = (text: string): Stored | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const stored = value as Record<string, unknown>;
  const key = stored.machineKey as Record<string, unknown> | undefined;
  if (
    stored.v !== 1 ||
    typeof stored.enabled !== "boolean" ||
    typeof key !== "object" ||
    key === null ||
    !isString(key.secret) ||
    !isString(key.publicKey) ||
    !Array.isArray(stored.grants) ||
    !Array.isArray(stored.audit)
  )
    return null;
  const grants = stored.grants.map(parseGrant);
  // One bad grant spoils the file: a half-read list is not a list a person approved.
  if (grants.some((grant) => grant === null)) return null;
  return {
    v: 1,
    enabled: stored.enabled,
    machineKey: { secret: key.secret, publicKey: key.publicKey },
    grants: grants as ReadonlyArray<ScreenShareGrant>,
    audit: (stored.audit as ReadonlyArray<ScreenShareAuditEntry>).filter(
      (entry) => typeof entry === "object" && entry !== null && isString(entry.id),
    ),
    strikes: parseStrikes(stored.strikes),
  };
};

export class ScreenShareStore {
  private state: Stored;
  private healthy: boolean;
  private readonly io: ScreenShareStoreIo;

  constructor(io: ScreenShareStoreIo) {
    this.io = io;
    const loaded = this.load();
    this.healthy = loaded.healthy;
    this.state = loaded.state;
  }

  private fresh(): Stored {
    return {
      v: 1,
      enabled: false,
      machineKey: newScreenShareMachineKey(),
      grants: [],
      audit: [],
      strikes: {},
    };
  }

  private load(): { readonly state: Stored; readonly healthy: boolean } {
    if (!this.io.canSeal()) return { state: this.fresh(), healthy: false };
    let bytes: Uint8Array | null;
    try {
      bytes = this.io.read();
    } catch {
      return { state: this.fresh(), healthy: false };
    }
    // No file yet is the ordinary first run.
    if (bytes === null) return { state: this.fresh(), healthy: true };
    try {
      const stored = parseStored(this.io.unseal(bytes));
      if (stored !== null) return { state: stored, healthy: true };
    } catch {
      // Falls through: a file that does not open is treated as no file, and said so.
    }
    return { state: this.fresh(), healthy: false };
  }

  /** Writes the next state. When it cannot be written nothing changes: off stays off. */
  private save(next: Stored): boolean {
    if (!this.io.canSeal()) return false;
    try {
      this.io.write(this.io.seal(JSON.stringify(next)));
    } catch {
      return false;
    }
    this.state = next;
    this.healthy = true;
    return true;
  }

  /** False when sharing cannot be kept safely on this machine at all. */
  get supported(): boolean {
    return this.io.canSeal();
  }

  get storeHealthy(): boolean {
    return this.healthy;
  }

  get enabled(): boolean {
    return this.io.canSeal() && this.state.enabled;
  }

  get machineKey(): ScreenShareMachineKey {
    return this.state.machineKey;
  }

  setEnabled(enabled: boolean): boolean {
    return this.save({ ...this.state, enabled });
  }

  private liveGrants(): ReadonlyArray<ScreenShareGrant> {
    const now = this.io.now();
    return this.state.grants.filter(
      (grant) => now - Date.parse(grant.lastUsedAt) < SCREEN_SHARE_GRANT_IDLE_MS,
    );
  }

  get grants(): ReadonlyArray<ScreenShareGrant> {
    return this.liveGrants();
  }

  hasGrant(thumbprint: string): boolean {
    return this.liveGrants().some((grant) => grant.thumbprint === thumbprint);
  }

  /** A person at this machine chose "Always allow" for this device. */
  addGrant(device: {
    readonly thumbprint: string;
    readonly label: string;
    readonly shortId: string;
  }) {
    const at = new Date(this.io.now()).toISOString();
    const others = this.liveGrants().filter((grant) => grant.thumbprint !== device.thumbprint);
    return this.save({
      ...this.state,
      grants: [...others, { ...device, grantedAt: at, lastUsedAt: at }].slice(-MAX_GRANTS),
    });
  }

  touchGrant(thumbprint: string): void {
    const at = new Date(this.io.now()).toISOString();
    this.save({
      ...this.state,
      grants: this.liveGrants().map((grant) =>
        grant.thumbprint === thumbprint ? { ...grant, lastUsedAt: at } : grant,
      ),
    });
  }

  removeGrant(thumbprint: string): boolean {
    return this.save({
      ...this.state,
      grants: this.state.grants.filter((grant) => grant.thumbprint !== thumbprint),
    });
  }

  get audit(): ReadonlyArray<ScreenShareAuditEntry> {
    return this.state.audit;
  }

  /** Adds an entry, or replaces the one with the same id. The newest come last. */
  recordAudit(entry: ScreenShareAuditEntry): void {
    const others = this.state.audit.filter((existing) => existing.id !== entry.id);
    this.save({ ...this.state, audit: [...others, entry].slice(-SCREEN_SHARE_AUDIT_LIMIT) });
  }

  /** True while this device is not to be asked about: it was refused too often lately. */
  inCooldown(thumbprint: string): boolean {
    return (this.state.strikes[thumbprint]?.quietUntil ?? 0) > this.io.now();
  }

  /**
   * Counts a refusal, a prompt nobody answered, a handshake that did not finish
   * or a wrong code. The third within the window starts the quiet time. Kept
   * in the file so restarting the app does not clear it.
   */
  addStrike(thumbprint: string): void {
    const now = this.io.now();
    const recent = [
      ...(this.state.strikes[thumbprint]?.at ?? []).filter(
        (at) => now - at < SCREEN_SHARE_COOLDOWN_WINDOW_MS,
      ),
      now,
    ];
    const quiet = recent.length >= SCREEN_SHARE_COOLDOWN_STRIKES;
    const others = Object.entries(this.state.strikes)
      .filter(
        ([key, entry]) =>
          key !== thumbprint &&
          (entry.quietUntil > now ||
            entry.at.some((at) => now - at < SCREEN_SHARE_COOLDOWN_WINDOW_MS)),
      )
      .slice(-MAX_STRIKE_DEVICES);
    this.save({
      ...this.state,
      strikes: {
        ...Object.fromEntries(others),
        [thumbprint]: {
          at: quiet ? [] : recent,
          quietUntil: quiet
            ? now + SCREEN_SHARE_COOLDOWN_WINDOW_MS
            : (this.state.strikes[thumbprint]?.quietUntil ?? 0),
        },
      },
    });
  }
}
