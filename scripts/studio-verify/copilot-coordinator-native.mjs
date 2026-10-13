import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

// Only an explicitly coordinated native window permits execute(). Importing this
// module performs no reads, mutations, subprocess calls, or provider inference.
// GitHub documents COPILOT_HOME and macOS Keychain separately:
// https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
// https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
export const MODEL = "claude-opus-5.5";
export const PROMPT =
  "What color is the central square in this image? Reply with exactly one lowercase color word. Do not use any tools, shell commands, files, browser, network, delegation, or skills.";
export const COPILOT_ARGS = Object.freeze([
  "--acp",
  "--no-auto-update",
  "--disable-builtin-mcps",
  "--no-custom-instructions",
  "--deny-tool",
  "shell,write,read,url,memory",
  "--disable-mcp-server",
  "studio-code",
]);
const INSTANCE_ID = "copilot-coordinator-proof";
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PENDING_IMAGE = new RegExp(`^pending-${UUID_PATTERN}$`, "i");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export function snapshot(path) {
  if (!existsSync(path)) return { exists: false };
  const link = lstatSync(path, { bigint: true });
  const file = statSync(path, { bigint: true });
  assert(file.isFile(), "Protected path is not a file");
  return {
    exists: true,
    sha256: sha(readFileSync(path)),
    size: String(file.size),
    mtimeNs: String(file.mtimeNs),
    ctimeNs: String(file.ctimeNs),
    birthtimeNs: String(file.birthtimeNs),
    dev: String(file.dev),
    ino: String(file.ino),
    mode: String(file.mode),
    uid: String(file.uid),
    gid: String(file.gid),
    linkMtimeNs: String(link.mtimeNs),
    linkDev: String(link.dev),
    linkIno: String(link.ino),
    linkCtimeNs: String(link.ctimeNs),
    linkBirthtimeNs: String(link.birthtimeNs),
    linkMode: String(link.mode),
    linkUid: String(link.uid),
    linkGid: String(link.gid),
    realpathSha256: sha(realpathSync(path)),
  };
}

export function assertSame(before, after) {
  assert.equal(JSON.stringify(after), JSON.stringify(before), "Protected state changed");
}

export function protectedPaths(home, liveBase) {
  return [
    ...["config.json", "settings.json", "mcp-config.json"].map((name) =>
      join(home, ".copilot", name),
    ),
    join(liveBase, "userdata/settings.json"),
    join(liveBase, "installation.json"),
    join(liveBase, "userdata/secrets/google-refresh-token.bin"),
    join(liveBase, "userdata/secrets/google-account-state.bin"),
  ];
}

export function parseNativeConfig(text) {
  // The installed CLI generates full-line JSONC comments. Other syntax fails closed.
  try {
    return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  } catch {
    throw new Error("Native selector metadata could not be parsed");
  }
}

export function accountSelectors(config) {
  assert(
    config && typeof config === "object" && !Array.isArray(config),
    "Invalid selector metadata",
  );
  const secretShape = /(?:gh[pousr]_|github_pat_|sk-|eyJ)[A-Za-z0-9_-]{8,}/;
  const account = (value) => {
    assert(value && typeof value === "object" && !Array.isArray(value), "Invalid account selector");
    assert(
      typeof value.host === "string" && value.host.length <= 256 && !secretShape.test(value.host),
    );
    const url = new URL(value.host);
    assert(
      url.protocol === "https:" &&
        url.hostname &&
        url.pathname === "/" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "Invalid account host",
    );
    assert(
      typeof value.login === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value.login) &&
        !secretShape.test(value.login),
      "Invalid account login",
    );
    return { host: value.host, login: value.login };
  };
  assert(
    Array.isArray(config.loggedInUsers) &&
      config.loggedInUsers.length > 0 &&
      config.loggedInUsers.length <= 16,
    "Remembered native identity required",
  );
  const users = config.loggedInUsers.map((user) => {
    assert(user && typeof user === "object" && !Array.isArray(user));
    assert(
      Object.keys(user).every((key) => ["host", "login", "kind"].includes(key)),
      "Unexpected account field; never copy tokens",
    );
    const selected = account(user);
    assert(
      typeof user.kind === "string" &&
        /^[A-Za-z][A-Za-z0-9_.:-]{0,31}$/.test(user.kind) &&
        !secretShape.test(user.kind),
      "Invalid account kind",
    );
    return { ...selected, kind: user.kind };
  });
  assert.equal(
    new Set(users.map(({ host, login }) => JSON.stringify([host, login]))).size,
    users.length,
    "Ambiguous remembered identity",
  );
  assert(
    config.lastLoggedInUser &&
      Object.keys(config.lastLoggedInUser).every((key) => ["host", "login"].includes(key)),
    "Unexpected last-account field",
  );
  const last = account(config.lastLoggedInUser);
  assert(
    users.some((user) => user.host === last.host && user.login === last.login),
    "Selected account is not remembered",
  );
  // Intentionally omit every other native config field, including credentials,
  // plugins, remembered permissions, custom instructions, hooks, and timestamps.
  return { loggedInUsers: users, lastLoggedInUser: last };
}

