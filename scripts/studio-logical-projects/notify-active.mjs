#!/usr/bin/env node
// Two real isolated servers, two apps connected to both: one question pops up on
// exactly one app, and moves to the other app once the person uses it. While a
// person is at the thread's own machine (its idle reading, injected as the
// desktop shell reports it), that machine shows it and the other holds back (1436).
// Build the server first (node apps/server/scripts/cli.ts build). Providers are off;
// no browser window is opened. Usage: node scripts/studio-logical-projects/notify-active.mjs [report-dir]
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const { spawn, spawnSync } = NodeChildProcess;
const { randomUUID } = NodeCrypto;
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = NodeFS;
const { createServer } = NodeNet;
const { tmpdir } = NodeOS;
const { dirname, join, resolve } = NodePath;
const { fileURLToPath } = NodeURL;

assert.equal(Number(process.versions.node.split(".")[0]), 22, "Use the project's Node 22 runtime");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2] ?? join(tmpdir(), `notify-active-proof-${randomUUID()}`));
mkdirSync(output, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(tmpdir(), "notify-active-servers-"));
const entrypoint = resolve(
  process.env.STUDIO_TEST_ENTRYPOINT ?? join(root, "apps/server/dist/bin.mjs"),
);
const DRIVERS = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];

const port = () =>
  new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => done(value));
    });
  });

async function start(label) {
  const dir = join(scratch, label);
  const data = join(dir, "data");
  mkdirSync(join(data, "userdata"), { recursive: true });
  writeFileSync(
    join(data, "userdata/settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(DRIVERS.map((driver) => [driver, { enabled: false }])),
      providerInstances: Object.fromEntries(
        DRIVERS.map((driver) => [driver, { driver, enabled: false, config: {} }]),
      ),
      cursorKeychainUsageEnabled: false,
    }),
  );
  const environmentId = randomUUID();
  writeFileSync(join(data, "userdata/environment-id"), environmentId);
  const host = { label, environmentId, port: await port() };
  host.origin = `http://127.0.0.1:${host.port}`;
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(host.port),
      "--base-dir",
      data,
      "--no-browser",
    ],
    {
      cwd: dir,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        LANG: "en_US.UTF-8",
        HOME: dir,
        STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        STUDIO_DISABLE_AUTO_UPDATE: "true",
        PWDEBUG: "0",
        PLAYWRIGHT_HTML_OPEN: "never",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  host.child = child;
  const credential = await new Promise((done, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`${label} startup timeout`)), 45_000);
    const inspect = (chunk) => {
      buffer = (buffer + chunk).slice(-65536);
      const token = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (token) {
        clearTimeout(timer);
        done(token[1]);
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", () => reject(new Error(`${label} exited during startup`)));
  });
  const response = await fetch(`${host.origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:specweave-studio:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Notify active verifier",
    }),
  });
  assert.equal(response.status, 200, `${label} token exchange failed`);
  host.token = (await response.json()).access_token;
  return host;
}

async function stop(host) {
  const child = host?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}

const hosts = [];
let status = 1;
try {
  hosts.push(await start("desk"), await start("laptop"));
  const run = spawnSync(
    process.execPath,
    [join(root, "node_modules/vite-plus/bin/vp"), "test", "run", "src/notifyActive.proof.test.ts"],
    {
      cwd: join(root, "apps/web"),
      encoding: "utf8",
      env: {
        ...process.env,
        STUDIO_NOTIFY_ACTIVE_RESULTS: join(output, "scenarios.json"),
        STUDIO_NOTIFY_ACTIVE_PROOF: JSON.stringify(
          hosts.map(({ label, origin, token, environmentId }) => ({
            label,
            origin,
            token,
            environmentId,
          })),
        ),
      },
    },
  );
  const log = `${run.stdout}\n${run.stderr}`;
  writeFileSync(join(output, "proof.log"), log);
  let results = null;
  try {
    results = readFileSync(join(output, "scenarios.json"), "utf8");
  } catch {
    // The proof did not get far enough to write its scenarios.
  }
  // Each server's record of every change of target or ownerInUse (1436 AC-05):
  // stopped first so the trace file is flushed. More than sampling's burst of
  // five in a minute must all be there, each carrying its event.
  for (const host of hosts) await stop(host);
  const decisionRecords = hosts.map((host) => {
    let lines = [];
    try {
      lines = readFileSync(
        join(scratch, host.label, "data/userdata/logs/server.trace.ndjson"),
        "utf8",
      ).split("\n");
    } catch {
      // No trace file: counted as no records.
    }
    const records = lines
      .filter((line) => line.includes("background.notification.decision.change"))
      .map((line) => JSON.parse(line))
      .filter((record) => record.name === "background.notification.decision.change");
    return {
      label: host.label,
      changes: records.length,
      withEvent: records.filter((record) =>
        record.events?.some((event) => event.name === "notification.decision.changed"),
      ).length,
      ownerInUseValues: [
        ...new Set(records.map((record) => record.attributes?.["notification.owner_in_use"])),
      ],
    };
  });
  const desk = decisionRecords[0];
  const recorded =
    desk.changes > 5 &&
    desk.withEvent === desk.changes &&
    desk.ownerInUseValues.includes(true) &&
    desk.ownerInUseValues.includes(false);
  const passed = run.status === 0 && /Tests\s+2 passed/.test(log) && recorded;
  writeFileSync(
    join(output, "receipt.json"),
    JSON.stringify(
      {
        evidenceKind: "two-real-isolated-servers-two-reporting-apps",
        entrypoint,
        hosts: hosts.map(({ label, environmentId }) => ({ label, environmentId })),
        scenarios: results ? JSON.parse(results) : null,
        decisionRecords,
        success: passed,
      },
      null,
      2,
    ) + "\n",
  );
  for (const scenario of results ? JSON.parse(results) : [])
    console.log(
      `${passed ? "ok" : "--"} - ${scenario.scenario}: ${JSON.stringify(scenario.outcome)}`,
    );
  for (const record of decisionRecords)
    console.log(
      `${recorded ? "ok" : "--"} - ${record.label} decision records: ${record.changes} changes, ${record.withEvent} with their event, ownerInUse ${JSON.stringify(record.ownerInUseValues)}`,
    );
  if (!passed) console.error(log.slice(-4000));
  status = passed ? 0 : 1;
  console.log(`receipt: ${join(output, "receipt.json")}`);
} finally {
  for (const host of hosts) await stop(host);
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status);
