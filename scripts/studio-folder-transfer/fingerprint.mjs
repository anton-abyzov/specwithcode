#!/usr/bin/env node
// Fingerprint a project folder so a folder copy can be checked on two machines
// without moving the files again. Read-only: it never writes inside the folder
// and never reads the contents of secret-like files (it records their names).
//
//   node fingerprint.mjs snapshot <folder> <out.json>     full snapshot + summary on stdout
//   node fingerprint.mjs section <folder> <section>       one section in detail (stdout)
//   node fingerprint.mjs compare <source.json> <dest.json>
//
// A section is a top-level entry of the folder ("files:<name>") or a repository
// ("repo:<relative path>"). The summary printed by `snapshot` is small enough to
// paste into a message; `compare` accepts a full snapshot or a saved summary on
// either side and exits 1 when anything that should have been copied differs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

// Kept in step with apps/server/src/fleet/folderTransfer/classify.ts.
const REBUILDABLE = new Set([
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".vite",
  "dist",
  "build",
  "out",
  "target",
  "DerivedData",
  "Pods",
  ".gradle",
  "coverage",
  ".nyc_output",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "venv",
  "bin",
  "obj",
]);

// A conservative superset of the app's secret-like list: contents are never read.
const SECRET_NAME =
  /^(\.env(\..*)?|\.envrc|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|secrets?(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore|mobileprovision|kdbx|age|gpg))$/i;

const git = (cwd, args) => {
  const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 256 << 20 });
  return run.status === 0 ? run.stdout.trim() : `! ${run.stderr.trim()}`;
};

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const hashFile = (file) =>
  new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => done(hash.digest("hex")));
  });

const toPosix = (path) => path.split(sep).join("/");

async function walk(root) {
  const files = [];
  const repos = [];
  const visit = async (dir) => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const full = join(dir, name);
      const rel = toPosix(relative(root, full));
      const info = await lstat(full);
      if (name === ".git") {
        repos.push(toPosix(relative(root, dir)) || ".");
        continue;
      }
      const top = rel.split("/")[0];
      const base = { path: rel, section: `files:${top}`, mode: (info.mode & 0o777).toString(8) };
      if (info.isSymbolicLink()) {
        files.push({ ...base, type: "link", target: await readlink(full) });
      } else if (info.isDirectory()) {
        files.push({ ...base, type: "dir" });
        await visit(full);
      } else if (info.isFile()) {
        const secret = SECRET_NAME.test(name);
        files.push({
          ...base,
          type: "file",
          size: info.size,
          ...(secret ? { secret: true } : { sha256: await hashFile(full) }),
        });
      }
    }
  };
  await visit(root);
  return { files, repos };
}

function repoState(root, repo) {
  const cwd = join(root, repo);
  const worktrees = git(cwd, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree ") || line.startsWith("branch "))
    .map((line) => {
      if (!line.startsWith("worktree ")) return line;
      const path = line.slice("worktree ".length);
      const inside = relative(root, path);
      return inside.startsWith("..") || isAbsolute(inside)
        ? `worktree <outside>/${basename(path)}`
        : `worktree ${toPosix(inside) || "."}`;
    });
  return {
    section: `repo:${repo}`,
    head: git(cwd, ["rev-parse", "HEAD"]),
    branch: git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]),
    refs: git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"])
      .split("\n")
      .filter((line) => line && !line.startsWith("refs/swc-backup/"))
      .sort(),
    stashes: git(cwd, ["stash", "list", "--format=%H %s"]).split("\n").filter(Boolean),
    status: git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])
      .split("\n")
      .filter(Boolean)
      .sort(),
    worktrees,
    fsck: git(cwd, ["fsck", "--no-dangling", "--connectivity-only"]).startsWith("!")
      ? "failed"
      : "ok",
  };
}

const excluded = (entry) =>
  entry.secret === true || entry.path.split("/").some((part) => REBUILDABLE.has(part));

