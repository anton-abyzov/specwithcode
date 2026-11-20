#!/usr/bin/env node
// Checks, on a private server, that a provider's command-line program is picked
// up after it is installed, with no click and no restart.
//
//   node scripts/studio-verify/provider-install-detect.mjs <evidence dir> [--real-muse]
//
// Build the server first (`node apps/server/scripts/cli.ts build`, Node 22).
// macOS and Linux only: the stand-in programs are shell scripts.
//
// Default run, with a throwaway home and stand-in programs that contact nothing:
//   1. Muse Code and Grok are on and not installed.
//   2. A stand-in `muse` lands in ~/.local/bin, a folder that did not exist when
//      the server started. The row must turn ready within 10 s.
//   3. A stand-in `grok` lands in a new folder that one new line in the shell
//      profile puts on PATH. The row must turn ready within 10 s.
// The script acts as one open window: it reports itself in the foreground and
// reads the provider list. It never asks for a refresh.
//
// --real-muse runs the installed `muse` with this account's own sign-in and an
// empty Muse data folder, the state of a machine where Muse Code was just
// installed: the row must be signed in with its plan and models, and Check
// again must bring the model list back after it is removed. It reads no
// credential file; `muse` reads its own.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.ok(process.versions.node.startsWith("22."), "Use Node 22");
assert.notEqual(process.platform, "win32", "This check runs on macOS and Linux");
const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"));
assert.ok(positional[0], "Pass an evidence directory");
const realMuse = process.argv.includes("--real-muse");
const out = resolve(positional[0]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entrypoint = join(root, "apps/server/dist/bin.mjs");
assert.ok(existsSync(entrypoint), "Build the server first: node apps/server/scripts/cli.ts build");

const FLIP_LIMIT_MS = 10_000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const lines = [];
const log = (line) => {
  lines.push(line);
  console.log(line);
};

mkdirSync(out, { recursive: true, mode: 0o700 });
const state = mkdtempSync(join(out, "private-state-"));
const home = realMuse ? homedir() : mkdtempSync(join(out, "private-home-"));
const stock = mkdtempSync(join(out, "stand-ins-"));
const museData = mkdtempSync(join(out, "muse-data-"));
mkdirSync(join(state, "userdata"));

const off = Object.fromEntries(
  ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"].map((id) => [
    id,
    { enabled: false },
  ]),
);
writeFileSync(
  join(state, "userdata/settings.json"),
  JSON.stringify({
    providers: off,
    providerInstances: realMuse
      ? {
          muse: {
            driver: "muse",
            enabled: true,
            // An empty data folder: Muse Code has no model list on disk yet.
            environment: [{ name: "XDG_DATA_HOME", value: museData, sensitive: false }],
            config: {},
          },
        }
      : {
          muse: { driver: "muse", enabled: true, config: {} },
          grok: { driver: "grok", enabled: true, config: {} },
        },
  }),
  { mode: 0o600 },
);

/** Puts a stand-in program in place the way an installer does: whole, then renamed. */
function install(folder, name, script) {
  mkdirSync(folder, { recursive: true });
  const partial = join(stock, `${name}.partial`);
  writeFileSync(partial, script);
  chmodSync(partial, 0o755);
  renameSync(partial, join(folder, name));
}

