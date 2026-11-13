import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  CopilotProbeError,
  copilotEnterpriseHost,
  findCopilotExistingSignIns,
  isCopilotExtensionFolder,
  parseGhAuthStatus,
  vscodeExtensionDirectories,
  type CopilotExistingSignInsProbe,
} from "./copilotExistingSignIns.ts";

const join = (...segments: ReadonlyArray<string>) => segments.join("/");

const NEW_WORDING = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo'

  ✓ Logged in to github.com account octo-work (keyring)
  - Active account: false

aaby.ghe.com
  ✓ Logged in to aaby.ghe.com account anton_aaby (GH_ENTERPRISE_TOKEN)
  - Active account: true

ghes.example.com
  X Failed to log in to ghes.example.com account broken (keyring)
  - The token in keyring is invalid.
`;

const OLD_WORDING = `github.com
  ✓ Logged in to github.com as octocat (/home/dev/.config/gh/hosts.yml)
  ✓ Git operations for github.com configured to use https protocol.
  ✓ Token: *******************
ghes.corp.example
  ✓ Logged in to GHES.corp.example as jdoe (oauth_token)
`;

describe("gh auth status parsing", () => {
  it("reads hosts and accounts in the current gh wording and skips failed sign-ins", () => {
    assert.deepEqual(parseGhAuthStatus(NEW_WORDING), [
      { host: "github.com", account: "octocat" },
      { host: "github.com", account: "octo-work" },
      { host: "aaby.ghe.com", account: "anton_aaby" },
    ]);
  });
  it("reads the older 'Logged in to HOST as NAME' wording and lowercases hosts", () => {
    assert.deepEqual(parseGhAuthStatus(OLD_WORDING), [
      { host: "github.com", account: "octocat" },
      { host: "ghes.corp.example", account: "jdoe" },
    ]);
  });
  it("ignores colour codes, duplicates and anything that is not a sign-in line", () => {
    assert.deepEqual(
      parseGhAuthStatus(
        "\u001b[32m✓\u001b[0m Logged in to github.com account a (keyring)\n" +
          "✓ Logged in to github.com account a (keyring)\n" +
          "You are not logged into any GitHub hosts. To log in, run: gh auth login\n" +
          "Logged in to ../etc account x\n",
      ),
      [{ host: "github.com", account: "a" }],
    );
    assert.deepEqual(parseGhAuthStatus(""), []);
  });
  it("picks a host only when gh is signed in to one enterprise host and nothing else", () => {
    // Signed in to github.com as well: the Copilot seat may be on either.
    assert.isUndefined(copilotEnterpriseHost(parseGhAuthStatus(NEW_WORDING)));
    assert.strictEqual(
      copilotEnterpriseHost([{ host: "aaby.ghe.com", account: "anton_aaby" }]),
      "aaby.ghe.com",
    );
    assert.isUndefined(copilotEnterpriseHost([{ host: "github.com", account: "a" }]));
    assert.isUndefined(
      copilotEnterpriseHost([
        { host: "a.ghe.com", account: "a" },
        { host: "b.ghe.com", account: "b" },
      ]),
    );
    assert.strictEqual(
      copilotEnterpriseHost([
        { host: "a.ghe.com", account: "a" },
        { host: "a.ghe.com", account: "b" },
      ]),
      "a.ghe.com",
    );
  });
});

describe("VS Code Copilot extension", () => {
  it("checks stable and Insiders extension folders under HOME or USERPROFILE", () => {
    assert.deepEqual(vscodeExtensionDirectories({ HOME: "/home/dev" }, join), [
      "/home/dev/.vscode/extensions",
      "/home/dev/.vscode-insiders/extensions",
    ]);
    assert.deepEqual(vscodeExtensionDirectories({ USERPROFILE: "C:\\Users\\dev" }, join), [
      "C:\\Users\\dev/.vscode/extensions",
      "C:\\Users\\dev/.vscode-insiders/extensions",
    ]);
    assert.deepEqual(vscodeExtensionDirectories({}, join), []);
  });
  it("recognizes Copilot and Copilot Chat folders only", () => {
    assert.isTrue(isCopilotExtensionFolder("github.copilot-1.250.0"));
    assert.isTrue(isCopilotExtensionFolder("github.copilot-chat-0.30.1"));
    assert.isTrue(isCopilotExtensionFolder("GitHub.copilot-chat-0.30.1-win32-x64"));
    assert.isFalse(isCopilotExtensionFolder("github.copilot-labs"));
    assert.isFalse(isCopilotExtensionFolder("github.vscode-pull-request-github-0.100.0"));
    assert.isFalse(isCopilotExtensionFolder("ms-python.python-2025.1.0"));
  });
});

const probe = (
  overrides: Partial<CopilotExistingSignInsProbe>,
  calls: Array<{ command: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv }> = [],
): CopilotExistingSignInsProbe => ({
  environment: { HOME: "/home/dev", PATH: "/bin" },
  join,
  readDirectory: () => Effect.succeed([]),
  exec: (command, args, env) =>
    Effect.sync(() => {
      calls.push({ command, args, env });
      return "";
    }),
  ...overrides,
});

describe("findCopilotExistingSignIns", () => {
  it.effect("runs plain gh auth status without prompts or colour and finds VS Code Copilot", () =>
    Effect.gen(function* () {
      const calls: Array<{ command: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv }> =
        [];
      const found = yield* findCopilotExistingSignIns(
        probe(
          {
            readDirectory: (directory) =>
              Effect.succeed(
                directory === "/home/dev/.vscode-insiders/extensions"
                  ? ["ms-python.python-1.0.0", "github.copilot-chat-0.30.1"]
                  : [],
              ),
            exec: (command, args, env) =>
              Effect.sync(() => {
                calls.push({ command, args, env });
                return NEW_WORDING;
              }),
          },
          calls,
        ),
      );
      assert.isTrue(found.vscodeCopilot);
      assert.strictEqual(found.ghAccounts.length, 3);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]!.command, "gh");
      assert.deepEqual(calls[0]!.args, ["auth", "status"]);
      assert.notInclude(calls[0]!.args.join(" "), "token");
      assert.strictEqual(calls[0]!.env.GH_PROMPT_DISABLED, "1");
      assert.strictEqual(calls[0]!.env.NO_COLOR, "1");
      assert.strictEqual(calls[0]!.env.PATH, "/bin");
    }),
  );
  it.effect("treats a missing gh, a failing gh and unreadable folders as nothing found", () =>
    Effect.gen(function* () {
      const found = yield* findCopilotExistingSignIns(
        probe({
          readDirectory: () => Effect.fail(new CopilotProbeError({ cause: "ENOENT" })),
          exec: () => Effect.fail(new CopilotProbeError({ cause: "spawn gh ENOENT" })),
        }),
      );
      assert.deepEqual(found, { vscodeCopilot: false, ghAccounts: [] });
    }),
  );
  it.effect("gives up on gh after 10 seconds", () =>
    Effect.gen(function* () {
      const fiber = yield* findCopilotExistingSignIns(probe({ exec: () => Effect.never })).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 seconds");
      const found = yield* Fiber.join(fiber);
      assert.deepEqual(found.ghAccounts, []);
    }),
  );
});
