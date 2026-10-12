// Run only after the fleet operator releases the verification window.
// This checks installed delivery/read-only rendering. verify.mjs owns the
// isolated writable option-selection/persistence proof; never bypass inert here.
//
// Host-independent: the installed identity, host and port are required flags and
// every path is derived from the installer layout under the current user's home
// (scripts/studio-fleet/install.py). The browser is always headless. The only
// write is a five-minute orchestration:read pairing (and the browser session it
// creates), both labelled with a per-run identifier and revoked before exit;
// settings, projects, threads, worktrees and the service are never changed.
//
// Usage:
//   node scripts/studio-workspaces/verify-installed.mjs --release-window-authorized \
//     --identity <id> --host 127.0.0.1 --port <port> --artifact-sha <sha256> \
//     --source-commit <sha1> --report-dir <new absolute dir> --playwright <playwright package dir>
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
const hash = (value) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const same = (a, b, code) => check(NodeUtil.isDeepStrictEqual(a, b), code);
const scope = ["orchestration:read"];
const workspaceLabels = ["Automatic (Git worktree)", "Current checkout", "New worktree"];
const startupCopy =
  "Fetches upstream refs when Studio starts. Use Pull to update checkouts. Projects can override it.";
const VALUE_FLAGS = [
  "--identity",
  "--host",
  "--port",
  "--artifact-sha",
  "--source-commit",
  "--report-dir",
  "--playwright",
];

export function parseOptions(argv) {
  const args = [...argv];
  const result = {};
  while (args.length) {
    const key = args.shift();
    check(VALUE_FLAGS.includes(key) || key === "--release-window-authorized", "Unknown argument");
    check(!Object.hasOwn(result, key), "Duplicate argument");
    if (key === "--release-window-authorized") result[key] = true;
    else {
      check(args.length && !args[0].startsWith("--"), "Missing argument");
      result[key] = args.shift();
    }
  }
  check(
    result["--release-window-authorized"] === true,
    "Release window authorization flag required",
  );
  check(/^[a-z0-9][a-z0-9-]{0,62}$/.test(result["--identity"] ?? ""), "Invalid installed identity");
  check(/^[A-Za-z0-9.-]{1,253}$/.test(result["--host"] ?? ""), "Invalid installed host");
  check(/^[1-9][0-9]{3,4}$/.test(result["--port"] ?? ""), "Invalid installed port");
  const port = Number(result["--port"]);
  check(port >= 1024 && port <= 65535, "Invalid installed port");
  check(/^[a-f0-9]{64}$/.test(result["--artifact-sha"] ?? ""), "Invalid archive digest");
  check(/^[a-f0-9]{40}$/.test(result["--source-commit"] ?? ""), "Invalid source commit");
  check(
    typeof result["--report-dir"] === "string" && NodePath.isAbsolute(result["--report-dir"]),
    "Absolute new report directory required",
  );
  check(
    typeof result["--playwright"] === "string" && NodePath.isAbsolute(result["--playwright"]),
    "Absolute Playwright package directory required",
  );
  return { ...result, "--port": port };
}

// Mirrors the installer layout; nothing here names a particular machine or user.
export function installedLayout(expected, home, uid) {
  const identity = expected["--identity"];
  const own = NodePath.join(home, ".specweave-studio", identity);
  const releasesRoot = NodePath.join(home, ".local", "share", "specweave-studio");
  return {
    home,
    uid,
    identity,
    own,
    origin: `http://${expected["--host"]}:${expected["--port"]}`,
    host: expected["--host"],
    port: expected["--port"],
    installationPath: NodePath.join(own, "installation.json"),
    settingsPath: NodePath.join(own, "userdata", "settings.json"),
    runtimePath: NodePath.join(own, "userdata", "server-runtime.json"),
    releasesRoot,
    release: NodePath.join(releasesRoot, "releases", expected["--artifact-sha"].slice(0, 20)),
    serviceDomain: `gui/${uid}`,
    serviceLabel: `com.specweave.studio.${identity}`,
  };
}

let home, own, origin, installationPath, settingsPath, layout;