async function museStandIn() {
  const serverRequire = createRequire(join(root, "apps/server/package.json"));
  const sdk = await import(pathToFileURL(serverRequire.resolve("@muse-code/sdk")).href);
  const work = join(stock, "muse-work");
  mkdirSync(work);
  writeFileSync(
    join(stock, "usage.json"),
    JSON.stringify({
      schemaVersion: 1,
      allowance: {
        tier: "Stand-in plan",
        window: { usedPercent: 1, resetsAtMs: Date.now() + 3_600_000 },
        weekly: { usedPercent: 5, resetsAtMs: Date.now() + 86_400_000 },
        asOfMs: Date.now(),
      },
    }),
  );
  return [
    "#!/bin/sh",
    'case "$1" in',
    `  serve) cd "${work}" && MUSE_TEST_FINGERPRINT="${sdk.EXPECTED_SCHEMA_FINGERPRINT}" exec "${process.execPath}" "${join(root, "apps/server/src/provider/muse/fixtures/serve.cjs")}" ;;`,
    `  usage) cat "${join(stock, "usage.json")}" ;;`,
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n");
}

function grokStandIn() {
  // Answers the one request the check sends its agent, then waits to be closed.
  const agent = join(stock, "grok-agent.cjs");
  writeFileSync(
    agent,
    [
      'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
      "  const { id, method } = JSON.parse(line);",
      "  if (id === undefined) return;",
      '  const result = method === "initialize" ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } : {};',
      '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");',
      "});",
      "",
    ].join("\n"),
  );
  return [
    "#!/bin/sh",
    'case "$1" in',
    '  --version) echo "grok 1.0.13" ;;',
    "  models) printf '%s\\n' 'You are logged in with grok.com.' '' 'Default model: stand-in-1' '' 'Available models:' '  * stand-in-1 (default)' ;;",
    `  agent) exec "${process.execPath}" "${agent}" ;;`,
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n");
}

const port = await new Promise((done, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const shell = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
const profile = join(home, shell.endsWith("zsh") ? ".zshrc" : ".bash_profile");
const child = spawn(
  process.execPath,
  [
    entrypoint,
    "serve",
    "--no-browser",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    state,
  ],
  {
    cwd: state,
    env: realMuse
      ? { ...process.env, STUDIO_DISABLE_AUTO_UPDATE: "true" }
      : {
          // Nothing of the person running this: no real home, PATH or provider keys.
          HOME: home,
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          SHELL: shell,
          USER: process.env.USER ?? "dev",
          LANG: process.env.LANG ?? "en_US.UTF-8",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          STUDIO_DISABLE_AUTO_UPDATE: "true",
        },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const stop = () => {
  if (child.exitCode === null) child.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", stop);

let failed = false;
try {
  const credential = await new Promise((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("The server did not start in 60 s")), 60_000);
    const observe = (chunk) => {
      output += chunk.toString();
      const match = output.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The server exited ${code}\n${output.slice(-2000)}`));
    });
  });
  const session = await fetch(`${origin}/api/auth/browser-session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  assert.equal(session.status, 200);
  const cookie = session.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(ticketResponse.status, 200);
  const { ticket } = await ticketResponse.json();
  const url = new URL("/ws", origin);
  url.protocol = "ws:";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");

  // One connection for the whole run, as a window keeps one.
  const socket = new WebSocket(url);
  await new Promise((done, reject) => {
    socket.onopen = done;
    socket.onerror = () => reject(new Error("The connection failed"));
  });
  const waiting = new Map();
  let nextId = 0;
  socket.onmessage = ({ data }) => {
    const values = JSON.parse(data);
    for (const item of Array.isArray(values) ? values : [values]) {
      if (item._tag !== "Exit") continue;
      const entry = waiting.get(String(item.requestId));
      if (!entry) continue;
      waiting.delete(String(item.requestId));
      clearTimeout(entry.timer);
      if (item.exit?._tag === "Success") entry.done(item.exit.value);
      else entry.reject(new Error(`${entry.tag} failed: ${JSON.stringify(item.exit)}`));
    }
  };
  const calls = [];
  const rpc = (tag, payload, limitMs = 30_000) =>
    new Promise((done, reject) => {
      const id = String(++nextId);
      if (tag !== "server.getConfig" && tag !== "server.reportClientActivity") calls.push(tag);
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${tag} timed out`));
      }, limitMs);
      waiting.set(id, { done, reject, timer, tag });
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });

  const inForeground = () =>
    rpc("server.reportClientActivity", {
      clientId: "provider-install-detect",
      clientKind: "web",
      visible: true,
      focused: true,
      recentlyInteracted: true,
      scopes: [{ type: "provider-status" }],
      observedAt: new Date().toISOString(),
      lastInteractionAt: new Date().toISOString(),
    });
  await inForeground();
  const lease = setInterval(() => inForeground().catch(() => {}), 10_000);

  const row = async (instanceId) => {
    const config = await rpc("server.getConfig", {});
    return config.providers.find((provider) => provider.instanceId === instanceId);
  };
  const brief = (provider) => ({
    installed: provider?.installed,
    status: provider?.status,
    auth: provider?.auth,
    cli: provider?.cli,
    version: provider?.version,
    models: provider?.models?.map((model) => model.slug),
    limits: provider?.usageLimits?.windows?.map(
      (window) => `${window.kind} ${window.usedPercent}%`,
    ),
    message: provider?.message,
  });
  /** Reads the row until `done` says so; the time is counted from `since`. */
  const until = async (instanceId, done, since, limitMs) => {
    for (;;) {
      const provider = await row(instanceId);
      const elapsed = Date.now() - since;
      if (provider && done(provider)) return { provider, elapsed };
      if (elapsed > limitMs) return { provider, elapsed: null };
      await sleep(250);
    }
  };
  const result = { mode: realMuse ? "real-muse" : "stand-ins", steps: [] };
  const expect = (name, ok, detail) => {
    result.steps.push({ name, ok, ...detail });
    log(
      `${ok ? "ok  " : "FAIL"} ${name}${detail?.elapsedMs != null ? ` (${detail.elapsedMs} ms)` : ""}`,
    );
    if (!ok) failed = true;
  };

  if (realMuse) {
    // Signed in, with models, and with the limits that let it be offered as a fallback.
    const signedIn = (provider) =>
      provider.auth?.status === "authenticated" &&
      (provider.models?.length ?? 0) > 0 &&
      (provider.usageLimits?.windows?.length ?? 0) > 0;
    const first = await until("muse", signedIn, Date.now(), 90_000);
    expect(
      "signed in with its plan and models on an empty Muse data folder",
      first.elapsed !== null,
      {
        row: brief(first.provider),
      },
    );
    // The model list goes, as on a newly installed machine; Check again brings it back.
    rmSync(join(museData, "muse"), { recursive: true, force: true });
    const start = Date.now();
    const answered = await rpc(
      "server.refreshProviders",
      { instanceId: "muse", fresh: true },
      90_000,
    );
    const after = answered.providers.find((provider) => provider.instanceId === "muse");
    expect("Check again reads the sign-in and downloads the model list again", signedIn(after), {
      elapsedMs: Date.now() - start,
      row: brief(after),
    });
  } else {
    const missing = (provider) => provider.installed === false && provider.cli?.state === "missing";
    const ready = (provider) => provider.installed === true && provider.status === "ready";
    for (const instanceId of ["muse", "grok"]) {
      const before = await until(instanceId, missing, Date.now(), 30_000);
      expect(
        `${instanceId} starts not installed, with its command named`,
        before.elapsed !== null,
        {
          row: brief(before.provider),
        },
      );
    }

    const localBin = join(home, ".local/bin");
    assert.ok(!existsSync(localBin), "~/.local/bin must not exist before the install");
    const museScript = await museStandIn();
    let since = Date.now();
    install(localBin, "muse", museScript);
    const muse = await until("muse", ready, since, FLIP_LIMIT_MS);
    expect("muse in a new ~/.local/bin turns ready with no click", muse.elapsed !== null, {
      elapsedMs: muse.elapsed,
      row: brief(muse.provider),
    });

    const later = join(home, "later-tools");
    install(later, "grok", grokStandIn());
    const unseen = await row("grok");
    expect("grok in a folder that is not on PATH is still not installed", missing(unseen), {
      row: brief(unseen),
    });
    since = Date.now();
    writeFileSync(profile, `export PATH="${later}:$PATH"\n`, { flag: "a" });
    const grok = await until("grok", ready, since, FLIP_LIMIT_MS);
    expect(
      "grok turns ready after one line in the shell profile, with no click",
      grok.elapsed !== null,
      {
        elapsedMs: grok.elapsed,
        row: brief(grok.provider),
      },
    );
    expect("the script asked for no refresh", calls.length === 0, { calls });
  }

  clearInterval(lease);
  socket.close();
  result.passed = !failed;
  writeFileSync(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(out, "result.txt"), `${lines.join("\n")}\n`);
  log(`${failed ? "FAILED" : "PASSED"}: ${join(out, "result.json")}`);
} finally {
  stop();
  // The stand-ins and the private home are of no use after the run; the result stays.
  for (const folder of [state, stock, museData, ...(realMuse ? [] : [home])]) {
    rmSync(folder, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
