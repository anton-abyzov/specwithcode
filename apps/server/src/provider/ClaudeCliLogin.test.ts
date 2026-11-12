// @effect-diagnostics nodeBuiltinImport:off - fake CLIs are written into a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderSetupError,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { writeFakeCli } from "../testUtils/fakeCli.ts";
import {
  makeClaudeCliAuth,
  readClaudeLoginCode,
  readClaudeLoginEnd,
  readClaudeLoginLink,
  runClaudeCliLogin,
  runClaudeCliLogout,
} from "./ClaudeCliLogin.ts";

const LINK =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile&code_challenge=xyz&state=STATE1";
const PRINTED = `Opening browser to sign in…\nIf the browser didn't open, visit: ${LINK}\nPaste code here if prompted > `;

describe("reading what the sign-in command prints", () => {
  it("finds the link by its shape", () => {
    assert.equal(readClaudeLoginLink(PRINTED), LINK);
    assert.equal(readClaudeLoginLink(`Öffne ${LINK} im Browser`), LINK);
    // Colour codes and a terminal hyperlink around it.
    assert.equal(
      readClaudeLoginLink(
        `\u001b[2mvisit:\u001b[0m \u001b]8;;${LINK}\u0007${LINK}\u001b]8;;\u0007\n`,
      ),
      LINK,
    );
    assert.isUndefined(readClaudeLoginLink("Opening browser to sign in…\n"));
    assert.isUndefined(readClaudeLoginLink("See https://claude.com/docs for help"));
    // Half a link, as a chunk may end: no state yet.
    assert.isUndefined(readClaudeLoginLink(PRINTED.slice(0, PRINTED.indexOf("&scope"))));
  });

  it("takes a pasted code, or the address of the page that shows it", () => {
    assert.equal(readClaudeLoginCode("  abc123#STATE1 \n"), "abc123#STATE1");
    assert.equal(
      readClaudeLoginCode(
        "https://platform.claude.com/oauth/code/callback?code=abc123&state=STATE1",
      ),
      "abc123#STATE1",
    );
    assert.isUndefined(readClaudeLoginCode("abc123"));
    assert.isUndefined(readClaudeLoginCode("abc123#"));
    assert.isUndefined(readClaudeLoginCode("abc 123#STATE1"));
    assert.isUndefined(readClaudeLoginCode("https://platform.claude.com/oauth/code/callback"));
    assert.isUndefined(readClaudeLoginCode(""));
  });

  it("judges the end by what was printed, not by the exit code alone", () => {
    assert.deepEqual(readClaudeLoginEnd(`${PRINTED}\nLogin successful.\n`, 0), { signedIn: true });
    // Interrupted: exit code 0 and no success line.
    const interrupted = readClaudeLoginEnd(PRINTED, 0);
    assert.isFalse(interrupted.signedIn);
    const refused = readClaudeLoginEnd(
      `${PRINTED}Login failed: That code wasn't accepted. Sign in again to get a new code.\n`,
      1,
    );
    assert.deepEqual(refused, {
      signedIn: false,
      detail:
        "Claude did not accept the sign-in. Start again to get a new page. Claude Code said: That code wasn't accepted. Sign in again to get a new code.",
    });
    // A success line with a failing exit code is not a sign-in.
    assert.isFalse(readClaudeLoginEnd("Login successful.\n", 1).signedIn);
    // It never ran at all.
    assert.deepEqual(readClaudeLoginEnd("", undefined), {
      signedIn: false,
      detail: "Could not start Claude Code's sign-in. Check that Claude Code is installed.",
    });
  });
});

/**
 * A stand-in for `claude auth login` that behaves as the recorded command
 * does: it prints the link, then reads `code#state` lines from stdin.
 */
const fakeClaude = (mode: "normal" | "silent" | "early-exit" | "no-sign-out" = "normal") => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-login-"));
  const record = NodePath.join(directory, "record.json");
  const command = writeFakeCli({
    directory,
    name: "claude",
    env: { FAKE_MODE: mode, FAKE_RECORD: record },
    source: `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.join(" ") === "auth logout") {
  if (process.env.FAKE_MODE === "no-sign-out") process.exit(1);
  writeFileSync(process.env.FAKE_RECORD + ".out", "signed out");
  process.exit(0);
}
if (args.join(" ") !== "auth login") process.exit(2);
writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ pid: process.pid, browser: process.env.BROWSER ?? null }));
if (process.env.FAKE_MODE === "early-exit") { console.error("Login failed: no network"); process.exit(1); }
if (process.env.FAKE_MODE === "silent") setInterval(() => {}, 1000);
else {
  process.stdout.write(${JSON.stringify(PRINTED)});
  createInterface({ input: process.stdin }).on("line", (line) => {
    const [code, state] = line.trim().split("#");
    if (!code || !state) { console.error("Invalid code. Please make sure the full code was copied."); return; }
    if (code === "good" && state === "STATE1") { console.log("Login successful."); process.exit(0); }
    console.error("Login failed: That code wasn't accepted.");
    process.exit(1);
  });
}
`,
  });
  const read = () =>
    JSON.parse(NodeFS.readFileSync(record, "utf8")) as { pid: number; browser: string | null };
  const signedOut = () => NodeFS.existsSync(`${record}.out`);
  return { command, read, signedOut };
};

