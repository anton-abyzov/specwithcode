import { verifyDpopProof } from "@specweave-studio/shared/dpop";
import { afterEach, describe, expect, it } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- real file modes and links exercise the key file checks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { join } from "../nodePath.ts";
import {
  FLEET_PROOF_KEY_FILE,
  loadOrCreateFleetProofKey,
  readFleetProofKey,
  tokenProofThumbprint,
} from "./fleetProofKey.ts";

const dirs: string[] = [];
const home = async () => {
  const dir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "studio-fleet-key-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});
const posix = process.platform !== "win32";

describe("this machine's fleet proof key", () => {
  it("is made once, owner-only, and read back as the same key", async () => {
    const baseDir = await home();
    expect(await readFleetProofKey(baseDir)).toBeNull();
    const made = await loadOrCreateFleetProofKey(baseDir);
    if (posix)
      expect((await NodeFSP.stat(join(baseDir, FLEET_PROOF_KEY_FILE))).mode & 0o777).toBe(0o600);
    expect((await readFleetProofKey(baseDir))?.thumbprint).toBe(made.thumbprint);
    expect((await loadOrCreateFleetProofKey(baseDir)).thumbprint).toBe(made.thumbprint);
    // No temp file is left behind.
    expect(await NodeFSP.readdir(baseDir)).toEqual([FLEET_PROOF_KEY_FILE]);
  });

  it("ends up with one key when two callers make it at once", async () => {
    const baseDir = await home();
    const keys = await Promise.all(
      Array.from({ length: 8 }, () => loadOrCreateFleetProofKey(baseDir)),
    );
    expect(new Set(keys.map((key) => key.thumbprint)).size).toBe(1);
  });

  it.skipIf(!posix)("refuses a group-readable file or a link", async () => {
    const baseDir = await home();
    await loadOrCreateFleetProofKey(baseDir);
    const path = join(baseDir, FLEET_PROOF_KEY_FILE);
    await NodeFSP.chmod(path, 0o640);
    await expect(readFleetProofKey(baseDir)).rejects.toThrow("securely");
    await expect(loadOrCreateFleetProofKey(baseDir)).rejects.toThrow("securely");
    const other = await home();
    await NodeFSP.chmod(path, 0o600);
    await NodeFSP.symlink(path, join(other, FLEET_PROOF_KEY_FILE));
    await expect(readFleetProofKey(other)).rejects.toThrow("securely");
  });

  it("signs proofs the worker's verifier accepts, bound to the token", async () => {
    const key = await loadOrCreateFleetProofKey(await home());
    const url = "https://prod-0123456789abcdef.spec-weave.com/api/auth/session";
    const token = "claims.signature";
    const proof = await key.proof({ method: "get", url, accessToken: token });
    const verified = verifyDpopProof({
      proof,
      method: "GET",
      url,
      // @effect-diagnostics-next-line globalDate:off - the verifier takes wall-clock seconds.
      nowEpochSeconds: Math.floor(Date.now() / 1000),
      expectedAccessToken: token,
      expectedThumbprint: key.thumbprint,
    });
    expect(verified).toMatchObject({ ok: true });
  });

  it("reads the key a token is bound to from its claims", () => {
    const token = (claims: object) =>
      `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    expect(tokenProofThumbprint(token({ sid: "s", jkt: "thumb" }))).toBe("thumb");
    expect(tokenProofThumbprint(token({ sid: "s" }))).toBeUndefined();
    expect(tokenProofThumbprint("not-a-token")).toBeUndefined();
    expect(tokenProofThumbprint("a.b.c")).toBeUndefined();
  });
});
