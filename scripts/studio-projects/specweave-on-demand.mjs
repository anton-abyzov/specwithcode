#!/usr/bin/env node
// SpecWeave on demand, end to end (1396 AC-09, AC-10), on an owned server with an
// offline fake agent:
//
//   1. a plain folder with no Git is added as a project;
//   2. the coordinator is asked for an increment, and its launch with increment
//      "new" comes back { launched: false, needs: "specweave" };
//   3. the "Set up SpecWeave to plan this" card shows in the coordinator thread,
//      with no .specweave and no .git in the folder;
//   4. "Set up Git and SpecWeave" is pressed in a headless browser;
//   5. the wake relaunches the work, the worker runs `specweave create-increment`,
//      and the Board lists the increment, all without reloading the page.
//
// Usage:
//   node scripts/studio-projects/specweave-on-demand.mjs [--entrypoint apps/server/dist/bin.mjs]
//     [--evidence-dir DIR] [--specweave /path/to/a/real/specweave] [--keep] [--timeout-ms 240000]
//
// It needs a built server with its web client (`apps/web`: vp build, then
// `node apps/server/scripts/cli.ts build`) and playwright-core's Chromium headless shell.
//
// Isolation: the server, the fake agent and the CLI run with a new HOME, base dir
// and TMPDIR inside one temporary folder, on a free loopback port (never 8319), with
// PATH reduced to system tools, so no provider or SpecWithCode data of the caller is
// read or written. Only processes this script starts are stopped, by PID.
//
// The CLI the server finds is a logging stand-in on PATH. By default the stand-in
// answers `init` and `create-increment` itself, offline, writing the files the real
// CLI writes (metadata.json and spec.md, the same shapes as SpecWeave 3.x); with
// --specweave it passes every call to that real CLI instead.
//
// The same file is the fake agent (--fake-agent CONFIG) and the stand-in CLI
// (--fake-specweave LOG REAL ...ARGS), so the check is these two files and nothing else.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

const SELF = NodeURL.fileURLToPath(import.meta.url);
const REPO_ROOT = NodePath.resolve(NodePath.dirname(SELF), "../..");
const RESERVED_PORT = 8319;
export const PROVIDER_INSTANCE_ID = "e2e-specweave";
export const MODEL_ID = "fake-specweave-1";
const MODEL_SELECTION = { instanceId: PROVIDER_INSTANCE_ID, model: MODEL_ID };
export const ASK_TOKEN = "E2E-ASK-PLAN";
export const WORKER_TOKEN = "E2E-WORKER-PLAN";
export const INCREMENT_TITLE = "Add a login page";
/** The wake the card's Set up sends the coordinator (packages/contracts/src/specweaveSetupRequest.ts). */
export const SET_UP_WAKE = "SpecWeave is set up in this project. Plan the work now";
/** AC-04's refusal, printed by the stand-in as SpecWeave 3.2.1 prints it. */
export const NOT_SET_UP_MESSAGE =
  "This folder is not set up for SpecWeave. Run `specweave init` here first. In SpecWithCode, press Set up SpecWeave on the project's Board tab.";
/** The Board's own refresh (apps/web/src/components/studio/shell/BoardPane.tsx). */
export const BOARD_REFRESH_MS = 30_000;
/** AC-09: the state reads on within 5 s of a successful setup. */
export const STATE_ON_WITHIN_MS = 5_000;

// ---------------------------------------------------------------- shared helpers

const REAL_DATA_DIRS = [".specwithcode", ".specweave-studio"].map((name) =>
  NodePath.resolve(NodeOS.homedir(), name),
);
/** True for a path inside the caller's own SpecWithCode data, which this check never writes. */
export function insideRealData(candidate, dirs = REAL_DATA_DIRS) {
  const resolved = NodePath.resolve(candidate);
  return dirs.some((dir) => resolved === dir || resolved.startsWith(dir + NodePath.sep));
}

