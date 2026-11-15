import { safeGitConfigEntries } from "./folderTransfer/safeGitConfig.ts";

/**
 * `.git/config` keys an existing copy may hold beyond the folder copy's safe list
 * (`safeGitConfig.ts`): they name people, signing and push defaults, and run nothing
 * during a fetch and fast-forward.
 */
const LOCAL_INERT_KEYS = new Set([
  "user.name",
  "user.email",
  "user.signingkey",
  "commit.gpgsign",
  "tag.gpgsign",
  "gpg.format",
  "push.default",
  "push.autosetupremote",
  "init.defaultbranch",
  "gc.auto",
  "rerere.enabled",
  "rerere.autoupdate",
  "merge.conflictstyle",
  "maintenance.auto",
  "maintenance.strategy",
]);
/** `git lfs install --local` writes these; the update turns LFS filters off either way. */
const STANDARD_LFS_FILTER = new Map([
  ["filter.lfs.clean", "git-lfs clean -- %f"],
  ["filter.lfs.smudge", "git-lfs smudge -- %f"],
  ["filter.lfs.process", "git-lfs filter-process"],
  ["filter.lfs.required", "true"],
]);
const HELPER_URL = /^[A-Za-z][A-Za-z0-9+.-]*::/;

/**
 * The keys of a destination's own `.git/config` entries that could run a command or reach
 * elsewhere during the update, sorted and without values (a URL may hold a token). Remote
 * URLs are judged for running something, not for carrying: a local path is fine here.
 */
export function unsafeExistingCopyConfig(
  entries: ReadonlyArray<readonly [string, string]>,
): Array<string> {
  const unsafe = new Set<string>();
  for (const [rawKey, value] of entries) {
    const key = rawKey.trim();
    const lower = key.toLowerCase();
    if (LOCAL_INERT_KEYS.has(lower) || STANDARD_LFS_FILTER.get(lower) === value.trim()) continue;
    const first = lower.indexOf(".");
    const last = lower.lastIndexOf(".");
    const section = lower.slice(0, first);
    const name = lower.slice(last + 1);
    if (first > 0 && last > first) {
      if (section === "branch" && name !== "mergeoptions") continue;
      if (
        (section === "remote" && (name === "url" || name === "pushurl")) ||
        (section === "submodule" && name === "url")
      ) {
        if (!HELPER_URL.test(value.trim())) continue;
        unsafe.add(key);
        continue;
      }
      if (section === "remote" && ["push", "prune", "mirror", "skipdefaultupdate"].includes(name))
        continue;
      if (section === "submodule" && name === "ignore") continue;
      if (section === "maintenance" && (name === "enabled" || name === "schedule")) continue;
    }
    if (safeGitConfigEntries([[key, value]]).length === 1) continue;
    unsafe.add(key);
  }
  return [...unsafe].sort();
}

/** `.lfsconfig` keys that only choose what LFS fetches; endpoints are pinned anyway. */
const LFSCONFIG_KEYS = new Set([
  "lfs.url",
  "lfs.pushurl",
  "lfs.fetchinclude",
  "lfs.fetchexclude",
  "lfs.locksverify",
]);
/** The keys of a repository's `.lfsconfig` beyond what it may set, sorted. */
export function unsafeLfsConfig(entries: ReadonlyArray<readonly [string, string]>): Array<string> {
  const unsafe = new Set<string>();
  for (const [rawKey] of entries) {
    const key = rawKey.trim().toLowerCase();
    if (LFSCONFIG_KEYS.has(key) || /^remote\.[^.]+(\..+)?\.(lfsurl|lfspushurl)$/.test(key))
      continue;
    unsafe.add(key);
  }
  return [...unsafe].sort();
}
/**
 * The LFS endpoint Git LFS itself derives from an origin URL, pinned so a repository's
 * `.lfsconfig` cannot send the download elsewhere. Null for a form it does not know.
 */