export function selectedIdentityHash(config) {
  const safe = accountSelectors(config),
    last = safe.lastLoggedInUser;
  const selected = safe.loggedInUsers.find(
    (user) => user.host === last.host && user.login === last.login,
  );
  return sha(JSON.stringify(selected));
}

export function isolatedEnvironment(env, home, copilotHome, node) {
  assert.equal(env.HOME, home, "HOME must remain unchanged");
  // Environment tokens/BYOK would outrank the selected existing Keychain identity.
  // Drop every incoming COPILOT_* override, including future provider/API variants,
  // rather than listing token values or inheriting an accidental BYOK route.
  const clean = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !["COPILOT_", "STUDIO_", "OTEL_", "GIT_", "GITHUB_COPILOT_", "VITE_"].some((prefix) =>
          key.startsWith(prefix),
        ) && !["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GITHUB_HOST", "NODE_OPTIONS"].includes(key),
    ),
  );
  return {
    ...clean,
    HOME: home,
    COPILOT_HOME: copilotHome,
    COPILOT_CACHE_HOME: join(dirname(copilotHome), "copilot-cache"),
    PATH: `${dirname(node)}:${env.PATH ?? ""}`,
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
    COPILOT_AUTO_UPDATE: "false",
    COPILOT_ALLOW_ALL: "false",
    STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    STUDIO_NO_BROWSER: "true",
    STUDIO_DISABLE_AUTO_UPDATE: "true",
    STUDIO_TELEMETRY_ENABLED: "false",
    STUDIO_ENABLE_HOSTED_SERVICES: "false",
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createImageFixture() {
  const chunk = (type, data) => {
    const name = Buffer.from(type),
      result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    name.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(128);
  header.writeUInt32BE(128, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(128 * 513);
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++) {
      const color =
        x >= 24 && x < 104 && y >= 24 && y < 104 ? [255, 0, 0, 255] : [255, 255, 255, 255];
      Buffer.from(color).copy(pixels, y * 513 + 1 + x * 4);
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function verifyImage(bytes) {
  assert(
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "Invalid PNG",
  );
  let pos = 8,
    header = null,
    ended = false;
  const packed = [];
  while (pos < bytes.length) {
    assert(pos + 12 <= bytes.length, "Truncated PNG");
    const len = bytes.readUInt32BE(pos),
      type = bytes.toString("ascii", pos + 4, pos + 8);
    assert(pos + 12 + len <= bytes.length, "Invalid PNG chunk size");
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    assert.equal(crc32(bytes.subarray(pos + 4, pos + 8 + len)), bytes.readUInt32BE(pos + 8 + len));
    if (type === "IHDR") {
      assert.equal(header, null);
      assert.equal(len, 13);
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4) };
      assert.equal(header.width, 128);
      assert.equal(header.height, 128);
      assert(data.subarray(8).equals(Buffer.from([8, 6, 0, 0, 0])), "Unexpected PNG encoding");
    }
    if (type === "IDAT") packed.push(data);
    if (type === "IEND") {
      assert.equal(len, 0);
      ended = true;
      assert.equal(pos + 12, bytes.length);
    }
    pos += len + 12;
  }
  assert(header && ended && packed.length > 0, "Incomplete PNG");
  const raw = inflateSync(Buffer.concat(packed), { maxOutputLength: 128 * 513 });
  assert.equal(raw.length, 128 * 513);
  for (let y = 0; y < 128; y++) {
    assert.equal(raw[y * 513], 0);
    for (let x = 0; x < 128; x++) {
      const expected =
        x >= 24 && x < 104 && y >= 24 && y < 104 ? [255, 0, 0, 255] : [255, 255, 255, 255];
      assert(
        raw.subarray(y * 513 + 1 + x * 4, y * 513 + 5 + x * 4).equals(Buffer.from(expected)),
        "Unexpected PNG pixel",
      );
    }
  }
  return {
    signature: "PNG",
    width: 128,
    height: 128,
    expectedAnswer: "red",
    rgbaVerified: true,
    sha256: sha(bytes),
    bytes: bytes.length,
  };
}

export function imageFallbackObserved(text) {
  return /image (?:input|attachment).{0,100}(?:reject|drop|unsupported)|retry(?:ing)?.{0,100}without images|invalid (?:input )?image|unsupported (?:input )?image|invalid base64|image.{0,80}decod.{0,40}(?:fail|error)/iu.test(
    text,
  );
}

export function nativeColorBinding(events, answer, expectedColor, expectedModel = MODEL) {
  const replies = events.filter((event) => event.type === "assistant.message"),
    final = replies.at(-1);
  const text = typeof final?.data?.content === "string" ? final.data.content : null;
  return {
    assistantMessageCount: replies.length,
    finalColorAndModelBound:
      text !== null && text.trim() === expectedColor && final.data.model === expectedModel,
    expectedModel,
    expectedColor,
    finalReplySha256: text === null ? null : sha(text),
    imageFallbackObserved:
      imageFallbackObserved(answer) ||
      events.some((event) => imageFallbackObserved(JSON.stringify(event))),
    nativeToolRequestsObserved: events.some(
      (event) =>
        /^tool\.(?:execution|request)/.test(event.type ?? "") ||
        (Array.isArray(event.data?.toolRequests) && event.data.toolRequests.length > 0),
    ),
  };
}

export function artifactIdentity(release, source) {
  assert(/^[a-f0-9]{40}$/.test(source ?? ""), "Full source SHA required");
  assert(
    isAbsolute(release ?? "") && existsSync(join(release, "bin.mjs")),
    "Absolute built candidate required",
  );
  const runtimeFiles = Object.fromEntries(
    readdirSync(release)
      .filter((name) => name.endsWith(".mjs"))
      .sort()
      .map((name) => [name, sha(readFileSync(join(release, name)))]),
  );
  const result = {
    entrypointSha256: runtimeFiles["bin.mjs"],
    runtimeFiles,
    sourceBinding: "served-server-identity-required",
  };
  const manifestPath = join(release, "studio-manifest.json");
  assert(existsSync(manifestPath), "Canonical built-artifact manifest required");
  {
    const bytes = readFileSync(manifestPath),
      manifest = JSON.parse(bytes);
    assert.equal(manifest.sourceCommit, source, "Candidate manifest source mismatch");
    for (const file of manifest.files ?? [])
      if (file.type === "file") {
        assert(
          typeof file.path === "string" &&
            !isAbsolute(file.path) &&
            !relative(release, resolve(release, file.path)).split(sep).includes(".."),
          "Manifest path escapes candidate",
        );
        assert.equal(
          sha(readFileSync(join(release, file.path))),
          file.sha256,
          "Candidate manifest hash mismatch",
        );
      }
    result.manifest = {
      sha256: sha(bytes),
      sourceCommit: manifest.sourceCommit,
      version: manifest.version,
    };
  }
  return result;
}

export function parseArgs(args) {
  const allowed = new Set(["--release", "--source", "--binary", "--out", "--live-base-dir"]),
    result = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--execute-authorized") {
      assert(!result.authorized);
      result.authorized = true;
      continue;
    }
    assert(
      allowed.has(flag) && typeof args[i + 1] === "string" && !args[i + 1].startsWith("--"),
      "Invalid argument",
    );
    const key = flag.slice(2);
    assert(!Object.hasOwn(result, key), "Duplicate argument");
    result[key] = args[++i];
  }
  assert(result.authorized, "Explicit publisher window required");
  for (const key of ["release", "binary", "out"])
    assert(isAbsolute(result[key] ?? ""), "Absolute paths required");
  assert(/^[a-f0-9]{40}$/.test(result.source ?? ""), "Full source SHA required");
  if (result["live-base-dir"] !== undefined) assert(isAbsolute(result["live-base-dir"]));
  return result;
}

