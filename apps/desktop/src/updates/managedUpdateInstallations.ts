// @effect-diagnostics nodeBuiltinImport:off -- This desktop adapter reads owned installation receipts and invokes the bundled Python authority.
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { ManagedUpdateError, ManagedUpdateStatus } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { MAC_SERVICE_UPDATER_FILES } from "../../../../scripts/lib/studio-service-updater.ts";

import type { AttachedLocalService } from "../backend/DesktopLocalService.ts";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const LEGACY_POLICIES: Readonly<Record<string, string>> = {
  m4: "browser-cookie",
  m1: "worker-relay",
  m3: "worker-relay",
};

export interface ManagedInstallationOwner {
  readonly uid: number;
  readonly user: string;
  readonly homeDirectory: string;
}

export interface ManagedLocalInstallation {
  readonly installationId: string;
  readonly studioHome: string;
  readonly stateDir: string;
  readonly release: string;
  readonly port: number;
  readonly version: string | null;
}

/** The account database, not HOME or a receipt, selects the owner. */
export function managedInstallationOwner(homeDirectory: string): ManagedInstallationOwner {
  const account = OS.userInfo();
  if (
    account.uid <= 0 ||
    process.getuid?.() !== account.uid ||
    process.geteuid?.() !== account.uid ||
    homeDirectory !== account.homedir ||
    FS.realpathSync(homeDirectory) !== homeDirectory
  ) {
    throw new ManagedUpdateError({ code: "unauthorized" });
  }
  return { uid: account.uid, user: account.username, homeDirectory };
}

export function isManagedInstallationId(value: string): boolean {
  return SLUG.test(value) && value !== "stage" && value !== "backups";
}

/** Receipt parsing supplies a candidate, never update or consent authority. */
export function parseManagedLocalInstallation(
  text: string,
  installationId: string,
  owner: ManagedInstallationOwner,
): ManagedLocalInstallation | null {
  if (!isManagedInstallationId(installationId) || !Number.isInteger(owner.uid) || owner.uid <= 0) {
    return null;
  }
  try {
    const record = JSON.parse(text) as Record<string, unknown>;
    const home = Path.join(owner.homeDirectory, ".specweave-studio", installationId);
    const service = record.service as Record<string, unknown> | undefined;
    const legacyPolicy = Object.hasOwn(LEGACY_POLICIES, installationId)
      ? LEGACY_POLICIES[installationId]
      : undefined;
    const policy = record.webSessionPolicy ?? legacyPolicy;
    const suffix = legacyPolicy === undefined ? `-${installationId}` : "";
    if (
      record.schemaVersion !== 1 ||
      record.identity !== installationId ||
      record.uid !== owner.uid ||
      record.user !== owner.user ||
      record.studioHome !== home ||
      record.stateDir !== Path.join(home, "userdata") ||
      record.cliWrapper !==
        Path.join(owner.homeDirectory, ".local", "bin", `specweave-studio${suffix}`) ||
      service?.installed !== true ||
      service.label !== `com.specweave.studio.${installationId}` ||
      service.domain !== `gui/${owner.uid}` ||
      record.host !== "127.0.0.1" ||
      typeof record.port !== "number" ||
      !Number.isInteger(record.port) ||
      record.port < 1024 ||
      record.port > 65535 ||
      (policy !== "browser-cookie" && policy !== "worker-relay") ||
      (legacyPolicy !== undefined && policy !== legacyPolicy) ||
      typeof record.archiveSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.archiveSha256) ||
      record.release !==
        Path.join(
          owner.homeDirectory,
          ".local",
          "share",
          "specweave-studio",
          "releases",
          record.archiveSha256.slice(0, 20),
        )
    )
      return null;
    return {
      installationId,
      studioHome: home,
      stateDir: Path.join(home, "userdata"),
      release: record.release,
      port: record.port,
      version: typeof record.version === "string" ? record.version : null,
    };
  } catch {
    return null;
  }
}

