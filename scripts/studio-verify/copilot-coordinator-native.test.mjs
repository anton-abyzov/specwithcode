import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MODEL,
  PROMPT,
  COPILOT_ARGS,
  accountSelectors,
  artifactIdentity,
  assertCoordinatorProjection,
  assertOwnedOutput,
  assertPrivateObservability,
  assertSame,
  createImageFixture,
  deadlineBudget,
  deliveredImage,
  isolatedEnvironment,
  nativeColorBinding,
  ownedIdentityMatches,
  ownedQuiescence,
  parseProcessIdentity,
  parseArgs,
  parseNativeConfig,
  protectedPaths,
  selectedIdentityHash,
  snapshot,
  stageImage,
  verifyImage,
} from "./copilot-coordinator-native.mjs";

const selectors = () => ({
  loggedInUsers: [{ host: "https://github.com", login: "fixture-user", kind: "oauth" }],
  lastLoggedInUser: { host: "https://github.com", login: "fixture-user" },
});
const event = (model, content, toolRequests = []) => ({
  type: "assistant.message",
  data: { model, content, toolRequests },
});
const pending = "pending-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function workspace(t) {
  const path = mkdtempSync(join(tmpdir(), "studio-copilot-static-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("imports are inert and the vision prompt contains no expected color", () => {
  assert(!PROMPT.includes("red"));
  assert.equal(MODEL, "claude-opus-5.5");
  assert(COPILOT_ARGS.includes("--deny-tool"));
  assert(!COPILOT_ARGS.some((arg) => arg.startsWith("--allow-")));
});
test("only validated selector fields are retained; all top-level tokens and plugins are excluded", () => {
  const input = {
    ...selectors(),
    token: "fixture-secret",
    accessToken: "another-secret",
    plugins: ["never-copy"],
    hooks: ["never-copy"],
  };
  assert.deepEqual(accountSelectors(input), selectors());
  assert(!JSON.stringify(accountSelectors(input)).includes("secret"));
});
for (const key of ["token", "accessToken", "oauthToken", "permissions", "hooks", "plugins"]) {
  test(`rejects nested ${key} instead of copying an unknown account field`, () => {
    const input = selectors();
    input.loggedInUsers[0][key] = "fixture-secret";
    assert.throws(() => accountSelectors(input));
  });
}
test("JSONC generated comments parse without accepting malformed JSON", () => {
  assert.deepEqual(
    accountSelectors(parseNativeConfig("// Generated config\n" + JSON.stringify(selectors()))),
    selectors(),
  );
  assert.throws(() => parseNativeConfig("invalid JSON"));
});
for (const change of [
  (s) => {
    s.loggedInUsers[0].host = "https://user:password@github.com";
  },
  (s) => {
    s.loggedInUsers[0].host = "https://github.com/?token=fixture";
  },
  (s) => {
    s.loggedInUsers[0].login = "gho_abcdefghijklmnop";
  },
  (s) => {
    s.loggedInUsers[0].kind = "gho_abcdefghijklmnop";
  },
  (s) => {
    s.lastLoggedInUser.login = "unknown-user";
  },
  (s) => {
    s.lastLoggedInUser.token = "never-copy";
  },
  (s) => {
    s.loggedInUsers = [];
  },
])
  test("invalid selector metadata fails closed", () => {
    const input = selectors();
    change(input);
    assert.throws(() => accountSelectors(input));
  });
