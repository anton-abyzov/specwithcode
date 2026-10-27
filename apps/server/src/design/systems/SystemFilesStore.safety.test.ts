// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DESIGN_SYSTEM_FILE_MAX_BYTES } from "@specweave-studio/contracts";
import { newDesignSystem } from "@specweave-studio/shared/designSystemOps";
import { symlinksSupported } from "@specweave-studio/shared/testing/symlinks";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { DesignStoreProblem, resolveDesignRoot, writeDesignSystem } from "../DesignStore.ts";
import {
  deleteSystemFile,
  listSystemFiles,
  moveSystemFile,
  putSystemFile,
  readSystemFile,
} from "./SystemFilesStore.ts";

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

/** A design root holding one empty system, and the system's folder. */
async function systemRoot() {
  const checkout = await tempDir("studio-system-files-");
  const root = (await resolveDesignRoot(checkout, ".specweave/design", { create: true }))!;
  await writeDesignSystem(
    root,
    newDesignSystem({ id: SYSTEM, name: "Weave", now: "2026-10-24T10:00:00.000Z" }),
    { expectedRevision: null, actor: { kind: "user" } },
  );
  return { root, folder: NodePath.join(root, "systems", SYSTEM) };
}

const text = (value: string) => new TextEncoder().encode(value);

const refusal = async (run: Promise<unknown>) => {
  const error = await run.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(DesignStoreProblem);
  return error as DesignStoreProblem;
};

const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

describe("SystemFilesStore paths", () => {
  it.each([
    ["../system.json"],
    ["assets/../../system.json"],
    ["/etc/passwd.txt"],
    ["./README.md"],
    ["assets/./logo.svg"],
    [".hidden/logo.svg"],
    ["assets/.logo.svg"],
    [".env"],
    ["config/.env"],
    ["id_rsa"],
    ["keys/id_rsa.pub"],
    ["server.pem"],
    ["tool.exe"],
    ["script.js"],
    ["README"],
    ["AGENTS.md"],
    ["docs/CLAUDE.md"],
    ["node_modules/a.md"],
    ["a//b.md"],
    ["assets\\logo.svg"],
    ["a/b/c/d/e.md"],
    ["trailing. /a.md"],
  ])("refuses %s on every operation and writes nothing", async (path) => {
    const { root, folder } = await systemRoot();
    expect((await refusal(putSystemFile(root, SYSTEM, path, text("x")))).code).toBe("invalid");
    expect((await refusal(readSystemFile(root, SYSTEM, path))).code).toBe("invalid");
    expect((await refusal(deleteSystemFile(root, SYSTEM, path))).code).toBe("invalid");
    expect((await refusal(moveSystemFile(root, SYSTEM, "README.md", path))).code).toBe("invalid");
    expect(await exists(NodePath.join(folder, "files"))).toBe(false);
  });

  it("keeps a stored file when an import writes the same name only if absent", async () => {
    const { root } = await systemRoot();
    await putSystemFile(root, SYSTEM, "README.md", text("by hand"));
    const kept = await putSystemFile(root, SYSTEM, "readme.md", text("imported"), undefined, {
      ifAbsent: true,
    });
    expect(kept.path).toBe("README.md");
    expect(new TextDecoder().decode((await readSystemFile(root, SYSTEM, "README.md")).bytes)).toBe(
      "by hand",
    );
    await putSystemFile(root, SYSTEM, "docs/usage.md", text("new"), undefined, { ifAbsent: true });
    expect((await listSystemFiles(root, SYSTEM)).files.map((file) => file.path)).toEqual([
      "README.md",
      "docs/usage.md",
    ]);
  });

  it("refuses a system id that names a path", async () => {
    const { root } = await systemRoot();
    for (const id of ["../systems", "systems", "s/x"]) {
      expect((await refusal(putSystemFile(root, id, "README.md", text("x")))).code).toBe("invalid");
    }
    expect((await refusal(listSystemFiles(root, "s_missing"))).code).toBe("not_found");
  });

  it("accepts nested asset sets up to four names deep, case-insensitive extensions included", async () => {
    const { root } = await systemRoot();
    await putSystemFile(root, SYSTEM, "assets/Brand (2026)/Logos/mark.SVG", text("<svg/>"));
    expect((await listSystemFiles(root, SYSTEM)).files).toMatchObject([
      { path: "assets/Brand (2026)/Logos/mark.SVG", mimeType: "image/svg+xml", bytes: 6 },
    ]);
  });
});

