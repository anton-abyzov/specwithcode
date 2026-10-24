#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Runs from the workflow's own commit without the release tag's node_modules, so only Node built-ins.
/**
 * Release helpers for .github/workflows/release-windows-linux.yml, which adds the Windows x64
 * and Linux x64 desktop installers, their electron-updater feeds and the Windows CLI zip to a
 * release that scripts/release/release.sh already published.
 *
 * Only Node built-ins: the workflow runs this file from its own commit while it builds an older
 * release tag, so it must not depend on that tag's node_modules.
 *
 *   node release-windows-linux.ts collect --platform win|linux --version X.Y.Z --from DIR... --out DIR
 *   node release-windows-linux.ts check-feed --repo OWNER/REPO FILE...
 *   node release-windows-linux.ts sums --dir DIR
 *   node release-windows-linux.ts check-public --rules FILE --dir DIR
 *   node release-windows-linux.ts plan-upload --version X.Y.Z --dir DIR --existing FILE [--replace]
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export type Platform = "win" | "linux";

/** The public repository whose Latest release every desktop install polls (app-update.yml). */
export const FEED_REPOSITORY = "anton-abyzov/specwithcode";
/**
 * Checksums of everything this workflow adds. release.sh owns SHA256SUMS: the fleet's update
 * plan and the next release's prev stage read it, so this workflow never rewrites it.
 */
export const WINDOWS_LINUX_SUMS = "SHA256SUMS-windows-linux";

export function isStableVersion(version: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version);
}

/** electron-updater's channel file for the latest channel: latest.yml on Windows, latest-linux.yml on x64 Linux. */
export function feedManifestName(platform: Platform): string {
  return platform === "win" ? "latest.yml" : "latest-linux.yml";
}

export function windowsCliArchiveName(version: string): string {
  return `studio-${version}-win32-x64.zip`;
}

/**
 * What each build must produce. electron-builder names files `SpecWithCode-${version}-${arch}`
 * (scripts/build-desktop-artifact.ts), with x64 written as x86_64 for AppImage and amd64 for deb.
 */
