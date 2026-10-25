// Shared pieces of the design live checks: a private, isolated server built from this checkout
// (or one another runner already started), its sign-in, RPC and WebSocket helpers, a headless
// browser and small assertion helpers. verify-canvas.mjs, verify-slides.mjs and
// scripts/studio-verify/design-boards-slides.mjs use it; nothing here opens a visible browser.
//
// A runner that owns the server calls startServer(). A runner given STUDIO_LIVE_SERVER (the path
// of the descriptor startServer() wrote) attaches to that server instead and never stops it.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const repoRoot = NodePath.resolve(here, "../../../../..");
export const serverEntrypoint = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");
export const webIndex = NodePath.join(repoRoot, "apps/web/dist/index.html");

/** Every built-in provider driver; the private server lists each one, disabled. */
export const PROVIDER_DRIVERS = [
  "codex",
  "claudeAgent",
  "claude-agent",
  "cursor",
  "grok",
  "pi",
  "opencode",
  "opencode2",
  "antigravity",
  "copilot",
  "githubCopilot",
];

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function waitFor(predicate, timeout = 5000, label = "condition") {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `check(name, run)` records `{name, ok, ms, detail | error}` into `results` and never throws. */
export function checker(results, { onFailure = null, log = console.log } = {}) {
  return async function check(name, run) {
    const started = Date.now();
    try {
      const detail = await run();
      results.push({ name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
      log(`ok   ${name}${detail ? ` (${JSON.stringify(detail).slice(0, 400)})` : ""}`);
      return detail ?? true;
    } catch (error) {
      results.push({
        name,
        ok: false,
        ms: Date.now() - started,
        error: String(error?.message ?? error).slice(0, 4000),
      });
      await onFailure?.(name).catch(() => undefined);
      log(`FAIL ${name}: ${String(error?.message ?? error).split("\n")[0]}`);
      return null;
    }
  };
}

export const gitHead = () =>
  NodeChildProcess.execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();

export const entrypointSha256 = () =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(serverEntrypoint)).digest("hex");

export function requireBuild() {
  for (const file of [serverEntrypoint, webIndex])
    if (!NodeFS.existsSync(file)) throw new Error(`Build first: missing ${file}`);
}

export function initRepository(dir, files) {
  NodeFS.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, name), text);
  }
  NodeChildProcess.execFileSync("/usr/bin/git", ["init", "-q", "-b", "main"], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

// ---- browser -----------------------------------------------------------------------------------

/** Playwright from STUDIO_PLAYWRIGHT_MODULE, else this checkout's own playwright-core. */
export async function loadPlaywright() {
  const require = NodeModule.createRequire(NodePath.join(repoRoot, "apps/server/package.json"));
  const candidate = process.env.STUDIO_PLAYWRIGHT_MODULE;
  if (candidate) {
    try {
      return require(candidate);
    } catch {
      return import(NodeURL.pathToFileURL(NodePath.join(candidate, "index.mjs")).href);
    }
  }
  return require("playwright-core");
}

/** Always headless; STUDIO_CHROMIUM_EXECUTABLE picks an installed headless shell. */
export async function launchBrowser() {
  const { chromium } = await loadPlaywright();
  return chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
}

/** Page and console errors, minus the CSP notices that sandboxed srcdoc frames print. */
export function watchErrors(page, label, errors) {
  page.on("pageerror", (error) => errors.push(`${label}: ${error}`));
  page.on(
    "console",
    (message) =>
      message.type() === "error" &&
      !(
        message.location().url === "about:srcdoc" &&
        /Content Security Policy|Blocked script execution/.test(message.text())
      ) &&
      errors.push(`${label}: ${message.text()}`),
  );
}

/**
 * Counts the orchestration commands a page sends over its sockets: `thread.create`,
 * `message.dispatch` (a turn) and the thread ids each names.
 */
export function watchCommands(page) {
  const seen = { threadCreate: [], messageDispatch: [], other: {} };
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : "";
      if (!text.includes('"type"')) return;
      for (const type of text.matchAll(/"type":"([a-z]+\.[a-zA-Z.]+)"/g)) {
        const name = type[1];
        const threadId = text.match(/"threadId":"([^"]+)"/)?.[1] ?? null;
        if (name === "thread.create") seen.threadCreate.push({ threadId, at: Date.now() });
        else if (name === "message.dispatch")
          seen.messageDispatch.push({ threadId, at: Date.now() });
        else if (/^(thread|message|turn)\./.test(name))
          seen.other[name] = (seen.other[name] ?? 0) + 1;
      }
    }),
  );
  return seen;
}

