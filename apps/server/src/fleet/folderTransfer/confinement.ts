// @effect-diagnostics globalTimers:off nodeBuiltinImport:off - Reads folder ownership, permission bits and ACLs before Apply writes.
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

/** An entry Apply left out because a folder on the way to it is not the user's alone. */
export interface RefusedEntry {
  readonly path: string;
  /** The folder that failed, relative to the target (`.` is the target itself). */
  readonly folder: string;
  readonly reason: ConfinementReason;
}

export const folderName = (folder: string) => (folder === "." ? "the target folder" : folder);

/** One line per folder and reason, for the person: which folder, why, how much was left out. */
export function refusalLines(refused: ReadonlyArray<RefusedEntry>): Array<string> {
  const counts = new Map<string, { readonly entry: RefusedEntry; count: number }>();
  for (const entry of refused) {
    const key = `${entry.folder}\0${entry.reason}`;
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else counts.set(key, { entry, count: 1 });
  }
  return [...counts.values()].map(
    ({ entry, count }) =>
      `Not copied: ${count === 1 ? "1 entry" : `${count} entries`} in ${folderName(entry.folder)}, because that folder is ${CONFINEMENT_REASON_TEXT[entry.reason]}.`,
  );
}

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
  /**
   * Windows only: what is made in the folder would inherit another principal's
   * right to write. A new entry must be private from its first moment, so such
   * a folder is refused before anything is made in it.
   */
  readonly childrenOpen?: boolean;
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
  /**
   * Makes a folder Apply just created the user's alone where permission bits do
   * not: on Windows an explicit owner and DACL in place of what it inherited.
   */
  readonly secure: (path: string) => Promise<void>;
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

/**
 * False when a listing of one folder marks an ACL (`+` after the permission
 * bits) but holds no entry, or a line that is not an entry this reader knows:
 * what it cannot read it does not call private.
 */