export function requiredAssetNames(platform: Platform, version: string): string[] {
  if (platform === "win") {
    return [
      `SpecWithCode-${version}-x64.exe`,
      `SpecWithCode-${version}-x64.exe.blockmap`,
      feedManifestName("win"),
      windowsCliArchiveName(version),
    ];
  }
  return [
    `SpecWithCode-${version}-x86_64.AppImage`,
    `SpecWithCode-${version}-amd64.deb`,
    feedManifestName("linux"),
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every name this workflow may put on a release. Anything else is left to release.sh. */
export function isWindowsLinuxAssetName(name: string, version: string): boolean {
  const v = escapeRegExp(version);
  return [
    new RegExp(`^SpecWithCode-${v}-x64\\.exe(?:\\.blockmap)?$`),
    new RegExp(`^SpecWithCode-${v}-x86_64\\.AppImage(?:\\.blockmap)?$`),
    new RegExp(`^SpecWithCode-${v}-amd64\\.deb$`),
    new RegExp(`^studio-${v}-win32-x64\\.zip$`),
    /^latest\.yml$/,
    /^latest-linux\.yml$/,
    new RegExp(`^${escapeRegExp(WINDOWS_LINUX_SUMS)}$`),
  ].some((pattern) => pattern.test(name));
}

/**
 * Names release.sh publishes (desktop_assets, linux_assets, installer_assets, release_assets),
 * the macOS feed first. A name matching here is never uploaded or replaced by this workflow.
 */
export function isReleaseShAssetName(name: string): boolean {
  return [
    /-mac\.yml$/,
    /\.dmg(?:\.blockmap)?$/,
    /^SpecWithCode-.*-arm64\.zip(?:\.blockmap)?$/,
    /^SHA256SUMS$/,
    /^studio-update\.json$/,
    /^deployment-helpers-manifest\.json$/,
    /^install\.sh$/,
    /^studio-.*\.tar\.gz$/,
  ].some((pattern) => pattern.test(name));
}

export interface FeedFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number | null;
}

export interface FeedManifest {
  readonly version: string;
  readonly path: string | null;
  readonly files: ReadonlyArray<FeedFile>;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Reads the flat YAML electron-builder writes for update feeds. File entries may carry more keys
 * than url, sha512 and size (blockMapSize on AppImage); those are skipped.
 */
export function parseFeedManifest(text: string): FeedManifest {
  let version: string | null = null;
  let path: string | null = null;
  const files: Array<{ url?: string; sha512?: string; size?: number }> = [];
  let inFiles = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const top = /^([A-Za-z][\w]*):\s*(.*)$/.exec(line);
    if (top) {
      const [, key, value = ""] = top;
      inFiles = key === "files" && value.trim() === "";
      if (key === "version") version = unquote(value);
      if (key === "path") path = unquote(value);
      continue;
    }
    if (!inFiles) throw new Error(`unexpected line in update feed: ${line}`);
    const entry = /^\s+-\s+([A-Za-z][\w]*):\s*(.*)$/.exec(line);
    const field = entry ?? /^\s+([A-Za-z][\w]*):\s*(.*)$/.exec(line);
    if (field === null) throw new Error(`unexpected line in update feed: ${line}`);
    if (entry) files.push({});
    const current = files.at(-1);
    if (current === undefined) throw new Error(`file field before the first file: ${line}`);
    const [, key, raw = ""] = field;
    const value = unquote(raw);
    if (key === "url") current.url = value;
    else if (key === "sha512") current.sha512 = value;
    else if (key === "size") current.size = Number.parseInt(value, 10);
  }
  if (version === null) throw new Error("update feed has no version");
  const complete: FeedFile[] = [];
  for (const file of files) {
    if (!file.url || !file.sha512)
      throw new Error("update feed lists a file without url or sha512");
    complete.push({
      url: file.url,
      sha512: file.sha512,
      size: Number.isFinite(file.size) ? (file.size as number) : null,
    });
  }
  if (complete.length === 0) throw new Error("update feed lists no files");
  return { version, path, files: complete };
}

export interface LocalFile {
  readonly sha512: string;
  readonly size: number;
}

/** Problems that would make electron-updater refuse or mis-install this feed; empty when it is sound. */
export function feedProblems(input: {
  readonly platform: Platform;
  readonly version: string;
  readonly manifest: FeedManifest;
  readonly files: ReadonlyMap<string, LocalFile>;
}): string[] {
  const problems: string[] = [];
  const name = feedManifestName(input.platform);
  if (input.manifest.version !== input.version) {
    problems.push(`${name} is for ${input.manifest.version}, not ${input.version}`);
  }
  const installer = input.platform === "win" ? /\.exe$/ : /\.AppImage$/;
  if (!input.manifest.files.some((file) => installer.test(file.url))) {
    problems.push(`${name} lists no ${input.platform === "win" ? ".exe" : ".AppImage"}`);
  }
  for (const file of input.manifest.files) {
    if (!isWindowsLinuxAssetName(file.url, input.version) || isReleaseShAssetName(file.url)) {
      problems.push(`${name} points at ${file.url}, which this workflow does not publish`);
      continue;
    }
    const local = input.files.get(file.url);
    if (local === undefined) {
      problems.push(`${name} lists ${file.url}, which the build did not produce`);
      continue;
    }
    if (local.sha512 !== file.sha512)
      problems.push(`${file.url} does not match its sha512 in ${name}`);
    if (file.size !== null && local.size !== file.size) {
      problems.push(`${file.url} is ${local.size} bytes; ${name} says ${file.size}`);
    }
  }
  return problems;
}

/** Problems with a packaged resources/app-update.yml: it must poll FEED_REPOSITORY's stable releases. */
export function appUpdateConfigProblems(text: string, repository = FEED_REPOSITORY): string[] {
  const entries: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\w+):\s*(.+)$/.exec(line);
    if (match?.[1] && match[2]) entries[match[1]] = unquote(match[2]);
  }
  const [owner, repo] = repository.split("/");
  const problems: string[] = [];
  if (entries.provider !== "github")
    problems.push(`provider is ${entries.provider ?? "missing"}, not github`);
  if (entries.owner !== owner || entries.repo !== repo) {
    problems.push(`feed is ${entries.owner ?? "?"}/${entries.repo ?? "?"}, not ${repository}`);
  }
  if (entries.channel !== undefined && entries.channel !== "latest") {
    problems.push(`channel is ${entries.channel}, not latest`);
  }
  if (entries.releaseType !== undefined && entries.releaseType !== "release") {
    problems.push(`releaseType is ${entries.releaseType}, not release`);
  }
  return problems;
}

