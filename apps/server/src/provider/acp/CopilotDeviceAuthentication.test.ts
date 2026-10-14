import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AcpRegistrySettings } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HostProcessExecutablePath } from "@specweave-studio/shared/hostProcess";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import {
  copilotBrowserOverride,
  copilotDeviceLoginArgs,
  isCopilotDeviceLogin,
  readCopilotDeviceCode,
  supportsCopilotDeviceLogin,
} from "./CopilotDeviceAuthentication.ts";

const decode = Schema.decodeSync(AcpRegistrySettings);
const prompt =
  "To authenticate, visit https://github.com/login/device and enter code ABCD-1234\r\n";

describe("Copilot device authorization compatibility", () => {
  it("requires the exact registry identity and advertised method", () => {
    assert.isTrue(isCopilotDeviceLogin(decode({ agentId: "github-copilot-cli" }), "copilot-login"));
    assert.isFalse(isCopilotDeviceLogin(decode({ agentId: "other" }), "copilot-login"));
    assert.isFalse(isCopilotDeviceLogin(decode({ agentId: "github-copilot-cli" }), "browser"));
    assert.isFalse(
      isCopilotDeviceLogin(
        decode({ source: "local", commandPath: "/fake/copilot" }),
        "copilot-login",
      ),
    );
  });
  it("requires the verified version contract and an advertised device-code flag", () => {
    assert.isTrue(supportsCopilotDeviceLogin("1.0.95", "  --device-code  Use device flow\n"));
    assert.isTrue(supportsCopilotDeviceLogin("1.1.0", " --device-code \n"));
    for (const version of ["1.0.94", "0.99.100", "2.0.0", "unknown", "1.0.95-preview"])
      assert.isFalse(supportsCopilotDeviceLogin(version, " --device-code \n"));
    assert.isFalse(supportsCopilotDeviceLogin("1.0.95", " --web-flow \n"));
  });
  it("preserves host/profile/version arguments while replacing web flow", () => {
    assert.deepEqual(
      copilotDeviceLoginArgs([
        "--no-auto-update",
        "login",
        "--host",
        "company.ghe.com",
        "--web-flow",
      ]),
      ["--no-auto-update", "login", "--host", "company.ghe.com", "--device-code"],
    );
    assert.deepEqual(copilotDeviceLoginArgs(["login", "--device-code"]), [
      "login",
      "--device-code",
    ]);
    assert.isUndefined(copilotDeviceLoginArgs(["--acp", "login"]));
    assert.isUndefined(copilotDeviceLoginArgs(["login", "login"]));
    assert.isUndefined(copilotDeviceLoginArgs(["--help"]));
  });
  it.effect(
    "runs the native browser argv override as a real harmless child, not a shell command",
    () =>
      Effect.gen(function* () {
        const node = yield* HostProcessExecutablePath;
        const [command, ...args] = JSON.parse(copilotBrowserOverride(node)) as string[];
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(
            command!,
            [...args, "https://example.invalid/device?literal=$(exit%201)"],
            { env: { ELECTRON_RUN_AS_NODE: "1" }, shell: false, forceKillAfter: "1 second" },
          ),
        );
        const [exit, stdout, stderr] = yield* Effect.all(
          [
            child.exitCode,
            collectUint8StreamText({ stream: child.stdout, maxBytes: 1024 }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: 1024 }),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(Number(exit), 0);
        assert.strictEqual(stdout.text, "");
        assert.strictEqual(stderr.text, "");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("owned Copilot terminal output", () => {
  it("recognizes complete prompts across chunks and terminal escape sequences", () => {
    assert.isUndefined(readCopilotDeviceCode(prompt.slice(0, -4), ["login"]));
    assert.deepEqual(
      readCopilotDeviceCode(`\u001b[32m${prompt}\u001b[0mWaiting for authorization...`, ["login"]),
      { url: "https://github.com/login/device", userCode: "ABCD-1234" },
    );
    assert.deepEqual(
      readCopilotDeviceCode(
        prompt.replace(
          "https://github.com/login/device",
          "\u001b]8;;https://github.com/login/device\u0007https://github.com/login/device\u001b]8;;\u0007",
        ),
        ["login"],
      ),
      { url: "https://github.com/login/device", userCode: "ABCD-1234" },
    );
  });
  it("uses only the explicitly configured GitHub enterprise host", () => {
    const enterprise = prompt.replace("github.com", "company.ghe.com");
    assert.isUndefined(readCopilotDeviceCode(enterprise, ["login"]));
    assert.strictEqual(
      readCopilotDeviceCode(enterprise, ["login", "--host", "company.ghe.com"])?.url,
      "https://company.ghe.com/login/device",
    );
    assert.strictEqual(
      readCopilotDeviceCode(enterprise, ["login", "--host=https://company.ghe.com"])?.url,
      "https://company.ghe.com/login/device",
    );
  });
  it("rejects deceptive URLs, embedded credentials, query tokens and malformed codes", () => {
    for (const url of [
      "http://github.com/login/device",
      "https://github.com.evil.invalid/login/device",
      "https://user@github.com/login/device",
      "https://github.com:8443/login/device",
      "https://github.com/login/device?token=secret",
      "https://github.com/login/device#fragment",
      "https://github.com/login/oauth",
    ])
      assert.isUndefined(
        readCopilotDeviceCode(prompt.replace("https://github.com/login/device", url), ["login"]),
      );
    for (const code of ["ABCD-12345", "abcd-1234", "ABCD", "ABCD-1234 extra"])
      assert.isUndefined(readCopilotDeviceCode(prompt.replace("ABCD-1234", code), ["login"]));
    assert.isUndefined(
      readCopilotDeviceCode("A response mentioned ABCD-1234 at https://github.com/login/device", [
        "login",
      ]),
    );
  });
});