export function deadlineBudget(started, now, cleaning = false) {
  const remaining = started + (cleaning ? 118_000 : 105_000) - now;
  assert(remaining > 0, "Owned execution deadline exceeded");
  return Math.min(cleaning ? 3000 : 10_000, remaining);
}

export function parseProcessIdentity(text) {
  const match = text.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match) return null;
  const pid = Number(match[1]),
    started = match[2].replace(/\s+/g, " ");
  return { pid, birthIdentity: `${pid} ${started}`, identity: text.trim() };
}

export function ownedIdentityMatches(expected, actual) {
  // An exec changes comm but preserves the recorded PID and process birth.
  return Boolean(
    expected &&
    actual &&
    Number.isSafeInteger(expected.pid) &&
    expected.pid > 0 &&
    expected.birthIdentity &&
    actual.pid === expected.pid &&
    actual.birthIdentity === expected.birthIdentity,
  );
}

function processProbe(pid) {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid=,lstart=,comm="], {
    encoding: "utf8",
    timeout: 1000,
  });
  const record = result.status === 0 ? parseProcessIdentity(result.stdout) : null;
  if (record) return { state: "present", record };
  if (result.status === 1 && !result.error && !result.stdout?.trim()) return { state: "absent" };
  return { state: "unknown" };
}

