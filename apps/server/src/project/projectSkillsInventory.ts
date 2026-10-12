// @effect-diagnostics nodeBuiltinImport:off - pure helpers: hashing and path math with no I/O.
/**
 * Pure join behind the project Skills view: providers' own skill discovery,
 * vskill lockfiles, on-disk content digests and optional `vskill doctor`
 * findings become one row per skill name. No I/O happens here; the gatherer
 * in `projectSkillsScan.ts` supplies every fact.
 *
 * @module project/projectSkillsInventory
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type {
  ProjectSkillDrift,
  ProjectSkillLock,
  ProjectSkillPresence,
  ProjectSkillRow,
  ProjectSkillStatus,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderSkill,
} from "@specweave-studio/contracts";

export interface ProviderSkillSource {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

/** The subset of a `vskill.lock` entry the view uses. */
export interface VskillLockEntry {
  readonly version: string | null;
  readonly sha: string | null;
  readonly tier: string | null;
  readonly source: string | null;
  readonly installedAt: string | null;
  readonly installedPath: string | null;
  readonly files: ReadonlyArray<string> | null;
  readonly pluginDir: boolean;
}

export interface VskillLockSource {
  readonly path: string;
  /** Directory the lockfile sits in; project-scope copies live under it. */
  readonly root: string;
  readonly scope: "project" | "user";
  readonly entries: ReadonlyMap<string, VskillLockEntry>;
}

/** What the gatherer learned about one SKILL.md a provider reported. */
export interface SkillFileFact {
  readonly realPath: string;
  /** vskill's single-file digest of the content, or null when unreadable. */
  readonly digest: string | null;
}

export interface ProjectSkillsJoinInput {
  readonly cwd: string;
  readonly providers: ReadonlyArray<ProviderSkillSource>;
  readonly locks: ReadonlyArray<VskillLockSource>;
  /** Keyed by the path a provider reported. */
  readonly files: ReadonlyMap<string, SkillFileFact>;
  /** Findings from `vskill doctor --json`, keyed by skill name. */
  readonly doctor: ReadonlyMap<string, ReadonlyArray<string>>;
}

/** vskill's `normalizeContent`: drop a BOM and use LF line endings. */
function normalizeSkillContent(content: string): string {
  return content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

/**
 * The digest vskill stores in `vskill.lock` for a single-file skill: SHA-256
 * of the normalized SKILL.md (vskill `src/updater/source-fetcher.ts`,
 * `computeSha(content)`). Some older entries keep only a 12-character prefix.
 */
export function vskillContentSha(content: string): string {
  return NodeCrypto.createHash("sha256").update(normalizeSkillContent(content)).digest("hex");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Parse a `vskill.lock` document; malformed entries are skipped, never fatal. */
export function parseVskillLock(text: string): ReadonlyMap<string, VskillLockEntry> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const skills = (parsed as Record<string, unknown>).skills;
  if (typeof skills !== "object" || skills === null) return undefined;
  const entries = new Map<string, VskillLockEntry>();
  for (const [name, raw] of Object.entries(skills as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || name.trim().length === 0) continue;
    const entry = raw as Record<string, unknown>;
    const files = Array.isArray(entry.files)
      ? entry.files.filter((file): file is string => typeof file === "string")
      : null;
    entries.set(name.trim(), {
      version: stringOrNull(entry.version),
      sha: stringOrNull(entry.sha),
      tier: stringOrNull(entry.tier),
      source: stringOrNull(entry.source),
      installedAt: stringOrNull(entry.installedAt),
      installedPath: stringOrNull(entry.installedPath),
      files,
      pluginDir: entry.pluginDir === true,
    });
  }
  return entries;
}

/**
 * Findings from `vskill doctor --json`, keyed by skill name. The report shape
 * is read tolerantly: an array of findings at the top level or under
 * `problems`, `findings`, `issues` or `checks`, each naming its skill by
 * `name`, `skill` or `skillName` (or a path to its folder or SKILL.md) and
 * describing itself with `message`, `detail`, `description` or its kind.
 * Returns undefined when the output is not such a report.
 */
export function parseVskillDoctorReport(
  stdout: string,
): ReadonlyMap<string, ReadonlyArray<string>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? (["problems", "findings", "issues", "checks"]
          .map((key) => (parsed as Record<string, unknown>)[key])
          .find(Array.isArray) as ReadonlyArray<unknown> | undefined)
      : undefined;
  if (!list) return undefined;
  const byName = new Map<string, Array<string>>();
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const pathValue =
      stringOrNull(record.path) ??
      (Array.isArray(record.paths) ? stringOrNull(record.paths[0]) : null);
    const name =
      stringOrNull(record.name) ??
      stringOrNull(record.skill) ??
      stringOrNull(record.skillName) ??
      (pathValue
        ? NodePath.basename(/skill\.md$/i.test(pathValue) ? NodePath.dirname(pathValue) : pathValue)
        : null);
    if (!name) continue;
    const kind =
      stringOrNull(record.kind) ?? stringOrNull(record.type) ?? stringOrNull(record.code);
    const message =
      stringOrNull(record.message) ??
      stringOrNull(record.detail) ??
      stringOrNull(record.description) ??
      kind;
    if (!message) continue;
    const list = byName.get(name) ?? [];
    if (!list.includes(message)) list.push(message);
    byName.set(name, list);
  }
  return byName;
}

