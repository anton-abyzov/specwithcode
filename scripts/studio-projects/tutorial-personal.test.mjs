import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inertMcpSource, createPersonalFixture } from "./tutorial-personal.mjs";

test("owned MCP fixture speaks newline-delimited discovery but refuses actual tool or arbitrary method calls", () => {
  const input =
    [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "read_synthetic_note", arguments: {} },
      },
      { jsonrpc: "2.0", id: 4, method: "connect_external_account" },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n";
  const result = spawnSync(process.execPath, ["-e", inertMcpSource()], {
    input,
    encoding: "utf8",
    timeout: 3000,
    env: { PATH: "/usr/bin:/bin" },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const frames = result.stdout
    .trim()
    .split("\n")
    .map((value) => JSON.parse(value));
  assert.deepEqual(
    frames.map((value) => value.id),
    [1, 2, 3, 4],
  );
  assert.equal(frames[0].result.serverInfo.name, "owned-tutorial");
  assert.deepEqual(
    frames[1].result.tools.map((tool) => tool.name),
    ["read_synthetic_note"],
  );
  assert.equal(frames[2].error.code, -32601);
  assert.equal(frames[3].error.code, -32601);
});
test("Personal fixture preserves no-Git root and prepares only a synthetic local matching checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-personal-tutorial-"));
  try {
    const project = { dir: path.join(root, "managed-personal") };
    fs.mkdirSync(project.dir);
    fs.mkdirSync(path.join(root, "home"));
    const fixture = createPersonalFixture(project, root);
    assert(!fs.existsSync(path.join(project.dir, ".git")));
    assert(fs.existsSync(path.join(fixture.checkout, ".git")));
    assert.equal(
      execFileSync("/usr/bin/git", ["remote", "get-url", "origin"], {
        cwd: fixture.checkout,
        encoding: "utf8",
        env: {
          HOME: path.join(root, "home"),
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      }).trim(),
      fixture.repositoryUrl,
    );
    assert.equal(fs.readFileSync(fixture.mcp, "utf8"), inertMcpSource());
    fs.mkdirSync(path.join(project.dir, ".git"));
    assert.throws(() => createPersonalFixture(project, root), /must start without Git/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fixture uses canonical paths when its owned root is reached through a symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-personal-alias-"));
  try {
    const actual = path.join(root, "actual"),
      alias = path.join(root, "alias");
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, alias, "dir");
    const project = { dir: path.join(alias, "personal") };
    fs.mkdirSync(project.dir);
    const fixture = createPersonalFixture(project, alias);
    assert.equal(fixture.additional, fs.realpathSync(path.join(actual, "reference-notes")));
    assert.equal(fixture.checkout, fs.realpathSync(path.join(actual, "personal/tutorial-notes")));
    assert.equal(fixture.mcp, fs.realpathSync(path.join(actual, "owned-discovery.cjs")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