describe("SystemFilesStore links", () => {
  it.skipIf(!symlinksSupported)("refuses a symlinked file for read, write and delete", async () => {
    const { root, folder } = await systemRoot();
    const outside = NodePath.join(await tempDir("studio-system-outside-"), "secret.txt");
    await NodeFSP.writeFile(outside, "top secret");
    await NodeFSP.mkdir(NodePath.join(folder, "files"));
    await NodeFSP.symlink(outside, NodePath.join(folder, "files", "notes.txt"));

    expect((await refusal(readSystemFile(root, SYSTEM, "notes.txt"))).code).toBe("invalid");
    expect((await refusal(putSystemFile(root, SYSTEM, "notes.txt", text("x")))).code).toBe(
      "invalid",
    );
    expect((await refusal(deleteSystemFile(root, SYSTEM, "notes.txt"))).code).toBe("invalid");
    expect((await refusal(moveSystemFile(root, SYSTEM, "notes.txt", "moved.txt"))).code).toBe(
      "invalid",
    );
    expect((await listSystemFiles(root, SYSTEM)).files).toEqual([]);
    expect(await NodeFSP.readFile(outside, "utf8")).toBe("top secret");
  });

  it.skipIf(!symlinksSupported)(
    "refuses a symlinked files folder and never writes through it",
    async () => {
      const { root, folder } = await systemRoot();
      const outside = await tempDir("studio-system-outside-");
      await NodeFSP.writeFile(NodePath.join(outside, "README.md"), "outside");
      await NodeFSP.symlink(outside, NodePath.join(folder, "files"));

      expect((await refusal(putSystemFile(root, SYSTEM, "new.md", text("x")))).code).toBe(
        "invalid",
      );
      expect((await refusal(readSystemFile(root, SYSTEM, "README.md"))).code).toBe("invalid");
      expect((await refusal(listSystemFiles(root, SYSTEM))).code).toBe("invalid");
      expect(await NodeFSP.readdir(outside)).toEqual(["README.md"]);
    },
  );

  it.skipIf(!symlinksSupported)("refuses a symlinked asset set folder", async () => {
    const { root, folder } = await systemRoot();
    const outside = await tempDir("studio-system-outside-");
    await NodeFSP.mkdir(NodePath.join(folder, "files", "assets"), { recursive: true });
    await NodeFSP.symlink(outside, NodePath.join(folder, "files", "assets", "Logos"));

    expect(
      (await refusal(putSystemFile(root, SYSTEM, "assets/Logos/mark.svg", text("<svg/>")))).code,
    ).toBe("invalid");
    expect((await listSystemFiles(root, SYSTEM)).files).toEqual([]);
    expect(await NodeFSP.readdir(outside)).toEqual([]);
  });

  it.skipIf(!symlinksSupported)("refuses a symlinked system folder", async () => {
    const { root } = await systemRoot();
    const other = await tempDir("studio-system-other-");
    await NodeFSP.writeFile(NodePath.join(other, "system.json"), "{}");
    await NodeFSP.symlink(other, NodePath.join(root, "systems", "s_linked"));
    expect((await refusal(putSystemFile(root, "s_linked", "a.md", text("x")))).code).toBe(
      "invalid",
    );
    expect(await NodeFSP.readdir(other)).toEqual(["system.json"]);
  });
});