function isInside(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

/** Folder name of a SKILL.md, the name vskill files a skill under. */
function skillFolderName(skillPath: string): string {
  return NodePath.basename(NodePath.dirname(skillPath));
}

/**
 * Locked digests are full SHA-256 hex or a short prefix of one; a match on
 * the prefix is a match.
 */
function digestMatches(locked: string, digest: string): boolean {
  const normalized = locked.toLowerCase();
  return /^[0-9a-f]{8,64}$/.test(normalized) && digest.startsWith(normalized);
}

function lockSupportsDrift(entry: VskillLockEntry): boolean {
  if (entry.pluginDir) return false;
  return entry.files === null || (entry.files.length === 1 && entry.files[0] === "SKILL.md");
}

interface PendingRow {
  name: string;
  description: string | undefined;
  presences: Array<ProjectSkillPresence>;
}

/** Pick the lock entry for a name: the project lock when a copy lives in the project. */
function selectLock(
  name: string,
  presences: ReadonlyArray<ProjectSkillPresence>,
  locks: ReadonlyArray<VskillLockSource>,
  cwd: string,
): { readonly source: VskillLockSource; readonly entry: VskillLockEntry } | undefined {
  const keys = new Set([name, ...presences.map((presence) => skillFolderName(presence.path))]);
  const candidates = locks.flatMap((source) =>
    [...keys].flatMap((key) => {
      const entry = source.entries.get(key);
      return entry ? [{ source, entry }] : [];
    }),
  );
  if (candidates.length === 0) return undefined;
  // A skill nothing loads is the project's own declaration first.
  const hasProjectCopy =
    presences.length === 0 || presences.some((presence) => isInside(cwd, presence.path));
  const preferred = candidates.find((candidate) =>
    hasProjectCopy ? candidate.source.scope === "project" : candidate.source.scope === "user",
  );
  return preferred ?? candidates[0];
}

/** One row per skill name across every provider and lockfile. */
export function buildProjectSkillRows(
  input: ProjectSkillsJoinInput,
): ReadonlyArray<ProjectSkillRow> {
  const pending = new Map<string, PendingRow>();
  for (const provider of input.providers) {
    for (const skill of provider.skills) {
      const row = pending.get(skill.name) ?? {
        name: skill.name,
        description: undefined,
        presences: [],
      };
      row.description ??= skill.description;
      row.presences.push({
        instanceId: provider.instanceId,
        driver: provider.driver,
        label: provider.label,
        path: skill.path,
        scope: skill.scope ?? null,
        enabled: skill.enabled,
      });
      pending.set(skill.name, row);
    }
  }

  // A locked skill no agent loads still gets a row, under its lock key,
  // unless a loaded skill already claimed that key through its folder name.
  // Plugin installs (`pluginDir`) are skipped: their skills load under the
  // plugin's namespace, so the lock key never names a skill an agent lists.
  const claimedKeys = new Set(
    [...pending.values()].flatMap((row) => [
      row.name,
      ...row.presences.map((presence) => skillFolderName(presence.path)),
    ]),
  );
  for (const source of input.locks) {
    for (const [key, entry] of source.entries) {
      if (claimedKeys.has(key) || entry.pluginDir) continue;
      claimedKeys.add(key);
      pending.set(key, { name: key, description: undefined, presences: [] });
    }
  }

  const rows = [...pending.values()].map((row): ProjectSkillRow => {
    const issues: Array<string> = [];
    const facts = row.presences.flatMap((presence) => {
      const fact = input.files.get(presence.path);
      return fact ? [{ presence, fact }] : [];
    });
    const realPaths = new Set(
      row.presences.map((presence) => input.files.get(presence.path)?.realPath ?? presence.path),
    );
    const digests = new Set(
      facts.flatMap(({ fact }) => (fact.digest === null ? [] : [fact.digest])),
    );
    const divergent = digests.size > 1;
    if (divergent) {
      issues.push(`Agents load ${digests.size} different versions of this skill.`);
    } else if (realPaths.size > 1) {
      issues.push(`${realPaths.size} identical copies; a link would keep them in step.`);
    }

    const selected = selectLock(row.name, row.presences, input.locks, input.cwd);
    let drift: ProjectSkillDrift = "unlocked";
    let lock: ProjectSkillLock | null = null;
    if (selected) {
      const { source, entry } = selected;
      lock = {
        lockPath: source.path,
        lockScope: source.scope,
        version: entry.version,
        tier: entry.tier,
        source: entry.source,
        sha: entry.sha,
        installedAt: entry.installedAt,
      };
      // Compare the copies that belong to this lock's scope.
      const scoped = facts.filter(({ presence }) =>
        source.scope === "project"
          ? isInside(source.root, presence.path)
          : !isInside(input.cwd, presence.path),
      );
      const compared = (scoped.length > 0 ? scoped : facts).flatMap(({ fact }) =>
        fact.digest === null ? [] : [fact.digest],
      );
      if (!entry.sha || !lockSupportsDrift(entry)) {
        drift = "unknown";
      } else if (compared.length === 0) {
        drift = "unknown";
      } else if (compared.some((digest) => digestMatches(entry.sha!, digest))) {
        drift = compared.every((digest) => digestMatches(entry.sha!, digest)) ? "match" : "drift";
      } else {
        drift = "drift";
      }
      if (drift === "drift") {
        issues.unshift(
          `SKILL.md changed since vskill installed it (locked sha ${entry.sha!.slice(0, 12)}).`,
        );
      }
    }

    const missing = row.presences.length === 0;
    if (missing) issues.push("A vskill lockfile lists it, but no agent loads it.");
    const enabledCount = row.presences.filter((presence) => presence.enabled).length;
    const disabled = !missing && enabledCount === 0;
    if (disabled) {
      issues.push("Switched off for every agent that sees it.");
    } else if (!missing && enabledCount < row.presences.length) {
      issues.push(
        `Switched off for ${row.presences
          .filter((presence) => !presence.enabled)
          .map((presence) => presence.label)
          .join(", ")}.`,
      );
    }
    const doctor = input.doctor.get(row.name) ?? [];

    const status: ProjectSkillStatus =
      drift === "drift"
        ? "drift"
        : divergent
          ? "duplicate"
          : missing
            ? "missing"
            : disabled
              ? "disabled"
              : "ok";

    // The path most providers load, for copying.
    const pathCounts = new Map<string, number>();
    for (const presence of row.presences) {
      pathCounts.set(presence.path, (pathCounts.get(presence.path) ?? 0) + 1);
    }
    const path =
      [...pathCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ??
      (selected?.entry.installedPath
        ? NodePath.join(selected.entry.installedPath, "SKILL.md")
        : null);

    return {
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      status,
      attention: status !== "ok" || doctor.length > 0,
      issues: [...issues, ...doctor],
      path,
      scopes: [
        ...new Set(row.presences.flatMap((presence) => (presence.scope ? [presence.scope] : []))),
      ].sort(),
      providers: row.presences.toSorted((left, right) => left.label.localeCompare(right.label)),
      lock,
      drift,
      copies: missing ? 0 : realPaths.size,
      divergent,
      doctor,
    };
  });

  return rows.sort((left, right) => left.name.localeCompare(right.name));
}