function summarize(snapshot) {
  const sections = {};
  const add = (name, item) => (sections[name] ??= []).push(item);
  for (const entry of snapshot.files) if (!excluded(entry)) add(entry.section, entry);
  const files = Object.fromEntries(
    Object.entries(sections).map(([name, items]) => [
      name,
      {
        count: items.length,
        bytes: items.reduce((sum, item) => sum + (item.size ?? 0), 0),
        digest: digest(items),
      },
    ]),
  );
  const repos = Object.fromEntries(
    snapshot.repoStates.map((state) => [
      state.section,
      { fsck: state.fsck, digest: digest(state) },
    ]),
  );
  return {
    kind: "summary",
    folder: snapshot.folder,
    takenAt: snapshot.takenAt,
    left: {
      secretLike: snapshot.files.filter((entry) => entry.secret).length,
      rebuildable: snapshot.files.filter((entry) => !entry.secret && excluded(entry)).length,
    },
    sections: { ...files, ...repos },
  };
}

async function snapshot(folder) {
  const root = resolve(folder);
  const { files, repos } = await walk(root);
  return {
    kind: "snapshot",
    folder: root,
    takenAt: new Date().toISOString(),
    files,
    repoStates: repos.sort().map((repo) => repoState(root, repo)),
  };
}

async function load(file) {
  const value = JSON.parse(await readFile(file, "utf8"));
  return value.kind === "snapshot"
    ? { full: value, summary: summarize(value) }
    : { summary: value };
}

function compare(source, destination) {
  const problems = [];
  const names = new Set([
    ...Object.keys(source.summary.sections),
    ...Object.keys(destination.summary.sections),
  ]);
  for (const name of [...names].sort()) {
    const a = source.summary.sections[name];
    const b = destination.summary.sections[name];
    if (!a) problems.push(`${name}: only on the destination`);
    else if (!b) problems.push(`${name}: missing on the destination`);
    else if (b.fsck === "failed") problems.push(`${name}: git fsck failed on the destination`);
    else if (a.digest !== b.digest) problems.push(`${name}: differs`);
  }
  if (source.full && destination.full) {
    const index = (snap) =>
      new Map(snap.files.filter((entry) => !excluded(entry)).map((entry) => [entry.path, entry]));
    const a = index(source.full);
    const b = index(destination.full);
    for (const [path, entry] of a) {
      const other = b.get(path);
      if (!other) problems.push(`  missing: ${path}`);
      else if (digest({ ...entry }) !== digest({ ...other })) problems.push(`  changed: ${path}`);
    }
    for (const path of b.keys()) if (!a.has(path)) problems.push(`  extra: ${path}`);
    for (const state of source.full.repoStates) {
      const other = destination.full.repoStates.find((item) => item.section === state.section);
      if (!other) continue;
      for (const key of ["head", "branch", "refs", "stashes", "status", "worktrees"])
        if (digest(state[key]) !== digest(other[key]))
          problems.push(`  ${state.section} ${key} differs`);
    }
  }
  return problems;
}

const [command, ...args] = process.argv.slice(2);
if (command === "snapshot" && args.length === 2) {
  const full = await snapshot(args[0]);
  await writeFile(args[1], JSON.stringify(full));
  console.log(JSON.stringify(summarize(full), null, 1));
} else if (command === "section" && args.length === 2) {
  const full = await snapshot(args[0]);
  const items = [
    ...full.files.filter((entry) => entry.section === args[1] && !excluded(entry)),
    ...full.repoStates.filter((state) => state.section === args[1]),
  ];
  console.log(JSON.stringify(items, null, 1));
} else if (command === "compare" && args.length === 2) {
  const problems = compare(await load(args[0]), await load(args[1]));
  console.log(problems.length === 0 ? "MATCH" : problems.join("\n"));
  process.exitCode = problems.length === 0 ? 0 : 1;
} else {
  console.error(
    "Usage: fingerprint.mjs snapshot <folder> <out.json> | section <folder> <section> | compare <a.json> <b.json>",
  );
  process.exitCode = 2;
}