const instanceId = ProviderInstanceId.make("claude-work");

interface Shown {
  readonly link: string;
  readonly sendCode: (pasted: string) => Effect.Effect<void, ProviderSetupError>;
}

/** Starts the sign-in on its own fiber and waits for the link it shows. */
const start = (command: string, openBrowserHere = true) =>
  Effect.gen(function* () {
    const shown = yield* Deferred.make<Shown>();
    const fiber = yield* runClaudeCliLogin({
      instanceId,
      binaryPath: command,
      environment: process.env,
      openBrowserHere,
      onLink: (link, sendCode) => Deferred.succeed(shown, { link, sendCode }).pipe(Effect.asVoid),
    }).pipe(Effect.scoped, Effect.forkScoped);
    return { fiber, shown: Deferred.await(shown) };
  });

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("running the sign-in command", () => {
  it.live("shows the link, passes the pasted code on, and ends signed in", () =>
    Effect.gen(function* () {
      const claude = fakeClaude();
      const login = yield* start(claude.command);
      const { link, sendCode } = yield* login.shown;
      assert.equal(link, LINK);
      // With the person's browser on this machine the command opens the page itself.
      assert.isNull(claude.read().browser);

      // A code that is not whole is refused here and the sign-in goes on.
      const refused = yield* sendCode("good").pipe(Effect.flip);
      assert.equal(refused.operation, "complete");
      assert.include(refused.detail, "not the whole code");

      yield* sendCode(" good#STATE1 ");
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(login.fiber)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports a code Claude refuses, in one sentence", () =>
    Effect.gen(function* () {
      const login = yield* start(fakeClaude().command);
      const { sendCode } = yield* login.shown;
      yield* sendCode("bad#STATE1");
      const error = yield* Fiber.join(login.fiber).pipe(Effect.flip);
      assert.equal(
        error.detail,
        "Claude did not accept the sign-in. Start again to get a new page. Claude Code said: That code wasn't accepted.",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("opens no browser here when the person is on another device", () =>
    Effect.gen(function* () {
      const claude = fakeClaude();
      const login = yield* start(claude.command, false);
      yield* login.shown;
      const browser = claude.read().browser;
      assert.isString(browser);
      // One program's path, as the command needs it: no arguments, and it exists.
      assert.isTrue(NodeFS.existsSync(browser!));
      yield* Fiber.interrupt(login.fiber);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops the command when the sign-in is cancelled", () =>
    Effect.gen(function* () {
      const claude = fakeClaude();
      const login = yield* start(claude.command);
      yield* login.shown;
      const { pid } = claude.read();
      assert.isTrue(isRunning(pid));
      yield* Fiber.interrupt(login.fiber);
      yield* Effect.sync(() => isRunning(pid)).pipe(
        Effect.repeat({ until: (running) => !running, schedule: Schedule.spaced("50 millis") }),
        Effect.timeout("10 seconds"),
      );
      assert.isFalse(isRunning(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("says so when the command ends before it shows a link", () =>
    Effect.gen(function* () {
      const error = yield* runClaudeCliLogin({
        instanceId,
        binaryPath: fakeClaude("early-exit").command,
        environment: process.env,
        openBrowserHere: true,
        onLink: () => Effect.void,
      }).pipe(Effect.scoped, Effect.flip);
      assert.include(error.detail, "Claude Code said: no network");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("gives up on a command that never shows a link", () =>
    Effect.gen(function* () {
      const claude = fakeClaude("silent");
      const error = yield* runClaudeCliLogin({
        instanceId,
        binaryPath: claude.command,
        environment: process.env,
        openBrowserHere: true,
        onLink: () => Effect.void,
        linkLimit: "1 second",
      }).pipe(Effect.scoped, Effect.flip);
      assert.include(error.detail, "did not show its sign-in page");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails with a plain sentence when Claude Code is not installed", () =>
    Effect.gen(function* () {
      const error = yield* runClaudeCliLogin({
        instanceId,
        binaryPath: NodePath.join(NodeOS.tmpdir(), "no-such-claude-command"),
        environment: process.env,
        openBrowserHere: true,
        onLink: () => Effect.void,
        linkLimit: "5 seconds",
      }).pipe(Effect.scoped, Effect.flip);
      assert.equal(
        error.detail,
        "Could not start Claude Code's sign-in. Check that Claude Code is installed.",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("the sign-in the app offers for a Claude instance", () => {
  const account = (status: ServerProvider["auth"]["status"]) =>
    ({ auth: { status } }) as ServerProvider;

  const controllerFor = (command: string, read: () => ServerProvider) =>
    Effect.gen(function* () {
      let checks = 0;
      const controller = yield* makeClaudeCliAuth({
        instanceId,
        binaryPath: command,
        environment: process.env,
        configDir: "/synthetic/.claude-work",
        checkAccount: Effect.sync(() => {
          checks += 1;
          return read();
        }),
      });
      const phase = (wanted: ProviderAuthState["phase"]) =>
        controller.subscribe("owner").pipe(
          Stream.filter((state) => state.phase === wanted),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
      return { controller, phase, checks: () => checks };
    });

  it.live("shows the link, takes the code and checks the account past the cache", () =>
    Effect.gen(function* () {
      const claude = fakeClaude();
      const { controller, phase, checks } = yield* controllerFor(claude.command, () =>
        account("authenticated"),
      );
      assert.deepEqual(controller.credentialBinding, {
        owner: "provider",
        key: "claude:/synthetic/.claude-work",
      });
      const started = yield* controller.start("owner", Effect.void, undefined, undefined, "client");
      const waiting = yield* phase("waiting");
      assert.deepEqual(waiting.interaction, {
        type: "browser",
        id: "claude-sign-in",
        url: LINK,
        requiresConsent: false,
        acceptsCallback: true,
      });
      // The person is on another device: no browser was opened on this machine.
      assert.isString(claude.read().browser);

      const refused = yield* controller
        .complete("owner", { flowId: started.flowId!, callbackUrl: "good" })
        .pipe(Effect.flip);
      assert.include(refused.detail, "not the whole code");
      // Another client cannot finish this sign-in.
      assert.isTrue(
        Exit.isFailure(
          yield* controller
            .complete("other", { flowId: started.flowId!, callbackUrl: "good#STATE1" })
            .pipe(Effect.exit),
        ),
      );
      assert.equal(checks(), 0);

      yield* controller.complete("owner", { flowId: started.flowId!, callbackUrl: "good#STATE1" });
      const done = yield* phase("succeeded");
      assert.isNull(done.interaction);
      assert.equal(checks(), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("opens the browser on this machine only when the client says the person is there", () =>
    Effect.gen(function* () {
      const claude = fakeClaude();
      const { controller, phase } = yield* controllerFor(claude.command, () =>
        account("authenticated"),
      );
      const started = yield* controller.start("owner", Effect.void, undefined, undefined, "server");
      yield* phase("waiting");
      assert.isNull(claude.read().browser);
      const { pid } = claude.read();
      const cancelled = yield* controller.cancel("owner", started.flowId!);
      assert.equal(cancelled.phase, "cancelled");
      yield* Effect.sync(() => isRunning(pid)).pipe(
        Effect.repeat({ until: (running) => !running, schedule: Schedule.spaced("50 millis") }),
        Effect.timeout("10 seconds"),
      );
      assert.isFalse(isRunning(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails with a reason when the account still reads signed out", () =>
    Effect.gen(function* () {
      const { controller, phase } = yield* controllerFor(fakeClaude().command, () =>
        account("unauthenticated"),
      );
      const started = yield* controller.start("owner", Effect.void, undefined, undefined, "client");
      yield* phase("waiting");
      yield* controller.complete("owner", { flowId: started.flowId!, callbackUrl: "good#STATE1" });
      const failed = yield* phase("failed");
      assert.equal(
        failed.message,
        "Claude Code finished its sign-in but still reports signed out. Try again.",
      );
      // Try again starts a new sign-in.
      const again = yield* controller.start("owner", Effect.void, undefined, undefined, "client");
      assert.notEqual(again.flowId, started.flowId);
      yield* phase("waiting");
      yield* controller.cancel("owner", again.flowId!);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("signs out with Claude Code's own command and reads the account again", () =>
    Effect.gen(function* () {
      const claude = fakeClaude();
      const { controller, checks } = yield* controllerFor(claude.command, () =>
        account("unauthenticated"),
      );
      const state = yield* controller.logout(Effect.void);
      assert.equal(state.phase, "idle");
      assert.isTrue(claude.signedOut());
      assert.equal(checks(), 1);

      const error = yield* runClaudeCliLogout({
        instanceId,
        binaryPath: fakeClaude("no-sign-out").command,
        environment: process.env,
      }).pipe(Effect.flip);
      assert.equal(error.detail, "Claude Code could not sign out. Try again.");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
