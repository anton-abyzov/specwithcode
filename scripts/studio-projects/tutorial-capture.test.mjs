import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertAcceptance,
  assertInside,
  assertNativeFixture,
  assertNativeUsage,
  assertTutorialRpc,
  captionsVtt,
  captureEnvironment,
  nativeProofScope,
  NATIVE_PROOF_CAPTION,
  ORIGIN,
} from "./tutorial-capture.mjs";

test("isolated server environment never inherits auth or endpoint overrides", () => {
  const environment = captureEnvironment("/owned/home", "/owned/tmp");
  assert.equal(environment.HOME, "/owned/home");
  assert.equal(environment.TMPDIR, "/owned/tmp");
  assert.equal(environment.PWDEBUG, "0");
  assert.equal(environment.PLAYWRIGHT_HTML_OPEN, "never");
  assert.equal(environment.STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "false");
  assert.deepEqual(
    Object.keys(environment).sort(),
    [
      "HOME",
      "LANG",
      "LOGNAME",
      "PATH",
      "PLAYWRIGHT_HTML_OPEN",
      "PWDEBUG",
      "STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
      "TMPDIR",
      "USER",
    ].sort(),
  );
  assert.equal(ORIGIN, "http://127.0.0.1:8432");
});
test("tutorial RPC guard rejects native dispatch, foreign projects and enabled schedules", () => {
  const scope = { projectIds: new Set(["atlas"]), routineIds: new Set(["daily"]) };
  assertTutorialRpc("projects.memoryRead", { projectId: "atlas" }, scope);
  assertTutorialRpc(
    "scheduledTasks.upsert",
    { projectId: "atlas", id: "daily", enabled: false },
    scope,
  );
  for (const [tag, payload] of [
    ["orchestration.dispatchCommand", { type: "message.dispatch" }],
    ["projects.coordinatorSend", { projectId: "atlas" }],
    ["projects.planVerify", { projectId: "atlas" }],
    ["projects.memoryWrite", { projectId: "private" }],
    ["scheduledTasks.upsert", { projectId: "atlas", id: "daily", enabled: true }],
    ["scheduledTasks.upsert", { projectId: "atlas", id: "foreign", enabled: false }],
  ])
    assert.throws(() => assertTutorialRpc(tag, payload, scope));
});
test("capture acceptance is bound to exact clean source and built executable", () => {
  const commit = "a".repeat(40),
    hash = "b".repeat(64);
  const receipt = {
    success: true,
    source: commit,
    sourceDirty: false,
    buildSha256: hash,
    version: "0.2.1",
    browser: { headless: true },
  };
  assertAcceptance(receipt, commit, hash, "0.2.1");
  for (const patch of [
    { success: false },
    { sourceDirty: true },
    { source: "c".repeat(40) },
    { buildSha256: "d".repeat(64) },
    { version: "0.2.0" },
    { browser: { headless: false } },
  ])
    assert.throws(() => assertAcceptance({ ...receipt, ...patch }, commit, hash, "0.2.1"));
  assert.throws(() => assertAcceptance(receipt, commit, hash, "0.2.3"));
});
test("mixed-provider capture refuses claimed fixtures without proof and ownership", () => {
  const fixture = {
    schemaVersion: 1,
    sourceCommit: "a".repeat(40),
    syntheticDataOnly: true,
    providersDisabled: true,
    captureOwnershipTransferred: true,
    proofScope: "functional-project-coordination",
    wholeProfileBytePreservation: "not-established",
    fleetDeploymentVerified: false,
    nativeProviders: { claude: "passed", codex: "passed" },
    nativeReceiptSha256: "b".repeat(64),
    projects: [{ id: "atlas", title: "Tutorial Atlas", dir: "/owned/atlas" }],
    coordinator: { id: "coordinator", title: "Codex coordinator", provider: "codex" },
    workers: [{ id: "one", title: "Claude worker", provider: "claude" }],
  };
  assertNativeFixture(fixture, fixture.sourceCommit);
  for (const patch of [
    { fleetDeploymentVerified: true },
    { wholeProfileBytePreservation: "passed" },
    { captureOwnershipTransferred: false },
    { syntheticDataOnly: false },
    { providersDisabled: false },
    { nativeProviders: { claude: "unknown", codex: "passed" } },
    { nativeReceiptSha256: "unknown" },
    { workers: [fixture.workers[0], fixture.workers[0]] },
  ])
    assert.throws(() => assertNativeFixture({ ...fixture, ...patch }, fixture.sourceCommit));
});
test("captions preserve action order and reject overlapping or injected markup", () => {
  const beats = [
    { start: 0, end: 7.25, caption: "Open the project." },
    { start: 7.25, end: 14, caption: "Save a decision." },
  ];
  assert.match(captionsVtt(beats), /00:00:00.000 --> 00:00:07.250/);
  assert.match(captionsVtt(beats), /00:00:07.250 --> 00:00:14.000/);
  assert.throws(() => captionsVtt([{ ...beats[0], end: -1 }]));
  assert.throws(() => captionsVtt([beats[0], { ...beats[1], start: 2 }]));
  assert.throws(() => captionsVtt([{ ...beats[0], caption: "<script>unsafe</script>" }]));
});
test("media containment rejects symlinks outside the task-owned capture root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tutorial-scope-"));
  try {
    fs.mkdirSync(path.join(root, "capture"));
    fs.writeFileSync(path.join(root, "outside.webm"), "fixture");
    fs.writeFileSync(path.join(root, "capture", "inside.webm"), "fixture");
    fs.symlinkSync(path.join(root, "outside.webm"), path.join(root, "capture", "escape.webm"));
    assertInside(path.join(root, "capture"), path.join(root, "capture", "inside.webm"));
    assert.throws(() =>
      assertInside(path.join(root, "capture"), path.join(root, "capture", "escape.webm")),
    );
    assert.throws(() => assertInside(root, root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("native usage walkthrough rejects empty, missing-thread and single-model evidence", () => {
  const fixture = { coordinator: { id: "coordinator" }, workers: [{ id: "worker" }] };
  const usage = {
    totals: { totalTokens: 80 },
    models: [{ model: "codex" }, { model: "claude" }],
    threads: [
      { threadId: "coordinator", totals: { totalTokens: 30 } },
      { threadId: "worker", totals: { totalTokens: 50 } },
    ],
  };
  assertNativeUsage(usage, fixture);
  for (const patch of [
    { totals: { totalTokens: null } },
    { totals: { totalTokens: 0 } },
    { threads: usage.threads.slice(0, 1) },
    { models: usage.models.slice(0, 1) },
  ])
    assert.throws(() => assertNativeUsage({ ...usage, ...patch }, fixture));
});
test("Personal setup is limited to the named project with disabled providers and scoped reads", () => {
  const scope = {
    projectIds: new Set(["personal"]),
    routineIds: new Set(),
    personal: true,
    providersDisabled: true,
  };
  assertTutorialRpc("projects.createNew", { name: "Tutorial Personal", kind: "personal" }, scope);
  assertTutorialRpc("projects.environmentRead", { projectId: "personal" }, scope);
  assertTutorialRpc("projects.connectionsRead", { projectId: "personal" }, scope);
  for (const altered of [
    { ...scope, personal: false },
    { ...scope, providersDisabled: false },
  ])
    assert.throws(() =>
      assertTutorialRpc(
        "projects.createNew",
        { name: "Tutorial Personal", kind: "personal" },
        altered,
      ),
    );
  assert.throws(() =>
    assertTutorialRpc("projects.createNew", { name: "Another project", kind: "personal" }, scope),
  );
  assert.throws(() =>
    assertTutorialRpc("projects.createNew", { name: "Tutorial Personal", kind: "code" }, scope),
  );
  assert.throws(() =>
    assertTutorialRpc(
      "projects.createNew",
      { name: "Tutorial Personal", kind: "personal", workspaceRoot: "/private" },
      scope,
    ),
  );
  assert.throws(() =>
    assertTutorialRpc("projects.connectionsRead", { projectId: "foreign" }, scope),
  );
  assert.throws(() =>
    assertTutorialRpc("projects.connectionCall", { projectId: "personal" }, scope),
  );
});
test("native walkthrough caption scopes its claim to project coordination", () => {
  assert.equal(
    NATIVE_PROOF_CAPTION,
    "Verified here: native project coordination. Device deployment is checked separately.",
  );
  assert.match(
    captionsVtt([{ start: 0, end: 9, caption: NATIVE_PROOF_CAPTION }]),
    /Device deployment is checked separately/,
  );
});
test("native proof cannot overclaim profile preservation or deployment, or omit scope", () => {
  const expected = {
    proofScope: "functional-project-coordination",
    wholeProfileBytePreservation: "not-established",
    fleetDeploymentVerified: false,
  };
  assert.deepEqual(nativeProofScope({ ...expected, unrelated: "not copied" }), expected);
  for (const [key, incorrect] of Object.entries({
    proofScope: "whole-account-verification",
    wholeProfileBytePreservation: "passed",
    fleetDeploymentVerified: true,
  })) {
    assert.throws(() => nativeProofScope({ ...expected, [key]: incorrect }));
    const omitted = { ...expected };
    delete omitted[key];
    assert.throws(() => nativeProofScope(omitted));
  }
});
