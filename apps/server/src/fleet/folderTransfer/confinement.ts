// @effect-diagnostics nodeBuiltinImport:off - Reads folder ownership, permission bits and ACLs before Apply writes.
import * as NodeChildProcess from "node:child_process";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Destination path confinement. Apply changes a folder only when nobody but the
 * app's user (and root) can add, rename or replace an entry in any folder on the
 * way to it: with that holding on the whole chain, no other local user can point
 * a checked path somewhere else before the write. The check establishes exclusive
 * control; it does not merely look at identities. Root, Administrators and the
 * app's own user are outside this promise.
 */

export type ConfinementReason =
  | "link-in-path"
  | "not-a-folder"
  | "not-owned"
  | "group-writable"
  | "other-writable"
  | "acl-entry"
  | "acl-unreadable";

/** The reason as the person reads it, after "the folder is". */
export const CONFINEMENT_REASON_TEXT: Record<ConfinementReason, string> = {
  "link-in-path": "a link or reparse point",
  "not-a-folder": "not a folder",
  "not-owned": "not owned by you",
  "group-writable": "writable by group",
  "other-writable": "writable by others",
  "acl-entry": "open to another user through an ACL entry",
  "acl-unreadable": "one whose access list could not be read",
};

type Stat = NodeFS.BigIntStats;

/** What the permission bits do not say about a folder. */
export interface FolderAccess {
  /** Windows only, where the stat carries no owner: who owns the folder. */
  readonly owner?: "user" | "trusted" | "other";
  /** Another principal may write, append, delete, delete a child or change permissions. */
  readonly othersMayWrite: boolean;
  /**
   * Windows only: another principal may remove or re-permission entries. Above
   * the target that is what counts: the right to add a folder to a drive's root,
   * which every user has, cannot rename one that exists.
   */
  readonly othersMayReplace?: boolean;
  /** Windows only: a reparse point that the stat does not report as a link. */
  readonly reparsePoint?: boolean;
}

/** Where confinement reads the file system; tests stand in another owner or identity here. */
export interface ConfinementSeam {
  readonly platform: NodeJS.Platform;
  /** The app's user. */
  readonly uid: number;
  /** Never follows a link. Null when nothing is there. */
  readonly lstat: (path: string) => Promise<Stat | null>;
  /** Access beyond permission bits, per path. A missing answer means it could not be read. */
  readonly access: (paths: ReadonlyArray<string>) => Promise<ReadonlyMap<string, FolderAccess>>;
}

const WRITE_RIGHTS = new Set([
  "write",
  "append",
  "delete",
  "delete_child",
  "add_file",
  "add_subdirectory",
  "writesecurity",
  "chown",
]);

/**
 * True when an `ls -lde` listing of one folder holds an allow entry that lets a
 * principal other than `user` change the folder. Deny entries only take rights away.
 */
export function darwinAclGrantsOthers(listing: string, user: string): boolean {
  for (const line of listing.split("\n")) {
    const entry = /^\s*\d+:\s+(.+?)\s+(?:inherited\s+)?(allow|deny)\s+(.*)$/.exec(line);
    if (!entry || entry[2] !== "allow" || entry[1] === `user:${user}`) continue;
    if (entry[3]!.split(",").some((right) => WRITE_RIGHTS.has(right.trim()))) return true;
  }
  return false;
}