/** `<sha256>  <name>` lines sorted by name, the format install.ps1 and `sha256sum -c` read. */
export function formatSums(
  entries: ReadonlyArray<{ readonly name: string; readonly sha256: string }>,
): string {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => `${entry.sha256}  ${entry.name}\n`)
    .join("");
}

export interface PublicRules {
  readonly replace?: ReadonlyArray<readonly [string, string]>;
  readonly deny?: ReadonlyArray<string>;
}

/**
 * Private values in text bound for the public release, the same rules publish.mjs applies to the
 * public snapshot. Findings name the rule, never the value.
 */
export function publicLeaks(text: string, rules: PublicRules): string[] {
  const found: string[] = [];
  if (text.includes("anton-abyzov/specwithcode")) found.push("the private repository name");
  (rules.deny ?? []).forEach((value, index) => {
    if (value && text.includes(value)) found.push(`deny rule ${index + 1}`);
  });
  (rules.replace ?? []).forEach(([from], index) => {
    if (from && text.includes(from)) found.push(`replace rule ${index + 1}`);
  });
  if (/\/Users\/antonabyzov\b/.test(text)) found.push("a home folder path");
  return found;
}

/**
 * Which local assets to upload. Refuses names outside this workflow's set, anything release.sh
 * owns, and (without replace) a name the release already has.
 */
export function planUpload(input: {
  readonly version: string;
  readonly localNames: ReadonlyArray<string>;
  readonly existingNames: ReadonlyArray<string>;
  readonly replace: boolean;
}): { readonly upload: string[]; readonly problems: string[] } {
  const problems: string[] = [];
  const existing = new Set(input.existingNames);
  for (const name of input.localNames) {
    if (isReleaseShAssetName(name)) problems.push(`${name} belongs to release.sh`);
    else if (!isWindowsLinuxAssetName(name, input.version))
      problems.push(`${name} is not a Windows or Linux asset of ${input.version}`);
    else if (existing.has(name) && !input.replace) {
      problems.push(
        `${name} is already on the release; rerun with replace to overwrite this workflow's assets`,
      );
    }
  }
  for (const platform of ["win", "linux"] as const) {
    for (const name of requiredAssetNames(platform, input.version)) {
      if (!input.localNames.includes(name)) problems.push(`${name} is missing`);
    }
  }
  if (!input.localNames.includes(WINDOWS_LINUX_SUMS))
    problems.push(`${WINDOWS_LINUX_SUMS} is missing`);
  return { upload: [...input.localNames].sort(), problems };
}

// ---------------------------------------------------------------- command line

function hashFile(
  path: string,
  algorithm: "sha256" | "sha512",
  encoding: "hex" | "base64",
): string {
  return NodeCrypto.createHash(algorithm).update(NodeFS.readFileSync(path)).digest(encoding);
}

function listFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir)
    .filter((name) => NodeFS.statSync(NodePath.join(dir, name)).isFile())
    .sort();
}

function parseArgs(argv: ReadonlyArray<string>) {
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--replace") {
      values.set("replace", ["true"]);
    } else if (arg.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      values.set(arg.slice(2), [...(values.get(arg.slice(2)) ?? []), value]);
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  const one = (name: string): string => {
    const value = values.get(name)?.[0];
    if (value === undefined) throw new Error(`--${name} is required`);
    return value;
  };
  return { values, positional, one };
}

function fail(problems: ReadonlyArray<string>): never {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}

