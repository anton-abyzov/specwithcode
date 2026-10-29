// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures.
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, type WorktreeLocationMode } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { resolveHandoffPlacement } from "./handoffPlacement.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});
function git(root: string, ...args: string[]) {
  return ChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", root, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}
function fixture() {
  const base = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "swc-handoff-placement-")));
  roots.push(base);
  const repository = Path.join(base, "repo");
  FS.mkdirSync(repository);
  git(repository, "init", "-q", "-b", "main");
  FS.writeFileSync(Path.join(repository, "file.txt"), "base\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "base");
  const input = {
    repository,
    name: "project-handoff-thread-e2",
    defaultDirectory: Path.join(base, "managed"),
    settings: DEFAULT_SERVER_SETTINGS,
  };
  return { base, repository, input };
}
const resolve = (input: Parameters<typeof resolveHandoffPlacement>[0]) =>
  Effect.runPromise(resolveHandoffPlacement(input));
it.each(["managed", "project", "custom"] as WorktreeLocationMode[])(
  "resolves %s placement and protects project-local files",
  async (mode) => {
    const { input, base, repository } = fixture();
    const custom = Path.join(base, "custom");
    const result = await resolve({
      ...input,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        worktreeLocationMode: mode,
        worktreesDirectory: custom,
      },
    });
    const parent =
      mode === "managed"
        ? input.defaultDirectory
        : mode === "custom"
          ? custom
          : Path.join(repository, ".specwithcode", "worktrees");
    expect(result).toEqual({ worktreePath: Path.join(parent, input.name), existing: false });
    if (mode === "project") {
      FS.mkdirSync(Path.join(parent, "example"), { recursive: true });
      FS.writeFileSync(Path.join(parent, "example", "saved.txt"), "retained");
      expect(git(repository, "status", "--porcelain")).toBe("");
      expect(FS.readFileSync(Path.join(repository, ".git", "info", "exclude"), "utf8")).toContain(
        "/.specwithcode/worktrees/",
      );
    }
  },
);
it.each(["root", "repository", "ancestor", "inside", "symlink-root", "project-escape"])(
  "rejects unsafe %s placement",
  async (kind) => {
    const { input, base, repository } = fixture();
    let mode: WorktreeLocationMode = "custom";
    let directory =
      kind === "root"
        ? Path.parse(base).root
        : kind === "repository"
          ? repository
          : kind === "ancestor"
            ? base
            : Path.join(repository, "nested");
    if (kind === "symlink-root") {
      directory = Path.join(base, "root-link");
      FS.symlinkSync(Path.parse(base).root, directory);
    }
    if (kind === "project-escape") {
      mode = "project";
      FS.mkdirSync(Path.join(repository, ".specwithcode"));
      FS.symlinkSync(base, Path.join(repository, ".specwithcode", "worktrees"));
    }
    await expect(
      resolve({
        ...input,
        settings: { worktreeLocationMode: mode, worktreesDirectory: directory },
      }),
    ).rejects.toThrow("unsafe");
  },
);
it("reuses a registered checkout across storage changes without touching retained edits", async () => {
  const { input, base, repository } = fixture();
  const original = Path.join(base, "old-custom", input.name);
  FS.mkdirSync(Path.dirname(original));
  git(repository, "worktree", "add", "-qb", "handoff/test", original);
  FS.writeFileSync(Path.join(original, "file.txt"), "retained dirty work\n");
  const result = await resolve({
    ...input,
    settings: { worktreeLocationMode: "custom", worktreesDirectory: "/" },
  });
  // Git reports forward slashes on Windows; compare the same native checkout path.
  expect({ ...result, worktreePath: Path.normalize(result.worktreePath) }).toEqual({
    worktreePath: original,
    existing: true,
  });
  expect(FS.readFileSync(Path.join(original, "file.txt"), "utf8")).toBe("retained dirty work\n");
  expect(FS.existsSync(input.defaultDirectory)).toBe(false);
});
it("rejects a destination folder absent from Git's worktree registry", async () => {
  const { input } = fixture();
  FS.mkdirSync(Path.join(input.defaultDirectory, input.name), { recursive: true });
  await expect(resolve(input)).rejects.toThrow("not a registered worktree");
});
it("rejects ambiguous registered handoff names instead of selecting a checkout", async () => {
  const { input, base, repository } = fixture();
  for (const parent of ["one", "two"]) {
    FS.mkdirSync(Path.join(base, parent));
    git(repository, "worktree", "add", "-qb", parent, Path.join(base, parent, input.name));
  }
  await expect(resolve(input)).rejects.toThrow("Several registered");
});
it("preserves a missing registered checkout as a recovery error", async () => {
  const { input, base, repository } = fixture();
  const original = Path.join(base, input.name);
  git(repository, "worktree", "add", "-qb", "handoff/missing", original);
  FS.rmSync(original, { recursive: true });
  await expect(resolve(input)).rejects.toThrow("registered handoff worktree is missing");
});
