// @effect-diagnostics nodeBuiltinImport:off - pure helpers: hashing and path math with no I/O.
/**
 * Pure join behind the project Skills view: providers' own skill discovery,
 * vskill lockfiles, on-disk content digests and optional `vskill doctor`
 * findings become one row per skill: presences of the same SKILL.md (after
 * resolving links) join first, then rows with the same name. No I/O happens
 * here; the gatherer
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
  /**
   * Digest of the content with Claude-only frontmatter dropped, the way
   * `vskill doctor` compares copies; falls back to {@link digest}.
   */
  readonly comparableDigest?: string | null;
  /** `name` from the frontmatter. */
  readonly frontmatterName?: string | null;
  /** `version` from the frontmatter (top level or under `metadata`). */
  readonly fileVersion?: string | null;
  /** `version` from the manifest of the plugin this file sits in. */
  readonly pluginVersion?: string | null;
}

/** One `vskill doctor --json` finding, keyed to its skill. */
export interface VskillDoctorFinding {
  readonly skill: string;
  readonly kind: string | null;
  readonly message: string;
  /** Agent ids (`claude-code`, `cursor`, ...) the finding is about; empty when not stated. */
  readonly agents: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
}

export interface ProjectSkillsJoinInput {
  readonly cwd: string;
  readonly providers: ReadonlyArray<ProviderSkillSource>;
  readonly locks: ReadonlyArray<VskillLockSource>;
  /** Keyed by the path a provider reported. */
  readonly files: ReadonlyMap<string, SkillFileFact>;
  /** Findings from `vskill doctor --json`. */
  readonly doctor: ReadonlyArray<VskillDoctorFinding>;
  /**
   * Lock entries with a folder on disk, as {@link lockEntryKey}. When given,
   * a locked skill nothing loads and nothing backs is a stale entry.
   */
  readonly lockOnDisk?: ReadonlySet<string>;
}

