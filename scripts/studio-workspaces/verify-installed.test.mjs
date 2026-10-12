import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { installedLayout, parseOptions } from "./verify-installed.mjs";

const source = fs.readFileSync(
  fileURLToPath(new URL("./verify-installed.mjs", import.meta.url)),
  "utf8",
);
const valid = {
  "--release-window-authorized": null,
  "--identity": "primary",
  "--host": "127.0.0.1",
  "--port": "9001",
  "--artifact-sha": "a".repeat(64),
  "--source-commit": "b".repeat(40),
  "--report-dir": "/evidence/new-run",
  "--playwright": "/deps/node_modules/playwright",
};
const argv = (overrides = {}, omit = []) =>
  Object.entries({ ...valid, ...overrides })
    .filter(([key]) => !omit.includes(key))
    .flatMap(([key, value]) => (value === null ? [key] : [key, value]));

test("importing the verifier does not start a run", () => {
  assert.equal(typeof parseOptions, "function");
  assert.equal(process.exitCode ?? 0, 0);
});

test("installed identity, host, port and Playwright location are required flags", () => {
  const parsed = parseOptions(argv());
  assert.equal(parsed["--identity"], "primary");
  assert.equal(parsed["--host"], "127.0.0.1");
  assert.equal(parsed["--port"], 9001);
  for (const key of Object.keys(valid))
    assert.throws(() => parseOptions(argv({}, [key])), undefined, `missing ${key} must fail`);
});

test("malformed or duplicate flags are refused", () => {
  for (const overrides of [
    { "--identity": "Primary Host" },
    { "--identity": "../escape" },
    { "--host": "127.0.0.1:9001" },
    { "--host": "host/name" },
    { "--port": "80" },
    { "--port": "70000" },
    { "--port": "09001" },
    { "--artifact-sha": "a".repeat(63) },
    { "--source-commit": "z".repeat(40) },
    { "--report-dir": "relative/dir" },
    { "--playwright": "relative/playwright" },
  ])
    assert.throws(() => parseOptions(argv(overrides)), undefined, JSON.stringify(overrides));
  assert.throws(() => parseOptions([...argv(), "--port", "9002"]), /Duplicate argument/);
  assert.throws(() => parseOptions([...argv(), "--base-dir", "/x"]), /Unknown argument/);
});

test("every installed path and service name derives from the flags and current user", () => {
  const layout = installedLayout(parseOptions(argv()), "/home/operator", 1234);
  assert.equal(layout.origin, "http://127.0.0.1:9001");
  assert.equal(layout.own, path.join("/home/operator", ".specweave-studio", "primary"));
  assert.equal(layout.installationPath, path.join(layout.own, "installation.json"));
  assert.equal(layout.settingsPath, path.join(layout.own, "userdata", "settings.json"));
  assert.equal(layout.runtimePath, path.join(layout.own, "userdata", "server-runtime.json"));
  assert.equal(
    layout.release,
    path.join("/home/operator", ".local/share/specweave-studio/releases", "a".repeat(20)),
  );
  assert.equal(layout.serviceDomain, "gui/1234");
  assert.equal(layout.serviceLabel, "com.specweave.studio.primary");
});

test("source carries no machine-specific host, port, user or path defaults", () => {
  for (const pattern of [
    /8319/,
    /\/Users\//,
    /\/Users\/[^/]+/,
    /specweave-studio\/m4/,
    /studio\.m4/,
    /gui\/501/,
    /codex-runtimes/,
  ])
    assert.doesNotMatch(source, pattern);
  assert.match(source, /headless: true/);
  assert.doesNotMatch(source, /headless: false/);
});