export function parseArgs(argv) {
  const options = { entrypoint: NodePath.join(REPO_ROOT, "apps/server/dist/bin.mjs"), keep: false, timeoutMs: 240_000 };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === "--keep") {
      options.keep = true;
      continue;
    }
    const value = argv[i + 1];
    if (!["--entrypoint", "--evidence-dir", "--specweave", "--timeout-ms"].includes(name))
      throw new Error(`unknown option ${name}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
    i++;
    if (name === "--timeout-ms") {
      options.timeoutMs = Number(value);
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 30_000)
        throw new Error("--timeout-ms must be a whole number of at least 30000");
    } else options[name.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = NodePath.resolve(value);
  }
  if (options.evidenceDir !== undefined && insideRealData(options.evidenceDir))
    throw new Error(`refusing to write evidence into SpecWithCode data: ${options.evidenceDir}`);
  return options;
}

/** SpecWeave's folder suffix for a title. */
export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

/** The folder whose .specweave/config.json covers `cwd`, or null. */
export function findSpecweaveRoot(cwd) {
  for (let dir = NodePath.resolve(cwd); ; dir = NodePath.dirname(dir)) {
    if (NodeFS.existsSync(NodePath.join(dir, ".specweave", "config.json"))) return dir;
    if (NodePath.dirname(dir) === dir) return null;
  }
}

/**
 * The stand-in CLI: `init` and `create-increment` as SpecWeave 3.2.1 does them, offline.
 * Returns { code, stdout, stderr } and writes only inside `cwd`.
 */
export function fakeSpecweave(args, cwd, now = new Date()) {
  const [command, ...rest] = args;
  if (command === "--version") return { code: 0, stdout: "3.2.1\n", stderr: "" };
  if (command === "init") {
    const config = NodePath.join(cwd, ".specweave", "config.json");
    if (NodeFS.existsSync(config)) return { code: 0, stdout: "SpecWeave is already set up here.\n", stderr: "" };
    NodeFS.mkdirSync(NodePath.join(cwd, ".specweave", "increments"), { recursive: true });
    const adapter = rest[rest.indexOf("--adapter") + 1] ?? "claude";
    NodeFS.writeFileSync(
      config,
      `${JSON.stringify(
        {
          version: "2.0",
          project: { name: NodePath.basename(cwd), version: "0.1.0" },
          adapters: { default: adapter },
          repository: { provider: "local" },
          testing: { commands: [] },
          limits: { activeIncrements: 3 },
          livingDocs: false,
        },
        null,
        2,
      )}\n`,
    );
    return { code: 0, stdout: "SpecWeave initialized.\n", stderr: "" };
  }
  if (command === "create-increment") {
    const title = rest.find((arg) => !arg.startsWith("--"))?.trim();
    if (!title) return { code: 2, stdout: "", stderr: "create-increment needs a title.\n" };
    const root = findSpecweaveRoot(cwd);
    if (root === null) return { code: 1, stdout: "", stderr: `${NOT_SET_UP_MESSAGE}\n` };
    const dir = NodePath.join(root, ".specweave", "increments");
    NodeFS.mkdirSync(dir, { recursive: true });
    const numbers = NodeFS.readdirSync(dir)
      .map((name) => /^(\d{4,})-/.exec(name)?.[1])
      .filter(Boolean)
      .map(Number);
    const id = `${String(Math.max(0, ...numbers) + 1).padStart(4, "0")}-${slugify(title)}`;
    const folder = NodePath.join(dir, id);
    NodeFS.mkdirSync(folder);
    const at = now.toISOString();
    NodeFS.writeFileSync(
      NodePath.join(folder, "metadata.json"),
      `${JSON.stringify(
        {
          id,
          uuid: NodeCrypto.randomUUID(),
          status: "active",
          type: "feature",
          priority: "P1",
          created: at,
          updated: at,
          lastActivity: at,
          title,
          project: NodePath.basename(root),
        },
        null,
        2,
      )}\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(folder, "spec.md"),
      `# ${title}\n\n## Problem\n\n${title}\n\n## Scope\n\nIn: [what this increment ships]. Out: [what it does not include].\n\n## Acceptance Criteria\n\n- [ ] AC-01: [Specific, testable criterion]\n\n## Approach\n\n[Files that change, in order.]\n\n## Tasks\n\n### T-01 [First task]\n- AC: AC-01 | Files: [paths] | Test: [command]\n`,
    );
    return { code: 0, stdout: `Created increment ${id}\n`, stderr: "" };
  }
  return { code: 2, stdout: "", stderr: `The stand-in does not know \`${command ?? ""}\`.\n` };
}

