#!/usr/bin/env node
// Black-box check of an outside MCP client (a bot or hosted agent that can only
// send an Authorization header) against an ISOLATED server built from this
// checkout. It never touches the installed service (port 8319) or the app.
//
//   node scripts/studio-verify/outside-agent-mcp.mjs [--port N] [--keep-home] [--out FILE]
//
// It starts apps/server (node src/bin.ts start) with its own temporary home and
// a free loopback port, mints a static token with `auth mcp-token create`, and
// speaks streamable HTTP JSON-RPC to /mcp with Authorization: Bearer:
//   - a request without a token gets 401 with WWW-Authenticate resource_metadata
//   - initialize, then tools/list lists the fleet tools (reports the longest description)
//   - studio_machine_list answers (an empty fleet is fine on a fresh home)
//   - studio_threads_wait on bogus refs answers with one error per row, not a failed call
//   - after `auth mcp-token revoke`, /mcp refuses the same token with 401
// It does not launch a thread: on this home a launch would start a real provider
// run and spend paid usage, so the multi-wait covers the follow-up path instead.
// Prints a JSON summary; exits 1 when any check fails.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUIRED_TOOLS = [
  "studio_machine_list",
  "studio_thread_launch",
  "studio_threads_wait",
  "studio_project_add_to_machine",
];
const INSTALLED_SERVICE_PORT = 8319;

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const serverDir = NodePath.join(repoRoot, "apps", "server");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const keepHome = args.includes("--keep-home");
const outFile = option("--out", undefined);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const check = (name, ok, detail = {}) => {
  checks.push({ name, ok: Boolean(ok), ...detail });
  return Boolean(ok);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Runs the server CLI against the isolated home; never prints the token. */
function cli(home, cliArgs) {
  // Keep HTTP socket lifecycle callbacks running while the CLI starts up. A
  // synchronous subprocess can leave fetch reusing an already-expired socket.
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["src/bin.ts", ...cliArgs, "--base-dir", home],
      {
        cwd: serverDir,
        timeout: 60_000,
        env: isolatedEnv(home),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function isolatedEnv(home) {
  const env = { ...process.env, STUDIO_HOME: home, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" };
  // Never inherit the installed service's port settings.
  delete env.STUDIO_PORT;
  delete env.STUDIO_PORT_OFFSET;
  return env;
}

function payloadsOf(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    return text
      .split(/\r?\n\r?\n/u)
      .map((event) =>
        event
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n"),
      )
      .filter((data) => data.length > 0)
      .map((data) => JSON.parse(data));
  }
  return text.trim().length === 0 ? [] : [JSON.parse(text)];
}

function mcpClient(endpoint, authorization) {
  let sessionId = null;
  let protocolVersion = null;
  let nextId = 1;
  const post = async (message) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(authorization === undefined ? {} : { authorization }),
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(30_000),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const text = await response.text();
    const payloads = response.ok
      ? payloadsOf(response.headers.get("content-type") ?? "", text)
      : [];
    for (const payload of payloads)
      protocolVersion = payload?.result?.protocolVersion ?? protocolVersion;
    return {
      status: response.status,
      wwwAuthenticate: response.headers.get("www-authenticate"),
      body: response.ok ? undefined : text,
      payloads,
    };
  };
  const request = async (method, params) => {
    const id = `req-${nextId++}`;
    const answer = await post({ jsonrpc: "2.0", id, method, params });
    return { ...answer, envelope: answer.payloads.find((payload) => payload?.id === id) };
  };
  const initialize = async () => {
    const answer = await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "outside-agent-mcp-check", version: "1.0.0" },
    });
    if (answer.status === 200) await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return answer;
  };
  const callTool = (name, toolArguments) =>
    request("tools/call", { name, arguments: toolArguments });
  return { initialize, request, callTool };
}

