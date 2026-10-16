#!/usr/bin/env node
// Checks, on an installed build, that agents keep SpecWithCode's MCP tools
// across a service restart without anyone reopening a chat.
//
//   node scripts/studio-verify/mcp-after-restart.mjs [options]
//
//   --base-dir DIR        service home (default ~/.specweave-studio/m4)
//   --label LABEL         launchd label (default com.specweave.studio.m4)
//   --restart             probe, restart the service (launchctl kickstart -k), probe again
//   --wait-live SECONDS   after the restart, wait until every credential that could
//                         change things before it can again; send a message in the
//                         coordinator (or let a wake arrive) while it waits
//   --thread ID           only the credential of this thread ...
//   --instance ID         ... and provider instance (for example claudeAgent)
//   --max-age-hours N     only credentials written in the last N hours (default 24)
//   --json                print the result as JSON
//
// It reads the owner-only credential files the service writes for each thread
// and provider instance (never printing them), and opens an MCP session with
// each the way a provider's bridge does:
//   read   orchestrator_capabilities must answer. A 401 after a restart means
//          the restart invalidated a credential an agent still holds.
//   write  task_status for a task that does not exist passes the write gate
//          when the credential's provider session is attached and runs its
//          thread ("live"), and is otherwise refused with parent_not_active and
//          a reason that tells the agent what to do ("refused").
// Right after a restart no provider session is attached yet, so writes are
// refused with "no longer attached ... the thread's next message attaches a new
// session"; once the thread gets its next message they must be live again with
// the same credential. It never opens the service's database.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const WRITE_PROBE_TASK_ID = "mcp-after-restart-probe";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const baseDir = option("--base-dir", NodePath.join(NodeOS.homedir(), ".specweave-studio/m4"));
const label = option("--label", "com.specweave.studio.m4");
const restart = flag("--restart");
const waitLiveSeconds = Number(option("--wait-live", "0"));
const maxAgeHours = Number(option("--max-age-hours", "24"));
const onlyThread = option("--thread", undefined);
const onlyInstance = option("--instance", undefined);
const asJson = flag("--json");
const secretsDir = NodePath.join(baseDir, "userdata", "secrets");
if ((onlyThread === undefined) !== (onlyInstance === undefined)) {
  console.error("Pass --thread and --instance together.");
  process.exit(2);
}

const log = (...parts) => {
  if (!asJson) console.log(...parts);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The credential file of one thread and instance, named as the service names it. */
function credentialFileFor(threadId, instanceId) {
  const environmentId = NodeFS.readFileSync(
    NodePath.join(baseDir, "userdata", "environment-id"),
    "utf8",
  ).trim();
  const hash = NodeCrypto.createHash("sha256")
    .update(`${environmentId}\0${threadId}\0${instanceId}`)
    .digest("hex")
    .slice(0, 32);
  return `mcp-session-${hash}.bin`;
}

function credentialFiles() {
  const wanted = onlyThread === undefined ? undefined : credentialFileFor(onlyThread, onlyInstance);
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  let names;
  try {
    names = NodeFS.readdirSync(secretsDir);
  } catch (cause) {
    throw new Error(`Cannot list ${secretsDir}: ${cause.message}`, { cause });
  }
  return names
    .filter((name) => /^mcp-session-[0-9a-f]{32}\.bin$/u.test(name))
    .filter((name) => wanted === undefined || name === wanted)
    .filter(
      (name) =>
        wanted !== undefined || NodeFS.statSync(NodePath.join(secretsDir, name)).mtimeMs >= cutoff,
    )
    .map((name) => ({ id: name.slice("mcp-session-".length, -".bin".length).slice(0, 8), name }));
}

function readCredential(name) {
  const parsed = JSON.parse(NodeFS.readFileSync(NodePath.join(secretsDir, name), "utf8"));
  if (typeof parsed?.endpoint !== "string" || typeof parsed?.authorization !== "string") {
    throw new Error(`${name} is not a credential file`);
  }
  return { endpoint: parsed.endpoint, authorization: parsed.authorization };
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

/** One MCP session over HTTP, as a bridge opens it. */
async function openSession(credential) {
  let sessionId = null;
  let protocolVersion = null;
  const post = async (message) => {
    const response = await fetch(credential.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: credential.authorization,
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(20_000),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const text = await response.text();
    if (!response.ok) return { status: response.status, payloads: [] };
    const payloads = payloadsOf(response.headers.get("content-type") ?? "", text);
    for (const payload of payloads) {
      protocolVersion = payload?.result?.protocolVersion ?? protocolVersion;
    }
    return { status: response.status, payloads };
  };
  const initialized = await post({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-after-restart", version: "1.0.0" },
    },
  });
  if (initialized.status !== 200) return { status: initialized.status };
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  let nextId = 1;
  const callTool = async (name, toolArguments) => {
    const id = `call-${nextId++}`;
    const answer = await post({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: toolArguments },
    });
    if (answer.status !== 200) return { status: answer.status };
    const envelope = answer.payloads.find((payload) => payload?.id === id);
    return { status: 200, envelope };
  };
  return { status: 200, callTool };
}

/** The refusal a tool result carries, or undefined when it is not one. */
function refusalOf(result) {
  if (result?.isError !== true) return undefined;
  const text = result.content?.find((part) => part.type === "text")?.text ?? "";
  try {
    const parsed = JSON.parse(text);
    return { code: parsed.code ?? "error", message: parsed.message ?? text };
  } catch {
    return { code: "error", message: text };
  }
}

async function probe(file) {
  const credential = readCredential(file.name);
  const target = new URL(credential.endpoint).host;
  try {
    const session = await openSession(credential);
    if (session.status !== 200) {
      return { ...file, target, read: session.status === 401 ? "401" : `http-${session.status}` };
    }
    const capabilities = await session.callTool("orchestrator_capabilities", {});
    const read =
      capabilities.status === 401
        ? "401"
        : capabilities.envelope?.result !== undefined &&
            refusalOf(capabilities.envelope.result) === undefined
          ? "ok"
          : "error";
    const gate = await session.callTool("task_status", { taskId: WRITE_PROBE_TASK_ID });
    const refusal = gate.envelope === undefined ? undefined : refusalOf(gate.envelope.result);
    const write =
      gate.status === 401
        ? "401"
        : refusal?.code === "parent_not_active"
          ? "refused"
          : gate.envelope === undefined
            ? "error"
            : "live";
    return {
      ...file,
      target,
      read,
      write,
      ...(write === "refused" ? { reason: refusal.message } : {}),
    };
  } catch (cause) {
    return {
      ...file,
      target,
      read: cause?.cause?.code === "ECONNREFUSED" ? "down" : `error: ${cause.message}`,
    };
  }
}

const probeAll = (files) => Promise.all(files.map(probe));

function report(title, results) {
  log(`\n${title}`);
  for (const result of results) {
    log(
      `  ${result.id}  ${result.target ?? "?"}  read=${result.read}  write=${result.write ?? "-"}${
        result.reason === undefined ? "" : `\n      ${result.reason}`
      }`,
    );
  }
}

async function waitForService(files) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const [first] = await probeAll(files.slice(0, 1));
    if (first !== undefined && first.read !== "down" && !first.read.startsWith("error"))
      return true;
  }
  return false;
}