function command(binary, args, timeout = 12000) {
  const result = NodeChildProcess.spawnSync(binary, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      HOME: home,
      USER: NodeOS.userInfo().username,
      LANG: "en_US.UTF-8",
      PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      PWDEBUG: "0",
      PLAYWRIGHT_HTML_OPEN: "never",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Never surface subprocess stdout/stderr: pairing creation contains a credential.
  check(result.status === 0 && !result.error, "Bounded owned command failed; output withheld");
  return result.stdout;
}

// Atomic, flushed private metadata survives interruption between auth mutation
// and its response. Recovery handles are public IDs/labels, never credentials.
function savePrivateJson(path, value) {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = NodeFS.openSync(temporary, "wx", 0o600);
    NodeFS.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n");
    NodeFS.fsyncSync(descriptor);
    NodeFS.closeSync(descriptor);
    descriptor = undefined;
    NodeFS.renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) NodeFS.closeSync(descriptor);
    if (NodeFS.existsSync(temporary)) NodeFS.unlinkSync(temporary);
  }
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid private metadata; output withheld");
  }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const metadataHash = (value) => hash(JSON.stringify(canonical(value)));
function sortedMetadata(rows, key) {
  check(Array.isArray(rows), "Metadata list unavailable");
  const ids = rows.map((row) => row[key]);
  check(
    ids.every((id) => typeof id === "string" && id.length) && new Set(ids).size === ids.length,
    "Metadata identities invalid",
  );
  return [...rows].sort((a, b) => a[key].localeCompare(b[key]));
}

function provenance(expected) {
  const bytes = NodeFS.readFileSync(installationPath);
  const current = json(bytes.toString());
  const release = layout.release;
  check(
    current.identity === layout.identity && current.uid === layout.uid,
    "Installed identity or user mismatch",
  );
  check(
    current.archiveSha256 === expected["--artifact-sha"] &&
      current.sourceCommit === expected["--source-commit"],
    "Installed artifact differs from reviewed release",
  );
  check(
    current.release === release &&
      NodeFS.realpathSync(release) === release &&
      NodeFS.realpathSync(own) === own,
    "Installed release or state path mismatch",
  );
  check(
    current.studioHome === own && current.stateDir === NodePath.join(own, "userdata"),
    "Installed state home mismatch",
  );
  check(current.host === layout.host && current.port === layout.port, "Installed origin mismatch");
  check(
    current.service?.installed === true &&
      current.service.domain === layout.serviceDomain &&
      current.service.label === layout.serviceLabel,
    "Installed service identity mismatch",
  );
  check(
    current.node === process.execPath && current.nodeVersion === "22.20.0",
    "Use the installed Node 22.20.0 executable",
  );
  const manifestPath = NodePath.join(current.release, "studio-manifest.json");
  const manifestBytes = NodeFS.readFileSync(manifestPath);
  const manifest = json(manifestBytes.toString());
  check(
    manifest.product === "SpecWeave Studio" &&
      manifest.sourceCommit === current.sourceCommit &&
      manifest.runtime === "Node22.20.0",
    "Manifest provenance mismatch",
  );
  check(
    Array.isArray(manifest.files) && manifest.files.length > 0,
    "Manifest inventory unavailable",
  );
  const declared = new Set(["studio-manifest.json"]);
  const optionAssets = new Map(workspaceLabels.map((label) => [label, []]));
  for (const entry of manifest.files) {
    check(
      typeof entry.path === "string" &&
        !NodePath.isAbsolute(entry.path) &&
        !declared.has(entry.path),
      "Invalid manifest member",
    );
    const file = NodePath.resolve(release, entry.path);
    check(
      file.startsWith(release + NodePath.sep) &&
        NodeFS.realpathSync(file).startsWith(release + NodePath.sep),
      "Artifact member escapes release",
    );
    declared.add(entry.path);
    const stat = NodeFS.lstatSync(file);
    if (entry.type === "symlink")
      check(
        stat.isSymbolicLink() && NodeFS.readlinkSync(file) === entry.target,
        "Artifact symlink mismatch",
      );
    else {
      check(
        entry.type === "file" && stat.isFile() && !stat.isSymbolicLink(),
        "Artifact file type mismatch",
      );
      const content = NodeFS.readFileSync(file);
      check(hash(content) === entry.sha256, "Artifact file digest mismatch");
      if (entry.path.startsWith("client/") && entry.path.endsWith(".js")) {
        const text = content.toString("utf8");
        for (const label of workspaceLabels)
          if (text.includes(label))
            optionAssets.get(label).push({ path: entry.path, sha256: entry.sha256 });
      }
    }
  }
  const actual = new Set();
  function walk(directory) {
    for (const name of NodeFS.readdirSync(directory)) {
      const path = NodePath.join(directory, name);
      if (NodeFS.lstatSync(path).isDirectory()) walk(path);
      else actual.add(NodePath.relative(release, path));
    }
  }
  walk(release);
  same([...actual].sort(), [...declared].sort(), "Installed artifact inventory mismatch");
  for (const label of workspaceLabels)
    check(
      optionAssets.get(label).length > 0,
      "Workspace option absent from verified client assets",
    );
  const runtimeBytes = NodeFS.readFileSync(layout.runtimePath);
  const runtime = json(runtimeBytes.toString());
  check(
    Number.isSafeInteger(runtime.pid) &&
      runtime.pid > 0 &&
      runtime.host === layout.host &&
      runtime.port === layout.port,
    "Runtime identity invalid",
  );
  const live = command("/bin/launchctl", [
    "print",
    `${layout.serviceDomain}/${layout.serviceLabel}`,
  ]);
  check(
    new RegExp(`^\\s*pid = ${runtime.pid}\\s*$`, "m").test(live),
    "Runtime PID differs from owned service",
  );
  const running = command("/bin/ps", ["-p", String(runtime.pid), "-o", "command="]);
  check(
    running.includes(current.node) &&
      running.includes(NodePath.join(current.release, "bin.mjs")) &&
      running.includes(own),
    "Live process differs from installed release",
  );
  same(
    command("/usr/sbin/lsof", ["-nP", "-t", `-iTCP:${layout.port}`, "-sTCP:LISTEN"])
      .trim()
      .split(/\s+/),
    [String(runtime.pid)],
    "Primary listener ownership mismatch",
  );
  return {
    current,
    manifestPath,
    runtimePath: layout.runtimePath,
    installationHash: hash(bytes),
    manifestHash: hash(manifestBytes),
    runtimeHash: hash(runtimeBytes),
    filesVerified: manifest.files.length,
    optionAssets: Object.fromEntries(optionAssets),
    pid: runtime.pid,
  };
}