/** SYSTEM, Administrators and TrustedInstaller, as SDDL writes them. */
const WINDOWS_TRUSTED = new Set([
  "SY",
  "BA",
  "S-1-5-18",
  "S-1-5-32-544",
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);
/** Creator owner and owner rights stand for whoever owns the entry, checked separately. */
const WINDOWS_OWNER_ALIASES = new Set(["CO", "OW"]);

const SDDL_RIGHTS: Record<string, bigint> = {
  GA: 0x10000000n,
  GW: 0x40000000n,
  FA: 0x1f01ffn,
  FW: 0x120116n,
  SD: 0x10000n,
  WD: 0x40000n,
  WO: 0x80000n,
  DC: 0x2n,
  LC: 0x4n,
  DT: 0x40n,
};
/** Delete child, delete, change permissions, take ownership, generic all: enough to swap an entry. */
const WINDOWS_REPLACE_MASK = 0x40n | 0x10000n | 0x40000n | 0x80000n | 0x10000000n;
/** Those, and add file, add subfolder and generic write. */
const WINDOWS_WRITE_MASK = WINDOWS_REPLACE_MASK | 0x2n | 0x4n | 0x40000000n;

function sddlMask(rights: string): bigint {
  if (/^0x[0-9a-f]+$/i.test(rights)) return BigInt(rights);
  let mask = 0n;
  for (let index = 0; index + 1 < rights.length; index += 2)
    mask |= SDDL_RIGHTS[rights.slice(index, index + 2)] ?? 0n;
  return mask;
}

/** Owner and effective write grants from a folder's security descriptor (SDDL). */
export function windowsAccess(
  sddl: string,
  userSid: string,
): {
  readonly owner: "user" | "trusted" | "other";
  readonly othersMayWrite: boolean;
  readonly othersMayReplace: boolean;
} {
  const ownerSid = /^O:(S-[\d-]+|[A-Z]{2})/.exec(sddl)?.[1] ?? "";
  const owner = ownerSid === userSid ? "user" : WINDOWS_TRUSTED.has(ownerSid) ? "trusted" : "other";
  let othersMayWrite = false;
  let othersMayReplace = false;
  for (const ace of sddl.matchAll(/\(([^)]*)\)/g)) {
    const [type, flags, rights, , , sid] = ace[1]!.split(";");
    // Allow entries only; an inherit-only entry applies to children, which are checked themselves.
    if (!["A", "OA", "XA", "ZA"].includes(type ?? "") || (flags ?? "").includes("IO")) continue;
    if (sid === userSid || WINDOWS_TRUSTED.has(sid ?? "") || WINDOWS_OWNER_ALIASES.has(sid ?? ""))
      continue;
    const mask = sddlMask(rights ?? "");
    if ((mask & WINDOWS_WRITE_MASK) !== 0n) othersMayWrite = true;
    if ((mask & WINDOWS_REPLACE_MASK) !== 0n) othersMayReplace = true;
  }
  return { owner, othersMayWrite, othersMayReplace };
}