const failures = [];
const files = credentialFiles();
if (files.length === 0) {
  const message =
    onlyThread === undefined
      ? `No MCP credential was written in the last ${maxAgeHours} h under ${secretsDir}. Send a message to a coordinator first.`
      : `No MCP credential for ${onlyThread} on ${onlyInstance} yet. Send it a message first.`;
  if (asJson) console.log(JSON.stringify({ ok: false, message }));
  else console.error(message);
  process.exit(2);
}

const before = await probeAll(files);
report(restart ? "Before the restart" : "Credentials", before);
for (const result of before) {
  if (result.read === "401" && !restart) failures.push(`${result.id}: read 401`);
}

let after = [];
if (restart) {
  const target = `gui/${NodeOS.userInfo().uid}/${label}`;
  log(`\nRestarting ${target} ...`);
  NodeChildProcess.execFileSync("launchctl", ["kickstart", "-k", target], { stdio: "inherit" });
  if (!(await waitForService(files))) failures.push("The service did not come back within 180 s.");
  after = await probeAll(files);
  report("After the restart", after);
  for (const result of after) {
    const earlier = before.find((entry) => entry.name === result.name);
    if (earlier?.read === "ok" && result.read !== "ok") {
      failures.push(
        `${result.id}: read ${earlier.read} before the restart, ${result.read} after it`,
      );
    }
    if (result.write === "refused" && (result.reason ?? "").length === 0) {
      failures.push(`${result.id}: a refused write gave no reason`);
    }
  }
  const mustReturn = before.filter((entry) => entry.write === "live").map((entry) => entry.name);
  if (waitLiveSeconds > 0 && mustReturn.length > 0) {
    log(
      `\nWaiting up to ${waitLiveSeconds} s for ${mustReturn.length} credential(s) to change things again.` +
        "\nSend a message in the coordinator now (do not reopen or restart anything).",
    );
    const deadline = Date.now() + waitLiveSeconds * 1_000;
    let pending = new Set(mustReturn);
    while (pending.size > 0 && Date.now() < deadline) {
      await sleep(5_000);
      const current = await probeAll(files.filter((file) => pending.has(file.name)));
      for (const result of current) if (result.write === "live") pending.delete(result.name);
    }
    after = await probeAll(files);
    report("After the next message", after);
    for (const name of pending) {
      failures.push(
        `${name.slice(12, 20)}: could still not change anything ${waitLiveSeconds} s after the restart`,
      );
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ ok: failures.length === 0, before, after, failures }, null, 2));
} else {
  log(failures.length === 0 ? "\nOK" : `\nFAILED\n  ${failures.join("\n  ")}`);
}
process.exit(failures.length === 0 ? 0 : 1);