const appendJsonLine = (file, entry) => {
  try {
    NodeFS.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
  } catch {}
};
export const readJsonLines = (file) => {
  try {
    return NodeFS.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

/**
 * What the fake agent does with a prompt. The coordinator asks for the work
 * once; after the set-up wake it launches it again; a worker plans it with the CLI.
 */
export function agentAction(text) {
  if (text.includes(SET_UP_WAKE)) return "relaunch";
  if (text.includes(WORKER_TOKEN)) return "plan";
  if (text.includes(ASK_TOKEN)) return "ask";
  return "reply";
}

/** The worker's task the coordinator launches; the worker finds its token in it. */
export const workerTask = () =>
  `${WORKER_TOKEN} Plan the work "${INCREMENT_TITLE}" as an increment named for it, then stop. Do not change any code.`;

// ---------------------------------------------------------------- the stand-in CLI

function runFakeSpecweave([log, real, ...args]) {
  appendJsonLine(log, { event: "specweave", argv: args, cwd: process.cwd(), real: real !== "-" });
  if (real !== "-") {
    const run = NodeChildProcess.spawnSync(real, args, { stdio: "inherit" });
    appendJsonLine(log, { event: "specweave-exit", argv: args, code: run.status ?? 1 });
    process.exit(run.status ?? 1);
  }
  const result = fakeSpecweave(args, process.cwd());
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  appendJsonLine(log, { event: "specweave-exit", argv: args, code: result.code });
  process.exit(result.code);
}

// ---------------------------------------------------------------- the fake agent

/** The studio-code MCP endpoint and authorization the server gave this session. */
export function mcpCredentialOf(params, env = process.env) {
  for (const server of params?.mcpServers ?? []) {
    if (server?.type === "http" && server.url) {
      const header = (server.headers ?? []).find((h) => h.name?.toLowerCase() === "authorization");
      if (header) return { endpoint: server.url, authorization: header.value };
    }
    const vars = Object.fromEntries((server?.env ?? []).map((v) => [v.name, v.value]));
    if (vars.STUDIO_ACP_MCP_ENDPOINT && vars.STUDIO_ACP_MCP_AUTHORIZATION)
      return { endpoint: vars.STUDIO_ACP_MCP_ENDPOINT, authorization: vars.STUDIO_ACP_MCP_AUTHORIZATION };
  }
  if (env.STUDIO_ACP_MCP_ENDPOINT && env.STUDIO_ACP_MCP_AUTHORIZATION)
    return { endpoint: env.STUDIO_ACP_MCP_ENDPOINT, authorization: env.STUDIO_ACP_MCP_AUTHORIZATION };
  return null;
}

function eventPayloads(contentType, text) {
  if (contentType.includes("text/event-stream"))
    return text
      .split(/\r?\n\r?\n/u)
      .map((event) =>
        event
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n"),
      )
      .filter(Boolean)
      .map((data) => JSON.parse(data));
  return text.trim() === "" ? [] : [JSON.parse(text)];
}

/** One MCP call over the server's streamable HTTP endpoint, as the stdio bridge makes it. */
async function callStudioTool(credential, name, args) {
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
      signal: AbortSignal.timeout(60_000),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const text = await response.text();
    if (!response.ok) throw new Error(`MCP ${message.method} answered HTTP ${response.status}`);
    const payloads = eventPayloads(response.headers.get("content-type") ?? "", text);
    for (const payload of payloads) protocolVersion = payload?.result?.protocolVersion ?? protocolVersion;
    return payloads.find((payload) => payload?.id === message.id);
  };
  await post({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "swc-e2e-specweave", version: "1.0.0" } },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const answer = await post({ jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { name, arguments: args } });
  return answer?.result ?? { isError: true, content: [{ type: "text", text: JSON.stringify(answer?.error ?? null) }] };
}

/** The JSON a tool result carries in its text, or its structured content. */
export function toolResultValue(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (result?.content ?? []).find((part) => part.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function runFakeAgent([configPath]) {
  const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
  const log = (entry) => appendJsonLine(config.log, entry);
  const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  const models = { availableModels: [{ modelId: MODEL_ID, name: "Fake SpecWeave 1" }], currentModelId: MODEL_ID };
  const sessions = new Map();
  let count = 0;
  const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
  const say = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

  /** Calls a studio-code tool and shows it as the tool item a real agent's MCP call is. */
  const tool = async (sessionId, name, args) => {
    const session = sessions.get(sessionId);
    const toolCallId = `e2e-${name}-${NodeCrypto.randomBytes(4).toString("hex")}`;
    const rawInput = { server: "studio-code", tool: name, arguments: args };
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      title: `mcp__studio-code__${name}`,
      kind: "other",
      status: "in_progress",
      rawInput,
      _meta: { is_mcp_tool_call: true },
    });
    let result;
    try {
      if (!session?.credential) throw new Error("this session has no studio-code MCP server");
      result = await callStudioTool(session.credential, name, args);
    } catch (error) {
      result = { isError: true, content: [{ type: "text", text: String(error?.message ?? error) }] };
    }
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: result.isError ? "failed" : "completed",
      rawOutput: result,
    });
    const value = toolResultValue(result);
    log({ event: "tool", sessionId, name, args, isError: result.isError === true, value });
    return { value, isError: result.isError === true };
  };

  const prompt = async (id, params) => {
    const sessionId = params.sessionId;
    const text = (params.prompt ?? []).map((part) => part.text ?? "").join("\n");
    const action = agentAction(text);
    const session = sessions.get(sessionId) ?? {};
    log({
      event: "prompt",
      sessionId,
      action,
      cwd: session.cwd ?? null,
      promptChars: text.length,
      createIncrementBrief: text.includes("specweave create-increment"),
    });
    if (action === "ask" || action === "relaunch") {
      const launched = await tool(sessionId, "delegate_task", {
        task: workerTask(),
        title: "Login page",
        increment: "new",
        mode: "async",
        // The fake model counts as billed per use, which is never picked automatically.
        target: { providerInstanceId: PROVIDER_INSTANCE_ID, model: MODEL_ID },
      });
      say(
        sessionId,
        launched.value?.needs === "specweave"
          ? "SpecWeave is not set up in this project yet. Press Set up on the card to plan it."
          : `Launched the work ${launched.isError ? "with an error" : "as an increment"}.`,
      );
    } else if (action === "plan") {
      const cwd = session.cwd ?? process.cwd();
      const run = NodeChildProcess.spawnSync(config.specweave, ["create-increment", INCREMENT_TITLE], {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
      });
      log({ event: "create-increment", sessionId, cwd, code: run.status, stdout: run.stdout, stderr: run.stderr });
      say(sessionId, run.status === 0 ? `Planned: ${run.stdout.trim()}` : `create-increment failed: ${run.stderr.trim()}`);
    } else say(sessionId, "E2E fake agent: nothing to do.");
    send({ id, result: { stopReason: "end_turn" } });
  };

  log({ event: "start", cwd: process.cwd() });
  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === undefined) return;
    const { id, method, params = {} } = message;
    if (method === "initialize")
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: {}, mcpCapabilities: { http: false, sse: false } },
          authMethods: [{ id: "e2e-sign-in", name: "E2E sign-in", description: null }],
          agentInfo: { name: "swc-e2e-specweave", version: "0.0.0-e2e" },
        },
      });
    if (method === "authenticate") return send({ id, result: {} });
    if (method === "session/new") {
      const sessionId = `e2e-sw-${process.pid}-${++count}`;
      const credential = mcpCredentialOf(params);
      sessions.set(sessionId, { cwd: params.cwd ?? null, credential });
      log({ event: "session", sessionId, cwd: params.cwd ?? null, mcp: credential !== null });
      return send({ id, result: { sessionId, models } });
    }
    if (["session/set_model", "session/set_mode", "session/set_config_option"].includes(method))
      return send({ id, result: {} });
    if (method === "session/prompt")
      return void prompt(id, params).catch((error) => {
        log({ event: "prompt-error", reason: String(error?.message ?? error) });
        send({ id, result: { stopReason: "end_turn" } });
      });
    if (method === "session/cancel") return;
    if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  });
  process.stdin.on("end", () => process.exit(0));
}

