// @effect-diagnostics nodeBuiltinImport:off - the test builds links and folders the store must refuse.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { newDesignSystem } from "@specweave-studio/shared/designSystemOps";
import { symlinksSupported } from "@specweave-studio/shared/testing/symlinks";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Windows has no O_NOFOLLOW. Take it away here so the lstat guard is what refuses a link.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { O_NOFOLLOW: _dropped, ...constants } = actual.constants;
  return { ...actual, constants, default: { ...actual, constants } };
});

const { DesignStoreProblem, resolveDesignRoot, writeDesignSystem } =
  await import("../DesignStore.ts");
const { readSystemFile } = await import("./SystemFilesStore.ts");
const { DESIGN_MOVED_DIR, readForward } = await import("../DesignMove.ts");

const SYSTEM = "s_weave";
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

const tempDir = async (prefix: string) => {
  const dir = await NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};

async function systemFolder() {
  const checkout = await tempDir("studio-system-nofollow-");
  const root = (await resolveDesignRoot(checkout, ".specweave/design", { create: true }))!;
  await writeDesignSystem(
    root,
    newDesignSystem({ id: SYSTEM, name: "Weave", now: "2026-10-24T10:00:00.000Z" }),
    { expectedRevision: null, actor: { kind: "user" } },
  );
  const files = NodePath.join(root, "systems", SYSTEM, "files");
  await NodeFSP.mkdir(files);
  return { root, files };
}

describe("stored reads without O_NOFOLLOW (Windows)", () => {
  it.skipIf(!symlinksSupported)(
    "refuses a symlinked file and reads nothing through it",
    async () => {
      const { root, files } = await systemFolder();
      const outside = NodePath.join(await tempDir("studio-system-outside-"), "secret.txt");
      await NodeFSP.writeFile(outside, "top secret");
      await NodeFSP.symlink(outside, NodePath.join(files, "notes.txt"));

      const error = await readSystemFile(root, SYSTEM, "notes.txt").then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(DesignStoreProblem);
      expect((error as InstanceType<typeof DesignStoreProblem>).code).toBe("invalid");
    },
  );

  it("still reads a plain file and reports a missing one", async () => {
    const { root, files } = await systemFolder();
    await NodeFSP.writeFile(NodePath.join(files, "notes.txt"), "hello");
    const read = await readSystemFile(root, SYSTEM, "notes.txt");
    expect(read.bytes.toString("utf8")).toBe("hello");
    const missing = await readSystemFile(root, SYSTEM, "gone.txt").then(
      () => null,
      (cause: unknown) => cause,
    );
    expect((missing as InstanceType<typeof DesignStoreProblem>).code).toBe("not_found");
  });

  it.skipIf(!symlinksSupported)("never follows a linked forward record", async () => {
    const playground = await tempDir("studio-forward-nofollow-");
    await NodeFSP.mkdir(NodePath.join(playground, DESIGN_MOVED_DIR));
    const forward = {
      to: { kind: "project", projectId: "project-a" },
      designId: "d_moved",
      movedAt: "2026-10-24T10:00:00.000Z",
      actor: { kind: "user" },
    };
    const outside = NodePath.join(await tempDir("studio-forward-outside-"), "forward.json");
    await NodeFSP.writeFile(outside, JSON.stringify(forward));
    const record = NodePath.join(playground, DESIGN_MOVED_DIR, "d_moved.json");
    await NodeFSP.symlink(outside, record);
    expect(await readForward(playground, "d_moved")).toBeNull();
    // The same record as a plain file is read, so the refusal above is the link's.
    await NodeFSP.rm(record);
    await NodeFSP.writeFile(record, JSON.stringify(forward));
    expect(await readForward(playground, "d_moved")).toEqual(forward);
  });
});
