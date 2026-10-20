#!/usr/bin/env node
// Checks the iOS app's DPoP proofs with the relay's own verifier
// (packages/shared/src/dpop.ts), so Swift and TypeScript cannot drift.
//
//   node apps/ios/Tools/verify-dpop-vectors.mjs
//
// Generates proofs with `swift test` (DpopTests.writesVectorsForTheRelayVerifier),
// installs the verifier's pinned dependencies into a temporary folder, and
// verifies every proof, then confirms that tampered proofs are rejected.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const shared = join(repo, "packages/shared/src");
const work = mkdtempSync(join(tmpdir(), "swc-dpop-"));

try {
  const catalog = readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8");
  const pin = (name) => {
    const match = catalog.match(
      new RegExp(`^\\s*"?${name.replace("/", "\\/")}"?:\\s*([^\\s#]+)`, "m"),
    );
    if (!match) throw new Error(`No catalog version for ${name}`);
    return match[1].replace(/^["']|["']$/g, "");
  };
  const dependencies = Object.fromEntries(
    ["effect", "@noble/curves", "@noble/hashes"].map((name) => [name, pin(name)]),
  );
  writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module", dependencies }));
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund"], {
    cwd: work,
    stdio: "inherit",
  });
  for (const file of ["dpop.ts", "dpopCommon.ts", "relaySigning.ts"])
    copyFileSync(join(shared, file), join(work, file));

  const vectorsPath = join(work, "vectors.json");
  execFileSync("swift", ["test", "--filter", "DpopTests/writesVectorsForTheRelayVerifier"], {
    cwd: join(repo, "apps/ios/SWCKit"),
    env: { ...process.env, SWC_DPOP_VECTORS_OUT: vectorsPath },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));
  if (vectors.length === 0) throw new Error("swift test wrote no vectors");

  const { verifyDpopProof } = await import(pathToFileURL(join(work, "dpop.ts")).href);
  let failures = 0;
  for (const vector of vectors) {
    const input = {
      proof: vector.proof,
      method: vector.method,
      url: vector.url,
      nowEpochSeconds: vector.iat,
      expectedThumbprint: vector.thumbprint,
      ...(vector.accessToken ? { expectedAccessToken: vector.accessToken } : {}),
    };
    const result = verifyDpopProof(input);
    if (!result.ok) {
      failures++;
      console.error(`REJECTED ${vector.method} ${vector.url}: ${result.code} ${result.reason}`);
    }
    const [h, p, s] = vector.proof.split(".");
    const flipped = s.slice(0, 10) + (s[10] === "A" ? "B" : "A") + s.slice(11);
    const tampered = [
      verifyDpopProof({ ...input, proof: `${h}.${p}.${flipped}` }),
      verifyDpopProof({ ...input, method: vector.method === "GET" ? "POST" : "GET" }),
      verifyDpopProof({ ...input, expectedAccessToken: "other-token" }),
    ];
    if (tampered.some((r) => r.ok)) {
      failures++;
      console.error(`ACCEPTED a tampered proof for ${vector.method} ${vector.url}`);
    }
  }
  if (failures > 0) {
    console.error(`${failures} of ${vectors.length} vectors failed`);
    process.exitCode = 1;
  } else {
    console.log(
      `ok: the relay verifier accepted all ${vectors.length} Swift proofs and rejected their tampered copies`,
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
