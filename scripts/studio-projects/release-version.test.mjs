import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";
const assert = NodeAssert;
const { createHash } = NodeCrypto;
const { execFileSync, spawnSync } = NodeChildProcess;
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = NodeFS;
const { tmpdir } = NodeOS;
const { dirname, join, resolve } = NodePath;
const { fileURLToPath } = NodeURL;
const { test } = NodeTest;
import { compatibleVersion, sourceVersion, validateArtifactIdentity } from "./version.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = (version) => ({
  product: "SpecWeave Studio",
  version,
  schemaVersion: 1,
  sourceCommit: "a".repeat(40),
  lockSha256: "b".repeat(64),
  runtime: "Node22.20.0",
  noAuthOrUserStores: true,
  files: [{ path: "package.json", type: "file" }],
});

test("application packages declare the same 1.0.5 version", () => {
  assert.equal(sourceVersion(root), "1.0.5");
});
test("version policy accepts the 0.1/0.2 alpha line and stable 1.x but rejects ambiguous or incompatible labels", () => {
  for (const version of ["0.1.0", "0.1.9", "0.2.0", "0.2.12", "1.0.0", "1.0.1", "1.2.0", "1.10.3"])
    assert.ok(compatibleVersion(version));
  for (const version of [
    "0.3.0",
    "2.0.0",
    "1.0",
    "01.0.0",
    "1.00.0",
    "1.0.01",
    "0.2",
    "0.2.01",
    "v0.2.0",
    "v1.0.0",
    "0.2.0-rc.1",
    "1.0.0-rc.1",
    null,
  ])
    assert.equal(compatibleVersion(version), false);
});
test("artifact identity binds package version to provenance", () => {
  const manifest = identity("0.2.0"),
    pkg = { name: "specweave-studio", version: "0.2.0" };
  assert.equal(validateArtifactIdentity(manifest, pkg), "0.2.0");
  for (const patch of [{ version: "0.1.0" }, { name: "different-app" }])
    assert.throws(() => validateArtifactIdentity(manifest, { ...pkg, ...patch }));
  for (const patch of [
    { sourceCommit: "unknown" },
    { lockSha256: "unknown" },
    { schemaVersion: 2 },
    { runtime: "Node24" },
    { noAuthOrUserStores: false },
    { files: [] },
  ])
    assert.throws(() => validateArtifactIdentity({ ...manifest, ...patch }, pkg));
});
test("source version refuses a stale desktop or web package", () => {
  const temp = mkdtempSync(join(tmpdir(), "studio-version-"));
  try {
    for (const app of ["server", "web", "desktop"]) {
      mkdirSync(join(temp, "apps", app), { recursive: true });
      writeFileSync(
        join(temp, "apps", app, "package.json"),
        JSON.stringify({ name: "specweave-studio", version: app === "web" ? "0.1.0" : "0.2.0" }),
      );
    }
    assert.throws(() => sourceVersion(temp), /versions differ/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("standalone verification checks emitted CLI version and file digests, without provider calls", () => {
  assert.equal(process.versions.node, "22.20.0");
  const temp = mkdtempSync(join(tmpdir(), "studio-artifact-fixture-"));
  const files = {
    "package.json": JSON.stringify({
      name: "specweave-studio",
      version: "0.2.0",
      type: "module",
      bin: { "specweave-studio": "./bin.mjs", specwithcode: "./bin.mjs" },
    }),
    "bin.mjs":
      "console.log(process.argv.includes('--version') ? 'specweave-studio v0.2.0' : 'specweave-studio start');\n",
    LICENSE: "MIT fixture",
    "UPSTREAM.md": "provenance fixture",
    "third-party-licenses.json": "{}",
    "client/third-party-licenses.json": "{}",
  };
  const verify = () =>
    spawnSync(process.execPath, [join(root, "scripts/studio-fleet/verify-bundle.mjs"), temp], {
      encoding: "utf8",
      timeout: 30000,
    });
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(temp, name)), { recursive: true });
      writeFileSync(join(temp, name), body);
    }
    const manifest = {
      ...identity("0.2.0"),
      runtimeRoots: [],
      files: Object.entries(files).map(([path, body]) => ({
        path,
        type: "file",
        sha256: hash(body),
      })),
    };
    writeFileSync(join(temp, "studio-manifest.json"), JSON.stringify(manifest));
    const success = verify();
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).version, "specweave-studio v0.2.0");
    const singleBin = {
      name: "specweave-studio",
      version: "0.2.0",
      type: "module",
      bin: { "specweave-studio": "./bin.mjs" },
    };
    writeFileSync(join(temp, "package.json"), JSON.stringify(singleBin));
    manifest.files.find((entry) => entry.path === "package.json").sha256 = hash(
      JSON.stringify(singleBin),
    );
    writeFileSync(join(temp, "studio-manifest.json"), JSON.stringify(manifest));
    const missingAlias = verify();
    assert.notEqual(missingAlias.status, 0, "a bundle without the specwithcode bin must fail");
    assert.match(missingAlias.stderr, /specwithcode/);
    writeFileSync(join(temp, "package.json"), files["package.json"]);
    manifest.files.find((entry) => entry.path === "package.json").sha256 = hash(
      files["package.json"],
    );
    writeFileSync(join(temp, "studio-manifest.json"), JSON.stringify(manifest));
    files["bin.mjs"] = files["bin.mjs"].replace("v0.2.0", "v0.1.0");
    writeFileSync(join(temp, "bin.mjs"), files["bin.mjs"]);
    assert.notEqual(verify().status, 0, "modified bytes must fail before execution");
    manifest.files.find((entry) => entry.path === "bin.mjs").sha256 = hash(files["bin.mjs"]);
    writeFileSync(join(temp, "studio-manifest.json"), JSON.stringify(manifest));
    const stale = verify();
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /v0\.1\.0/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("Python policy retains exact legacy compatibility and rejects new-release provenance errors and downgrades", () => {
  const source = String.raw`
import json,sys
sys.path.insert(0,sys.argv[1])
from release_policy import validate_manifest,validate_package,validate_upgrade
legacy={'product':'SpecWeave Studio','version':'0.1.0'}
validate_package(legacy,None)
current=json.loads(sys.argv[2]);validate_package(current,b'{"name":"specweave-studio","version":"0.2.0"}')
validate_upgrade('0.1.0','0.2.0');validate_upgrade('0.2.0','0.2.1')
def rejects(fn):
 try: fn()
 except (AssertionError,ValueError): return
 raise AssertionError('Invalid artifact was accepted')
rejects(lambda:validate_upgrade('0.2.0','0.1.0'))
patch=dict(current,version='0.1.1')
validate_package(patch,b'{"name":"specweave-studio","version":"0.1.1"}')
validate_upgrade('0.1.0','0.1.1')
rejects(lambda:validate_upgrade('0.1.1','0.1.0'))
rejects(lambda:validate_manifest(dict(legacy,version='0.1.1')))
rejects(lambda:validate_manifest(dict(patch,sourceCommit='unknown')))
rejects(lambda:validate_manifest(dict(patch,noAuthOrUserStores=False)))
rejects(lambda:validate_package(patch,None))
rejects(lambda:validate_manifest(dict(current,sourceCommit='unknown')))
rejects(lambda:validate_manifest(dict(current,noAuthOrUserStores=False)))
rejects(lambda:validate_package(current,None))
rejects(lambda:validate_package(current,b'{"name":"specweave-studio","version":"0.1.0"}'))
`;
  execFileSync(
    "python3",
    ["-B", "-c", source, join(root, "scripts/studio-fleet"), JSON.stringify(identity("0.2.0"))],
    { stdio: "pipe" },
  );
});

test("acceptance RPC guard rejects foreign scope and native dispatch before transport", async () => {
  const { assertRpcScope, safeFailure } = await import("./rpc.mjs");
  const scope = {
    projectIds: new Set(["owned"]),
    routineIds: new Set(["routine"]),
    threadIds: new Set(),
    providersDisabled: true,
  };
  assertRpcScope("http://127.0.0.1:8428", "projects.memoryWrite", { projectId: "owned" }, scope);
  assert.throws(() =>
    assertRpcScope("http://127.0.0.1:8319", "projects.memoryWrite", { projectId: "owned" }, scope),
  );
  assert.throws(() =>
    assertRpcScope(
      "http://127.0.0.1:8428",
      "projects.memoryWrite",
      { projectId: "foreign" },
      scope,
    ),
  );
  assert.throws(() =>
    assertRpcScope("http://127.0.0.1:8428", "orchestration.dispatchCommand", {}, scope),
  );
  assert.throws(() =>
    assertRpcScope(
      "http://127.0.0.1:8428",
      "scheduledTasks.runNow",
      { id: "routine" },
      { ...scope, providersDisabled: false },
    ),
  );
  const connection = {
    projectId: "owned",
    id: "owned-tools",
    config: { command: "/owned/node", args: ["owned-fixture.mjs"], envKeys: [] },
  };
  assert.throws(() =>
    assertRpcScope("http://127.0.0.1:8428", "projects.connectionSave", connection, scope),
  );
  const connectionScope = {
    ...scope,
    connectionCommand: "/owned/node",
    connectionArgs: ["owned-fixture.mjs"],
  };
  assertRpcScope("http://127.0.0.1:8428", "projects.connectionSave", connection, connectionScope);
  assert.throws(() =>
    assertRpcScope(
      "http://127.0.0.1:8428",
      "projects.connectionSave",
      { ...connection, config: { ...connection.config, command: "/unowned/node" } },
      connectionScope,
    ),
  );
  assert.equal(
    safeFailure({
      cause: { _tag: "Fail", error: { code: "conflict", message: "private-secret" } },
    }),
    "conflict",
  );
  assert.equal(safeFailure({ message: "private-secret" }), null);
});

test("owned acceptance MCP fixture emits real NDJSON and refuses external calls", async () => {
  const { ownedConnectionFixtureSource } = await import("./environment-acceptance.mjs");
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_fixture" } },
    { jsonrpc: "2.0", id: 4, method: "ping" },
  ];
  const output = execFileSync(process.execPath, ["-e", ownedConnectionFixtureSource], {
    input: messages.map((value) => JSON.stringify(value)).join("\n") + "\n",
    encoding: "utf8",
    timeout: 10000,
    env: { PATH: "/usr/bin:/bin" },
  });
  const responses = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 4);
  assert.deepEqual(
    responses.map((r) => r.id),
    [1, 2, 3, 4],
  );
  assert.equal(responses[1].result.tools[0].name, "read_fixture");
  assert.equal(responses[2].error.code, -32601);
  assert.deepEqual(responses[3].result, {});
});