/** Read-only receipt discovery rejects symlink/foreign-owned components. */
export function isOwnedManagedPath(path: string, owner: ManagedInstallationOwner): boolean {
  const relative = Path.relative(owner.homeDirectory, path);
  if (Path.resolve(path) !== path || relative.startsWith("..") || Path.isAbsolute(relative))
    return false;
  let current = owner.homeDirectory;
  try {
    for (const part of ["", ...relative.split(Path.sep).filter(Boolean)]) {
      current = part === "" ? current : Path.join(current, part);
      const info = FS.lstatSync(current);
      if (
        info.isSymbolicLink() ||
        info.uid !== owner.uid ||
        (current !== path && !info.isDirectory())
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function findManagedUpdateInstallations(
  owner: ManagedInstallationOwner,
): ReadonlyArray<ManagedLocalInstallation> {
  const root = Path.join(owner.homeDirectory, ".specweave-studio");
  if (!isOwnedManagedPath(root, owner)) return [];
  const found: ManagedLocalInstallation[] = [];
  for (const id of FS.readdirSync(root).sort()) {
    if (!isManagedInstallationId(id)) continue;
    const receipt = Path.join(root, id, "installation.json");
    if (!isOwnedManagedPath(receipt, owner)) continue;
    try {
      const info = FS.statSync(receipt);
      if (!info.isFile() || info.size > 64 * 1024) continue;
      const installation = parseManagedLocalInstallation(
        FS.readFileSync(receipt, "utf8"),
        id,
        owner,
      );
      if (installation !== null) found.push(installation);
    } catch {
      /* A disappearing or unreadable candidate is not an installation. */
    }
  }
  return found;
}

/** Exact attached service only: discovery order and display labels are never identity. */
export function selectAttachedManagedInstallation(
  installations: ReadonlyArray<ManagedLocalInstallation>,
  service: AttachedLocalService,
  target: { readonly installationId: string; readonly environmentId: string },
): ManagedLocalInstallation {
  const matches = installations.filter(
    (value) =>
      value.installationId === target.installationId && value.studioHome === service.baseDir,
  );
  const installation = matches.length === 1 ? matches[0] : undefined;
  if (
    installation === undefined ||
    target.environmentId !== service.descriptor.environmentId ||
    service.descriptor.platform.os !== "darwin" ||
    !service.runtime.serviceManaged ||
    service.runtime.port !== installation.port ||
    service.runtime.origin !== `http://127.0.0.1:${installation.port}` ||
    service.httpBaseUrl.origin !== service.runtime.origin ||
    service.httpBaseUrl.pathname !== "/" ||
    service.httpBaseUrl.username !== "" ||
    service.httpBaseUrl.password !== "" ||
    service.httpBaseUrl.search !== "" ||
    service.httpBaseUrl.hash !== ""
  )
    throw new ManagedUpdateError({ code: "binding-changed" });
  return installation;
}

export interface ManagedUpdateControllerIdentity {
  readonly sessionId: string;
  readonly subject: string;
}

/**
 * Extract metadata only from DesktopLocalService's main-process bearer. This is not
 * signature verification: the helper checks the exact active persisted session again.
 */
export function controllerFromAttachedBearer(
  token: string,
  nowMs: number,
): ManagedUpdateControllerIdentity {
  try {
    if (token.length > 16 * 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
      throw new Error();
    const claims = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));
    if (
      (claims.v !== 1 && claims.v !== 2) ||
      claims.kind !== "session" ||
      claims.method !== "bearer-access-token" ||
      typeof claims.sid !== "string" ||
      !claims.sid.trim() ||
      claims.sid.length > 256 ||
      typeof claims.sub !== "string" ||
      !claims.sub.trim() ||
      claims.sub.length > 256 ||
      !Array.isArray(claims.scopes) ||
      !claims.scopes.includes("environment:maintain") ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= nowMs
    )
      throw new Error();
    return { sessionId: claims.sid, subject: claims.sub };
  } catch {
    throw new ManagedUpdateError({ code: "unauthorized" });
  }
}

export interface LocalManagedUpdateInvocation {
  readonly action: "enroll-local" | "revoke-local";
  readonly environmentId: string;
  readonly controller: ManagedUpdateControllerIdentity;
  readonly input: {
    readonly installationId: string;
    readonly environmentId: string;
    readonly expectedRevision: number;
    readonly consent?: true;
  };
  readonly approval: {
    readonly kind: "native-owner";
    readonly confirmed: true;
    readonly installationId: string;
    readonly environmentId: string;
    readonly expectedRevision: number;
  };
}

/** Executable imports need trusted ancestors all the way to the filesystem root. */
function isTrustedHelperDirectory(directory: string, owner: ManagedInstallationOwner): boolean {
  if (Path.resolve(directory) !== directory || FS.realpathSync(directory) !== directory)
    return false;
  for (let current = directory; ; current = Path.dirname(current)) {
    const info = FS.lstatSync(current);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (info.uid !== owner.uid && info.uid !== 0) ||
      (info.mode & 0o022) !== 0
    )
      return false;
    if (Path.dirname(current) === current) return true;
  }
}

export function selectManagedUpdateHelper(
  candidates: ReadonlyArray<string>,
  owner: ManagedInstallationOwner,
): string | null {
  for (const path of candidates) {
    if (
      !Path.isAbsolute(path) ||
      Path.resolve(path) !== path ||
      /(?:^|[/\\])[^/\\]*\.asar(?:[/\\]|$)/.test(path)
    )
      continue;
    try {
      if (!isTrustedHelperDirectory(Path.dirname(path), owner)) continue;
      const files = new Set<string>([...MAC_SERVICE_UPDATER_FILES, "managed_updates.py"]);
      if (!files.has(Path.basename(path))) continue;
      const valid = [...files].every((name) => {
        const sibling = Path.join(Path.dirname(path), name);
        const stat = FS.lstatSync(sibling);
        if (
          stat.isSymbolicLink() ||
          !stat.isFile() ||
          stat.uid !== owner.uid ||
          (stat.mode & 0o022) !== 0 ||
          FS.realpathSync(sibling) !== sibling
        )
          return false;
        return true;
      });
      if (!valid) continue;
      return path;
    } catch {
      /* Missing helpers remain unsupported; never install implicitly. */
    }
  }
  return null;
}

export function decodeManagedUpdateHelperReply(
  stdout: string,
  failed: boolean,
): ManagedUpdateStatus {
  try {
    if (Buffer.byteLength(stdout) > 64 * 1024) throw new Error();
    const result = JSON.parse(stdout);
    if (result?.ok === false) {
      const error = Schema.decodeSync(ManagedUpdateError)({
        _tag: "ManagedUpdateError",
        code: result.error?.code,
      });
      throw error;
    }
    if (failed || result?.ok !== true) throw new Error();
    return Schema.decodeUnknownSync(ManagedUpdateStatus)(result.status);
  } catch (error) {
    if (Schema.is(ManagedUpdateError)(error)) throw error;
    throw new ManagedUpdateError({ code: "unavailable" });
  }
}

/** Bounded, credential-free argv; the trusted controller metadata goes through stdin. */
export function invokeManagedUpdateHelper(
  script: string,
  installation: ManagedLocalInstallation,
  owner: ManagedInstallationOwner,
  request: LocalManagedUpdateInvocation,
): Promise<ManagedUpdateStatus> {
  return new Promise((resolve, reject) => {
    const child = ChildProcess.execFile(
      "/usr/bin/python3",
      ["-B", "-E", "-s", script, "--state-dir", installation.stateDir],
      {
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        env: {
          HOME: owner.homeDirectory,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
      (error, stdout) => {
        try {
          if (error && "code" in error && error.code === "ENOENT")
            throw new ManagedUpdateError({ code: "unsupported" });
          resolve(decodeManagedUpdateHelperReply(stdout, error !== null));
        } catch (cause) {
          reject(cause);
        }
      },
    );
    child.stdin?.on("error", () => {
      /* execFile reports the child failure without exposing stderr. */
    });
    child.stdin?.end(JSON.stringify(request));
  });
}
