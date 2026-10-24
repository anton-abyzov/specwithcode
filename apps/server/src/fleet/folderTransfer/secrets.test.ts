// @effect-diagnostics nodeBuiltinImport:off - disposable scratch folders only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  MAX_SECRET_FILE_BYTES,
  MAX_SECRET_FILES,
  SentSecretsLedger,
  SecretStepError,
  removeReceivedSecrets,
  selectSecretFiles,
  writeSecretFile,
} from "./secrets.ts";

let base: string;
beforeEach(() => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-secrets-")));
});
afterEach(() => NodeFS.rmSync(base, { recursive: true, force: true }));

const bytes = (text: string) => new TextEncoder().encode(text);
const code = (run: () => unknown) => {
  try {
    run();
  } catch (cause) {
    return cause instanceof SecretStepError ? cause.code : "other";
  }
  return null;
};

describe("selectSecretFiles", () => {
  const offered = [
    { path: ".env", size: 20 },
    { path: "svc/.env.local", size: 30 },
    { path: "big.pem", size: MAX_SECRET_FILE_BYTES + 1 },
  ];
  it("returns only offered files in the ticked order", () => {
    expect(selectSecretFiles(offered, ["svc/.env.local", ".env"])).toEqual([
      offered[1],
      offered[0],
    ]);
    expect(selectSecretFiles(offered, [])).toEqual([]);
  });
  it("refuses files the scan did not offer, duplicates, unsafe paths and limits", () => {
    expect(code(() => selectSecretFiles(offered, ["README.md"]))).toBe("not_offered");
    expect(code(() => selectSecretFiles([{ path: "../x", size: 1 }], ["../x"]))).toBe(
      "not_offered",
    );
    expect(code(() => selectSecretFiles(offered, [".env", ".env"]))).toBe("duplicate");
    expect(code(() => selectSecretFiles(offered, ["big.pem"]))).toBe("too_large");
    expect(
      code(() =>
        selectSecretFiles(
          offered,
          Array.from({ length: MAX_SECRET_FILES + 1 }, (_, index) => `f${index}`),
        ),
      ),
    ).toBe("too_many");
    const many = Array.from({ length: 17 }, (_, index) => ({
      path: `k${index}.pem`,
      size: MAX_SECRET_FILE_BYTES,
    }));
    expect(
      code(() =>
        selectSecretFiles(
          many,
          many.map((file) => file.path),
        ),
      ),
    ).toBe("too_large");
  });
});

describe("SentSecretsLedger", () => {
  it("keeps one line per operation and path and filters by destination", async () => {
    const ledger = new SentSecretsLedger(base);
    const entry = {
      operationId: "op-1",
      destinationEnvironmentId: "env-b",
      destinationLabel: "M3",
      folder: "/p",
      path: ".env",
      size: 3,
      sentAt: "2026-10-20T00:00:00.000Z",
    };
    await Promise.all([ledger.record(entry), ledger.record(entry)]);
    await ledger.record({ ...entry, destinationEnvironmentId: "env-c", operationId: "op-2" });
    expect(await ledger.list()).toHaveLength(2);
    expect((await ledger.list("env-b")).map((item) => item.operationId)).toEqual(["op-1"]);
    await ledger.close();
    const reread = new SentSecretsLedger(base);
    expect(await reread.list()).toHaveLength(2);
    await reread.close();
  });
});

