#!/usr/bin/env node
// Credential-free real CLI receipt. Never authenticates or sends a prompt.
// Usage: node scripts/studio-copilot/probe.mjs /absolute/path/to/copilot /receipt/output.json
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const [binary, output] = process.argv.slice(2);
if (!binary || !isAbsolute(binary) || !output)
  throw new Error("Expected absolute Copilot executable and receipt output path.");
const scratch = await mkdtemp(join(tmpdir(), "studio-copilot-noauth-"));
const home = join(scratch, "home");
const cwd = join(scratch, "workspace");
await Promise.all([mkdir(home), mkdir(cwd)]);
const args = ["--acp", "--stdio", "--no-auto-update", "--no-auto-login", "--disable-builtin-mcps"];
const child = spawn(binary, args, {
  cwd,
  env: {
    HOME: home,
    COPILOT_HOME: join(home, ".copilot"),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    CI: "1",
    NO_COLOR: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const wire = [];
const pending = new Map();
let stderr = "";
child.stderr.on("data", (data) => {
  stderr = (stderr + data.toString()).slice(-8192);
});
child.on("error", (error) => {
  for (const item of pending.values()) item.reject(error);
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  wire.push({ direction: "in", frame });
  if (frame.id !== undefined && pending.has(frame.id)) {
    const item = pending.get(frame.id);
    pending.delete(frame.id);
    clearTimeout(item.timeout);
    item.resolve(frame);
  }
});
let nextId = 1;
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 20000);
    pending.set(id, { resolve, reject, timeout });
    const frame = { jsonrpc: "2.0", id, method, params };
    wire.push({ direction: "out", frame });
    child.stdin.write(JSON.stringify(frame) + "\n");
  });
try {
  const initialize = await request("initialize", {
    protocolVersion: 2,
    clientInfo: { name: "studio-noauth-probe", version: "1" },
    clientCapabilities: { auth: { terminal: true }, elicitation: { url: true } },
  });
  const session = await request("session/new", { cwd, mcpServers: [] });
  const receipt = {
    checkedAt: new Date().toISOString(),
    binary,
    args,
    scratch,
    credentialEnvironment: "fresh; no inherited provider credentials",
    authenticatedTurnAttempted: false,
    initialize,
    session,
    wire,
    stderr,
  };
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({
      receipt: resolve(output),
      version: initialize.result?.agentInfo?.version,
      sessionError: session.error ?? null,
      authenticatedTurnAttempted: false,
    }),
  );
} finally {
  lines.close();
  child.stdin.end();
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
  timeout.unref();
  for (const item of pending.values()) clearTimeout(item.timeout);
}
