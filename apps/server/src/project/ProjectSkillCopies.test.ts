import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProviderDriverKind, ProviderInstanceId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { afterEach, describe, expect, it } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- isolated filesystem fixture.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "../nodePath.ts";
import type { ProjectSkillsActionsDeps } from "./ProjectSkillsActionsCommon.ts";
import { makeProjectSkillCopies } from "./ProjectSkillCopies.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(alter?: (service: FileSystem.FileSystem) => FileSystem.FileSystem) {
  const root = await fs.mkdtemp(join(os.tmpdir(), "skill-copies-"));
  roots.push(root);
  const a = join(root, ".agents/skills/notes/SKILL.md"),
    b = join(root, ".claude/skills/notes/SKILL.md");
  await fs.mkdir(join(a, ".."), { recursive: true });
  await fs.mkdir(join(b, ".."), { recursive: true });
  await fs.writeFile(a, "# Notes\nFirst copy\n");
  await fs.writeFile(b, "# Notes\nSecond copy\n");
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      label: "Codex",
      path: a,
      scope: "project",
      enabled: true,
      fileVersion: "1.0.0",
    },
    {
      instanceId: ProviderInstanceId.make("claude"),
      driver: ProviderDriverKind.make("claudeAgent"),
      label: "Claude",
      path: b,
      scope: "project",
      enabled: true,
      fileVersion: "1.0.0",
    },
  ];
  let refreshed = 0;
  const projectId = ProjectId.make("copy-fixture");
  const deps: ProjectSkillsActionsDeps = {
    home: root,
    environment: {},
    platform: process.platform,
    backupDir: undefined,
    resolveRow: () =>
      Effect.succeed({
        projectId,
        cwd: root,
        row: {
          name: "notes",
          status: "ok",
          attention: false,
          issues: [],
          path: a,
          scopes: ["project"],
          providers,
          lock: null,
          drift: "unlocked",
          copies: 2,
          divergent: true,
          doctor: [],
        },
      }),
    agentControl: () => Effect.succeed(undefined),
    codexClient: () => Effect.die("not used"),
    afterWrite: () =>
      Effect.sync(() => {
        refreshed++;
      }),
  };
  const api = await Effect.runPromise(
    Effect.gen(function* () {
      const native = yield* FileSystem.FileSystem;
      return yield* makeProjectSkillCopies(deps).pipe(
        Effect.provideService(FileSystem.FileSystem, alter ? alter(native) : native),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  const input = { projectId, skill: "notes" };
  const call = (extra: Parameters<typeof api.execute>[0]) => Effect.runPromise(api.execute(extra));
  return { root, a, b, providers, input, call, refreshed: () => refreshed };
}
describe("inventory-bound skill copies", () => {
  it("reads distinct copies and groups agents sharing a canonical path", async () => {
    const f = await fixture();
    f.providers.push({
      ...f.providers[0]!,
      instanceId: ProviderInstanceId.make("second"),
      label: "Second",
    });
    const result = await f.call({ ...f.input, operation: "read" });
    expect(result.copies).toHaveLength(2);
    expect(result.copies[0]?.agents).toHaveLength(2);
    expect(result.copies[0]?.content).toContain("First copy");
  });
  it("previews without writes, then replaces only selected copies and refreshes discovery", async () => {
    const f = await fixture();
    const read = await f.call({ ...f.input, operation: "read" });
    const select = { ...f.input, sourceId: read.copies[0]!.id, targetIds: [read.copies[1]!.id] };
    const preview = await f.call({ ...select, operation: "preview" });
    expect(await fs.readFile(f.b, "utf8")).toContain("Second copy");
    const applied = await f.call({ ...select, operation: "apply", expected: preview.expected! });
    expect(applied._tag).toBe("applied");
    expect(await fs.readFile(f.b, "utf8")).toEqual(await fs.readFile(f.a, "utf8"));
    expect(f.refreshed()).toBe(1);
  });
  it.each(["source", "target"])("refuses a stale %s without writing", async (changed) => {
    const f = await fixture();
    const read = await f.call({ ...f.input, operation: "read" });
    const select = { ...f.input, sourceId: read.copies[0]!.id, targetIds: [read.copies[1]!.id] };
    const preview = await f.call({ ...select, operation: "preview" });
    await fs.writeFile(changed === "source" ? f.a : f.b, "new content");
    await expect(
      f.call({ ...select, operation: "apply", expected: preview.expected! }),
    ).rejects.toMatchObject({ reason: "stale" });
    expect(await fs.readFile(f.b, "utf8")).toContain(
      changed === "source" ? "Second copy" : "new content",
    );
  });
  it("does not accept caller paths or unknown ids", async () => {
    const f = await fixture();
    await expect(
      f.call({ ...f.input, operation: "preview", sourceId: f.a, targetIds: [f.b] }),
    ).rejects.toMatchObject({ reason: "scope_unsupported" });
  });
  it("refuses plugin-managed destinations", async () => {
    const f = await fixture();
    Object.assign(f.providers[1]!, { pluginVersion: "1.0.0" });
    const read = await f.call({ ...f.input, operation: "read" });
    expect(read.copies[1]?.writable).toBe(false);
    await expect(
      f.call({
        ...f.input,
        operation: "preview",
        sourceId: read.copies[0]!.id,
        targetIds: [read.copies[1]!.id],
      }),
    ).rejects.toMatchObject({ reason: "scope_unsupported" });
  });
  it("refuses an inventory path outside both authorized roots", async () => {
    const f = await fixture();
    const other = await fixture();
    f.providers[0]!.path = other.a;
    await expect(f.call({ ...f.input, operation: "read" })).rejects.toMatchObject({
      reason: "scope_unsupported",
    });
  });
  it("allows in-root link reads but refuses replacing their targets", async () => {
    const f = await fixture();
    const alias = join(f.root, "alias", "SKILL.md");
    await fs.mkdir(join(alias, ".."));
    await fs.symlink(f.b, alias);
    f.providers[1]!.path = alias;
    const read = await f.call({ ...f.input, operation: "read" });
    await expect(
      f.call({
        ...f.input,
        operation: "preview",
        sourceId: read.copies[0]!.id,
        targetIds: [read.copies[1]!.id],
      }),
    ).rejects.toMatchObject({ reason: "scope_unsupported" });
    expect(await fs.readFile(f.b, "utf8")).toContain("Second copy");
  });
  it("refuses oversized text", async () => {
    const f = await fixture();
    await fs.writeFile(f.a, "x".repeat(512 * 1024 + 1));
    await expect(f.call({ ...f.input, operation: "read" })).rejects.toMatchObject({
      reason: "scope_unsupported",
    });
  });
});

describe("multi-copy reconciliation", () => {
  const addThird = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const c = join(f.root, "third", "SKILL.md");
    await fs.mkdir(join(c, ".."));
    await fs.writeFile(c, "third original");
    f.providers.push({ ...f.providers[1]!, path: c, instanceId: ProviderInstanceId.make("third") });
    return c;
  };
  it("checks all targets before writing even when a later target changes during preflight", async () => {
    let armed = false,
      reads = 0,
      c = "";
    const f = await fixture((native) => ({
      ...native,
      open: (path, options) =>
        Effect.gen(function* () {
          if (armed && path.includes(".agents") && options?.flag === "r" && ++reads === 2) {
            armed = false;
            yield* Effect.promise(() => fs.writeFile(c, "changed during validation"));
          }
          return yield* native.open(path, options);
        }),
    }));
    c = await addThird(f);
    const read = await f.call({ ...f.input, operation: "read" });
    const select = {
      ...f.input,
      sourceId: read.copies[0]!.id,
      targetIds: read.copies.slice(1).map((copy) => copy.id),
    };
    const preview = await f.call({ ...select, operation: "preview" });
    armed = true;
    await expect(
      f.call({ ...select, operation: "apply", expected: preview.expected! }),
    ).rejects.toMatchObject({ reason: "stale" });
    expect(await fs.readFile(f.b, "utf8")).toContain("Second copy");
    expect(f.refreshed()).toBe(0);
  });
  it("returns applied/failed/not-applied receipts and refreshes successful targets after a later rename fails", async () => {
    let blocked = "";
    const f = await fixture((native) => ({
      ...native,
      rename: (from, to) =>
        to === blocked ? FileSystem.makeNoop({}).rename(from, to) : native.rename(from, to),
    }));
    const c = await addThird(f);
    blocked = await fs.realpath(c);
    const d = join(f.root, "fourth", "SKILL.md");
    await fs.mkdir(join(d, ".."));
    await fs.writeFile(d, "fourth original");
    f.providers.push({
      ...f.providers[1]!,
      path: d,
      instanceId: ProviderInstanceId.make("fourth"),
    });
    const read = await f.call({ ...f.input, operation: "read" });
    const select = {
      ...f.input,
      sourceId: read.copies[0]!.id,
      targetIds: read.copies.slice(1).map((copy) => copy.id),
    };
    const preview = await f.call({ ...select, operation: "preview" });
    const result = await f.call({ ...select, operation: "apply", expected: preview.expected! });
    expect(result._tag).toBe("partial");
    expect(result.receipts?.map((r) => r.status)).toEqual(["applied", "failed", "not_applied"]);
    expect(await fs.readFile(f.b, "utf8")).toEqual(await fs.readFile(f.a, "utf8"));
    expect(await fs.readFile(c, "utf8")).toBe("third original");
    expect(await fs.readFile(d, "utf8")).toBe("fourth original");
    expect(f.refreshed()).toBe(1);
  });
  it("preserves BOM bytes and destination mode", async () => {
    const f = await fixture();
    await fs.writeFile(f.a, "\uFEFF# Notes\nOriginal bytes\n");
    await fs.chmod(f.b, 0o644);
    const read = await f.call({ ...f.input, operation: "read" });
    const select = { ...f.input, sourceId: read.copies[0]!.id, targetIds: [read.copies[1]!.id] };
    const preview = await f.call({ ...select, operation: "preview" });
    await f.call({ ...select, operation: "apply", expected: preview.expected! });
    expect(await fs.readFile(f.b)).toEqual(await fs.readFile(f.a));
    if (process.platform !== "win32") expect((await fs.stat(f.b)).mode & 0o777).toBe(0o644);
  });
  it("bounds aggregate copy contents", async () => {
    const f = await fixture();
    await fs.writeFile(f.a, "a".repeat(500 * 1024));
    await fs.writeFile(f.b, "b".repeat(500 * 1024));
    for (let i = 0; i < 3; i++) {
      const file = join(f.root, `extra-${i}`, "SKILL.md");
      await fs.mkdir(join(file, ".."));
      await fs.writeFile(file, "x".repeat(500 * 1024));
      f.providers.push({ ...f.providers[0]!, path: file });
    }
    await expect(f.call({ ...f.input, operation: "read" })).rejects.toThrow(
      "combined skill copies exceed 2 MB",
    );
  });
});