/** Text of the shell around the app: no Token line ever leaves this module. */
const redact = (text) => text.replace(/Token: \S+/g, "Token: <omitted>");

// ---- server ------------------------------------------------------------------------------------

const freePort = () =>
  new Promise((done, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => done(value));
    });
  });

export const portIsFree = (port) =>
  new Promise((done) => {
    const server = NodeNet.createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });

export const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function serverApi({ origin, accessToken }) {
  async function request(path, body) {
    const response = await fetch(origin + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Authorization: `Bearer ${accessToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status !== 200)
      throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json();
  }
  async function socket() {
    const { ticket } = await request("/api/auth/websocket-ticket");
    const url = new URL(origin);
    url.protocol = "ws:";
    url.pathname = "/ws";
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    return new WebSocket(url);
  }
  /** One request on its own socket; resolves with the Exit value. */
  async function rpc(tag, payload, timeout = 30000) {
    const ws = await socket();
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`RPC timeout: ${tag}`));
      }, timeout);
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
      );
      ws.addEventListener("message", (event) => {
        for (const value of [JSON.parse(event.data)].flat())
          if (value._tag === "Exit" && String(value.requestId) === "1") {
            clearTimeout(timer);
            ws.close();
            if (value.exit?._tag === "Success") done(value.exit.value);
            else
              reject(new Error(`RPC ${tag} failed: ${JSON.stringify(value.exit).slice(0, 800)}`));
          }
      });
    });
  }
  /** A stream request: resolves with the first chunk value `accept` takes, then closes. */
  async function rpcFirst(tag, payload, accept = () => true, timeout = 30000) {
    const ws = await socket();
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`RPC stream timeout: ${tag}`));
      }, timeout);
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
      );
      ws.addEventListener("message", (event) => {
        for (const value of [JSON.parse(event.data)].flat()) {
          if (String(value.requestId) !== "1") continue;
          if (value._tag === "Chunk")
            for (const item of value.values ?? [])
              if (accept(item)) {
                clearTimeout(timer);
                ws.close();
                done(item);
                return;
              }
          if (value._tag === "Exit") {
            clearTimeout(timer);
            ws.close();
            reject(new Error(`RPC ${tag} ended: ${JSON.stringify(value.exit).slice(0, 800)}`));
          }
        }
      });
    });
  }
  return { request, rpc, rpcFirst };
}

/**
 * Starts this checkout's built server on a fresh loopback port with `home` as its private base
 * dir (never a live store). Every provider is off; `extraInstances` adds provider instances
 * (verify-canvas's model-free design agent). The headless export browser runs without Chrome's
 * sandbox, as the private runs before this one did, unless `browserSandbox` is true.
 */
export async function startServer({
  home,
  cwd,
  logFile,
  label,
  extraInstances = {},
  browserSandbox = false,
}) {
  requireBuild();
  for (const live of [".specwithcode", ".specweave-studio"])
    assert(
      !NodePath.resolve(home).split(NodePath.sep).includes(live),
      `refusing a live store: ${home}`,
    );
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(
    NodePath.join(home, "userdata/settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(PROVIDER_DRIVERS.map((driver) => [driver, { enabled: false }])),
      providerInstances: {
        ...Object.fromEntries(
          PROVIDER_DRIVERS.map((driver) => [driver, { driver, enabled: false, config: {} }]),
        ),
        ...extraInstances,
      },
      cursorKeychainUsageEnabled: false,
    }),
  );
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const log = NodeFS.createWriteStream(logFile);
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      serverEntrypoint,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      home,
      "--no-browser",
    ],
    {
      cwd: cwd ?? home,
      env: {
        PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: cwd ?? home,
        LANG: "en_US.UTF-8",
        STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        STUDIO_DISABLE_AUTO_UPDATE: "true",
        SPECWITHCODE_DISABLE_AUTO_UPDATE: "true",
        ...(browserSandbox ? {} : { STUDIO_SERVER_BROWSER_SANDBOX: "0" }),
        PWDEBUG: "0",
        PLAYWRIGHT_HTML_OPEN: "never",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let tail = "";
  const bootstrap = await new Promise((done, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("server startup timeout")), 60000);
    const inspect = (chunk) => {
      const text = chunk.toString();
      log.write(redact(text));
      tail = (tail + redact(text)).slice(-8000);
      buffer = (buffer + text).slice(-65536);
      const token = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (token) {
        clearTimeout(timer);
        done(token[1]);
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => reject(new Error(`server exited during startup (${code})`)));
  });
  const response = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:specweave-studio:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: label ?? "Design live check",
    }),
  });
  if (response.status !== 200) {
    child.kill("SIGTERM");
    throw new Error(`token exchange ${response.status}`);
  }
  const accessToken = (await response.json()).access_token;
  const server = makeServer({ origin, port, pid: child.pid, accessToken, home, owned: true });
  server.logTail = () => tail;
  server.stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(8000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exited, sleep(3000)]);
      }
    }
    log.end();
    return { pid: child.pid, alive: pidAlive(child.pid), portFree: await portIsFree(port) };
  };
  return server;
}

/** The server a parent runner started: STUDIO_LIVE_SERVER names its descriptor. */
export function attachedServer() {
  const file = process.env.STUDIO_LIVE_SERVER;
  if (!file) return null;
  const descriptor = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  const server = makeServer({ ...descriptor, owned: false });
  server.stop = async () => ({ pid: descriptor.pid, attached: true });
  return server;
}

function makeServer({ origin, port, pid, accessToken, home, scratchRoot, owned }) {
  const api = serverApi({ origin, accessToken });
  return {
    origin,
    port,
    pid,
    home,
    owned,
    scratchRoot: scratchRoot ?? NodePath.dirname(home),
    ...api,
    /** Where an attached runner may make its own folders. */
    describe(file, extra = {}) {
      NodeFS.writeFileSync(
        file,
        JSON.stringify({ origin, port, pid, accessToken, home, ...extra }, null, 2),
        { mode: 0o600 },
      );
      return file;
    },
    /**
     * A browser context signed in as the owner (the desktop app): pairs a browser with the
     * design scopes, then carries the startup credential's session in the cookie.
     */
    async signedInContext(browser, { colorScheme = "light", viewport, deviceScaleFactor } = {}) {
      const context = await browser.newContext({
        viewport: viewport ?? { width: 1600, height: 960 },
        colorScheme,
        acceptDownloads: true,
        ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
      });
      const pairing = await api.request("/api/auth/pairing-token", {
        label: `Design live ${colorScheme}`,
        scopes: [
          "orchestration:read",
          "orchestration:operate",
          "filesystem:read",
          "filesystem:write",
          "settings:write",
        ],
      });
      const signedIn = await context.request.post(`${origin}/api/auth/browser-session`, {
        headers: { Origin: origin },
        data: { credential: pairing.credential },
      });
      assert(signedIn.status() === 200, `browser sign-in ${signedIn.status()}`);
      const cookies = await context.cookies(origin);
      const session = cookies.find((cookie) => cookie.name.startsWith("studio_session"));
      assert(session, `no session cookie: ${cookies.map((cookie) => cookie.name).join(",")}`);
      await context.addCookies([{ ...session, value: accessToken }]);
      return context;
    },
  };
}

// ---- editor helpers ----------------------------------------------------------------------------

export const saved = (page, timeout = 8000) =>
  waitFor(
    async () => (await page.getByTestId("save-state").textContent())?.trim() === "Saved",
    timeout,
    "Saved",
  );

/** Picks `item` from the editor's Export menu and saves the download as `file`. */
export async function exportFromMenu(page, item, file, timeout = 180000) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout }),
    page.getByRole("menuitem", { name: item }).click(),
  ]);
  await download.saveAs(file);
  return { file, bytes: NodeFS.statSync(file).size, suggested: download.suggestedFilename() };
}

/**
 * Waits until the server's export browser renders: a fresh home installs its pinned headless
 * shell on the first export, and a check that raced that install would test the download.
 */
export async function warmExportBrowser(server, address, timeout = 420000) {
  const end = Date.now() + timeout;
  const started = Date.now();
  let attempts = 0;
  let last = null;
  while (Date.now() < end) {
    attempts += 1;
    try {
      const result = await server.rpc(
        "design.export",
        { ...address, format: "png", scale: 1 },
        120000,
      );
      return {
        ms: Date.now() - started,
        attempts,
        bytes: Buffer.from(result.data, "base64").length,
      };
    } catch (error) {
      last = String(error?.message ?? error);
      await sleep(5000);
    }
  }
  throw new Error(`the export browser never rendered: ${last}`);
}

/** Messages, runs and provider turns a thread has: all zero while nothing ran. */
export async function threadActivity(server, threadId) {
  const projection = await server.rpc("orchestration.getThreadProjection", { threadId });
  return {
    messages: projection.messages?.length ?? null,
    runs: projection.runs?.length ?? null,
    providerTurns: projection.providerTurns?.length ?? null,
    title: projection.thread?.title ?? null,
    projectId: projection.thread?.projectId ?? null,
  };
}

/** The composer's text in `scope` (a page or locator). */
export const composerText = async (scope) =>
  ((await scope.locator('[data-testid="composer-editor"]').first().textContent()) ?? "").trim();