// ---------------------------------------------------------------- the scenario

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error) => (error instanceof Error ? error.message : String(error)).split("\n")[0];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
const sh = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** Stops a process this script started, and its group, by PID. */
async function stopPid(pid) {
  if (!pid || !alive(pid)) return true;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {}
    }
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
    if (!alive(pid)) return true;
  }
  return !alive(pid);
}

/** Runs the scenario and returns its results; never throws for a failed check. */
export async function runScenario(options) {
  const scratch = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-1396-")));
  if (insideRealData(scratch)) throw new Error(`scratch folder is inside SpecWithCode data: ${scratch}`);
  const paths = {
    home: NodePath.join(scratch, "home"),
    base: NodePath.join(scratch, "base"),
    tmp: NodePath.join(scratch, "tmp"),
    bin: NodePath.join(scratch, "bin"),
    project: NodePath.join(scratch, "firstproject"),
    evidence: options.evidenceDir ?? NodePath.join(scratch, "evidence"),
  };
  for (const dir of Object.values(paths)) NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(paths.project, "README.md"), "# firstproject\n\nA plain folder.\n");
  const logs = {
    agent: NodePath.join(paths.evidence, "fake-agent.jsonl"),
    specweave: NodePath.join(paths.evidence, "specweave-calls.jsonl"),
    server: NodePath.join(paths.evidence, "server.log"),
  };
  for (const file of [...Object.values(logs), NodePath.join(paths.evidence, "results.json")]) NodeFS.rmSync(file, { force: true });
  const results = {
    startedAt: new Date().toISOString(),
    entrypoint: options.entrypoint,
    specweave: options.specweave ? "real" : "stand-in",
    scratch,
    evidence: paths.evidence,
    headless: true,
    checks: [],
    consoleErrors: [],
    cleanup: [],
    ok: false,
  };
  const save = () => NodeFS.writeFileSync(NodePath.join(paths.evidence, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  const record = (name, pass, observed = {}) => {
    results.checks.push({ name, status: pass ? "pass" : "fail", ...observed });
    save();
    if (!pass) throw Object.assign(new Error(`${name} failed`), { recorded: true });
  };

  // The CLI the server and the worker find: a logging stand-in, or a pass-through to --specweave.
  const shim = NodePath.join(paths.bin, "specweave");
  NodeFS.writeFileSync(
    shim,
    `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(SELF)} --fake-specweave ${sh(logs.specweave)} ${sh(options.specweave ?? "-")} "$@"\n`,
  );
  NodeFS.chmodSync(shim, 0o755);
  // The server reads its PATH from `$SHELL -ilc ...` and puts that first. A real
  // login shell reads the machine's profile (path_helper adds /opt/homebrew/bin and
  // /usr/local/bin even under a new HOME), so a specweave installed there would win
  // over the stand-in. This shell runs the read under plain sh with the PATH below.
  const loginShell = NodePath.join(paths.bin, "login-shell");
  NodeFS.writeFileSync(loginShell, `#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n`);
  NodeFS.chmodSync(loginShell, 0o755);
  const agentConfig = NodePath.join(paths.bin, "fake-agent.json");
  NodeFS.writeFileSync(agentConfig, JSON.stringify({ log: logs.agent, specweave: shim }));

  const env = {
    HOME: paths.home,
    USER: "swc-e2e",
    LOGNAME: "swc-e2e",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: paths.tmp,
    XDG_CONFIG_HOME: NodePath.join(paths.home, ".config"),
    XDG_DATA_HOME: NodePath.join(paths.home, ".local", "share"),
    XDG_STATE_HOME: NodePath.join(paths.home, ".local", "state"),
    XDG_CACHE_HOME: NodePath.join(paths.home, ".cache"),
    STUDIO_HOME: paths.base,
    SHELL: loginShell,
    STUDIO_NO_BROWSER: "true",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "SpecWithCode e2e",
    GIT_AUTHOR_EMAIL: "e2e@example.invalid",
    GIT_COMMITTER_NAME: "SpecWithCode e2e",
    GIT_COMMITTER_EMAIL: "e2e@example.invalid",
    // System tools and this Node only, so no provider CLI or other specweave is found.
    PATH: [paths.bin, NodePath.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  };

  let server = null;
  let serverExit = null;
  let browser = null;
  let page = null;
  try {
    record("built-server", NodeFS.existsSync(options.entrypoint), { entrypoint: options.entrypoint });
    let port = await freePort();
    while (port === RESERVED_PORT) port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    results.port = port;
    const serverLog = NodeFS.createWriteStream(logs.server);
    server = NodeChildProcess.spawn(
      process.execPath,
      [options.entrypoint, "serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", paths.base, "--no-browser"],
      { cwd: paths.home, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    results.serverPid = server.pid;
    server.on("exit", (code, signal) => (serverExit = { code, signal }));
    const credential = await new Promise((resolve, reject) => {
      let startup = "";
      const timer = setTimeout(() => reject(new Error("the server printed no token in 60 s")), 60_000);
      const inspect = (chunk) => {
        const text = chunk.toString();
        // The token and pairing links stay out of the evidence.
        serverLog.write(text.replace(/(Token: )\S+/g, "$1<redacted>").replace(/https?:\/\/\S*(token|pair)\S*/gi, "<link redacted>"));
        startup += text;
        const match = /(?:^|\n)Token: (\S+)/.exec(startup);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      server.stdout.on("data", inspect);
      server.stderr.on("data", inspect);
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`the server exited during start: ${code}`));
      });
    });
    const environment = await (await fetch(`${origin}/.well-known/studio/environment`)).json();
    record("server-start", true, { pid: server.pid, serverVersion: environment.serverVersion });

    const waitFor = async (what, fn, { timeout = options.timeoutMs, interval = 500 } = {}) => {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        try {
          const value = await fn();
          if (value) return value;
        } catch (error) {
          last = error;
        }
        if (serverExit !== null) throw new Error(`the server exited (${JSON.stringify(serverExit)}) while waiting for ${what}`);
        await sleep(interval);
      }
      throw new Error(`timed out waiting for ${what}${last ? `: ${errorText(last)}` : ""}`);
    };

    const require = NodeModule.createRequire(NodePath.join(REPO_ROOT, "apps", "server", "package.json"));
    const { chromium } = require("playwright-core");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
    const session = await context.request.post(`${origin}/api/auth/browser-session`, {
      headers: { Origin: origin },
      data: { credential },
    });
    record("browser-session", session.status() === 200, { httpStatus: session.status() });

    // Effect RPC over an authenticated socket, from this process.
    const rpc = async (tag, payload = {}) => {
      const ticketResponse = await context.request.post(`${origin}/api/auth/websocket-ticket`, { headers: { Origin: origin } });
      const { ticket } = await ticketResponse.json();
      const url = new URL(`${origin.replace("http", "ws")}/ws`);
      url.searchParams.set("wsTicket", ticket);
      url.searchParams.set("orchestrationProtocol", "2");
      return await new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => (ws.close(), reject(new Error(`${tag} timed out`))), 30_000);
        ws.addEventListener("open", () => ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })));
        ws.addEventListener("error", () => (clearTimeout(timer), reject(new Error(`${tag}: socket error`))));
        ws.addEventListener("message", (event) => {
          let items;
          try {
            const value = JSON.parse(String(event.data));
            items = Array.isArray(value) ? value : [value];
          } catch {
            return;
          }
          for (const item of items) {
            if (item._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
            if (item._tag !== "Exit" || String(item.requestId) !== "1") continue;
            clearTimeout(timer);
            ws.close();
            if (item.exit?._tag === "Success") resolve(item.exit.value);
            else reject(new Error(`${tag}: ${JSON.stringify(item.exit).slice(0, 600)}`));
          }
        });
      });
    };

    // The fake agent as a local ACP provider, signed in as a person would.
    await rpc("server.updateSettings", {
      patch: {},
      providerInstanceMutation: {
        operation: "upsert",
        instanceId: PROVIDER_INSTANCE_ID,
        instance: {
          driver: "acpRegistry",
          displayName: "E2E SpecWeave agent",
          enabled: true,
          config: { source: "local", agentId: "", commandPath: process.execPath, commandArgs: [SELF, "--fake-agent", agentConfig] },
        },
      },
    });
    const providerOf = async () =>
      ((await rpc("server.getConfig")).providers ?? []).find((p) => p.instanceId === PROVIDER_INSTANCE_ID);
    await waitFor("the fake provider", async () => {
      const entry = await providerOf();
      return ["ready", "warning"].includes(entry?.status) && (entry.models ?? []).some((m) => m.slug === MODEL_ID);
    });
    await rpc("provider.auth.start", { instanceId: PROVIDER_INSTANCE_ID, methodId: "e2e-sign-in" });
    await waitFor("the fake provider sign-in", async () => (await providerOf())?.auth?.status === "authenticated");
    record("fake-provider", true, { instanceId: PROVIDER_INSTANCE_ID });

    // 1. A plain folder with no Git, added as a project.
    const projectId = `e2e-${NodeCrypto.randomUUID()}`;
    await rpc("projects.mutate", {
      type: "project.create",
      commandId: `e2e-${NodeCrypto.randomUUID()}`,
      projectId,
      title: "firstproject",
      workspaceRoot: paths.project,
      defaultModelSelection: MODEL_SELECTION,
    });
    await rpc("projects.mutate", {
      type: "project.update",
      commandId: `e2e-${NodeCrypto.randomUUID()}`,
      projectId,
      defaultModelSelection: MODEL_SELECTION,
    });
    const onDisk = () => ({
      git: NodeFS.existsSync(NodePath.join(paths.project, ".git")),
      specweave: NodeFS.existsSync(NodePath.join(paths.project, ".specweave")),
    });
    const workspace = () => rpc("projects.workspaceRead", { projectId });
    const before = await workspace();
    record("plain-folder-project", !onDisk().git && !onDisk().specweave && before.specweaveState === "off", {
      onDisk: onDisk(),
      specweaveState: before.specweaveState,
      gitRepository: before.gitRepository,
    });

    // The project page, open the whole time: nothing below reloads it.
    page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on("console", (m) => m.type() === "error" && results.consoleErrors.push(m.text().slice(0, 300)));
    page.on("pageerror", (e) => results.consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`));
    const shot = async (name) => {
      const file = NodePath.join(paths.evidence, `${name}.png`);
      await page.screenshot({ path: file, animations: "disabled" }).catch(() => {});
      return NodeFS.existsSync(file) ? file : null;
    };
    const { walkFirstRun } = await import("../studio-verify/first-run-walk.mjs");
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    const nav = page.getByRole("navigation", { name: "Projects and chats" });
    const wizardSteps = await walkFirstRun(page, { until: () => nav.isVisible().catch(() => false), appearTimeoutMs: 60_000, timeoutMs: 120_000 });
    // A project in a temporary folder counts as made by checks, so the sidebar leaves
    // it out and Settings > Archive lists it: open it from there, as a person would.
    await page.goto(`${origin}/settings/archived`, { waitUntil: "domcontentloaded" });
    await page
      .locator("[data-automated-projects], [data-archived-projects]")
      .getByRole("link", { name: "firstproject" })
      .first()
      .click();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.first().waitFor({ state: "visible" });
    record("project-page", true, { wizardSteps, url: new URL(page.url()).pathname });

    // 2. The coordinator is asked for an increment; its launch needs SpecWeave.
    // Typed in the coordinator's message box, as a person asks.
    const coordinatorThreadId = `project-coordinator:${projectId}`;
    const ask = `${ASK_TOKEN} Create an increment for "${INCREMENT_TITLE}".`;
    const box = composer.first();
    const asks = () => readJsonLines(logs.agent).filter((e) => e.event === "prompt" && e.action === "ask");
    const boxHoldsAsk = async () => (await box.innerText().catch(() => "")).includes(ASK_TOKEN);
    // Enter again only while the box still holds the ask, so a slow delivery is never sent twice.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await boxHoldsAsk())) await box.fill(ask);
      await box.press("Enter");
      const taken = await waitFor("the composer to take the ask", async () => !(await boxHoldsAsk()), { timeout: 10_000 }).then(
        () => true,
        () => false,
      );
      if (taken) break;
    }
    await waitFor("the ask to reach the coordinator", () => asks().length > 0);
    const firstLaunch = await waitFor("the coordinator's launch", () =>
      readJsonLines(logs.agent).find((e) => e.event === "tool" && e.name === "delegate_task"),
    );
    record(
      "launch-needs-specweave",
      asks().length === 1 && firstLaunch.value?.launched === false && firstLaunch.value?.needs === "specweave",
      { asks: asks().length, result: firstLaunch.value },
    );

    // 3. The card shows in the coordinator thread, with nothing written yet.
    const cards = page.locator("[data-specweave-card]");
    const card = cards.first();
    await card.waitFor({ state: "visible", timeout: 30_000 });
    // A marker on the page's window: still there at the end means the page never reloaded.
    await page.evaluate(() => {
      window.__swc1396NoReload = true;
    });
    const asking = await workspace();
    const pressLabel = "Set up Git and SpecWeave";
    const button = card.getByRole("button", { name: pressLabel, exact: true });
    await button.waitFor({ state: "visible", timeout: 10_000 });
    record(
      "card-shows",
      (await cards.count()) === 1 &&
        (await card.getAttribute("data-state")) === "asking" &&
        asking.specweaveSetupRequest?.state === "asking" &&
        asking.specweaveSetupRequest?.threadId === coordinatorThreadId &&
        !onDisk().git &&
        !onDisk().specweave &&
        readJsonLines(logs.specweave).length === 0,
      {
        cards: await cards.count(),
        cardState: await card.getAttribute("data-state"),
        request: asking.specweaveSetupRequest,
        onDisk: onDisk(),
        gitSentence: await card.locator("[data-specweave-git]").count(),
        screenshot: await shot("01-card-asking"),
      },
    );

    // 4. One press. The snapshot is watched from the press on, so both it and the
    // card are timed from the moment setup itself finished (the CLI's init exit).
    const pressedAt = Date.now();
    const snapshotOn = waitFor(
      "the snapshot to read on",
      async () => {
        const snapshot = await workspace();
        return snapshot.specweaveState === "on" ? { snapshot, at: Date.now() } : null;
      },
      { timeout: 120_000, interval: 250 },
    );
    snapshotOn.catch(() => {});
    await button.click();
    await waitFor("setup to finish", async () => (await card.getAttribute("data-state")) === "on", { timeout: 120_000, interval: 100 });
    const cardOnAt = Date.now();
    const on = await snapshotOn;
    const initExit = readJsonLines(logs.specweave).find((e) => e.event === "specweave-exit" && e.argv[0] === "init");
    const setUpAt = initExit === undefined ? Number.NaN : Date.parse(initExit.at);
    const inits = readJsonLines(logs.specweave).filter((e) => e.event === "specweave" && e.argv[0] === "init");
    record(
      "set-up",
      onDisk().git &&
        NodeFS.existsSync(NodePath.join(paths.project, ".specweave", "config.json")) &&
        inits.length === 1 &&
        initExit?.code === 0 &&
        NodeFS.realpathSync(inits[0].cwd) === paths.project &&
        cardOnAt - setUpAt <= STATE_ON_WITHIN_MS &&
        on.at - setUpAt <= STATE_ON_WITHIN_MS,
      {
        pressToOnMs: cardOnAt - pressedAt,
        setUpToCardOnMs: cardOnAt - setUpAt,
        setUpToSnapshotOnMs: on.at - setUpAt,
        specweaveState: on.snapshot.specweaveState,
        init: inits.map((e) => ({ argv: e.argv, cwd: e.cwd })),
        onDisk: onDisk(),
        screenshot: await shot("02-card-on"),
      },
    );

    // 5. The wake relaunches the work, and a worker plans it with the CLI.
    const relaunch = await waitFor("the relaunch", () =>
      readJsonLines(logs.agent).find((e) => e.event === "tool" && e.name === "delegate_task" && Date.parse(e.at) >= pressedAt),
    );
    record("relaunch", relaunch.value?.needs === undefined && relaunch.isError === false, { result: relaunch.value });
    const planned = await waitFor("the worker's create-increment", () =>
      readJsonLines(logs.agent).find((e) => e.event === "create-increment"),
    );
    const workerPrompt = readJsonLines(logs.agent).find((e) => e.event === "prompt" && e.action === "plan");
    const incrementsDir = NodePath.join(paths.project, ".specweave", "increments");
    const increments = NodeFS.existsSync(incrementsDir) ? NodeFS.readdirSync(incrementsDir) : [];
    const incrementId = increments.find((name) => name.endsWith(`-${slugify(INCREMENT_TITLE)}`));
    record("increment-created", planned.code === 0 && incrementId !== undefined, {
      workerCwd: planned.cwd,
      workerInProjectFolder: NodeFS.realpathSync(planned.cwd) === paths.project,
      createIncrementBriefGiven: workerPrompt?.createIncrementBrief ?? null,
      stdout: planned.stdout,
      stderr: planned.stderr,
      increments,
    });

    // The Board lists it, opened from the card and never reloaded.
    await card.getByRole("button", { name: "Open the Board", exact: true }).click();
    const boardCard = page.locator(`[data-board-card="${incrementId}"]`).first();
    const openedBoardAt = Date.now();
    await boardCard.waitFor({ state: "visible", timeout: BOARD_REFRESH_MS + 15_000 });
    const board = await rpc("projects.board", { projectId });
    const neverReloaded = await page.evaluate(() => window.__swc1396NoReload === true);
    record("board-lists-increment", neverReloaded && (board.cards ?? []).some((c) => c.incrementId === incrementId), {
      incrementId,
      neverReloaded,
      visibleAfterMs: Date.now() - openedBoardAt,
      boardCards: (board.cards ?? []).map((c) => ({ id: c.incrementId, title: c.title })),
      screenshot: await shot("03-board"),
    });
    results.ok = true;
  } catch (error) {
    if (!error?.recorded) {
      const screenshot = NodePath.join(paths.evidence, "failure.png");
      await page?.screenshot({ path: screenshot, animations: "disabled" }).catch(() => {});
      results.checks.push({
        name: "harness",
        status: "fail",
        reason: errorText(error),
        ...(NodeFS.existsSync(screenshot) ? { screenshot, url: page?.url() } : {}),
      });
    }
  } finally {
    await browser?.close().catch(() => {});
    if (server && serverExit === null) results.cleanup.push({ pid: server.pid, label: "server", stopped: await stopPid(server.pid) });
    for (const pid of new Set(readJsonLines(logs.agent).filter((e) => e.event === "start").map((e) => e.pid)))
      if (alive(pid)) results.cleanup.push({ pid, label: "fake-agent", stopped: await stopPid(pid) });
    results.finishedAt = new Date().toISOString();
    save();
    if (!options.keep) {
      const evidenceInside = paths.evidence.startsWith(scratch + NodePath.sep);
      for (const name of NodeFS.readdirSync(scratch))
        if (!(evidenceInside && NodePath.join(scratch, name) === paths.evidence))
          NodeFS.rmSync(NodePath.join(scratch, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      if (!evidenceInside) NodeFS.rmSync(scratch, { recursive: true, force: true });
    }
  }
  return results;
}

// ---------------------------------------------------------------- entry

if (process.argv[1] && NodePath.resolve(process.argv[1]) === SELF) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "--fake-agent") runFakeAgent(rest);
  else if (mode === "--fake-specweave") runFakeSpecweave(rest);
  else {
    const options = parseArgs(process.argv.slice(2));
    const results = await runScenario(options);
    for (const check of results.checks) console.log(`${check.status === "pass" ? "PASS" : "FAIL"} ${check.name}${check.reason ? `: ${check.reason}` : ""}`);
    console.log(`${results.ok ? "ALL CHECKS PASSED" : "FAILED"} ${NodePath.join(results.evidence, "results.json")}`);
    process.exit(results.ok ? 0 : 1);
  }
}