test("identity hashes bind selected host/login while excluding transient configuration", () => {
  const initial = selectors();
  assert.equal(
    selectedIdentityHash(initial),
    selectedIdentityHash({ ...initial, timestamp: "changed" }),
  );
  const changed = selectors();
  changed.lastLoggedInUser.login = changed.loggedInUsers[0].login = "different-user";
  assert.notEqual(selectedIdentityHash(initial), selectedIdentityHash(changed));
  const methodChanged = selectors();
  methodChanged.loggedInUsers[0].kind = "different-kind";
  assert.notEqual(selectedIdentityHash(initial), selectedIdentityHash(methodChanged));
});
test("COPILOT_HOME isolates all native state while HOME/keychain and ambient environment stay unchanged", () => {
  const original = {
    HOME: "/home/fixture",
    PATH: "/bin",
    LANG: "en_US.UTF-8",
    COPILOT_HOME: "/original",
  };
  const env = isolatedEnvironment(
    original,
    original.HOME,
    "/owned/copilot-home",
    "/node22/bin/node",
  );
  assert.equal(env.HOME, original.HOME);
  assert.equal(env.COPILOT_HOME, "/owned/copilot-home");
  assert.equal(env.COPILOT_CACHE_HOME, "/owned/copilot-cache");
  assert.equal(original.COPILOT_HOME, "/original");
  assert.equal(env.LANG, original.LANG);
  assert.throws(() => isolatedEnvironment(original, "/different-home", "/owned", "/node22/node"));
});
test("all token, BYOK, API, model and provider overrides are removed without copying their bytes", () => {
  const env = isolatedEnvironment(
    {
      HOME: "/fixture",
      PATH: "/bin",
      GH_TOKEN: "fixture-secret",
      GITHUB_TOKEN: "fixture-secret",
      GH_HOST: "another-host",
      GITHUB_HOST: "another-host",
      NODE_OPTIONS: "--require untrusted",
      COPILOT_GITHUB_TOKEN: "fixture-secret",
      COPILOT_PROVIDERS_CONFIG: "/private/providers",
      COPILOT_API_URL: "https://override.invalid",
      COPILOT_PROVIDER_API_KEY: "fixture-secret",
      COPILOT_PROVIDER_BASE_URL: "https://byok.invalid",
      COPILOT_MODEL: "other",
      COPILOT_FUTURE_PROVIDER_OVERRIDE: "future-secret",
    },
    "/fixture",
    "/owned/copilot-home",
    "/node22/node",
  );
  assert(!JSON.stringify(env).includes("fixture-secret"));
  assert(!JSON.stringify(env).includes("future-secret"));
  assert.deepEqual(
    Object.keys(env)
      .filter((key) => key.startsWith("COPILOT_"))
      .sort(),
    ["COPILOT_ALLOW_ALL", "COPILOT_AUTO_UPDATE", "COPILOT_CACHE_HOME", "COPILOT_HOME"],
  );
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GITHUB_HOST", "NODE_OPTIONS"])
    assert(!Object.hasOwn(env, key));
});
test("inherited product analytics, OTLP collectors, relay, dev UI, hooks and git destinations cannot escape isolation", () => {
  const env = isolatedEnvironment(
    {
      HOME: "/fixture",
      STUDIO_TELEMETRY_ENABLED: "true",
      STUDIO_POSTHOG_KEY: "fixture-secret",
      STUDIO_POSTHOG_HOST: "https://analytics.invalid",
      STUDIO_OTLP_TRACES_URL: "https://collector.invalid",
      STUDIO_OTLP_HEADERS: "Authorization=fixture-secret",
      STUDIO_RELAY_CLIENT_OTLP_TRACES_TOKEN: "fixture-secret",
      STUDIO_ENABLE_HOSTED_SERVICES: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.invalid",
      GIT_DIR: "/live/repo/.git",
      GIT_WORK_TREE: "/live/repo",
      GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: "true",
      VITE_DEV_SERVER_URL: "https://external-ui.invalid",
    },
    "/fixture",
    "/owned/copilot-home",
    "/node22/node",
  );
  assert.equal(env.STUDIO_TELEMETRY_ENABLED, "false");
  assert.equal(env.STUDIO_ENABLE_HOSTED_SERVICES, "false");
  for (const key of [
    "STUDIO_POSTHOG_KEY",
    "STUDIO_POSTHOG_HOST",
    "STUDIO_OTLP_TRACES_URL",
    "STUDIO_OTLP_HEADERS",
    "STUDIO_RELAY_CLIENT_OTLP_TRACES_TOKEN",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS",
    "VITE_DEV_SERVER_URL",
  ])
    assert(!Object.hasOwn(env, key));
  assert(!JSON.stringify(env).includes("fixture-secret"));
});
test("served analytics and all three export flags must be explicitly off before submission", () => {
  const observability = {
    productUsageEnabled: false,
    productUsageDestinationConfigured: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  };
  assert.deepEqual(assertPrivateObservability({ observability }), observability);
  for (const key of Object.keys(observability)) {
    assert.throws(() =>
      assertPrivateObservability({ observability: { ...observability, [key]: true } }),
    );
    assert.throws(() =>
      assertPrivateObservability({ observability: { ...observability, [key]: undefined } }),
    );
  }
  assert.throws(() =>
    assertPrivateObservability({
      observability: { ...observability, otlpLogsUrl: "https://collector.invalid" },
    }),
  );
});
test("original file guards include native settings/MCP and live settings/install/Google credentials", () => {
  const paths = protectedPaths("/home/fixture", "/live/m4");
  assert.equal(paths.length, 7);
  assert(paths.includes("/home/fixture/.copilot/mcp-config.json"));
  assert(paths.includes("/live/m4/userdata/secrets/google-refresh-token.bin"));
  assert(paths.includes("/live/m4/userdata/secrets/google-account-state.bin"));
});
test("a content-identical file replacement still fails the original metadata guard", (t) => {
  const path = join(workspace(t), "config.json");
  writeFileSync(path, "same bytes", { mode: 0o600 });
  const before = snapshot(path);
  writeFileSync(path + ".replacement", "same bytes", { mode: 0o600 });
  renameSync(path + ".replacement", path);
  const after = snapshot(path);
  assert.equal(before.sha256, after.sha256);
  assert.throws(() => assertSame(before, after));
});
test("missing/created or byte-changed original files fail strict guards", (t) => {
  const path = join(workspace(t), "settings.json"),
    absent = snapshot(path);
  writeFileSync(path, "before");
  assert.throws(() => assertSame(absent, snapshot(path)));
  const before = snapshot(path);
  writeFileSync(path, "after");
  assert.throws(() => assertSame(before, snapshot(path)));
});
test("a permission round trip changes ctime and still fails when final bytes/mode match", (t) => {
  const path = join(workspace(t), "config.json");
  writeFileSync(path, "same bytes", { mode: 0o600 });
  const before = snapshot(path);
  chmodSync(path, 0o640);
  chmodSync(path, 0o600);
  const after = snapshot(path);
  for (const key of ["sha256", "mode", "mtimeNs", "ino"]) assert.equal(before[key], after[key]);
  for (const key of ["ctimeNs", "uid", "gid", "birthtimeNs", "linkCtimeNs", "linkUid", "linkGid"])
    assert.equal(typeof after[key], "string");
  assert.notEqual(before.ctimeNs, after.ctimeNs);
  assert.throws(() => assertSame(before, after));
});
test("fixture is a valid 128px RGBA PNG with every pixel checked independently of prompt", () => {
  const image = verifyImage(createImageFixture());
  assert.equal(image.width, 128);
  assert.equal(image.height, 128);
  assert.equal(image.expectedAnswer, "red");
  assert.equal(image.rgbaVerified, true);
  assert.throws(() => verifyImage(Buffer.from("tiny text fallback")));
  const broken = createImageFixture();
  broken[30] ^= 1;
  assert.throws(() => verifyImage(broken));
});
test("the actual final color and selected model must occur on the same native event", () => {
  assert(
    nativeColorBinding([event("sonnet", "red"), event(MODEL, "red")], "red", "red")
      .finalColorAndModelBound,
  );
  assert(
    !nativeColorBinding([event(MODEL, "red"), event("sonnet", "red")], "red", "red")
      .finalColorAndModelBound,
  );
  assert(
    !nativeColorBinding([event(MODEL, "blue"), event("sonnet", "red")], "red", "red")
      .finalColorAndModelBound,
  );
  assert(!nativeColorBinding([event(MODEL, "blue")], "blue", "red").finalColorAndModelBound);
});
test("rejects native image fallback and tool requests without retaining raw event content", () => {
  const proof = nativeColorBinding(
    [
      event(MODEL, "red"),
      {
        type: "warning",
        data: {
          private: "fixture-secret",
          message: "Image input was rejected. Retrying without images.",
        },
      },
    ],
    "red",
    "red",
  );
  assert(proof.imageFallbackObserved);
  assert(!JSON.stringify(proof).includes("fixture-secret"));
  assert(
    nativeColorBinding([event(MODEL, "red", [{ name: "write" }])], "red", "red")
      .nativeToolRequestsObserved,
  );
  assert(
    nativeColorBinding([event(MODEL, "red"), { type: "tool.execution_start" }], "red", "red")
      .nativeToolRequestsObserved,
  );
});
test("staging obtains a real signed grant then posts exact PNG bytes to that route", async () => {
  const bytes = createImageFixture(),
    calls = [];
  const attachment = await stageImage({
    bytes,
    origin: "http://127.0.0.1:1234",
    rpc: async (tag, payload) => {
      calls.push(tag);
      assert.equal(payload.name, "fixture.png");
      assert.equal(payload.sizeBytes, bytes.length);
      return { attachmentId: pending, relativeUrl: "/api/attachments/upload/fixture.signature" };
    },
    post: async (path, body, mime) => {
      calls.push(path);
      assert.equal(body, bytes);
      assert.equal(mime, "image/png");
      return { status: 204 };
    },
  });
  assert.deepEqual(calls, [
    "attachments.createUploadUrl",
    "/api/attachments/upload/fixture.signature",
  ]);
  assert.equal(attachment.id, pending);
});
for (const grant of [
  {
    attachmentId: "invented-finalized-id",
    relativeUrl: "/api/attachments/upload/fixture.signature",
  },
  {
    attachmentId: pending,
    relativeUrl: "https://other.invalid/api/attachments/upload/fixture.signature",
  },
  {
    attachmentId: pending,
    relativeUrl: "//other.invalid/api/attachments/upload/fixture.signature",
  },
  { attachmentId: pending, relativeUrl: "/api/projects/mutate" },
])
  test("never posts image bytes to an unissued finalized ID or another destination", async () => {
    let posted = false;
    await assert.rejects(
      stageImage({
        bytes: createImageFixture(),
        origin: "http://127.0.0.1:1234",
        rpc: async () => grant,
        post: async () => {
          posted = true;
          return { status: 204 };
        },
      }),
    );
    assert.equal(posted, false);
  });
