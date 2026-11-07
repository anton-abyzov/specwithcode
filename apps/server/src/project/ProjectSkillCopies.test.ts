import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProviderDriverKind, ProviderInstanceId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
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
async function fixture() {
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
    makeProjectSkillCopies(deps).pipe(Effect.provide(NodeServices.layer)),
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