export function darwinListingReadable(listing: string): boolean {
  const [heading = "", ...rest] = listing.split("\n");
  const lines = rest.filter((line) => line.trim().length > 0);
  if (!lines.every((line) => /^\s*\d+:\s+.+?\s+(?:inherited\s+)?(?:allow|deny)\s+\S/.test(line)))
    return false;
  const marked = (heading.split(/\s+/)[0] ?? "").charAt(10) === "+";
  return marked ? lines.length > 0 : true;
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

/** The Administrators group, by alias and by SID. */
const WINDOWS_ADMINISTRATORS = new Set(["BA", "S-1-5-32-544"]);
/** A machine's or domain's built-in administrator account: relative id 500. */
const WINDOWS_BUILT_IN_ADMINISTRATOR = /^S-1-5-21(?:-\d+)+-500$/;

const SDDL_SID = "(?:S-[\\d-]+|[A-Z]{2})";
/** Owner, group, then the DACL's flags and entries; the SACL after it grants nothing. */
const SDDL_SHAPE = new RegExp(
  `^O:(${SDDL_SID})(?:G:${SDDL_SID})?(?:D:([A-Z_]*?)((?:\\([^)]*\\))*))?(?:S:.*)?$`,
);

/**
 * Owner and effective write grants from a folder's security descriptor (SDDL).
 * No DACL at all (a null DACL) lets everyone do everything; a DACL with no
 * entries lets nobody do anything. A descriptor this cannot read counts as open.
 *
 * Windows writes the built-in administrator account as `LA`: that is the user
 * only when the user is that account. What an elevated administrator makes is
 * owned by the Administrators group, so for that user (`elevated`) the group's
 * ownership is their own.
 */
export function windowsAccess(
  sddl: string,
  userSid: string,
  elevated = false,
): {
  readonly owner: "user" | "trusted" | "other";
  readonly othersMayWrite: boolean;
  readonly othersMayReplace: boolean;
  readonly childrenOpen: boolean;
} {
  const shape = SDDL_SHAPE.exec(sddl.trim());
  if (!shape)
    return { owner: "other", othersMayWrite: true, othersMayReplace: true, childrenOpen: true };
  const isUser = (sid: string) =>
    sid === userSid || (sid === "LA" && WINDOWS_BUILT_IN_ADMINISTRATOR.test(userSid));
  const ownerSid = shape[1]!;
  const owner =
    isUser(ownerSid) || (elevated && WINDOWS_ADMINISTRATORS.has(ownerSid))
      ? "user"
      : WINDOWS_TRUSTED.has(ownerSid)
        ? "trusted"
        : "other";
  if (shape[2] === undefined || shape[2].includes("NO_ACCESS_CONTROL"))
    return { owner, othersMayWrite: true, othersMayReplace: true, childrenOpen: true };
  let othersMayWrite = false;
  let othersMayReplace = false;
  let childrenOpen = false;
  for (const ace of (shape[3] ?? "").matchAll(/\(([^)]*)\)/g)) {
    const [type, flags, rights, , , sid] = ace[1]!.split(";");
    if (!["A", "OA", "XA", "ZA"].includes(type ?? "")) continue;
    if (isUser(sid ?? "") || WINDOWS_TRUSTED.has(sid ?? "") || WINDOWS_OWNER_ALIASES.has(sid ?? ""))
      continue;
    const mask = sddlMask(rights ?? "");
    const inherited = /CI|OI/.test(flags ?? "");
    // What a new folder or file here would start with, before anything could restrict it.
    if (inherited && (mask & WINDOWS_WRITE_MASK) !== 0n) childrenOpen = true;
    // An inherit-only entry says nothing about the folder itself.
    if ((flags ?? "").includes("IO")) continue;
    if ((mask & WINDOWS_WRITE_MASK) !== 0n) othersMayWrite = true;
    if ((mask & WINDOWS_REPLACE_MASK) !== 0n) othersMayReplace = true;
  }
  return { owner, othersMayWrite, othersMayReplace, childrenOpen };
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  input = "",
): Promise<{ readonly output: string; readonly ok: boolean }> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(command, args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve({ output: "", ok: false }));
    child.on("close", (code) =>
      resolve({ output: Buffer.concat(chunks).toString("utf8"), ok: code === 0 }),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

const ACCESS_BATCH = 200;

async function darwinAccess(paths: ReadonlyArray<string>): Promise<Map<string, FolderAccess>> {
  const user = NodeOS.userInfo().username;
  const result = new Map<string, FolderAccess>();
  const read = async (batch: ReadonlyArray<string>): Promise<void> => {
    const listed = await run("/bin/ls", ["-lde", "--", ...batch]);
    if (!listed.ok) {
      // One path that cannot be listed fails the call: ask one at a time, and leave that one unread.
      if (batch.length > 1) for (const path of batch) await read([path]);
      return;
    }
    let current: string | null = null;
    let lines: Array<string> = [];
    const close = () => {
      if (current === null) return;
      const listing = lines.join("\n");
      if (darwinListingReadable(listing))
        result.set(current, { othersMayWrite: darwinAclGrantsOthers(listing, user) });
    };
    for (const line of listed.output.split("\n")) {
      if (/^\s+\d+:\s/.test(line)) {
        lines.push(line);
        continue;
      }
      close();
      lines = [line];
      // The folder a heading names: the longest asked path the line ends with.
      current =
        batch.filter((path) => line.endsWith(` ${path}`)).sort((a, b) => b.length - a.length)[0] ??
        null;
    }
    close();
  };
  for (let start = 0; start < paths.length; start += ACCESS_BATCH)
    await read(paths.slice(start, start + ACCESS_BATCH));
  return result;
}

/**
 * File systems where a POSIX ACL cannot grant more than the group permission
 * bits show (its mask is those bits): ext, XFS, Btrfs, tmpfs, overlayfs, ZFS,
 * F2FS, bcachefs. Anywhere else (network, FUSE, FAT) the bits are not known to
 * be the whole story, and the folder reads as unreadable.
 */
const POSIX_MASK_FILE_SYSTEMS = new Set([
  0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0x2fc12fc1, 0xf2f52010, 0xca451a4e,
]);

async function linuxAccess(paths: ReadonlyArray<string>): Promise<Map<string, FolderAccess>> {
  const result = new Map<string, FolderAccess>();
  for (const path of paths) {
    const type = await NodeFSP.statfs(path).then(
      (stat) => Number(stat.type),
      () => null,
    );
    if (type !== null && POSIX_MASK_FILE_SYSTEMS.has(type))
      result.set(path, { othersMayWrite: false });
  }
  return result;
}

const WINDOWS_SCRIPT = [
  "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent()",
  "$sid=$me.User.Value",
  "$role=[System.Security.Principal.WindowsBuiltInRole]::Administrator",
  "$up=[int]([System.Security.Principal.WindowsPrincipal]$me).IsInRole($role)",
  "[Console]::InputEncoding=[Text.Encoding]::UTF8",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "while(($p=[Console]::In.ReadLine()) -ne $null){",
  "try{$i=Get-Item -LiteralPath $p -Force -ErrorAction Stop;",
  "$s=(Get-Acl -LiteralPath $p -ErrorAction Stop).Sddl;",
  '[Console]::Out.WriteLine("ok`t$sid`t$up`t$([int]$i.Attributes)`t$s")}',
  'catch{[Console]::Out.WriteLine("fail")}}',
].join("\n");
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

interface WindowsReader {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  buffer: string;
  /** One per line still owed, oldest first; null when the reader ended before answering. */
  readonly waiting: Array<(line: string | null) => void>;
}
let windowsReader: WindowsReader | null = null;
/** How long one batch of answers may take before the reader counts as gone. */
const WINDOWS_READER_TIMEOUT_MS = 30_000;

/**
 * One PowerShell kept open for the whole process: starting one per reading costs
 * about a second, and a copy reads its folders again after every write. It holds
 * the process open only while an answer is owed.
 */
function windowsReaderSession(): WindowsReader {
  if (windowsReader) return windowsReader;
  const child = NodeChildProcess.spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const made: WindowsReader = { child, buffer: "", waiting: [] };
  const end = () => {
    if (windowsReader === made) windowsReader = null;
    for (const settle of made.waiting.splice(0)) settle(null);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    made.buffer += chunk;
    for (let at = made.buffer.indexOf("\n"); at >= 0; at = made.buffer.indexOf("\n")) {
      const line = made.buffer.slice(0, at).replace(/\r$/, "");
      made.buffer = made.buffer.slice(at + 1);
      made.waiting.shift()?.(line);
    }
  });
  child.stderr.resume();
  child.on("error", end);
  child.on("close", end);
  child.stdin.on("error", end);
  windowsReader = made;
  return made;
}