/** A tool result's structured payload: structuredContent, else its JSON text part. */
function toolPayload(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find((part) => part.type === "text")?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function waitForServer(baseUrl, child, logFile) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with ${child.exitCode}; see ${logFile}`);
    }
    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        signal: AbortSignal.timeout(2_000),
      });
      await response.text();
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`server did not listen within 120s; see ${logFile}`);
}

function stopServer(child) {
  if (child === undefined || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      resolve();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    // The server was started in its own process group: stop it and its helpers.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  });
}

async function main() {
  const port = Number(option("--port", 0)) || (await freePort());
  if (port === INSTALLED_SERVICE_PORT)
    throw new Error("refusing the installed service's port 8319");
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "outside-agent-mcp-"));
  const logFile = NodePath.join(home, "server.log");
  const baseUrl = `http://127.0.0.1:${port}`;
  const endpoint = `${baseUrl}/mcp`;
  const summary = { server: { port, home: keepHome ? home : "(removed)", pid: null }, checks };
  let child;
  try {
    const log = NodeFS.openSync(logFile, "a");
    child = NodeChildProcess.spawn(
      process.execPath,
      [
        "src/bin.ts",
        "start",
        "--mode",
        "web",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--base-dir",
        home,
        "--no-browser",
      ],
      { cwd: serverDir, env: isolatedEnv(home), stdio: ["ignore", log, log], detached: true },
    );
    summary.server.pid = child.pid;
    await waitForServer(baseUrl, child, logFile);

    // No token: 401 that points an OAuth-capable client at the resource metadata.
    const anonymous = await mcpClient(endpoint, undefined).initialize();
    check(
      "no token is refused with resource_metadata",
      anonymous.status === 401 &&
        /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/u.test(
          anonymous.wwwAuthenticate ?? "",
        ),
      {
        status: anonymous.status,
        wwwAuthenticate: anonymous.wwwAuthenticate,
      },
    );

    // Mint a static token through the CLI, the way the owner gives one to a bot.
    const minted = await cli(home, [
      "auth",
      "mcp-token",
      "create",
      "--access",
      "auto",
      "--label",
      "bb-check",
      "--json",
    ]);
    let issued;
    try {
      issued = JSON.parse(minted.stdout);
    } catch {}
    if (
      !check(
        "auth mcp-token create mints a token",
        minted.status === 0 && typeof issued?.token === "string",
        {
          exitCode: minted.status,
          sessionId: issued?.sessionId,
          access: issued?.access,
          label: issued?.label,
          expiresAt: issued?.expiresAt,
          stderr: minted.status === 0 ? undefined : minted.stderr.slice(-500),
        },
      )
    )
      return summary;
    const authorization = `Bearer ${issued.token}`;

    const client = mcpClient(endpoint, authorization);
    const initialized = await client.initialize();
    check(
      "initialize with the static token",
      initialized.status === 200 && initialized.envelope?.result !== undefined,
      {
        status: initialized.status,
        protocolVersion: initialized.envelope?.result?.protocolVersion,
        serverName: initialized.envelope?.result?.serverInfo?.name,
      },
    );

    const listed = await client.request("tools/list", {});
    const tools = listed.envelope?.result?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    const longest = tools.reduce(
      (best, tool) =>
        (tool.description ?? "").length > best.length
          ? { name: tool.name, length: tool.description.length }
          : best,
      { name: null, length: 0 },
    );
    const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name));
    check("tools/list has the fleet tools", listed.status === 200 && missing.length === 0, {
      toolCount: names.length,
      missing,
      maxDescriptionLength: longest.length,
      maxDescriptionTool: longest.name,
    });

    const machines = await client.callTool("studio_machine_list", {});
    const machinesResult = machines.envelope?.result;
    const machinesPayload = toolPayload(machinesResult);
    check(
      "studio_machine_list answers",
      machines.status === 200 &&
        machinesResult?.isError !== true &&
        Array.isArray(machinesPayload?.machines),
      {
        status: machines.status,
        machineCount: Array.isArray(machinesPayload?.machines)
          ? machinesPayload.machines.length
          : null,
        error: machinesResult?.isError === true ? machinesPayload : undefined,
      },
    );

    check("thread launch skipped", true, {
      reason:
        "a launch on this home would start a real provider run; the multi-wait below covers follow-up without paid usage",
    });

    const bogus = ["thread-does-not-exist-bb-check", "studio://thread/bogus-machine/not-a-thread"];
    const waited = await client.callTool("studio_threads_wait", {
      threads: bogus,
      mode: "all",
      timeoutMs: 2_000,
    });
    const waitedResult = waited.envelope?.result;
    const waitedPayload = toolPayload(waitedResult);
    const rows = Array.isArray(waitedPayload?.threads) ? waitedPayload.threads : [];
    check(
      "studio_threads_wait reports one error per bogus row",
      waited.status === 200 &&
        waitedResult?.isError !== true &&
        rows.length === bogus.length &&
        rows.every((row) => typeof row?.error?.code === "string" && row.done === false),
      {
        status: waited.status,
        rows: rows.map((row) => ({ ref: row.ref, machine: row.machine, error: row.error?.code })),
        error: waitedResult?.isError === true ? waitedPayload : undefined,
      },
    );

    // Revoke and confirm the very same header is refused at once.
    const revoked = await cli(home, ["auth", "mcp-token", "revoke", issued.sessionId]);
    check(
      "auth mcp-token revoke",
      revoked.status === 0 && /Revoked MCP client/u.test(revoked.stdout),
      {
        exitCode: revoked.status,
        output: revoked.stdout.trim().slice(0, 200),
      },
    );
    const afterRevoke = await mcpClient(endpoint, authorization).initialize();
    const sameSession = await client.request("tools/list", {});
    check("revoked token gets 401", afterRevoke.status === 401 && sameSession.status === 401, {
      newSessionStatus: afterRevoke.status,
      openSessionStatus: sameSession.status,
      wwwAuthenticate: afterRevoke.wwwAuthenticate,
    });
    return summary;
  } finally {
    await stopServer(child);
    if (child !== undefined) {
      summary.server.stopped = child.exitCode !== null || child.signalCode !== null;
      // Nothing may still listen on the isolated port.
      try {
        const still = NodeChildProcess.execFileSync(
          "lsof",
          ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
          { encoding: "utf8" },
        ).trim();
        summary.server.stillListening = still.length > 0;
      } catch {
        summary.server.stillListening = false;
      }
    }
    if (!keepHome) NodeFS.rmSync(home, { recursive: true, force: true });
  }
}

let summary;
try {
  summary = await main();
} catch (cause) {
  check("run", false, { error: cause instanceof Error ? cause.message : String(cause) });
  summary = { checks };
}
summary.passed =
  checks.length > 0 && checks.every((entry) => entry.ok) && summary.server?.stillListening !== true;
summary.at = new Date().toISOString();
const text = `${JSON.stringify(summary, null, 2)}\n`;
if (outFile !== undefined) NodeFS.writeFileSync(outFile, text);
process.stdout.write(text);
process.exit(summary.passed ? 0 : 1);
