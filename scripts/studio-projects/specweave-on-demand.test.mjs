// node --test scripts/studio-projects/specweave-on-demand.test.mjs
//
// The helpers and the stand-in CLI run everywhere. The end-to-end case needs a built
// server with its web client (apps/server/dist/bin.mjs and dist/client) and
// playwright-core's Chromium headless shell; without them it is skipped and says why.
// SWC_E2E_REQUIRE=1 turns that skip into a failure.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  agentAction,
  ASK_TOKEN,
  fakeSpecweave,
  findSpecweaveRoot,
  insideRealData,
  mcpCredentialOf,
  NOT_SET_UP_MESSAGE,
  parseArgs,
  runScenario,
  SET_UP_WAKE,
  slugify,
  toolResultValue,
  WORKER_TOKEN,
  workerTask,
} from "./specweave-on-demand.mjs";

/** The Board's folder pattern (apps/server/src/project/ProjectBoard.ts). */
const INCREMENT_FOLDER = /^\d{4,}[A-Z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/i;

const scratch = () => mkdtempSync(join(tmpdir(), "swc-1396-unit-"));

describe("options and isolation", () => {
  it("defaults to the built server and refuses unknown options", () => {
    const options = parseArgs([]);
    assert.match(options.entrypoint, /apps\/server\/dist\/bin\.mjs$/);
    assert.equal(options.keep, false);
    assert.throws(() => parseArgs(["--port", "8319"]), /unknown option/);
    assert.throws(() => parseArgs(["--timeout-ms", "10"]), /at least 30000/);
    assert.equal(parseArgs(["--keep", "--specweave", "/opt/sw/bin/specweave"]).specweave, "/opt/sw/bin/specweave");
  });

  it("never writes into SpecWithCode's own data", () => {
    const dirs = ["/home/someone/.specwithcode", "/home/someone/.specweave-studio"];
    assert.equal(insideRealData("/home/someone/.specwithcode", dirs), true);
    assert.equal(insideRealData("/home/someone/.specwithcode/m4/evidence", dirs), true);
    assert.equal(insideRealData("/home/someone/.specweave-studio-copy", dirs), false);
    assert.equal(insideRealData("/tmp/evidence", dirs), false);
  });
});

describe("the stand-in specweave", () => {
  it("refuses create-increment in a folder that was never set up, and writes nothing", () => {
    const dir = scratch();
    try {
      const result = fakeSpecweave(["create-increment", "Add a login page"], dir);
      assert.equal(result.code, 1);
      assert.equal(result.stderr.trim(), NOT_SET_UP_MESSAGE);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets up, then plans increments the Board can read, from any folder below the root", () => {
    const dir = scratch();
    try {
      assert.equal(fakeSpecweave(["init", "--quick", "--adapter", "claude"], dir).code, 0);
      const config = JSON.parse(readFileSync(join(dir, ".specweave", "config.json"), "utf8"));
      assert.equal(config.adapters.default, "claude");
      assert.equal(fakeSpecweave(["init", "--quick"], dir).stdout, "SpecWeave is already set up here.\n");

      const now = new Date("2026-11-18T12:00:00.000Z");
      const first = fakeSpecweave(["create-increment", "Add a login page"], dir, now);
      assert.equal(first.stdout, "Created increment 0001-add-a-login-page\n");
      const folder = join(dir, ".specweave", "increments", "0001-add-a-login-page");
      const metadata = JSON.parse(readFileSync(join(folder, "metadata.json"), "utf8"));
      assert.deepEqual(
        { id: metadata.id, status: metadata.status, title: metadata.title, created: metadata.created },
        { id: "0001-add-a-login-page", status: "active", title: "Add a login page", created: now.toISOString() },
      );
      assert.match(readFileSync(join(folder, "spec.md"), "utf8"), /^# Add a login page\n/);

      mkdirSync(join(dir, "src", "deep"), { recursive: true });
      assert.equal(findSpecweaveRoot(join(dir, "src", "deep")), dir);
      const second = fakeSpecweave(["create-increment", "Fix: the sign-in redirect!"], join(dir, "src", "deep"));
      assert.equal(second.stdout, "Created increment 0002-fix-the-sign-in-redirect\n");
      for (const name of readdirSync(join(dir, ".specweave", "increments"))) assert.match(name, INCREMENT_FOLDER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names its version and refuses what it does not know", () => {
    assert.equal(fakeSpecweave(["--version"], tmpdir()).stdout, "3.2.1\n");
    assert.equal(fakeSpecweave(["sync"], tmpdir()).code, 2);
    assert.equal(fakeSpecweave(["create-increment"], tmpdir()).code, 2);
    assert.equal(slugify("  Add a login page  "), "add-a-login-page");
  });
});

describe("the fake agent", () => {
  it("asks once, launches again after the set-up wake, and plans as a worker", () => {
    assert.equal(agentAction(`${ASK_TOKEN} Create an increment`), "ask");
    assert.equal(agentAction(`${SET_UP_WAKE}: launch it with increment "new".`), "relaunch");
    assert.equal(agentAction(workerTask()), "plan");
    assert.ok(workerTask().startsWith(WORKER_TOKEN));
    assert.equal(agentAction("hello"), "reply");
  });

  it("finds the studio-code endpoint in the session's stdio bridge, http server or environment", () => {
    const stdio = {
      mcpServers: [
        {
          name: "studio-code",
          command: "/bin/true",
          args: [],
          env: [
            { name: "STUDIO_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:1/mcp" },
            { name: "STUDIO_ACP_MCP_AUTHORIZATION", value: "Bearer a" },
          ],
        },
      ],
    };
    assert.deepEqual(mcpCredentialOf(stdio, {}), { endpoint: "http://127.0.0.1:1/mcp", authorization: "Bearer a" });
    const http = { mcpServers: [{ type: "http", url: "http://127.0.0.1:2/mcp", headers: [{ name: "Authorization", value: "Bearer b" }] }] };
    assert.deepEqual(mcpCredentialOf(http, {}), { endpoint: "http://127.0.0.1:2/mcp", authorization: "Bearer b" });
    assert.deepEqual(
      mcpCredentialOf({}, { STUDIO_ACP_MCP_ENDPOINT: "http://127.0.0.1:3/mcp", STUDIO_ACP_MCP_AUTHORIZATION: "Bearer c" }),
      { endpoint: "http://127.0.0.1:3/mcp", authorization: "Bearer c" },
    );
    assert.equal(mcpCredentialOf({ mcpServers: [] }, {}), null);
  });

  it("reads a tool's JSON from its structured content or its text", () => {
    assert.deepEqual(toolResultValue({ structuredContent: { launched: false } }), { launched: false });
    assert.deepEqual(
      toolResultValue({ content: [{ type: "text", text: '{"launched":false,"needs":"specweave"}' }] }),
      { launched: false, needs: "specweave" },
    );
    assert.deepEqual(toolResultValue({ content: [{ type: "text", text: "not json" }] }), { text: "not json" });
  });
});

describe("end to end", () => {
  const options = parseArgs(process.env.SWC_SERVER_ENTRY ? ["--entrypoint", process.env.SWC_SERVER_ENTRY] : []);
  const client = join(options.entrypoint, "..", "client", "index.html");
  const missing = !existsSync(options.entrypoint)
    ? `no built server at ${options.entrypoint}`
    : !existsSync(client)
      ? `the built server has no web client at ${client}`
      : null;
  const skip = missing && process.env.SWC_E2E_REQUIRE !== "1"
    ? `${missing}: build apps/web (vp build), then node apps/server/scripts/cli.ts build`
    : false;

  it(
    "a plain folder, an ask for an increment, the card, one press, and a card on the Board",
    { skip, timeout: 420_000 },
    async () => {
      assert.equal(missing, null, missing ?? "");
      const results = await runScenario({ ...options, timeoutMs: 240_000 });
      const failed = results.checks.filter((check) => check.status !== "pass");
      console.log(`evidence: ${results.evidence}`);
      assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
      assert.deepEqual(
        results.checks.map((check) => check.name),
        [
          "built-server",
          "server-start",
          "browser-session",
          "fake-provider",
          "plain-folder-project",
          "project-page",
          "launch-needs-specweave",
          "card-shows",
          "set-up",
          "relaunch",
          "increment-created",
          "board-lists-increment",
        ],
      );
      assert.equal(results.ok, true);
      assert.ok(results.cleanup.every((entry) => entry.stopped), JSON.stringify(results.cleanup));
    },
  );
});