function processIdentity(pid) {
  return processProbe(pid).record ?? null;
}
function canSignal(identity) {
  return Boolean(
    identity &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    ownedIdentityMatches(identity, processIdentity(identity.pid)),
  );
}
function signalOwned(identity, signal) {
  if (!canSignal(identity)) return false;
  try {
    process.kill(identity.pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function ownedQuiescence(records, probe) {
  const remainingPids = [],
    unresolvedPids = [];
  for (const record of records) {
    const result = probe(record.pid);
    if (result.state === "absent") continue;
    if (result.state === "present" && record.birthIdentity && result.record?.birthIdentity) {
      if (ownedIdentityMatches(record, result.record)) remainingPids.push(record.pid);
      // A different birth on the same PID proves the recorded process is gone;
      // the new process is unrelated and must never be signaled.
    } else unresolvedPids.push(record.pid);
  }
  return {
    remainingPids,
    unresolvedPids,
    complete: remainingPids.length === 0 && unresolvedPids.length === 0,
  };
}

export async function stageImage({ rpc, post, bytes, origin }) {
  const meta = {
    type: "image",
    name: "fixture.png",
    mimeType: "image/png",
    sizeBytes: bytes.length,
  };
  const grant = await rpc("attachments.createUploadUrl", meta);
  assert(PENDING_IMAGE.test(grant.attachmentId ?? ""), "Server must issue a pending image ID");
  assert(
    typeof grant.relativeUrl === "string" &&
      /^\/api\/attachments\/upload\/[^/?#]+$/.test(grant.relativeUrl),
    "Only the server-issued relative upload route is allowed",
  );
  const url = new URL(grant.relativeUrl, origin);
  assert.equal(url.origin, origin);
  const response = await post(grant.relativeUrl, bytes, meta.mimeType);
  assert.equal(response.status, 204, "Native staging failed");
  return { ...meta, id: grant.attachmentId };
}

function threadSegment(threadId) {
  return threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80)
    .replace(/[-_]+$/g, "");
}

export function assertCoordinatorProjection(projection, projectId, threadId) {
  assert.equal(threadId, `project-coordinator:${projectId}`, "Unexpected coordinator binding");
  assert.equal(projection.thread.id, threadId);
  assert.equal(projection.thread.projectId, projectId);
  assert.equal(projection.thread.runtimeMode, "full-access");
  assert.equal(projection.thread.modelSelection.instanceId, INSTANCE_ID);
  assert.equal(projection.thread.modelSelection.model, MODEL);
}

export function assertPrivateObservability(config) {
  const observation = config.observability;
  assert(observation, "Served privacy configuration required");
  for (const flag of [
    "productUsageEnabled",
    "productUsageDestinationConfigured",
    "otlpTracesEnabled",
    "otlpMetricsEnabled",
    "otlpLogsEnabled",
  ])
    assert.equal(observation[flag], false, "Outbound observability must be explicitly disabled");
  for (const field of ["otlpTracesUrl", "otlpMetricsUrl", "otlpLogsUrl"])
    assert(!observation[field], "Outbound collector destination must be absent");
  return {
    productUsageEnabled: false,
    productUsageDestinationConfigured: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  };
}

export function deliveredImage(projection, threadId, pending, expectedHash, attachmentsDir) {
  const users = projection.turnItems.filter((item) => item.type === "user_message");
  assert.equal(users.length, 1);
  const images = users[0].attachments;
  assert.equal(images.length, 1);
  const image = images[0];
  assert.notEqual(image.id, pending.id, "Pending upload was not claimed for coordinator");
  assert(
    new RegExp(`^${threadSegment(threadId)}-${UUID_PATTERN}$`, "i").test(image.id),
    "Image is not bound to the selected coordinator",
  );
  assert.equal(image.type, "image");
  assert.equal(image.name, pending.name);
  assert.equal(image.mimeType, pending.mimeType);
  assert.equal(image.sizeBytes, pending.sizeBytes);
  assert.equal(sha(readFileSync(join(attachmentsDir, `${image.id}.png`))), expectedHash);
  return {
    serverIssuedPendingUpload: true,
    coordinatorClaimVerified: true,
    claimedImageSha256: expectedHash,
  };
}

export function assertOwnedOutput(out, home, liveBase, release) {
  assert(isAbsolute(out) && !existsSync(out), "A new absolute output directory is required");
  const actualOut = join(realpathSync(dirname(out)), relative(dirname(out), out));
  for (const protectedRoot of [join(home, ".copilot"), liveBase, release]) {
    const root = existsSync(protectedRoot) ? realpathSync(protectedRoot) : resolve(protectedRoot);
    const child = relative(root, actualOut);
    assert(
      child !== "" && (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)),
      "Output cannot lie inside native/live/candidate state",
    );
  }
}

export async function execute(options) {
  const started = Date.now(),
    node = process.execPath,
    home = homedir();
  assert(options.authorized, "Explicit publisher window required");
  assert.equal(process.platform, "darwin", "This guarded Keychain proof is macOS only");
  assert(process.versions.node.startsWith("22."), "Node 22 required");
  const { release, source, binary, out } = options;
  const artifact = artifactIdentity(release, source);
  assert(
    isAbsolute(binary) && statSync(binary).isFile(),
    "Exact existing native executable required",
  );
  const liveBase = options["live-base-dir"] ?? join(home, ".specweave-studio/m4");
  assertOwnedOutput(out, home, liveBase, release);
  const paths = protectedPaths(home, liveBase),
    snapshots = () => Object.fromEntries(paths.map((path) => [path, snapshot(path)]));
  const before = snapshots();
  const selectors = accountSelectors(
    parseNativeConfig(readFileSync(join(home, ".copilot/config.json"), "utf8")),
  );
  const expectedIdentity = selectedIdentityHash(selectors),
    copilotHome = join(out, "copilot-home");
  const env = isolatedEnvironment(process.env, home, copilotHome, node);
  const imageBytes = createImageFixture(),
    image = verifyImage(imageBytes);
  mkdirSync(out, { mode: 0o700 });
  mkdirSync(copilotHome, { mode: 0o700 });
  mkdirSync(env.COPILOT_CACHE_HOME, { mode: 0o700 });
  writeFileSync(join(copilotHome, "config.json"), JSON.stringify(selectors, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  const state = join(out, "state"),
    fixture = join(out, "fixture");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(fixture, { mode: 0o700 });
  mkdirSync(join(state, "userdata"), { mode: 0o700 });
  writeFileSync(join(out, "fixture.png"), imageBytes, { mode: 0o600, flag: "wx" });
  const receipt = {
    kind: "isolated-built-product-coordinator",
    source,
    release,
    node,
    binary,
    realBinary: realpathSync(binary),
    binarySha256: sha(readFileSync(binary)),
    artifact,
    imageVerification: image,
    startedAt: new Date(started).toISOString(),
    model: MODEL,
    providerTurns: 0,
    status: "running",
    steps: [],
    rawOutputRetained: false,
    protectedState: { before },
    copilotIsolation: {
      home: copilotHome,
      cacheHome: env.COPILOT_CACHE_HOME,
      originalHomePreserved: true,
      secretBytesCopied: false,
      selectorFieldsOnly: ["host", "login", "kind"],
      expectedIdentitySha256: expectedIdentity,
    },
  };
  const receiptPath = join(out, "receipt.json");
  const save = () =>
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  const record = (name, data = {}) => {
    receipt.steps.push({ name, at: new Date().toISOString(), ...data });
    save();
    console.log(JSON.stringify({ name, ...data }));
  };
  let child,
    serverIdentity,
    ownershipTracker,
    forceTimer,
    cookie = "",
    privateOutput = "";
  let threadId,
    projectId,
    lastProjection,
    cleaning = false,
    nativeOutputImageFallback = false;
  const tracked = new Map();
  const descendants = () => {
    if (serverIdentity && canSignal(serverIdentity)) {
      const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], {
        encoding: "utf8",
        timeout: 1000,
      });
      const rows = (result.stdout ?? "")
        .trim()
        .split("\n")
        .map((row) => row.trim().split(/\s+/).map(Number));
      const ids = new Set([serverIdentity.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, parent] of rows)
          if (ids.has(parent) && !ids.has(pid)) {
            ids.add(pid);
            changed = true;
          }
      }
      for (const pid of ids) {
        const identity = processIdentity(pid);
        if (identity && !tracked.has(pid)) tracked.set(pid, identity);
      }
    }
    return [...tracked.values()].filter(canSignal);
  };
  let origin;
  const request = async (path, body, mime = "application/json") => {
    assert(typeof path === "string" && /^\/api\//.test(path) && !path.startsWith("//"));
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Origin: origin,
        "Content-Type": mime,
        "x-studio-orchestration-protocol": "2",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(deadlineBudget(started, Date.now(), cleaning)),
    });
    return response;
  };
  const json = async (path, body) => {
    const response = await request(path, body);
    assert.equal(response.status, 200, "Owned API request failed");
    return { response, value: await response.json() };
  };
  const allowedRpcs = new Set([
    "server.getConfig",
    "server.refreshProviders",
    "projects.coordinatorStart",
    "projects.coordinatorSend",
    "attachments.createUploadUrl",
    "orchestration.dispatchCommand",
  ]);
  const rpc = async (tag, payload = {}) => {
    assert(allowedRpcs.has(tag));
    if (tag === "projects.coordinatorStart" || tag === "projects.coordinatorSend")
      assert.equal(payload.projectId, projectId);
    if (tag === "orchestration.dispatchCommand") {
      assert.equal(payload.type, "run.interrupt");
      assert.equal(payload.threadId, threadId);
      assert.equal(payload.runId, lastProjection?.runs.at(-1)?.id);
    }
    const { value } = await json("/api/auth/websocket-ticket", {});
    const url = new URL(origin);
    url.protocol = "ws:";
    url.pathname = "/ws";
    url.searchParams.set("wsTicket", value.ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    return new Promise((done, reject) => {
      const ws = new WebSocket(url),
        timer = setTimeout(
          () => {
            ws.close();
            reject(new Error("Owned RPC timed out"));
          },
          deadlineBudget(started, Date.now(), cleaning),
        );
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
      );
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Owned RPC transport failed"));
      });
      ws.addEventListener("message", (event) => {
        let values;
        try {
          const parsed = JSON.parse(event.data);
          values = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return;
        }
        for (const result of values)
          if (result._tag === "Exit" && String(result.requestId) === "1") {
            clearTimeout(timer);
            ws.close();
            if (result.exit?._tag === "Success") done(result.exit.value);
            else reject(new Error("Owned RPC rejected"));
          }
      });
    });
  };
  save();
  try {
    writeFileSync(
      join(fixture, "AGENTS.md"),
      "Answer the user's image question. Do not use tools, commands, files, network, browser, delegation, or skills.\n",
      { mode: 0o600 },
    );
    const emptyGitTemplate = join(out, "empty-git-template");
    mkdirSync(emptyGitTemplate, { mode: 0o700 });
    for (const args of [
      ["init", "--template", emptyGitTemplate, "-b", "copilot-smoke"],
      ["add", "AGENTS.md"],
      [
        "-c",
        "user.name=Studio Verification",
        "-c",
        "user.email=verification@example.invalid",
        "commit",
        "-m",
        "Owned image fixture",
      ],
    ]) {
      assert.equal(
        spawnSync(
          "/usr/bin/git",
          [
            "-c",
            `core.hooksPath=${emptyGitTemplate}`,
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.fsmonitor=false",
            ...args,
          ],
          { cwd: fixture, env, stdio: "ignore", timeout: 3000 },
        ).status,
        0,
      );
    }
    const providerInstances = {},
      providers = {};
    for (const driver of [
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "pi",
      "opencode",
      "antigravity",
    ]) {
      providers[driver] = { enabled: false };
      providerInstances[driver] = {
        driver,
        enabled: false,
        config: { enabled: false, setupMode: "existing" },
      };
    }
    providerInstances[INSTANCE_ID] = {
      driver: "acpRegistry",
      enabled: true,
      displayName: "Copilot owned image proof",
      config: {
        source: "local",
        enabled: true,
        agentId: "github-copilot-cli",
        commandPath: binary,
        commandArgs: [...COPILOT_ARGS],
        authMethodId: "",
        customModels: [],
      },
    };
    writeFileSync(
      join(state, "userdata/settings.json"),
      JSON.stringify({
        providers,
        providerInstances,
        defaultThreadEnvMode: "local",
        defaultRuntimeMode: "full-access",
        newWorktreesStartFromOrigin: false,
        cursorKeychainUsageEnabled: false,
      }),
      { mode: 0o600, flag: "wx" },
    );
    const port = await new Promise((done, reject) => {
      const socket = net.createServer();
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", () => {
        const address = socket.address();
        socket.close(() => done(address.port));
      });
    });
    origin = `http://127.0.0.1:${port}`;
    receipt.port = port;
    child = spawn(
      node,
      [
        join(release, "bin.mjs"),
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--base-dir",
        state,
        "--no-browser",
      ],
      { cwd: fixture, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    // Register before the first synchronous identity probe: a spawn error must
    // remain a curated proof failure, never an unhandled raw child-process error.
    child.on("error", () => {});
    serverIdentity = processIdentity(child.pid) ?? { pid: child.pid };
    receipt.server = { pid: child.pid, baseDir: state, identity: serverIdentity.identity ?? null };
    tracked.set(child.pid, serverIdentity);
    assert(serverIdentity.birthIdentity, "Owned server identity unavailable");
    ownershipTracker = setInterval(descendants, 500);
    forceTimer = setTimeout(
      () => {
        const owned = descendants();
        for (const identity of owned.reverse()) signalOwned(identity, "SIGTERM");
      },
      Math.max(1, started + 105_000 - Date.now()),
    );
    let token = await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Owned startup timed out")),
        Math.max(1, Math.min(40_000, started + 105_000 - Date.now())),
      );
      const collect = (bytes) => {
        privateOutput = (privateOutput + bytes.toString()).slice(-30_000);
        nativeOutputImageFallback ||= imageFallbackObserved(privateOutput);
        const match = privateOutput.match(/(?:^|\n)Token: ([^\s]+)/);
        if (match) {
          clearTimeout(timer);
          done(match[1]);
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Owned server could not start"));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Owned server exited"));
      });
    });
    record("server-ready", { pid: child.pid });
    const auth = await json("/api/auth/browser-session", { credential: token });
    token = "";
    cookie = auth.response.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    assert(cookie);
    record("isolated-session-created");
    const initialConfig = await rpc("server.getConfig");
    assert.equal(initialConfig.environment.serverSourceCommit, source);
    receipt.observability = assertPrivateObservability(initialConfig);
    save();
    await rpc("server.refreshProviders", { instanceId: INSTANCE_ID, cwd: fixture });
    let config, provider;
    for (let i = 0; i < 12; i++) {
      config = await rpc("server.getConfig");
      assert.equal(config.environment.serverSourceCommit, source);
      assertPrivateObservability(config);
      provider = config.providers.find((item) => item.instanceId === INSTANCE_ID);
      if (["authenticated", "unauthenticated"].includes(provider?.auth?.status)) break;
      await pause(1000);
    }
    // No provider.message or raw native output is retained in the public receipt.
    record("provider-probe", {
      status: ["ready", "error", "unavailable"].includes(provider?.status)
        ? provider.status
        : "unknown",
      authStatus: ["authenticated", "unauthenticated", "unknown"].includes(provider?.auth?.status)
        ? provider.auth.status
        : "unknown",
      requestedModelAdvertised: provider?.models?.some((item) => item.slug === MODEL) ?? false,
    });
    assert(["authenticated", "unknown"].includes(provider?.auth?.status), "Stop without login");
    assert.equal(provider.status, "ready");
    assert(provider.models.some((item) => item.slug === MODEL));
    receipt.servedArtifact = {
      sourceCommit: config.environment.serverSourceCommit,
      version: config.environment.serverVersion,
    };
    assertSame(before, snapshots());
    const actualIdentity = () =>
      selectedIdentityHash(
        parseNativeConfig(readFileSync(join(copilotHome, "config.json"), "utf8")),
      );
    assert.equal(actualIdentity(), expectedIdentity, "Native identity changed during probe");
    projectId = randomUUID();
    const selection = { instanceId: INSTANCE_ID, model: MODEL };
    const folders = [join(out, "extra-project-one"), join(out, "extra-project-two")];
    for (const path of folders) mkdirSync(path, { mode: 0o700 });
    await json("/api/projects/mutate", {
      type: "project.create",
      kind: "personal",
      commandId: randomUUID(),
      projectId,
      title: "Owned coordinator image verification",
      workspaceRoot: fixture,
      defaultModelSelection: selection,
    });
    await json("/api/projects/mutate", {
      type: "project.update",
      commandId: randomUUID(),
      projectId,
      workspaceSettings: {
        expectedRevision: 0,
        environment: { additionalFolders: folders, repositories: [] },
        coordinatorModelSelection: selection,
        autoResume: false,
      },
    });
    const coordinator = await rpc("projects.coordinatorStart", {
      projectId,
      commandId: randomUUID(),
    });
    threadId = coordinator.threadId;
    receipt.coordinator = { projectId, threadId, extraFolderCount: 2 };
    const initial = (await json(`/api/orchestration/threads/${encodeURIComponent(threadId)}`)).value
      .projection;
    assertCoordinatorProjection(initial, projectId, threadId);
    assert.equal(initial.runs.length, 0);
    const attachment = await stageImage({ rpc, post: request, bytes: imageBytes, origin });
    receipt.imageUpload = { serverIssuedPendingUpload: true, sizeBytes: imageBytes.length };
    // Exactly one submission; an ambiguous outcome is never retried.
    receipt.providerSubmissionAttempts = 1;
    save();
    await rpc("projects.coordinatorSend", {
      projectId,
      commandId: randomUUID(),
      prompt: PROMPT,
      attachments: [attachment],
    });
    receipt.providerTurns = 1;
    record("coordinator-image-submitted");
    while (Date.now() < started + 105_000) {
      lastProjection = (await json(`/api/orchestration/threads/${encodeURIComponent(threadId)}`))
        .value.projection;
      assertCoordinatorProjection(lastProjection, projectId, threadId);
      assert(
        !lastProjection.runtimeRequests.some((item) => item.status === "pending"),
        "Never accept permission requests",
      );
      if (
        ["completed", "failed", "interrupted", "cancelled"].includes(
          lastProjection.runs.at(-1)?.status,
        )
      )
        break;
      await pause(400);
    }
    assert(lastProjection);
    const projection = lastProjection;
    assert.equal(projection.runs.length, 1);
    assert.equal(projection.runs[0].status, "completed");
    const assistants = projection.turnItems.filter((item) => item.type === "assistant_message");
    const answer = assistants.map((item) => item.text).join("\n");
    assert.equal(answer.trim(), image.expectedAnswer);
    assert.equal(projection.providerTurns.length, 1);
    assert.equal(projection.providerTurns[0].status, "completed");
    assert(
      projection.providerSessions.some(
        (session) =>
          session.driver === "acpRegistry" &&
          session.providerInstanceId === INSTANCE_ID &&
          session.model === MODEL,
      ),
      "ACP provenance missing",
    );
    const toolKinds = projection.turnItems
      .filter(
        (item) =>
          !["user_message", "assistant_message", "reasoning", "notification"].includes(item.type),
      )
      .map((item) => item.type);
    assert(
      toolKinds.every((type) => type === "checkpoint"),
      "Unexpected tool activity",
    );
    receipt.imageUpload = deliveredImage(
      projection,
      threadId,
      attachment,
      image.sha256,
      join(state, "userdata/attachments"),
    );
    const nativeId = projection.providerThreads.find(
      (item) => item.providerInstanceId === INSTANCE_ID,
    )?.nativeThreadRef?.nativeId;
    assert(typeof nativeId === "string" && /^[A-Za-z0-9_-]+$/.test(nativeId));
    // This directory was minted fresh above. Never inventory/read unrelated sessions.
    const nativePath = join(copilotHome, "session-state", nativeId, "events.jsonl"),
      nativeBytes = readFileSync(nativePath);
    const events = nativeBytes.toString("utf8").trim().split("\n").map(JSON.parse);
    const binding = nativeColorBinding(events, answer, image.expectedAnswer);
    binding.imageFallbackObserved ||= nativeOutputImageFallback;
    receipt.nativeModelProof = { sha256: sha(nativeBytes), ...binding };
    assert(!binding.imageFallbackObserved);
    assert(!binding.nativeToolRequestsObserved);
    assert(binding.finalColorAndModelBound);
    assertSame(before, snapshots());
    assert.equal(actualIdentity(), expectedIdentity);
    receipt.proof = {
      runStatus: "completed",
      requestedModel: MODEL,
      actualFinalModel: MODEL,
      colorReplyVerified: true,
      answerSha256: sha(answer),
      toolActivityObserved: false,
    };
    receipt.status = "passed";
    record("coordinator-vision-verified", receipt.proof);
  } catch (error) {
    receipt.status = "failed";
    receipt.failure = {
      name: ["AssertionError", "Error", "AbortError", "TimeoutError"].includes(error?.name)
        ? error.name
        : "UnknownError",
      code: error?.code === "ERR_ASSERTION" ? "assertion_failed" : "proof_failed",
      lastStep: receipt.steps.at(-1)?.name ?? "startup",
    };
    record("proof-failed", { failure: receipt.failure });
  } finally {
    cleaning = true;
    clearTimeout(forceTimer);
    clearInterval(ownershipTracker);
    if (
      threadId &&
      lastProjection?.runs.at(-1) &&
      !["completed", "failed", "interrupted", "cancelled"].includes(
        lastProjection.runs.at(-1).status,
      )
    ) {
      try {
        await rpc("orchestration.dispatchCommand", {
          type: "run.interrupt",
          commandId: randomUUID(),
          threadId,
          runId: lastProjection.runs.at(-1).id,
          reason: "Owned bounded proof cleanup",
          holdQueue: true,
        });
      } catch {
        /* terminate only owned processes */
      }
    }
    const owned = descendants();
    receipt.server ??= {};
    receipt.server.ownedPids = [...tracked.keys()];
    for (const identity of owned.reverse()) signalOwned(identity, "SIGTERM");
    if (child && child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise((done) => child.once("exit", done)),
        pause(Math.max(0, Math.min(3000, started + 118_000 - Date.now()))),
      ]);
    }
    await pause(Math.max(0, Math.min(400, started + 118_000 - Date.now())));
    for (const identity of owned) signalOwned(identity, "SIGKILL");
    await pause(Math.max(0, Math.min(100, started + 118_000 - Date.now())));
    const quiescence = ownedQuiescence([...tracked.values()], processProbe);
    receipt.server.remainingPids = quiescence.remainingPids;
    receipt.server.unresolvedPids = quiescence.unresolvedPids;
    receipt.cleanupComplete =
      quiescence.complete && (!child || child.exitCode !== null || child.signalCode !== null);
    if (!receipt.cleanupComplete) receipt.status = "needs-attention";
    try {
      const after = snapshots();
      receipt.protectedState.after = after;
      receipt.protectedState.changedPaths = paths.filter(
        (path) => JSON.stringify(before[path]) !== JSON.stringify(after[path]),
      );
      assertSame(before, after);
      receipt.protectedState.unchanged = true;
    } catch {
      receipt.protectedState.unchanged = false;
      receipt.status = "failed";
    }
    try {
      const actual = selectedIdentityHash(
        parseNativeConfig(readFileSync(join(copilotHome, "config.json"), "utf8")),
      );
      receipt.copilotIsolation.actualIdentitySha256 = actual;
      receipt.copilotIsolation.selectedIdentityUnchanged = actual === expectedIdentity;
      assert.equal(actual, expectedIdentity);
    } catch {
      receipt.copilotIsolation.selectedIdentityUnchanged = false;
      receipt.status = "failed";
    }
    try {
      assertSame(artifact, artifactIdentity(release, source));
      assert.equal(sha(readFileSync(binary)), receipt.binarySha256);
      receipt.artifact.unchanged = true;
    } catch {
      receipt.artifact.unchanged = false;
      receipt.status = "failed";
    }
    receipt.elapsedMs = Date.now() - started;
    receipt.completedWithinOwnerWindow = receipt.elapsedMs < 120_000;
    if (!receipt.completedWithinOwnerWindow) receipt.status = "failed";
    receipt.server.exitCode = child?.exitCode ?? null;
    receipt.server.stoppedAt = new Date().toISOString();
    privateOutput = "";
    cookie = "";
    save();
    console.log(
      JSON.stringify({
        receipt: receiptPath,
        status: receipt.status,
        cleanupComplete: receipt.cleanupComplete,
        protectedStateUnchanged: receipt.protectedState.unchanged,
        remainingOwnedPids: receipt.server.remainingPids,
        unresolvedOwnedPids: receipt.server.unresolvedPids,
      }),
    );
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) {
    console.log(
      "Node22 copilot-coordinator-native.mjs --release ABSOLUTE_CANDIDATE --source FULL40SHA --binary ABSOLUTE_COPILOT --out NEW_ABSOLUTE_DIR --execute-authorized [--live-base-dir ABSOLUTE_LIVE_DIR]",
    );
  } else {
    try {
      const receipt = await execute(parseArgs(process.argv.slice(2)));
      process.exitCode =
        receipt.status === "passed" &&
        receipt.cleanupComplete &&
        receipt.protectedState.unchanged &&
        receipt.copilotIsolation.selectedIdentityUnchanged &&
        receipt.completedWithinOwnerWindow
          ? 0
          : 1;
    } catch {
      console.error(
        JSON.stringify({
          status: "failed",
          code: "preflight_failed",
          nativeExecutionNotProved: true,
        }),
      );
      process.exitCode = 1;
    }
  }
}