test("coordinator and claimed image readback bind to the exact selected project/thread", (t) => {
  const projectId = "owned-project",
    threadId = "project-coordinator:owned-project",
    root = workspace(t);
  const bytes = createImageFixture(),
    imageId = "project-coordinator-owned-project-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  writeFileSync(join(root, imageId + ".png"), bytes);
  const attachment = {
    type: "image",
    id: pending,
    name: "fixture.png",
    mimeType: "image/png",
    sizeBytes: bytes.length,
  };
  const projection = {
    thread: {
      id: threadId,
      projectId,
      runtimeMode: "full-access",
      modelSelection: { instanceId: "copilot-coordinator-proof", model: MODEL },
    },
    turnItems: [{ type: "user_message", attachments: [{ ...attachment, id: imageId }] }],
  };
  assertCoordinatorProjection(projection, projectId, threadId);
  assert.equal(
    deliveredImage(projection, threadId, attachment, sha(bytes), root).coordinatorClaimVerified,
    true,
  );
  assert.throws(() => assertCoordinatorProjection(projection, "other-project", threadId));
  projection.turnItems[0].attachments[0].id = pending;
  assert.throws(() => deliveredImage(projection, threadId, attachment, sha(bytes), root));
});
test("candidate requires full source SHA, matching manifest, and real artifact hashes", (t) => {
  const path = workspace(t),
    source = "a".repeat(40);
  writeFileSync(join(path, "bin.mjs"), "export const candidate = true;");
  const bytes = readFileSync(join(path, "bin.mjs"));
  assert.throws(() => artifactIdentity(path, source), /manifest required/);
  writeFileSync(
    join(path, "studio-manifest.json"),
    JSON.stringify({
      sourceCommit: source,
      version: "fixture",
      files: [{ type: "file", path: "bin.mjs", sha256: sha(bytes) }],
    }),
  );
  assert.equal(artifactIdentity(path, source).entrypointSha256, sha(bytes));
  assert.throws(() => artifactIdentity(path, "caller-asserted"));
  assert.throws(() => artifactIdentity(path, "b".repeat(40)));
  writeFileSync(join(path, "bin.mjs"), "changed");
  assert.throws(() => artifactIdentity(path, source));
});
test("disposable output cannot be inside original native/live/candidate directories", (t) => {
  const home = workspace(t),
    release = join(home, "candidate"),
    live = join(home, "live");
  for (const path of [release, live, join(home, ".copilot")]) mkdirSync(path);
  assertOwnedOutput(join(home, "new-owned-proof"), home, live, release);
  for (const path of [release, live, join(home, ".copilot")]) {
    assert.throws(() => assertOwnedOutput(join(path, "new-proof"), home, live, release));
  }
});
test("CLI requires four explicit paths/source and a window; no arbitrary ACP argument override", () => {
  const args = [
    "--release",
    "/candidate",
    "--source",
    "a".repeat(40),
    "--binary",
    "/copilot",
    "--out",
    "/owned/new",
    "--execute-authorized",
  ];
  assert.equal(parseArgs(args).authorized, true);
  assert.throws(() => parseArgs(args.slice(0, -1)));
  assert.throws(() => parseArgs([...args, "--acp-args-json", '["--allow-all"]']));
  assert.throws(() => parseArgs([...args, "--binary", "/different"]));
});
test("whole execution deadline includes startup and cleanup remains inside 120 seconds", () => {
  assert.equal(deadlineBudget(1000, 1000), 10_000);
  assert.equal(deadlineBudget(1000, 105_999), 1);
  assert.throws(() => deadlineBudget(1000, 106_000));
  assert.equal(deadlineBudget(1000, 118_999, true), 1);
  assert.throws(() => deadlineBudget(1000, 119_000, true));
});
test("reused or unrelated PIDs cannot pass the exact identity signal guard", () => {
  const expected = parseProcessIdentity("42 Tue Oct 13 14:00:00 2026 /owned/server");
  assert(ownedIdentityMatches(expected, expected));
  assert(
    !ownedIdentityMatches(
      expected,
      parseProcessIdentity("42 Tue Oct 13 14:00:01 2026 /unrelated/server"),
    ),
  );
  assert(!ownedIdentityMatches(null, null));
  assert(!ownedIdentityMatches(expected, null));
});
test("an owned exec remains tracked after comm changes; unknown identities never prove cleanup", () => {
  const before = parseProcessIdentity("42 Tue Oct 13 14:00:00 2026 /owned/launcher");
  const after = parseProcessIdentity("42 Tue Oct 13 14:00:00 2026 /owned/copilot");
  assert(ownedIdentityMatches(before, after));
  assert.deepEqual(
    ownedQuiescence([before], () => ({ state: "present", record: after })),
    { remainingPids: [42], unresolvedPids: [], complete: false },
  );
  assert.deepEqual(
    ownedQuiescence([before], () => ({ state: "unknown" })),
    { remainingPids: [], unresolvedPids: [42], complete: false },
  );
  assert.deepEqual(
    ownedQuiescence([before], () => ({ state: "absent" })),
    { remainingPids: [], unresolvedPids: [], complete: true },
  );
});
test("PID reuse proves original disappearance while preserving the unrelated replacement", () => {
  const before = parseProcessIdentity("42 Tue Oct 13 14:00:00 2026 /owned/launcher");
  const reused = parseProcessIdentity("42 Tue Oct 13 14:00:01 2026 /other/copilot");
  assert(!ownedIdentityMatches(before, reused));
  assert.deepEqual(
    ownedQuiescence([before], () => ({ state: "present", record: reused })),
    { remainingPids: [], unresolvedPids: [], complete: true },
  );
  assert.equal(parseProcessIdentity("unknown process output"), null);
});