function run(command: string, args: ReadonlyArray<string>, input = ""): Promise<string> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(command, args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    // A path that vanished makes `ls` exit non-zero; what it did list still counts.
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

const ACCESS_BATCH = 200;

async function darwinAccess(paths: ReadonlyArray<string>): Promise<Map<string, FolderAccess>> {
  const user = NodeOS.userInfo().username;
  const result = new Map<string, FolderAccess>();
  for (let start = 0; start < paths.length; start += ACCESS_BATCH) {
    const batch = paths.slice(start, start + ACCESS_BATCH);
    const output = await run("/bin/ls", ["-lde", "--", ...batch]);
    let current: string | null = null;
    let lines: Array<string> = [];
    const close = () => {
      if (current !== null)
        result.set(current, { othersMayWrite: darwinAclGrantsOthers(lines.join("\n"), user) });
    };
    for (const line of output.split("\n")) {
      if (/^\s+\d+:\s/.test(line)) {
        lines.push(line);
        continue;
      }
      close();
      lines = [];
      // The folder a heading names: the longest asked path the line ends with.
      current =
        batch.filter((path) => line.endsWith(` ${path}`)).sort((a, b) => b.length - a.length)[0] ??
        null;
    }
    close();
  }
  return result;
}

const WINDOWS_SCRIPT = [
  "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "[Console]::InputEncoding=[Text.Encoding]::UTF8",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "while(($p=[Console]::In.ReadLine()) -ne $null){",
  "try{$i=Get-Item -LiteralPath $p -Force -ErrorAction Stop;",
  "$s=(Get-Acl -LiteralPath $p -ErrorAction Stop).Sddl;",
  '[Console]::Out.WriteLine("ok`t$sid`t$([int]$i.Attributes)`t$s")}',
  'catch{[Console]::Out.WriteLine("fail")}}',
].join("\n");
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

async function windowsAccessOf(paths: ReadonlyArray<string>): Promise<Map<string, FolderAccess>> {
  const result = new Map<string, FolderAccess>();
  const output = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT],
    paths.map((path) => `${path}\n`).join(""),
  );
  const lines = output.split(/\r?\n/);
  paths.forEach((path, index) => {
    const [state, sid, attributes, sddl] = (lines[index] ?? "").split("\t");
    if (state !== "ok" || !sid || !sddl) return;
    result.set(path, {
      ...windowsAccess(sddl, sid),
      reparsePoint: (Number(attributes) & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
    });
  });
  return result;
}

const lstatOrNull = (path: string): Promise<Stat | null> =>
  NodeFSP.lstat(path, { bigint: true }).catch((cause: unknown) => {
    // Below a file there is nothing either.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw cause;
  });

function defaultSeam(overrides: Partial<ConfinementSeam> = {}): ConfinementSeam {
  const platform = overrides.platform ?? process.platform;
  return {
    platform,
    uid: overrides.uid ?? process.getuid?.() ?? -1,
    lstat: overrides.lstat ?? lstatOrNull,
    access:
      overrides.access ??
      (platform === "darwin"
        ? darwinAccess
        : platform === "win32"
          ? windowsAccessOf
          : // A POSIX ACL's mask is the group permission bits: no entry grants more than they show.
            async (paths) => new Map(paths.map((path) => [path, { othersMayWrite: false }]))),
  };
}

export interface ConfinementFailure {
  /** Relative to the target (`.` is the target itself) on the chain; absolute above it. */
  readonly folder: string;
  readonly reason: ConfinementReason;
}

/** One reading of a chain: the first folder that fails, and each folder's identity. */
export interface ChainReading {
  readonly failure: ConfinementFailure | null;
  /** Device and file id of every folder read, by target-relative path. */
  readonly identities: ReadonlyMap<string, string>;
}

const identityOf = (stat: Stat) => `${stat.dev}:${stat.ino}`;
const MAX_LINK_HOPS = 40;

export class Confinement {
  private readonly seam: ConfinementSeam;
  /** Access answers by folder state: an ACL change moves the change time. */
  private readonly accessCache = new Map<string, FolderAccess | null>();

  private readonly root: string;

  constructor(root: string, overrides?: Partial<ConfinementSeam>) {
    this.root = root;
    this.seam = defaultSeam(overrides);
  }

  private accessKey(path: string, stat: Stat) {
    return `${path}\0${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mode}:${stat.uid}`;
  }

  private async accessOf(path: string, stat: Stat): Promise<FolderAccess | null> {
    const key = this.accessKey(path, stat);
    if (!this.accessCache.has(key))
      this.accessCache.set(key, (await this.seam.access([path])).get(path) ?? null);
    return this.accessCache.get(key) ?? null;
  }

  /** Reads access for many folders in as few calls as the platform allows. */
  async prime(paths: ReadonlyArray<string>): Promise<void> {
    const asked: Array<readonly [string, string]> = [];
    for (const path of new Set(paths)) {
      const stat = await this.seam.lstat(path);
      if (!stat?.isDirectory()) continue;
      const key = this.accessKey(path, stat);
      if (!this.accessCache.has(key)) asked.push([path, key]);
    }
    if (asked.length === 0) return;
    const answers = await this.seam.access(asked.map(([path]) => path));
    for (const [path, key] of asked) this.accessCache.set(key, answers.get(path) ?? null);
  }

  /**
   * Why `path` is not the user's alone, or null. `above` is a folder over the
   * target: root may own it too, and a sticky one may be writable by others when
   * the entry used in it (`next`) is an existing folder the user owns.
   */
  private async judge(
    path: string,
    stat: Stat,
    above: { readonly next: Stat | null } | null,
  ): Promise<ConfinementReason | null> {
    if (stat.isSymbolicLink()) return "link-in-path";
    if (!stat.isDirectory()) return "not-a-folder";
    const access = await this.accessOf(path, stat);
    if (access === null) return "acl-unreadable";
    if (access.reparsePoint) return "link-in-path";
    if (this.seam.platform === "win32") {
      // Administrators are outside the threat model, and an elevated user's folders belong to that group.
      if (access.owner === undefined || access.owner === "other") return "not-owned";
    } else {
      const uid = Number(stat.uid);
      if (uid !== this.seam.uid && !(above && uid === 0)) return "not-owned";
      const mode = Number(stat.mode);
      const next = above?.next;
      const stickyHolds =
        (mode & 0o1000) !== 0 &&
        next !== null &&
        next !== undefined &&
        next.isDirectory() &&
        Number(next.uid) === this.seam.uid;
      if (!stickyHolds) {
        if (mode & 0o002) return "other-writable";
        if (mode & 0o020) return "group-writable";
      }
    }
    const open = above ? (access.othersMayReplace ?? access.othersMayWrite) : access.othersMayWrite;
    return open ? "acl-entry" : null;
  }

  /**
   * Root anchoring: every folder above the target is one that no other user can
   * rename entries in, so nobody can swap the target itself. A link on the way is
   * followed only when its own folder passed, and the folders it names are checked too.
   */
  async anchor(): Promise<ConfinementFailure | null> {
    const resolved = NodePath.resolve(this.root);
    const start = NodePath.parse(resolved).root;
    let pending = resolved.slice(start.length).split(NodePath.sep).filter(Boolean);
    let current = start;
    let hops = 0;
    for (;;) {
      const stat = await this.seam.lstat(current);
      if (!stat) return null;
      const part = pending[0];
      // The target itself is the first folder of the chain, judged there.
      if (part === undefined) return null;
      const child = NodePath.join(current, part);
      const next = await this.seam.lstat(child);
      const reason = await this.judge(current, stat, { next });
      if (reason) return { folder: current, reason };
      // Missing from here down: Add creates the rest, inside a folder that just passed.
      if (!next) return null;
      pending = pending.slice(1);
      if (!next.isSymbolicLink()) {
        current = child;
        continue;
      }
      // The folder holding the link passed, so only its owner or root could have put it there.
      if (
        this.seam.platform === "win32" ||
        (Number(next.uid) !== this.seam.uid && Number(next.uid) !== 0)
      )
        return { folder: child, reason: "link-in-path" };
      hops += 1;
      if (hops > MAX_LINK_HOPS) return { folder: child, reason: "link-in-path" };
      const named = NodePath.resolve(current, await NodeFSP.readlink(child));
      const namedRoot = NodePath.parse(named).root;
      pending = [...named.slice(namedRoot.length).split(NodePath.sep).filter(Boolean), ...pending];
      current = namedRoot;
    }
  }

  /** The folders an entry at `relative` is written through: the target, then each parent. */
  folders(relative: string): Array<readonly [string, string]> {
    const parts = relative === "." ? [] : relative.split("/").slice(0, -1);
    const result: Array<readonly [string, string]> = [[".", this.root]];
    let current = this.root;
    let prefix = "";
    for (const part of parts) {
      current = NodePath.join(current, part);
      prefix = prefix ? `${prefix}/${part}` : part;
      result.push([prefix, current]);
    }
    return result;
  }

  /**
   * The exclusive-control rule for an entry at `relative`: every folder from the
   * target down to the one holding it. Stops at a folder that does not exist yet
   * (Apply makes it, private), or one in `replaced` that Apply is about to replace.
   * `memo` shares one reading of each folder across the entries of a preflight.
   */
  async chain(
    relative: string,
    replaced?: ReadonlySet<string>,
    memo?: Map<string, ConfinementFailure | string | null>,
  ): Promise<ChainReading> {
    const identities = new Map<string, string>();
    for (const [prefix, path] of this.folders(relative)) {
      let verdict = memo?.get(prefix);
      if (verdict === undefined) {
        const stat = await this.seam.lstat(path);
        if (!stat || (!stat.isDirectory() && replaced?.has(prefix))) verdict = null;
        else {
          const reason = await this.judge(path, stat, null);
          verdict = reason ? { folder: prefix, reason } : identityOf(stat);
        }
        memo?.set(prefix, verdict);
      }
      if (verdict === null) break;
      if (typeof verdict !== "string") return { failure: verdict, identities };
      identities.set(prefix, verdict);
    }
    return { failure: null, identities };
  }

  /** The first folder that is no longer the one read before, or null. */
  static moved(before: ChainReading, after: ChainReading): string | null {
    for (const [prefix, identity] of before.identities)
      if (after.identities.get(prefix) !== identity) return prefix;
    return null;
  }
}