export function lfsEndpoint(origin: string): string | null {
  const value = origin.trim();
  if (/^https?:\/\//i.test(value)) {
    const base = value.replace(/\/+$/, "");
    return `${base.endsWith(".git") ? base : `${base}.git`}/info/lfs`;
  }
  if (/^(ssh|file):\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `file://${value}`;
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (drive) return `file:///${drive[1]}:/${drive[2]!.replace(/\\/g, "/")}`;
  const scp = /^([A-Za-z0-9._-]+@[A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(value);
  if (scp) return `ssh://${scp[1]}/${scp[2]!.replace(/^\/+/, "")}`;
  return null;
}

/** The forms `git lfs install` has written for its filter, with and without `--skip-smudge`. */
const STANDARD_LFS_VALUES: Readonly<Record<string, ReadonlyArray<string>>> = {
  clean: ["git-lfs clean -- %f", "git-lfs clean %f"],
  smudge: [
    "git-lfs smudge -- %f",
    "git-lfs smudge %f",
    "git-lfs smudge --skip -- %f",
    "git-lfs smudge --skip %f",
  ],
  process: ["git-lfs filter-process", "git-lfs filter-process --skip"],
};
/**
 * The clean, smudge and process filters this machine's own Git settings define (system,
 * global, environment), from `git config --list --null --show-scope`: filter name to its
 * keys, sorted. A repository's attributes choose which of them run on its files, so an
 * existing copy's update switches every one off. Git LFS is left alone while what Git ends
 * up using for it, the repository's own entries included, is the standard filter. The
 * repository's own config is judged by `unsafeExistingCopyConfig`.
 */
export function ambientFilters(scoped: string): Map<string, Array<string>> {
  const filters = new Map<string, { ambient: boolean; values: Map<string, string> }>();
  const records = scoped.split("\0");
  for (let index = 0; index + 1 < records.length; index += 2) {
    const scope = records[index]!;
    const record = records[index + 1]!;
    const line = record.indexOf("\n");
    const key = line < 0 ? record : record.slice(0, line);
    const first = key.indexOf(".");
    const last = key.lastIndexOf(".");
    if (first < 0 || last <= first || key.slice(0, first).toLowerCase() !== "filter") continue;
    const variable = key.slice(last + 1).toLowerCase();
    if (!["clean", "smudge", "process"].includes(variable)) continue;
    const name = key.slice(first + 1, last);
    const filter = filters.get(name) ?? { ambient: false, values: new Map<string, string>() };
    if (scope !== "local" && scope !== "worktree") filter.ambient = true;
    // Git lists scopes in the order it reads them: a later one overrides an earlier one.
    filter.values.set(variable, line < 0 ? "" : record.slice(line + 1).trim());
    filters.set(name, filter);
  }
  const found = new Map<string, Array<string>>();
  for (const [name, { ambient, values }] of filters) {
    const set = [...values].filter(([, value]) => value !== "");
    if (
      !ambient ||
      set.length === 0 ||
      (name === "lfs" &&
        set.every(([variable, value]) => STANDARD_LFS_VALUES[variable]!.includes(value)))
    )
      continue;
    found.set(name, set.map(([variable]) => `filter.${name}.${variable}`).sort());
  }
  return found;
}
/** `-c` settings that switch the named filters off without failing a checkout. */
export function filtersOff(names: Iterable<string>): Array<string> {
  return [...names].flatMap((name) => [
    `filter.${name}.clean=`,
    `filter.${name}.smudge=`,
    `filter.${name}.process=`,
    `filter.${name}.required=false`,
  ]);
}
/**
 * The object stores an `objects/info/alternates` file names, as written (relative ones are
 * relative to the object store). Null for a quoted path, which is refused rather than decoded.
 */
export function alternatePaths(content: string): Array<string> | null {
  const paths: Array<string> = [];
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith('"')) return null;
    paths.push(line);
  }
  return paths;
}