/** Key for {@link ProjectSkillsJoinInput.lockOnDisk}. */
export function lockEntryKey(lockPath: string, name: string): string {
  return `${lockPath}\u0000${name}`;
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

/** Claude Code-only frontmatter vskill strips for other agents (vskill `stripClaudeFields`). */
const CLAUDE_ONLY_FIELDS = [
  /^user-invoc?k?able\s*:.*\n?/gm,
  /^allowed-tools\s*:.*\n?/gm,
  /^model\s*:.*\n?/gm,
  /^argument-hint\s*:.*\n?/gm,
  /^context\s*:.*\n?/gm,
];

/**
 * The content `vskill doctor` compares when it decides two copies are the
 * same skill: Claude-only frontmatter dropped and a `name` filled in, since
 * vskill installs Claude's copy with those extra fields on purpose.
 */
export function comparableSkillContent(content: string, folderName: string): string {
  const normalized = normalizeSkillContent(content);
  if (!normalized.startsWith("---")) return normalized;
  const end = normalized.indexOf("---", 3);
  if (end === -1) return normalized;
  let block = normalized.substring(3, end);
  for (const pattern of CLAUDE_ONLY_FIELDS) block = block.replace(pattern, "");
  block = block.replace(/\n{3,}/g, "\n\n");
  if (!/^name:/m.test(block)) block = `\nname: ${folderName}${block}`;
  return `---${block}---${normalized.substring(end + 3)}`;
}

function unquote(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** `name` and `version` from a SKILL.md frontmatter; `version` may sit under `metadata`. */
export function readSkillFrontmatter(content: string): {
  readonly name: string | null;
  readonly version: string | null;
} {
  const normalized = normalizeSkillContent(content);
  const match = /^---\n([\s\S]*?)\n---/.exec(normalized);
  if (!match) return { name: null, version: null };
  const lines = match[1]!.split("\n");
  let name: string | null = null;
  let version: string | null = null;
  let nested: string | null = null;
  let inMetadata = false;
  for (const line of lines) {
    const top = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (top) {
      inMetadata = top[1] === "metadata" && top[2]!.trim() === "";
      if (top[1] === "name") name = unquote(top[2]!);
      if (top[1] === "version") version = unquote(top[2]!);
      continue;
    }
    const child = /^\s+version\s*:\s*(.*)$/.exec(line);
    if (inMetadata && child) nested ??= unquote(child[1]!);
  }
  return { name, version: version ?? nested };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** `version` from a plugin manifest (`plugin.json`), or null. */
export function parsePluginManifestVersion(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? stringOrNull((parsed as Record<string, unknown>).version)
      : null;
  } catch {
    return null;
  }
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
 * Findings from `vskill doctor --json`. The report shape is read tolerantly:
 * an array of findings at the top level or under `problems`, `findings`,
 * `issues` or `checks`, each naming its skill by `name`, `skill` or
 * `skillName` (or a path to its folder or SKILL.md) and describing itself
 * with `message`, `detail`, `description` or its kind. `agents` and `paths`
 * are kept so the view can drop findings about agents it does not show.
 * Returns undefined when the output is not such a report.
 */
export function parseVskillDoctorReport(
  stdout: string,
): ReadonlyArray<VskillDoctorFinding> | undefined {
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
  const strings = (value: unknown): Array<string> =>
    Array.isArray(value) ? value.flatMap((item) => stringOrNull(item) ?? []) : [];
  const findings: Array<VskillDoctorFinding> = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const paths = [
      ...new Set([
        ...(stringOrNull(record.path) ? [stringOrNull(record.path)!] : []),
        ...strings(record.paths),
      ]),
    ];
    const pathValue = paths[0] ?? null;
    const skill =
      stringOrNull(record.name) ??
      stringOrNull(record.skill) ??
      stringOrNull(record.skillName) ??
      (pathValue
        ? NodePath.basename(/skill\.md$/i.test(pathValue) ? NodePath.dirname(pathValue) : pathValue)
        : null);
    if (!skill) continue;
    const kind =
      stringOrNull(record.kind) ?? stringOrNull(record.type) ?? stringOrNull(record.code);
    const message =
      stringOrNull(record.message) ??
      stringOrNull(record.detail) ??
      stringOrNull(record.description) ??
      kind;
    if (!message) continue;
    const agents = [
      ...new Set([
        ...strings(record.agents),
        ...(stringOrNull(record.agent) ? [stringOrNull(record.agent)!] : []),
      ]),
    ];
    const key = [skill, message, agents.join(","), paths.join(",")].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ skill, kind, message, agents, paths });
  }
  return findings;
}

/**
 * The ids `vskill doctor` uses for the agents behind each provider driver.
 * A driver not listed matches an agent id equal to its own kind.
 */
const DOCTOR_AGENT_IDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  claudeAgent: ["claude-code"],
  codex: ["codex"],
  grok: ["grok"],
  cursor: ["cursor"],
  antigravity: ["antigravity"],
  opencode: ["opencode"],
  pi: ["pi"],
};

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

interface PendingPresence {
  readonly presence: ProjectSkillPresence;
  /** The name the provider lists it under. */
  readonly providerName: string;
  readonly realPath: string;
  readonly fact: SkillFileFact | undefined;
  readonly description: string | undefined;
}

interface PendingRow {
  name: string;
  description: string | undefined;
  presences: Array<PendingPresence>;
}

/**
 * The plugin a namespaced skill (`<plugin>:<skill>`) belongs to, the key
 * vskill files a plugin install under.
 */
function pluginNamespace(name: string): string | undefined {
  const separator = name.indexOf(":");
  return separator > 0 ? name.slice(0, separator) : undefined;
}

/**
 * Names vskill could have locked a loaded copy under: its folder and the
 * name its provider lists. A plugin skill (`plugin` scope) is excluded: its
 * folder sits inside the plugin, so a standalone skill locked under the same
 * folder name (`lint` for `frontend:lint`) is a different skill.
 */