describe("writeSecretFile", () => {
  const write = (path: string, text: string) =>
    writeSecretFile({ targetRoot: base, path, bytes: bytes(text), sourceMachine: "m4" });

  it("writes new files with mode 0600 and creates parent folders", async () => {
    const result = await write("svc/config/.env", "A=1\n");
    expect(result).toMatchObject({ state: "written", writtenAs: "svc/config/.env", size: 4 });
    const stat = NodeFS.statSync(NodePath.join(base, "svc/config/.env"));
    // Windows has no POSIX mode bits to check.
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
    expect(NodeFS.readdirSync(NodePath.join(base, "svc/config"))).toEqual([".env"]);
  });

  it("leaves identical files alone and puts different ones beside", async () => {
    NodeFS.writeFileSync(NodePath.join(base, ".env"), "A=1\n");
    expect((await write(".env", "A=1\n")).state).toBe("unchanged");
    const beside = await write(".env", "A=2\n");
    expect(beside).toMatchObject({ state: "beside", writtenAs: ".env.from-m4" });
    expect(NodeFS.readFileSync(NodePath.join(base, ".env"), "utf8")).toBe("A=1\n");
    expect(NodeFS.readFileSync(NodePath.join(base, ".env.from-m4"), "utf8")).toBe("A=2\n");
  });

  it("never replaces an earlier file beside it, and Undo leaves that file alone", async () => {
    NodeFS.writeFileSync(NodePath.join(base, ".env"), "A=1\n");
    NodeFS.writeFileSync(NodePath.join(base, ".env.from-m4"), "EARLIER=1\n");
    const beside = await write(".env", "A=3\n");
    expect(beside).toMatchObject({ state: "beside", writtenAs: ".env.from-m4-2" });
    expect(NodeFS.readFileSync(NodePath.join(base, ".env.from-m4-2"), "utf8")).toBe("A=3\n");
    expect(await removeReceivedSecrets(base, [beside])).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(base, ".env.from-m4-2"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(base, ".env.from-m4"), "utf8")).toBe("EARLIER=1\n");
  });

  it("refuses unsafe paths and links on the way", async () => {
    await expect(write("../escape", "x")).rejects.toThrow(/unsafe/);
    await expect(write("/abs", "x")).rejects.toThrow(/unsafe/);
    const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-outside-"));
    try {
      NodeFS.symlinkSync(outside, NodePath.join(base, "linked"));
      await expect(write("linked/.env", "x")).rejects.toThrow(/link or a file/);
      NodeFS.symlinkSync(NodePath.join(outside, "target"), NodePath.join(base, ".env"));
      const result = await write(".env", "x");
      expect(result.state).toBe("beside");
      expect(NodeFS.existsSync(NodePath.join(outside, "target"))).toBe(false);
      expect(NodeFS.readdirSync(outside)).toEqual([]);
    } finally {
      NodeFS.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("removeReceivedSecrets", () => {
  it("removes files this copy created and keeps edited or pre-existing ones", async () => {
    const created = await writeSecretFile({
      targetRoot: base,
      path: ".env",
      bytes: bytes("A=1\n"),
      sourceMachine: "m4",
    });
    const edited = await writeSecretFile({
      targetRoot: base,
      path: "svc/.env",
      bytes: bytes("B=1\n"),
      sourceMachine: "m4",
    });
    NodeFS.writeFileSync(NodePath.join(base, "kept.pem"), "k");
    const unchanged = await writeSecretFile({
      targetRoot: base,
      path: "kept.pem",
      bytes: bytes("k"),
      sourceMachine: "m4",
    });
    NodeFS.writeFileSync(NodePath.join(base, "svc/.env"), "B=edited-by-hand\n");
    const kept = await removeReceivedSecrets(base, [created, edited, unchanged]);
    expect(kept).toEqual(["svc/.env"]);
    expect(NodeFS.existsSync(NodePath.join(base, ".env"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(base, "svc/.env"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(base, "kept.pem"))).toBe(true);
  });
});

describe("secretsSentTo", () => {
  it("lists each file sent to the removed machine once, across state folders", async () => {
    const { secretsSentTo } = await import("./secretsReport.ts");
    const entry = {
      operationId: "op-1",
      destinationEnvironmentId: "env-b",
      destinationLabel: "M3",
      folder: "/p",
      path: ".env",
      size: 3,
      sentAt: "2026-10-20T00:00:00.000Z",
    };
    const user = new SentSecretsLedger(NodePath.join(base, "userdata", "machine-handoffs"));
    NodeFS.mkdirSync(NodePath.join(base, "userdata", "machine-handoffs"), { recursive: true });
    await user.record(entry);
    await user.record({ ...entry, operationId: "op-2" });
    await user.record({ ...entry, path: "other.pem", destinationEnvironmentId: "env-c" });
    await user.close();
    expect((await secretsSentTo(base, "env-b")).map((item) => item.path)).toEqual([".env"]);
    expect(await secretsSentTo(base, "env-z")).toEqual([]);
  });
});