function holdWindowsReader(reader: WindowsReader, held: boolean): void {
  const parts = [
    reader.child,
    reader.child.stdin,
    reader.child.stdout,
    reader.child.stderr,
  ] as const;
  for (const part of parts) {
    const handle = part as unknown as { ref?: () => void; unref?: () => void };
    if (held) handle.ref?.();
    else handle.unref?.();
  }
}

/** Serialized: answers come back in the order the paths went in. */
let windowsReading: Promise<unknown> = Promise.resolve();

async function windowsLines(paths: ReadonlyArray<string>): Promise<Array<string | null>> {
  const reader = windowsReaderSession();
  holdWindowsReader(reader, true);
  const timer = setTimeout(() => reader.child.kill(), WINDOWS_READER_TIMEOUT_MS);
  try {
    const lines = paths.map(
      () => new Promise<string | null>((resolve) => reader.waiting.push(resolve)),
    );
    // A reader that has already gone settles what waits when the write fails.
    reader.child.stdin.write(paths.map((path) => `${path}\n`).join(""));
    return await Promise.all(lines);
  } finally {
    clearTimeout(timer);
    if (windowsReader === reader) holdWindowsReader(reader, false);
  }
}

async function windowsAccessOf(paths: ReadonlyArray<string>): Promise<Map<string, FolderAccess>> {
  const result = new Map<string, FolderAccess>();
  // A name with a line break in it cannot be asked about, and stays unread.
  const asked = paths.filter((path) => !/[\r\n]/.test(path));
  if (asked.length === 0) return result;
  const reading = windowsReading.then(() => windowsLines(asked));
  windowsReading = reading.catch(() => undefined);
  const lines = await reading.catch(() => asked.map(() => null));
  asked.forEach((path, index) => {
    const [state, sid, elevated, attributes, sddl] = (lines[index] ?? "").split("\t");
    if (state !== "ok" || !sid || !sddl) return;
    result.set(path, {
      ...windowsAccess(sddl, sid, elevated === "1"),
      reparsePoint: (Number(attributes) & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
    });
  });
  return result;
}

let windowsUser: Promise<string> | null = null;

/**
 * Replaces what a new folder inherited with an explicit owner and DACL: the
 * user, SYSTEM and Administrators, and nobody else. A failure shows in the
 * check that follows, which reads the folder's access again.
 */
async function windowsSecure(path: string): Promise<void> {
  windowsUser ??= run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  ]).then((result) => result.output.trim());
  const sid = await windowsUser;
  if (!/^S-[\d-]+$/.test(sid)) return;
  await run("icacls.exe", [path, "/setowner", `*${sid}`]);
  await run("icacls.exe", [
    path,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
  ]);
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
          : platform === "linux"
            ? linuxAccess
            : // Unknown rules: no answer, so every folder reads as unreadable.
              async () => new Map()),
    secure: overrides.secure ?? (platform === "win32" ? windowsSecure : async () => undefined),
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
    // A name that does not exist yet belongs to whoever may add it: no leniency above it.
    const missing = above !== null && above.next === null;
    if (stat.isSymbolicLink()) return "link-in-path";
    if (!stat.isDirectory()) return "not-a-folder";
    const access = await this.accessOf(path, stat);
    if (access === null) return "acl-unreadable";
    if (access.reparsePoint) return "link-in-path";
    if (this.seam.platform === "win32") {
      // Above the target SYSTEM and Administrators may own a folder; inside it only the user.
      if (access.owner === undefined || access.owner === "other") return "not-owned";
      if (!above && access.owner !== "user") return "not-owned";
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
    const open =
      above && !missing
        ? (access.othersMayReplace ?? access.othersMayWrite)
        : access.othersMayWrite || access.childrenOpen === true;
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
      // Followed part by part as the system would. Text that climbs back up is
      // refused: after another link, `..` does not lead where the text suggests.
      const text = await NodeFSP.readlink(child);
      const textRoot = NodePath.parse(text).root;
      const parts = text
        .slice(textRoot.length)
        .split(NodePath.sep)
        .filter((item) => item !== "" && item !== ".");
      if (parts.includes("..")) return { folder: child, reason: "link-in-path" };
      pending = [...parts, ...pending];
      if (textRoot) current = textRoot;
    }
  }

  /**
   * Makes one missing folder under a parent that passed: private from its first
   * moment, secured where bits are not enough, and read back before anything
   * uses it. Returns why it is not the user's alone, or null.
   */
  async create(path: string): Promise<ConfinementReason | null> {
    await NodeFSP.mkdir(path, { mode: 0o700 });
    await this.seam.secure(path);
    const stat = await this.seam.lstat(path);
    return stat ? this.judge(path, stat, null) : "not-a-folder";
  }

  /** The target folder as it reads now: which folder stands there, or null. */
  async rootIdentity(): Promise<string | null> {
    const stat = await this.seam.lstat(this.root);
    return stat ? identityOf(stat) : null;
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

/**
 * Creates `folder` and what is missing above it one part at a time, each private
 * (0700): a recursive mkdir would walk through a link put there meanwhile.
 */
export async function makePrivateFolders(folder: string, create: (part: string) => Promise<void>) {
  const missing: Array<string> = [];
  for (let current = folder; !(await lstatOrNull(current)); current = NodePath.dirname(current)) {
    missing.unshift(current);
    if (NodePath.dirname(current) === current) break;
  }
  for (const part of missing) await create(part);
}