function collect(args: ReturnType<typeof parseArgs>): void {
  const platform = args.one("platform");
  if (platform !== "win" && platform !== "linux")
    throw new Error("--platform must be win or linux");
  const version = args.one("version");
  if (!isStableVersion(version)) throw new Error(`${version} is not an X.Y.Z version`);
  const sources = args.values.get("from") ?? [];
  const out = args.one("out");
  const locate = (name: string): string | undefined =>
    sources.map((dir) => NodePath.join(dir, name)).find((path) => NodeFS.existsSync(path));

  const manifestName = feedManifestName(platform);
  const manifestPath = locate(manifestName);
  if (manifestPath === undefined) fail([`the build wrote no ${manifestName}`]);
  const manifest = parseFeedManifest(NodeFS.readFileSync(manifestPath, "utf8"));
  const local = new Map<string, LocalFile>();
  for (const file of manifest.files) {
    const path = locate(file.url);
    if (path !== undefined) {
      local.set(file.url, {
        sha512: hashFile(path, "sha512", "base64"),
        size: NodeFS.statSync(path).size,
      });
    }
  }
  const problems = feedProblems({ platform, version, manifest, files: local });
  const names = new Set([manifestName, ...manifest.files.map((file) => file.url)]);
  for (const file of manifest.files) {
    if (locate(`${file.url}.blockmap`) !== undefined) names.add(`${file.url}.blockmap`);
  }
  for (const name of requiredAssetNames(platform, version)) {
    if (locate(name) === undefined) problems.push(`the build did not produce ${name}`);
    names.add(name);
  }
  for (const name of names) {
    if (!isWindowsLinuxAssetName(name, version) || isReleaseShAssetName(name)) {
      problems.push(`${name} is not a ${platform} asset this workflow may publish`);
    }
  }
  if (problems.length > 0) fail(problems);
  NodeFS.mkdirSync(out, { recursive: true });
  for (const name of [...names].sort()) {
    NodeFS.copyFileSync(locate(name)!, NodePath.join(out, name));
    console.log(`${name}  ${NodeFS.statSync(NodePath.join(out, name)).size} bytes`);
  }
}

function main(argv: ReadonlyArray<string>): void {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  switch (command) {
    case "collect":
      return collect(args);
    case "check-feed": {
      const repository = args.values.get("repo")?.[0] ?? FEED_REPOSITORY;
      if (args.positional.length === 0) throw new Error("name at least one app-update.yml");
      const problems = args.positional.flatMap((file) =>
        appUpdateConfigProblems(NodeFS.readFileSync(file, "utf8"), repository).map(
          (problem) => `${file}: ${problem}`,
        ),
      );
      if (problems.length > 0) fail(problems);
      console.log(`app-update.yml polls ${repository}: ${args.positional.join(", ")}`);
      return;
    }
    case "sums": {
      const dir = args.one("dir");
      const entries = listFiles(dir)
        .filter((name) => name !== WINDOWS_LINUX_SUMS)
        .map((name) => ({ name, sha256: hashFile(NodePath.join(dir, name), "sha256", "hex") }));
      NodeFS.writeFileSync(NodePath.join(dir, WINDOWS_LINUX_SUMS), formatSums(entries));
      process.stdout.write(formatSums(entries));
      return;
    }
    case "check-public": {
      const rules = JSON.parse(NodeFS.readFileSync(args.one("rules"), "utf8")) as PublicRules;
      const dir = args.one("dir");
      const problems = listFiles(dir)
        .filter((name) => /\.(?:yml|ps1)$/.test(name) || name === WINDOWS_LINUX_SUMS)
        .flatMap((name) =>
          publicLeaks(NodeFS.readFileSync(NodePath.join(dir, name), "utf8"), rules).map(
            (rule) => `${name} contains ${rule}`,
          ),
        );
      if (problems.length > 0) fail(problems);
      console.log("No private values in the text assets.");
      return;
    }
    case "plan-upload": {
      const dir = args.one("dir");
      const existing = JSON.parse(NodeFS.readFileSync(args.one("existing"), "utf8")) as unknown;
      if (!Array.isArray(existing) || !existing.every((name) => typeof name === "string")) {
        throw new Error("--existing must hold a JSON array of asset names");
      }
      const plan = planUpload({
        version: args.one("version"),
        localNames: listFiles(dir),
        existingNames: existing,
        replace: args.values.has("replace"),
      });
      if (plan.problems.length > 0) fail(plan.problems);
      process.stdout.write(plan.upload.map((name) => `${name}\n`).join(""));
      return;
    }
    default:
      throw new Error(
        `unknown command ${command ?? "(none)"}; see the header of ${NodePath.basename(import.meta.filename)}`,
      );
  }
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail([error instanceof Error ? error.message : String(error)]);
  }
}