function lockableNames(presences: ReadonlyArray<PendingPresence>): Array<string> {
  return presences.flatMap((pending) =>
    pending.presence.scope === "plugin"
      ? []
      : [skillFolderName(pending.presence.path), pending.providerName],
  );
}

/**
 * Pick the lock entry for a skill: the project lock when a copy lives in the
 * project. A skill locked under one of its names or folders wins; otherwise
 * a namespaced plugin skill takes its plugin's `pluginDir` entry, since
 * vskill locks a plugin once under the plugin's name.
 */
function selectLock(
  name: string,
  presences: ReadonlyArray<PendingPresence>,
  locks: ReadonlyArray<VskillLockSource>,
  cwd: string,
): { readonly source: VskillLockSource; readonly entry: VskillLockEntry } | undefined {
  const keys = new Set([name, ...lockableNames(presences)]);
  const direct = locks.flatMap((source) =>
    [...keys].flatMap((key) => {
      const entry = source.entries.get(key);
      return entry ? [{ source, entry }] : [];
    }),
  );
  const namespace = pluginNamespace(name);
  const candidates =
    direct.length > 0 || namespace === undefined
      ? direct
      : locks.flatMap((source) => {
          const entry = source.entries.get(namespace);
          return entry?.pluginDir ? [{ source, entry }] : [];
        });
  if (candidates.length === 0) return undefined;
  // A skill nothing loads is the project's own declaration first.
  const hasProjectCopy =
    presences.length === 0 || presences.some((pending) => isInside(cwd, pending.presence.path));
  const preferred = candidates.find((candidate) =>
    hasProjectCopy ? candidate.source.scope === "project" : candidate.source.scope === "user",
  );
  return preferred ?? candidates[0];
}

/**
 * The name a group of presences of one SKILL.md is shown under: the name
 * Claude lists (its folder, or `plugin:skill` for a plugin skill), else
 * the key a vskill lock files it under, else its frontmatter `name`, else the
 * name most providers list.
 */
