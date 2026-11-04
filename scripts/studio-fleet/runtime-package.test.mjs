import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { runtimePackage, verifyRuntimeBins } from "./runtime-package.mjs";

test("runtime bundle package registers both command names on the one entry", () => {
  const pkg = runtimePackage("0.2.7");
  assert.equal(pkg.name, "specweave-studio");
  assert.equal(pkg.version, "0.2.7");
  assert.equal(pkg.license, "UNLICENSED");
  assert.deepEqual(pkg.bin, { "specweave-studio": "./bin.mjs", specwithcode: "./bin.mjs" });
  verifyRuntimeBins(pkg);
});

test("runtime and desktop package the complete executable managed helper graph", () => {
  const source = readFileSync(new URL("../lib/studio-service-updater.ts", import.meta.url), "utf8");
  const shipped = [...source.matchAll(/"([a-z_]+\.py)"/g)].map((match) => match[1]);
  const fleet = new URL("./", import.meta.url);
  const local = new Set(readdirSync(fleet).filter((name) => name.endsWith(".py")));
  const required = new Set();
  // migrate_home.py is an entry point of its own: the desktop runs it beside the agent.
  // relay_ownership.py too: the runtime runs it beside managed_updates.py to record its relay
  // (apps/server/src/cloud/RelayProcessOwnership.ts).
  const pending = [
    "update_agent.py",
    "managed_updates.py",
    "migrate_home.py",
    "relay_ownership.py",
  ];
  while (pending.length) {
    const name = pending.pop();
    if (required.has(name)) continue;
    required.add(name);
    const content = readFileSync(new URL(name, fleet), "utf8");
    for (const match of content.matchAll(/^(?:import|from) ([a-z_]+)\b/gm)) {
      if (local.has(`${match[1]}.py`)) pending.push(`${match[1]}.py`);
    }
  }
  assert.deepEqual(shipped.toSorted(), [...required].toSorted());
  const bundle = readFileSync(new URL("./bundle.mjs", import.meta.url), "utf8");
  assert.match(bundle, /import \{ MAC_SERVICE_UPDATER_FILES \} from/);
  assert.match(bundle, /join\(output, ['"]studio-updater['"]\)/);
  assert.match(bundle, /for \(const file of MAC_SERVICE_UPDATER_FILES\)/);
  assert.ok(
    bundle.indexOf("cpSync(source, join(updater, file))") < bundle.indexOf("indexTree(output);"),
    "helper copies must precede the archive's hashed file inventory",
  );
  const isolated = mkdtempSync(join(tmpdir(), "studio-updater-graph-"));
  try {
    for (const name of shipped) cpSync(new URL(name, fleet), join(isolated, name));
    const help = execFileSync(
      "/usr/bin/python3",
      ["-B", "-E", "-s", join(isolated, "managed_updates.py"), "--help"],
      {
        cwd: isolated,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    assert.match(help, /--state-dir/);
    assert.deepEqual(
      readdirSync(isolated).toSorted(),
      shipped.toSorted(),
      "helper import creates no cache or state",
    );
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

test("runtime packages the disk room check with every module it imports", () => {
  const read = (file) => readFileSync(new URL(`../lib/${file}`, import.meta.url), "utf8");
  const agent = [...read("studio-service-updater.ts").matchAll(/"([a-z_]+\.py)"/g)].map(
    (match) => match[1],
  );
  const room = [...read("studio-disk-room.ts").matchAll(/"([a-z_]+\.py)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    room.filter((name) => agent.includes(name)),
    [],
    "the disk room list adds only files the agent list lacks",
  );
  const fleet = new URL("./", import.meta.url);
  const local = new Set(readdirSync(fleet).filter((name) => name.endsWith(".py")));
  const required = new Set();
  const pending = ["disk_room.py"];
  while (pending.length) {
    const name = pending.pop();
    if (required.has(name)) continue;
    required.add(name);
    const content = readFileSync(new URL(name, fleet), "utf8");
    for (const match of content.matchAll(/^(?:import|from) ([a-z_]+)\b/gm)) {
      if (local.has(`${match[1]}.py`)) pending.push(`${match[1]}.py`);
    }
  }
  const shipped = [...new Set([...agent, ...room])];
  for (const name of required) assert.ok(shipped.includes(name), `${name} is not shipped`);
  assert.deepEqual(
    room.toSorted(),
    [...required].filter((name) => !agent.includes(name)).toSorted(),
    "the disk room list is exactly what its closure needs beyond the agent files",
  );
  const bundle = readFileSync(new URL("./bundle.mjs", import.meta.url), "utf8");
  assert.match(bundle, /import \{ DISK_ROOM_FILES \} from/);
  assert.match(bundle, /for \(const file of DISK_ROOM_FILES\)/);
  assert.ok(
    bundle.indexOf("for (const file of DISK_ROOM_FILES)") < bundle.indexOf("indexTree(output);"),
    "disk room copies must precede the archive's hashed file inventory",
  );
  const isolated = mkdtempSync(join(tmpdir(), "studio-disk-room-graph-"));
  try {
    for (const name of required) cpSync(new URL(name, fleet), join(isolated, name));
    const help = execFileSync(
      "/usr/bin/python3",
      ["-B", "-E", "-s", join(isolated, "disk_room.py"), "--help"],
      {
        cwd: isolated,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    assert.match(help, /--full-read/);
    assert.deepEqual(
      readdirSync(isolated).toSorted(),
      [...required].toSorted(),
      "disk room import creates no cache or state",
    );
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

test("bundle verification rejects a runtime package without the specwithcode bin", () => {
  // The 0.2.6 bundle shape: only the identity name was registered.
  assert.throws(
    () => verifyRuntimeBins({ name: "specweave-studio", bin: { "specweave-studio": "./bin.mjs" } }),
    /specwithcode/,
  );
  assert.throws(() =>
    verifyRuntimeBins({
      name: "specweave-studio",
      bin: { "specweave-studio": "./bin.mjs", specwithcode: "./other.mjs" },
    }),
  );
  assert.throws(() => verifyRuntimeBins({ name: "specweave-studio" }));
});

test("bundle.mjs writes the shared runtime package and verify-bundle checks its bins", () => {
  const bundle = readFileSync(new URL("./bundle.mjs", import.meta.url), "utf8");
  assert.match(bundle, /JSON\.stringify\(runtimePackage\(version\)/);
  assert.doesNotMatch(bundle, /bin: \{ 'specweave-studio': '\.\/bin\.mjs' \}/);
  const verify = readFileSync(new URL("./verify-bundle.mjs", import.meta.url), "utf8");
  assert.match(verify, /verifyRuntimeBins\(runtimePackageJson\)/);
});