// RpcAuthorization.ts maps server.getSettings to AuthOrchestrationReadScope.
// Keep this helper single-purpose: it cannot issue any mutation RPC.
async function readSettings(context) {
  const response = await context.request.post(origin + "/api/auth/websocket-ticket", {
    headers: { Origin: origin },
    timeout: 12000,
  });
  check(response.status() === 200, "Read-only ticket failed");
  const { ticket } = await response.json();
  check(typeof ticket === "string" && ticket.length > 0, "Read-only ticket missing");
  const url = new URL("/ws", origin);
  url.protocol = "ws:";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return await new Promise((done, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(new Error(error));
      else done(value);
    };
    const timer = setTimeout(() => finish("Read-only settings RPC timed out"), 12000);
    ws.addEventListener("open", () => {
      try {
        ws.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "server.getSettings",
            payload: {},
            headers: [],
          }),
        );
      } catch {
        finish("Read-only settings send failed");
      }
    });
    ws.addEventListener("error", () => finish("Read-only settings transport failed"));
    ws.addEventListener("close", () => {
      if (!settled) finish("Read-only settings transport closed");
    });
    ws.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        finish("Read-only settings response invalid");
        return;
      }
      for (const item of Array.isArray(data) ? data : [data]) {
        if (item._tag !== "Exit" || String(item.requestId) !== "1") continue;
        if (item.exit?._tag === "Success") finish(null, item.exit.value);
        else finish("Read-only settings RPC rejected");
      }
    });
  });
}