function displayName(
  group: ReadonlyArray<PendingPresence>,
  locks: ReadonlyArray<VskillLockSource>,
): string {
  const claude = group.find((pending) => pending.presence.driver === "claudeAgent");
  if (claude) return claude.providerName;
  const lockKey = lockableNames(group).find((key) =>
    locks.some((source) => source.entries.has(key)),
  );
  if (lockKey) return lockKey;
  const frontmatter = group.find((pending) => pending.fact?.frontmatterName)?.fact?.frontmatterName;
  // A namespaced listing of the same skill (`sw:do` for `do`) keeps its namespace.
  if (frontmatter) {
    return (
      group.find((pending) => pending.providerName.endsWith(`:${frontmatter}`))?.providerName ??
      frontmatter
    );
  }
  const counts = new Map<string, number>();
  for (const pending of group) {
    counts.set(pending.providerName, (counts.get(pending.providerName) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0]![0];
}

/** The version a presence reports: its plugin's manifest, else its frontmatter. */
function presenceVersion(presence: ProjectSkillPresence): string | null {
  return presence.pluginVersion ?? presence.fileVersion ?? null;
}

/**
 * Whether a doctor finding is about an agent or folder in this snapshot.
 * Findings naming agents count only for agents the snapshot has; findings
 * naming only paths count when a path is one of the row's copies or folders.
 */
function doctorFindingApplies(
  finding: VskillDoctorFinding,
  agents: ReadonlySet<string>,
  presences: ReadonlyArray<PendingPresence>,
): boolean {
  if (finding.agents.length > 0) return finding.agents.some((agent) => agents.has(agent));
  if (finding.paths.length === 0 || presences.length === 0) return true;
  const known = new Set(
    presences.flatMap((pending) => [
      pending.presence.path,
      NodePath.dirname(pending.presence.path),
      pending.realPath,
      NodePath.dirname(pending.realPath),
    ]),
  );
  return finding.paths.some((path) => known.has(path) || known.has(NodePath.resolve(path)));
}

/**
 * Catalog entries the view leaves out: anything under a dot folder inside a
 * skills folder (`.trash`, `.root-owned-*`; Codex's own `.system` stays) and
 * files that are not a SKILL.md (Claude Code plugin command files).
 */
export function isListableSkillPath(skillPath: string): boolean {
  const segments = skillPath.split(/[\\/]+/);
  if (!/^skill\.md$/i.test(segments.at(-1) ?? "")) return false;
  const skillsIndex = segments.lastIndexOf("skills");
  if (skillsIndex === -1) return true;
  return segments
    .slice(skillsIndex + 1, -1)
    .every((segment) => !segment.startsWith(".") || segment === ".system");
}

/** One row per skill across every provider and lockfile. */
export function buildProjectSkillRows(
  input: ProjectSkillsJoinInput,
): ReadonlyArray<ProjectSkillRow> {
  // 1. Presences of the same file (after links) are one skill, whatever each
  //    provider calls it.
  const byFile = new Map<string, Array<PendingPresence>>();
  for (const provider of input.providers) {
    for (const skill of provider.skills) {
      const fact = input.files.get(skill.path);
      const realPath = fact?.realPath ?? skill.path;
      const group = byFile.get(realPath) ?? [];
      group.push({
        presence: {
          instanceId: provider.instanceId,
          driver: provider.driver,
          label: provider.label,
          path: skill.path,
          scope: skill.scope ?? null,
          enabled: skill.enabled,
          ...(skill.userInvocable === false ? { userInvocable: false } : {}),
          ...(fact?.fileVersion !== undefined ? { fileVersion: fact.fileVersion } : {}),
          ...(fact?.pluginVersion !== undefined ? { pluginVersion: fact.pluginVersion } : {}),
        },
        providerName: skill.name,
        realPath,
        fact,
        description: skill.description,
      });
      byFile.set(realPath, group);
    }
  }

  // 2. Files shown under the same name are one skill in several copies.
  const pending = new Map<string, PendingRow>();
  for (const group of byFile.values()) {
    const name = displayName(group, input.locks);
    const row = pending.get(name) ?? { name, description: undefined, presences: [] };
    for (const entry of group) {
      row.description ??= entry.description;
      row.presences.push(entry);
    }
    pending.set(name, row);
  }

  // A locked skill no agent loads still gets a row, under its lock key,
  // unless a loaded skill already claimed that key through one of its names.
  // Plugin installs (`pluginDir`) are skipped: their skills load under the
  // plugin's namespace, so the lock key never names a skill an agent lists;
  // `selectLock` attaches the entry to those namespaced rows instead.
  const claimedKeys = new Set(
    [...pending.values()].flatMap((row) => [
      row.name,
      ...row.presences.map((entry) => entry.providerName),
      ...lockableNames(row.presences),
    ]),
  );
  const staleKeys = new Set<string>();
  for (const source of input.locks) {
    for (const [key, entry] of source.entries) {
      if (claimedKeys.has(key) || entry.pluginDir) continue;
      claimedKeys.add(key);
      pending.set(key, { name: key, description: undefined, presences: [] });
      if (input.lockOnDisk && !input.lockOnDisk.has(lockEntryKey(source.path, key))) {
        staleKeys.add(key);
      }
    }
  }

  const snapshotAgents = new Set(
    input.providers.flatMap((provider) => [
      provider.driver,
      ...(DOCTOR_AGENT_IDS[provider.driver] ?? []),
    ]),
  );
  const findingsBySkill = new Map<string, Array<VskillDoctorFinding>>();
  for (const finding of input.doctor) {
    const list = findingsBySkill.get(finding.skill) ?? [];
    list.push(finding);
    findingsBySkill.set(finding.skill, list);
  }

  const rows = [...pending.values()].map((row): ProjectSkillRow => {
    const issues: Array<string> = [];
    const presences = row.presences.map((entry) => entry.presence);
    const realPaths = new Set(row.presences.map((entry) => entry.realPath));
    // Copies are the same skill when vskill doctor would call them identical.
    const versionsByContent = new Map<string, Array<ProjectSkillPresence>>();
    for (const entry of row.presences) {
      const comparable = entry.fact?.comparableDigest ?? entry.fact?.digest ?? null;
      if (comparable === null) continue;
      const list = versionsByContent.get(comparable) ?? [];
      list.push(entry.presence);
      versionsByContent.set(comparable, list);
    }
    const divergent = versionsByContent.size > 1;
    if (divergent) {
      const detail = [...versionsByContent.values()]
        .map((list) => {
          const labels = [...new Set(list.map((presence) => presence.label))].join(", ");
          const versions = [
            ...new Set(list.flatMap((presence) => presenceVersion(presence) ?? [])),
          ];
          return versions.length > 0 ? `${labels} ${versions.join("/")}` : labels;
        })
        .join("; ");
      issues.push(
        `Agents load ${versionsByContent.size} different versions of this skill: ${detail}.`,
      );
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
      const facts = row.presences.flatMap((pending) =>
        pending.fact ? [{ presence: pending.presence, fact: pending.fact }] : [],
      );
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

    const missing = presences.length === 0;
    const staleLock = missing && staleKeys.has(row.name);
    if (staleLock) {
      issues.push("Stale lock entry: a vskill lockfile lists it, but nothing is on disk.");
    } else if (missing) {
      issues.push("A vskill lockfile lists it, but no agent loads it.");
    }
    const enabledCount = presences.filter((presence) => presence.enabled).length;
    const disabled = !missing && enabledCount === 0;
    if (disabled) {
      issues.push("Switched off for every agent that sees it.");
    } else if (!missing && enabledCount < presences.length) {
      issues.push(
        `Switched off for ${[
          ...new Set(
            presences.filter((presence) => !presence.enabled).map((presence) => presence.label),
          ),
        ].join(", ")}.`,
      );
    }

    const aliases = [
      ...new Set(
        row.presences.map((entry) => entry.providerName).filter((name) => name !== row.name),
      ),
    ].sort();
    const doctorKeys = new Set([
      row.name,
      ...aliases,
      ...row.presences.map((entry) => skillFolderName(entry.presence.path)),
    ]);
    const applicable = [...doctorKeys]
      .flatMap((key) => findingsBySkill.get(key) ?? [])
      .filter((finding) => doctorFindingApplies(finding, snapshotAgents, row.presences))
      // A stale entry is already reported above; doctor's lock-missing says the same.
      .filter((finding) => !(staleLock && finding.kind === "lock-missing"));
    const doctor = [...new Set(applicable.map((finding) => finding.message))];
    // Doctor's identical-copy finding names the copy to keep; show it instead of ours.
    if (applicable.some((finding) => finding.kind === "identical-copy")) {
      const own = issues.findIndex((issue) => / identical copies; /.test(issue));
      if (own !== -1) issues.splice(own, 1);
    }

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
    for (const presence of presences) {
      pathCounts.set(presence.path, (pathCounts.get(presence.path) ?? 0) + 1);
    }
    const path =
      [...pathCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ??
      (selected?.entry.installedPath
        ? NodePath.join(selected.entry.installedPath, "SKILL.md")
        : null);

    return {
      name: row.name,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(row.description ? { description: row.description } : {}),
      status,
      attention: (status !== "ok" && !staleLock) || doctor.length > 0,
      issues: [...issues, ...doctor],
      path,
      scopes: [
        ...new Set(presences.flatMap((presence) => (presence.scope ? [presence.scope] : []))),
      ].sort(),
      providers: row.presences
        .map((entry) =>
          entry.providerName === row.name
            ? entry.presence
            : { ...entry.presence, name: entry.providerName },
        )
        .toSorted((left, right) => left.label.localeCompare(right.label)),
      lock,
      drift,
      copies: missing ? 0 : realPaths.size,
      divergent,
      doctor,
      ...(staleLock ? { staleLock: true } : {}),
    };
  });

  return rows.sort((left, right) => left.name.localeCompare(right.name));
}
