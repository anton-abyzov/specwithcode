// @effect-diagnostics-next-line nodeBuiltinImport:off - the fleet file needs exclusive create with mode 0600 and an atomic rename.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - a random temp name keeps two writers from sharing one file.
import * as NodeCrypto from "node:crypto";
import {
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { join } from "./nodePath.ts";
import {
  assertManagementTokenCanPair,
  checkIdentity,
  FLEET_CONFIG_FILE,
  type FleetFetch,
  FleetError,
  parseFleetConfig,
  readFleetConfigSource,
} from "./studioFleet.ts";

/**
 * A machine's invitation to join a fleet: its private Tailscale HTTPS address,
 * its pinned environment id and a management token that lets the primary
 * server mint short-lived pairings there. Made by `fleet invite` on that
 * machine and pasted into `fleet add` (or Settings) on the primary.
 */
export interface FleetJoin {
  readonly url: string;
  readonly environmentId: string;
  readonly label: string;
  readonly managementToken: string;
}

export const FLEET_JOIN_PREFIX = "swc-machine-";

export class FleetJoinError extends Error {
  readonly kind: "invalid-code" | "address-in-use" | "id-in-use" | "unknown-machine" | "write";
  constructor(kind: FleetJoinError["kind"]) {
    super(
      {
        "invalid-code":
          "This is not a machine invitation. Make a new line on that machine (Invite this machine in its Settings > Connections, or `fleet invite`) and copy the whole line.",
        "address-in-use": "Another configured machine already uses this address.",
        "id-in-use": "Another configured machine already uses this name.",
        "unknown-machine": "No configured machine has that name.",
        write: "The private machine list could not be saved.",
      }[kind],
    );
    this.kind = kind;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function encodeFleetJoinCode(join: FleetJoin): string {
  const body = JSON.stringify({ v: 1, ...join });
  return FLEET_JOIN_PREFIX + Buffer.from(body, "utf8").toString("base64url");
}

/** Accepts the code with surrounding whitespace or line breaks from a terminal copy. */
export function decodeFleetJoinCode(code: string): FleetJoin {
  const compact = code.replace(/\s+/gu, "");
  if (!compact.startsWith(FLEET_JOIN_PREFIX) || compact.length > 16384)
    throw new FleetJoinError("invalid-code");
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(compact.slice(FLEET_JOIN_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    throw new FleetJoinError("invalid-code");
  }
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    !Object.keys(value).every((key) =>
      ["v", "url", "environmentId", "label", "managementToken"].includes(key),
    ) ||
    typeof value.url !== "string" ||
    typeof value.environmentId !== "string" ||
    typeof value.label !== "string" ||
    typeof value.managementToken !== "string"
  )
    throw new FleetJoinError("invalid-code");
  const join = {
    url: value.url,
    environmentId: value.environmentId,
    label: value.label,
    managementToken: value.managementToken,
  };
  // The same rules as the fleet file: private *.ts.net HTTPS only, no stray characters.
  try {
    const [parsed] = parseFleetConfig({
      version: 1,
      machines: [{ id: "invite", ...join }],
    }).machines;
    return { ...join, url: parsed!.url };
  } catch {
    throw new FleetJoinError("invalid-code");
  }
}

/** A lowercase machine id from its label, unique among `taken`. */
export function fleetMachineIdFor(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40) || "machine";
  const start = /^[a-z0-9]/u.test(base) ? base : `m-${base}`;
  if (!taken.has(start)) return start;
  for (let n = 2; ; n += 1) {
    const candidate = `${start}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Replaces the fleet file through a new owner-only file and a rename, so a
 * reader never sees half a file and the management tokens are never readable
 * by anyone else, even for a moment. A symlink in its place is refused.
 */
export async function writeFleetConfigSource(baseDir: string, value: unknown): Promise<void> {
  parseFleetConfig(value);
  const target = join(baseDir, FLEET_CONFIG_FILE);
  const existing = await NodeFSP.lstat(target).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw new FleetJoinError("write");
  });
  if (existing !== null && !existing.isFile()) throw new FleetJoinError("write");
  const temp = join(
    baseDir,
    `.${FLEET_CONFIG_FILE}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const file = await NodeFSP.open(temp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await NodeFSP.rename(temp, target);
  } catch (error) {
    await NodeFSP.rm(temp, { force: true }).catch(() => undefined);
    throw error instanceof FleetJoinError ? error : new FleetJoinError("write");
  }
}

export interface FleetAddResult {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly environmentId: EnvironmentId;
  /** added: a new machine; updated: a configured machine's address or token changed. */
  readonly change: "added" | "updated";
  /** The machine was configured before at another address. */
  readonly previousUrl?: string;
}

/**
 * Adds the machine an invitation names, or updates the one already configured
 * with its environment id (a machine that moved to a new address keeps its id,
 * label, scopes and the workers allowed on it). The address must answer as
 * that environment before anything is written.
 */
export async function addFleetMachine(input: {
  readonly baseDir: string;
  readonly code: string;
  readonly id?: string | undefined;
  readonly label?: string | undefined;
  readonly fetcher?: FleetFetch;
}): Promise<FleetAddResult> {
  const invite = decodeFleetJoinCode(input.code);
  const source = (await readFleetConfigSource(input.baseDir)) ?? { version: 1, machines: [] };
  parseFleetConfig(source);
  const document = source as Record<string, unknown> & {
    machines: Array<Record<string, unknown>>;
  };
  const descriptor = await checkIdentity(input.fetcher ?? fetch, {
    url: invite.url,
    environmentId: EnvironmentId.make(invite.environmentId),
  });
  const label = (input.label ?? invite.label).trim() || descriptor.label;
  const index = document.machines.findIndex(
    (machine) => machine.environmentId === invite.environmentId,
  );
  const sameUrl = document.machines.findIndex(
    (machine) => typeof machine.url === "string" && new URL(machine.url).origin === invite.url,
  );
  if (sameUrl !== -1 && sameUrl !== index) throw new FleetJoinError("address-in-use");
  // An invitation whose token cannot open sessions there would be saved as
  // "Added" yet never connect, so check it before writing anything.
  const wantedScopes = (
    index !== -1 && Array.isArray(document.machines[index]!.scopes)
      ? document.machines[index]!.scopes
      : AuthStandardClientScopes
  ) as ReadonlyArray<AuthEnvironmentScope>;
  await assertManagementTokenCanPair(
    input.fetcher ?? fetch,
    { url: invite.url, managementToken: invite.managementToken },
    wantedScopes,
  );

  let result: FleetAddResult;
  const machines = [...document.machines];
  if (index !== -1) {
    const previous = machines[index]!;
    const previousUrl = new URL(String(previous.url)).origin;
    const next: Record<string, unknown> = {
      ...previous,
      url: invite.url,
      managementToken: invite.managementToken,
      ...(input.label === undefined ? {} : { label }),
    };
    machines[index] = next;
    result = {
      id: String(next.id),
      label: String(next.label),
      url: invite.url,
      environmentId: EnvironmentId.make(invite.environmentId),
      change: "updated",
      ...(previousUrl === invite.url ? {} : { previousUrl }),
    };
  } else {
    const taken = new Set(document.machines.map((machine) => String(machine.id)));
    if (input.id !== undefined && taken.has(input.id)) throw new FleetJoinError("id-in-use");
    const id = input.id ?? fleetMachineIdFor(label, taken);
    machines.push({
      id,
      label,
      environmentId: invite.environmentId,
      url: invite.url,
      managementToken: invite.managementToken,
    });
    result = {
      id,
      label,
      url: invite.url,
      environmentId: EnvironmentId.make(invite.environmentId),
      change: "added",
    };
  }
  const next = { ...document, machines };
  try {
    parseFleetConfig(next);
  } catch (error) {
    throw error instanceof FleetError ? new FleetJoinError("invalid-code") : error;
  }
  await writeFleetConfigSource(input.baseDir, next);
  return result;
}

/** Removes a configured machine by id or label. Workers allowed there stay until revoked there. */
export async function removeFleetMachine(input: {
  readonly baseDir: string;
  readonly machine: string;
}): Promise<{ readonly id: string; readonly label: string }> {
  const source = await readFleetConfigSource(input.baseDir);
  if (source === null) throw new FleetJoinError("unknown-machine");
  parseFleetConfig(source);
  const document = source as Record<string, unknown> & {
    machines: Array<Record<string, unknown>>;
  };
  const wanted = input.machine.trim().toLowerCase();
  const found = document.machines.find(
    (machine) =>
      String(machine.id) === wanted || String(machine.label).trim().toLowerCase() === wanted,
  );
  if (!found) throw new FleetJoinError("unknown-machine");
  await writeFleetConfigSource(input.baseDir, {
    ...document,
    machines: document.machines.filter((machine) => machine !== found),
  });
  return { id: String(found.id), label: String(found.label) };
}