describe("SystemFilesStore limits", () => {
  it("never replaces a stored file through a name that differs only in case", async () => {
    const { root } = await systemRoot();
    await putSystemFile(root, SYSTEM, "assets/Brand/logo.svg", text("<svg>a</svg>"));
    const caseInsensitive = await NodeFSP.lstat(
      NodePath.join(root, "systems", SYSTEM, "files", "assets", "Brand", "LOGO.svg"),
    ).then(
      () => true,
      () => false,
    );
    if (caseInsensitive) {
      expect(
        (await refusal(putSystemFile(root, SYSTEM, "assets/Brand/LOGO.svg", text("<svg>b</svg>"))))
          .code,
      ).toBe("conflict");
    } else {
      await putSystemFile(root, SYSTEM, "assets/Brand/LOGO.svg", text("<svg>b</svg>"));
    }
    // The original keeps its bytes either way, and replacing it by its own name still works.
    const read = await readSystemFile(root, SYSTEM, "assets/Brand/logo.svg");
    expect(Buffer.from(read.bytes).toString()).toBe("<svg>a</svg>");
    await putSystemFile(root, SYSTEM, "assets/Brand/logo.svg", text("<svg>c</svg>"));
  });

  it("writes into an existing folder named with other letter case", async () => {
    const { root } = await systemRoot();
    await putSystemFile(root, SYSTEM, "assets/Brand/logo.svg", text("<svg>a</svg>"));
    // On a case-insensitive disk this lands in Brand; on a case-sensitive one in a new brand.
    await putSystemFile(root, SYSTEM, "assets/brand/mark.svg", text("<svg>m</svg>"));
    await moveSystemFile(root, SYSTEM, "assets/brand/mark.svg", "assets/BRAND/mark2.svg");
    const paths = (await listSystemFiles(root, SYSTEM)).files.map((file) =>
      file.path.toLowerCase(),
    );
    expect(paths).toEqual(
      expect.arrayContaining(["assets/brand/logo.svg", "assets/brand/mark2.svg"]),
    );
    await deleteSystemFile(root, SYSTEM, "assets/BRAND/mark2.svg");
    expect((await listSystemFiles(root, SYSTEM)).files.map((file) => file.path)).toEqual([
      "assets/Brand/logo.svg",
    ]);
  });

  it("refuses a file over 10 MiB", async () => {
    const { root } = await systemRoot();
    const big = new Uint8Array(DESIGN_SYSTEM_FILE_MAX_BYTES + 1);
    expect((await refusal(putSystemFile(root, SYSTEM, "assets/big.png", big))).code).toBe(
      "too_large",
    );
    expect((await listSystemFiles(root, SYSTEM)).files).toEqual([]);
  });

  it("refuses a file placed by hand over 10 MiB when it is read", async () => {
    const { root, folder } = await systemRoot();
    await NodeFSP.mkdir(NodePath.join(folder, "files"));
    await NodeFSP.writeFile(
      NodePath.join(folder, "files", "huge.pdf"),
      new Uint8Array(DESIGN_SYSTEM_FILE_MAX_BYTES + 1),
    );
    expect((await refusal(readSystemFile(root, SYSTEM, "huge.pdf"))).code).toBe("too_large");
  });

  it("holds the file count, counting a replacement once", async () => {
    const { root } = await systemRoot();
    const limits = { maxFiles: 2, maxBytes: 1024 };
    await putSystemFile(root, SYSTEM, "a.md", text("a"), limits);
    await putSystemFile(root, SYSTEM, "b.md", text("b"), limits);
    const refused = await refusal(putSystemFile(root, SYSTEM, "c.md", text("c"), limits));
    expect(refused.code).toBe("too_large");
    expect(refused.message).toBe("A design system keeps at most 2 files. Delete some first.");
    await putSystemFile(root, SYSTEM, "a.md", text("again"), limits);
    expect((await listSystemFiles(root, SYSTEM)).files.map((file) => file.path)).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  it("holds the total size, counting a replacement's new size only", async () => {
    const { root } = await systemRoot();
    const limits = { maxFiles: 100, maxBytes: 10 };
    await putSystemFile(root, SYSTEM, "a.txt", text("123456"), limits);
    const refused = await refusal(putSystemFile(root, SYSTEM, "b.txt", text("123456"), limits));
    expect(refused.code).toBe("too_large");
    expect(refused.message).toBe(
      "This design system's files would be over 10 bytes. Delete some first.",
    );
    await putSystemFile(root, SYSTEM, "a.txt", text("1234567890"), limits);
    expect((await listSystemFiles(root, SYSTEM)).usedBytes).toBe(10);
  });

  it("leaves no temp file or empty folder behind after a refused write", async () => {
    const { root, folder } = await systemRoot();
    const limits = { maxFiles: 100, maxBytes: 1 };
    await refusal(putSystemFile(root, SYSTEM, "assets/Icons/a.svg", text("<svg/>"), limits));
    expect(await NodeFSP.readdir(NodePath.join(folder, "files"))).toEqual([]);
  });
});

describe("SystemFilesStore listing", () => {
  it("lists plain files sorted by path and skips dot files, links and stray names", async () => {
    const { root, folder } = await systemRoot();
    await putSystemFile(root, SYSTEM, "README.md", text("# Weave"));
    await putSystemFile(root, SYSTEM, "assets/Logos/mark.png", new Uint8Array([137, 80, 78, 71]));
    await putSystemFile(root, SYSTEM, "fonts/Inter.woff2", new Uint8Array([1, 2, 3]));
    const files = NodePath.join(folder, "files");
    await NodeFSP.writeFile(NodePath.join(files, ".DS_Store"), "x");
    await NodeFSP.writeFile(NodePath.join(files, "notes"), "no extension");
    await NodeFSP.writeFile(NodePath.join(files, "run.sh"), "echo");
    const listed = await listSystemFiles(root, SYSTEM);
    expect(listed.files.map((file) => [file.path, file.mimeType, file.origin])).toEqual([
      ["README.md", "text/markdown", "stored"],
      ["assets/Logos/mark.png", "image/png", "stored"],
      ["fonts/Inter.woff2", "font/woff2", "stored"],
    ]);
    expect(listed.usedBytes).toBe(7 + 4 + 3);
  });
});