async function dismissPermissionNotice(page) {
  // The read-only pairing intentionally leaves settings controls inert. Dismiss
  // only the product's explanatory toast through its ordinary local UI action.
  const notice = page.getByText(
    "This connection still uses the old permissions, so some actions may no longer be available. Pair again using a new link with the permissions you need.",
    { exact: true },
  );
  if (!(await notice.isVisible())) return;
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await notice.waitFor({ state: "hidden" });
}

async function main() {
  check(process.version === "v22.20.0", "Node 22.20.0 required");
  process.env.PWDEBUG = "0";
  process.env.PLAYWRIGHT_HTML_OPEN = "never";
  const expected = parseOptions(process.argv.slice(2));
  layout = installedLayout(expected, NodeOS.homedir(), process.getuid());
  ({ home, own, origin, installationPath, settingsPath } = layout);
  const directory = NodePath.resolve(expected["--report-dir"]);
  check(
    !NodeFS.existsSync(directory) &&
      !directory.startsWith(own + NodePath.sep) &&
      !directory.startsWith(layout.releasesRoot + NodePath.sep),
    "Use a fresh evidence directory outside installed state",
  );
  for (
    let parent = NodePath.dirname(directory);
    parent !== NodePath.dirname(parent);
    parent = NodePath.dirname(parent)
  ) {
    check(
      !NodeFS.existsSync(parent) || !NodeFS.lstatSync(parent).isSymbolicLink(),
      "Evidence path has a symlink ancestor",
    );
  }
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receipt = {
    schemaVersion: 1,
    result: "incomplete",
    startedAt: new Date().toISOString(),
    host: layout.identity,
    origin,
    artifactSha256: expected["--artifact-sha"],
    sourceCommit: expected["--source-commit"],
    headless: true,
    scope,
    settingsWrites: 0,
    projectOrThreadMutations: 0,
    worktreeRemovals: 0,
    nativeTurns: 0,
    serviceMutations: 0,
    checks: [],
    screenshots: [],
    proofBoundary:
      "Installed artifact-bound delivery and read-only rendering. Inert options are not opened or selected; verify.mjs separately proves selection and persistence in an isolated writable server.",
    cleanup: { attempted: false, verified: false },
  };
  const label = "installed workspace settings read-only " + NodeCrypto.randomUUID();
  const recovery = {
    schemaVersion: 1,
    state: "not-required",
    host: layout.identity,
    stateHome: own,
    ownershipLabel: label,
    scope,
    ownedGrantIds: [],
    ownedSessionIds: [],
    pairingTtlSeconds: 300,
    browserSessionTtl: "server default; not bounded by pairing TTL",
    guidance:
      "If cleanup is required, use the installed auth CLI to list pairing and session metadata. Match only this exact ownershipLabel (session client.label), then revoke only the matching nonpreexisting IDs. Never revoke a list difference or unrelated session.",
  };
  receipt.cleanup.recoveryFile = "recovery.json";
  receipt.cleanup.ownershipLabel = label;
  const save = () => {
    savePrivateJson(NodePath.join(directory, "recovery.json"), recovery);
    savePrivateJson(NodePath.join(directory, "receipt.json"), receipt);
  };
  let installed,
    pairingBefore,
    sessionsBefore,
    settingsBefore,
    settingsAfter,
    settingsBytesBefore,
    browser,
    currentContext;
  let grantId,
    aborted = false,
    timer,
    failed = false;
  const ownedGrants = new Set();
  const ownedSessions = new Set();
  const rememberGrant = (id) => {
    ownedGrants.add(id);
    recovery.ownedGrantIds = [...ownedGrants];
    save();
  };
  const rememberSession = (id) => {
    ownedSessions.add(id);
    recovery.ownedSessionIds = [...ownedSessions];
    save();
  };
  const abort = () => {
    aborted = true;
    void browser?.close().catch(() => {});
  };
  const assertRuntimeUnchanged = () => {
    check(
      hash(NodeFS.readFileSync(installationPath)) === installed.installationHash &&
        hash(NodeFS.readFileSync(installed.manifestPath)) === installed.manifestHash &&
        hash(NodeFS.readFileSync(installed.runtimePath)) === installed.runtimeHash,
      "Installed runtime changed during verification",
    );
  };
  const ensureContinuity = () => {
    check(!aborted, "Verification interrupted or deadline reached");
    assertRuntimeUnchanged();
  };
  const cli = (args, timeout) =>
    command(
      installed.current.node,
      [NodePath.join(installed.current.release, "bin.mjs"), "auth", ...args, "--base-dir", own],
      timeout,
    );
  const pairings = (timeout) =>
    sortedMetadata(json(cli(["pairing", "list", "--json"], timeout)), "id");
  const sessions = (timeout) =>
    sortedMetadata(json(cli(["session", "list", "--json"], timeout)), "sessionId");
  const ownedSession = (row) =>
    row.client?.label === label &&
    row.method === "browser-session-cookie" &&
    row.subject === "one-time-token" &&
    !sessionsBefore.some((before) => before.sessionId === row.sessionId);
  try {
    receipt.phase = "installed-provenance";
    save();
    installed = provenance(expected);
    receipt.provenance = {
      pid: installed.pid,
      release: installed.current.release,
      filesVerified: installed.filesVerified,
      installationSha256: installed.installationHash,
      manifestSha256: installed.manifestHash,
      optionAssets: installed.optionAssets,
    };
    pairingBefore = pairings();
    sessionsBefore = sessions();
    settingsBytesBefore = NodeFS.readFileSync(settingsPath);
    check(
      !pairingBefore.some((row) => row.label === label) &&
        !sessionsBefore.some((row) => row.client?.label === label),
      "Owned label collision",
    );
    recovery.preexistingLabelAbsent = true;
    const { chromium } = NodeModule.createRequire(import.meta.url)(
      NodeFS.realpathSync(expected["--playwright"]),
    );
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    timer = setTimeout(abort, 150000);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.STUDIO_TEST_CHROMIUM
        ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
        : {}),
    });
    currentContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "dark",
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    currentContext.setDefaultTimeout(12000);
    currentContext.setDefaultNavigationTimeout(15000);
    ensureContinuity();
    receipt.phase = "owned-read-only-pairing";
    recovery.state = "cleanup-required";
    recovery.authMutationStartedAt = new Date().toISOString();
    recovery.cli = {
      node: installed.current.node,
      entrypoint: NodePath.join(installed.current.release, "bin.mjs"),
      baseDir: own,
    };
    // Persist before calling create: even a killed/failed CLI can commit a grant.
    save();
    const grant = json(
      cli([
        "pairing",
        "create",
        "--ttl",
        "5m",
        "--label",
        label,
        "--base-url",
        origin,
        "--scope",
        scope[0],
        "--json",
      ]),
    );
    check(
      typeof grant.id === "string" && grant.id.length > 0 && grant.label === label,
      "Owned grant metadata mismatch",
    );
    check(!pairingBefore.some((row) => row.id === grant.id), "Grant identity is preexisting");
    grantId = grant.id;
    rememberGrant(grantId);
    same(grant.scopes, scope, "Owned grant must be read-only");
    check(
      Number.isFinite(Date.parse(grant.expiresAt)) &&
        Date.parse(grant.expiresAt) > Date.now() &&
        Date.parse(grant.expiresAt) <= Date.now() + 305000,
      "Owned pairing TTL exceeds five minutes",
    );
    const pairUrl = new URL(grant.pairUrl);
    check(
      pairUrl.origin === origin &&
        pairUrl.pathname === "/pair" &&
        !pairUrl.search &&
        pairUrl.hash.startsWith("#token="),
      "Pairing URL is outside primary origin",
    );
    const page = await currentContext.newPage();
    await page.goto(grant.pairUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => location.pathname !== "/pair" && location.hash === "", null, {
      timeout: 15000,
    });
    grant.credential = "";
    grant.pairUrl = "";
    check(
      (await currentContext.cookies(origin)).some(
        (cookie) => cookie.name === installed.current.cookieName,
      ),
      "Owned browser cookie missing",
    );
    const owned = sessions().filter(ownedSession);
    for (const session of owned) rememberSession(session.sessionId);
    check(owned.length === 1, "Expected exactly one label-bound owned browser session");
    same(owned[0].scopes, scope, "Owned browser session must be read-only");
    settingsBefore = await readSettings(currentContext);
    check(
      [null, "local", "worktree"].includes(settingsBefore.defaultThreadEnvMode) &&
        typeof settingsBefore.defaultAutoPull === "boolean",
      "Workspace settings shape invalid",
    );
    const state = await currentContext.storageState(); // In memory only; never persist credentials.
    await currentContext.close();
    currentContext = undefined;
    receipt.phase = "read-only-settings-rendering";
    save();
    for (const [width, theme] of [
      [1440, "dark"],
      [390, "light"],
    ]) {
      ensureContinuity();
      currentContext = await browser.newContext({
        viewport: { width, height: 1000 },
        colorScheme: theme,
        reducedMotion: "reduce",
        serviceWorkers: "block",
        storageState: state,
      });
      currentContext.setDefaultTimeout(12000);
      currentContext.setDefaultNavigationTimeout(15000);
      // Only this disposable browser's onboarding/theme preferences change.
      await currentContext.addInitScript(
        ({ theme }) => {
          localStorage.setItem(
            "studio:client-settings:v1",
            JSON.stringify({ onboardingCompletedAt: "2026-10-09T00:00:00.000Z" }),
          );
          localStorage.setItem("studio:theme", theme);
          localStorage.setItem("studio:theme-follow-system", "true");
        },
        { theme },
      );
      const view = await currentContext.newPage();
      let pageErrorCount = 0;
      view.on("pageerror", () => {
        pageErrorCount++;
      }); // Messages can contain private state.
      await view.goto(origin + "/settings/general#new-threads", { waitUntil: "domcontentloaded" });
      await view.waitForFunction(
        (dark) => document.documentElement.classList.contains("dark") === dark,
        theme === "dark",
      );
      const selector = view.locator('[aria-label="Default workspace"]');
      await selector.waitFor({ state: "visible" });
      const expectedLabel =
        settingsBefore.defaultThreadEnvMode === "local"
          ? workspaceLabels[1]
          : settingsBefore.defaultThreadEnvMode === "worktree"
            ? workspaceLabels[2]
            : workspaceLabels[0];
      await view.waitForFunction(
        (text) =>
          document.querySelector('[aria-label="Default workspace"]')?.textContent?.trim() === text,
        expectedLabel,
      );
      check(
        await selector.evaluate((element) => element.closest("[inert]") !== null),
        "Read-only workspace control must remain inert",
      );
      const workspaceRow = view.locator('[data-slot="settings-row"]').filter({ has: selector });
      check((await workspaceRow.count()) === 1, "Workspace row is ambiguous");
      check(
        await workspaceRow.evaluate((row) => row.scrollWidth <= row.clientWidth + 1),
        "Workspace row overflows",
      );
      const workspaceImage = `workspace-${width}-${theme}.png`;
      await dismissPermissionNotice(view);
      await workspaceRow.screenshot({
        path: NodePath.join(directory, workspaceImage),
        animations: "disabled",
      });
      receipt.screenshots.push(workspaceImage);
      await view.goto(origin + "/settings/source-control#automatic-pull", {
        waitUntil: "domcontentloaded",
      });
      const refresh = view.locator('[aria-label="Refresh upstreams at startup"]');
      await refresh.waitFor({ state: "visible" });
      await view.waitForFunction(
        (value) =>
          document
            .querySelector('[aria-label="Refresh upstreams at startup"]')
            ?.getAttribute("aria-checked") === String(value),
        settingsBefore.defaultAutoPull,
      );
      check(
        await refresh.evaluate((element) => element.closest("[inert]") !== null),
        "Read-only refresh control must remain inert",
      );
      const refreshRow = view.locator('[data-slot="settings-row"]').filter({ has: refresh });
      check(
        (await refreshRow.count()) === 1 && (await refreshRow.innerText()).includes(startupCopy),
        "Startup refresh copy mismatch",
      );
      check(
        await refreshRow.evaluate((row) => row.scrollWidth <= row.clientWidth + 1),
        "Startup refresh row overflows",
      );
      const refreshImage = `startup-refresh-${width}-${theme}.png`;
      await dismissPermissionNotice(view);
      await refreshRow.screenshot({
        path: NodePath.join(directory, refreshImage),
        animations: "disabled",
      });
      receipt.screenshots.push(refreshImage);
      check(
        await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        "Settings viewport overflows",
      );
      check(pageErrorCount === 0, "Settings page had runtime errors; details withheld");
      settingsAfter = await readSettings(currentContext);
      same(settingsAfter, settingsBefore, "Exact settings snapshot changed");
      receipt.checks.push({
        width,
        theme,
        themeVerified: true,
        workspaceLabel: expectedLabel,
        workspaceInert: true,
        startupRefresh: settingsBefore.defaultAutoPull,
        startupCopyVerified: true,
        refreshInert: true,
        optionLabelsVerifiedInInstalledAssets: true,
        optionMenuOpened: false,
        settingsUnchanged: true,
        pageErrorCount,
      });
      save();
      await currentContext.close();
      currentContext = undefined;
    }
    receipt.settings = {
      beforeSha256: metadataHash(settingsBefore),
      afterSha256: metadataHash(settingsAfter),
      defaultThreadEnvMode: settingsBefore.defaultThreadEnvMode,
      defaultAutoPull: settingsBefore.defaultAutoPull,
      exactRpcSnapshotPreserved: true,
    };
    ensureContinuity();
  } catch {
    failed = true;
    receipt.failedStage = receipt.phase;
    // Do not serialize caught errors, page content, auth URLs, CLI output or config.
  } finally {
    clearTimeout(timer);
    receipt.cleanup.attempted = Boolean(recovery.authMutationStartedAt);
    try {
      await currentContext?.close();
    } catch {
      failed = true;
    }
    try {
      await browser?.close();
    } catch {
      failed = true;
    }
    if (receipt.cleanup.attempted) {
      const cleanupDeadline = Date.now() + 60000;
      let afterPairings,
        afterSessions,
        stableAbsenceReadbacks = 0;
      receipt.cleanup.attempts = [];
      receipt.cleanup.ownedAbsenceVerified = false;
      const remainingTimeout = () => {
        const remaining = cleanupDeadline - Date.now();
        check(remaining > 0, "Credential cleanup deadline reached");
        return Math.min(4000, remaining);
      };
      // Three rounds within one minute, with two separate absence readbacks.
      // Closing our browser first prevents further intentional exchanges. A
      // partial/in-flight exchange is found by the exact persisted label.
      for (let attempt = 1; attempt <= 3 && Date.now() < cleanupDeadline; attempt++) {
        const observation = { attempt, discoveryFailed: false, revokeFailures: 0, absent: false };
        const knownCount = ownedGrants.size + ownedSessions.size;
        try {
          for (const row of pairings(remainingTimeout()))
            if (row.label === label) {
              check(!pairingBefore.some((before) => before.id === row.id), "Unproven owned grant");
              rememberGrant(row.id);
            }
          for (const row of sessions(remainingTimeout()))
            if (ownedSession(row)) rememberSession(row.sessionId);
        } catch {
          observation.discoveryFailed = true;
        }
        if (knownCount !== ownedGrants.size + ownedSessions.size) stableAbsenceReadbacks = 0;
        // Known IDs remain revocable even if metadata discovery is temporarily
        // unavailable. Each ID was proven from this invocation's label earlier.
        for (const id of ownedGrants) {
          try {
            cli(["pairing", "revoke", id], remainingTimeout());
          } catch {
            observation.revokeFailures++;
          }
        }
        for (const id of ownedSessions) {
          try {
            cli(["session", "revoke", id], remainingTimeout());
          } catch {
            observation.revokeFailures++;
          }
        }
        try {
          afterPairings = pairings(remainingTimeout());
          afterSessions = sessions(remainingTimeout());
          check(
            !afterPairings.some((row) => ownedGrants.has(row.id) || row.label === label),
            "Owned grant still present",
          );
          check(
            !afterSessions.some(
              (row) => ownedSessions.has(row.sessionId) || row.client?.label === label,
            ),
            "Owned session still present",
          );
          observation.absent = true;
          stableAbsenceReadbacks++;
        } catch {
          stableAbsenceReadbacks = 0;
        }
        receipt.cleanup.attempts.push(observation);
        receipt.cleanup.stableAbsenceReadbacks = stableAbsenceReadbacks;
        save();
        if (stableAbsenceReadbacks >= 2) {
          receipt.cleanup.ownedAbsenceVerified = true;
          break;
        }
        if (attempt < 3 && Date.now() + 250 < cleanupDeadline)
          await new Promise((done) => setTimeout(done, 250));
      }
      recovery.state = receipt.cleanup.ownedAbsenceVerified ? "complete" : "cleanup-required";
      recovery.lastCleanupAttemptAt = new Date().toISOString();
      receipt.cleanup.verified = receipt.cleanup.ownedAbsenceVerified;
      receipt.cleanup.recoveryFile = "recovery.json";
      receipt.cleanup.ownedGrantIds = [...ownedGrants];
      receipt.cleanup.ownedSessionIds = [...ownedSessions];
      receipt.cleanup.ownedSessionsRevoked = receipt.cleanup.ownedAbsenceVerified
        ? ownedSessions.size
        : 0;
      save();
      try {
        check(
          receipt.cleanup.ownedAbsenceVerified,
          "Owned credential absence unverified; recovery required",
        );
        same(afterPairings, pairingBefore, "Preexisting pairing metadata changed");
        check(afterSessions.length === sessionsBefore.length, "Session inventory changed");
        let heartbeatChanges = 0;
        const normalizedBefore = [],
          normalizedAfter = [];
        for (const before of sessionsBefore) {
          const after = afterSessions.find((row) => row.sessionId === before.sessionId);
          check(after, "Preexisting session missing");
          const { lastConnectedAt: oldTime, ...oldMetadata } = before;
          const { lastConnectedAt: newTime, ...newMetadata } = after;
          same(newMetadata, oldMetadata, "Preexisting session metadata changed");
          if (oldTime !== newTime) {
            check(
              typeof newTime === "string" &&
                Number.isFinite(Date.parse(newTime)) &&
                Date.parse(newTime) <= Date.now() + 5000 &&
                (oldTime === null || Date.parse(newTime) >= Date.parse(oldTime)),
              "Invalid heartbeat timestamp change",
            );
            heartbeatChanges++;
          }
          normalizedBefore.push(oldMetadata);
          normalizedAfter.push(newMetadata);
        }
        check(
          hash(NodeFS.readFileSync(settingsPath)) === hash(settingsBytesBefore),
          "Settings file bytes changed",
        );
        assertRuntimeUnchanged();
        receipt.preservation = {
          existingPairings: pairingBefore.length,
          existingSessions: sessionsBefore.length,
          pairingBeforeSha256: metadataHash(pairingBefore),
          pairingAfterSha256: metadataHash(afterPairings),
          sessionMetadataBeforeSha256: metadataHash(normalizedBefore),
          sessionMetadataAfterSha256: metadataHash(normalizedAfter),
          allowedHeartbeatField: "lastConnectedAt",
          heartbeatChanges,
          settingsFileSha256: hash(settingsBytesBefore),
          settingsFileBytesPreserved: true,
          preexistingMetadataPreserved: true,
          installedRuntimePreserved: true,
        };
        receipt.cleanup.preexistingMetadataPreserved = true;
      } catch {
        failed = true;
        receipt.cleanup.preexistingMetadataPreserved = false;
      }
      if (!receipt.cleanup.ownedAbsenceVerified) failed = true;
    }
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    receipt.result = failed ? "failed" : "passed";
    receipt.completedAt = new Date().toISOString();
    save();
  }
  console.log(
    JSON.stringify({
      result: receipt.result,
      report: NodePath.join(directory, "receipt.json"),
      headless: true,
      cleanupVerified: receipt.cleanup.verified,
    }),
  );
  if (failed) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);
if (invokedDirectly)
  await main().catch(() => {
    console.error("Installed read-only verification could not start; private details withheld.");
    process.exitCode = 1;
  });
