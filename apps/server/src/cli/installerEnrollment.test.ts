// @effect-diagnostics nodeBuiltinImport:off - Exercises the shell-to-parser boundary without installing.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@specweave-studio/shared/Net";
import { EnvironmentId } from "@specweave-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

vi.mock("./pair.ts", async (original) => ({
  ...(await original<typeof import("./pair.ts")>()),
  // Stop immediately after parsing, before filesystem, auth, sign-in or network access.
  discoverPairTarget: () => Effect.fail("installer-parser-boundary"),
}));

import { cli } from "../binCli.ts";

const installer = NodeFS.readFileSync(
  new URL("../../../../scripts/install.sh", import.meta.url),
  "utf8",
);
const blankIds = [
  "",
  " ",
  "\t\r\n",
  "\u00a0",
  "\u1680",
  ...Array.from({ length: 11 }, (_, index) => String.fromCharCode(0x2000 + index)),
  "\u2028\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
];
// Windows caps a command line at 32,767 characters and the installer alone is longer, so the
// contract runs from a script file rather than through `bash -c`.
const runInstallerContract = (
  overrides: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "installer-contract-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(scratch, "installer-contract.sh"),
      `${installer.replace(/main "\$@"\s*$/, "")}\n${overrides}\n`,
    );
    const result = NodeChildProcess.spawnSync("bash", ["installer-contract.sh", ...args], {
      cwd: scratch,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: "/nonexistent-installer-contract-home", ...env },
    });
    expect(result.error).toBeUndefined();
    return result;
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
};
const parse = (args: ReadonlyArray<string>) =>
  Effect.exit(Command.runWith(cli, { version: "synthetic" })(args)).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

const installerArgs = (coordinator: string): string[] => {
  const invocation = installer.match(/if "\$@" (fleet invite[^>]+)>/);
  expect(invocation).not.toBeNull();
  // Let the shell evaluate the real invocation's quoting, including whitespace in the ID.
  return NodeChildProcess.execFileSync(
    "bash",
    [
      "-c",
      `coordinator="$1"; capture() { printf '%s\\0' "$@"; }; capture ${invocation![1]}`,
      "installer-contract",
      coordinator,
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .slice(0, -1);
};

it.effect(
  "forwards the explicitly approved coordinator from the real installer invocation to the real parser",
  () =>
    Effect.gen(function* () {
      for (const id of ["main-environment", "  approved main environment  ", "é環境", "\u0085"]) {
        const args = installerArgs(id);
        expect(args).toEqual(["fleet", "invite", "--coordinator", id]);
        expect(yield* Schema.decodeUnknownEffect(EnvironmentId)(id)).toBe(id.trim());
        expect(JSON.stringify(yield* parse(args))).toContain("installer-parser-boundary");
        const withoutCoordinator = args.slice(0, args.indexOf("--coordinator"));
        const missing = JSON.stringify(yield* parse(withoutCoordinator));
        expect(missing).toContain("MissingOption");
        expect(missing).toContain("coordinator");
        expect(missing).not.toContain("installer-parser-boundary");
      }
    }),
);

it.effect("rejects blank coordinator IDs at the real parser boundary", () =>
  Effect.gen(function* () {
    for (const id of blankIds) {
      expect((yield* Effect.exit(Schema.decodeUnknownEffect(EnvironmentId)(id)))._tag).toBe(
        "Failure",
      );
      const result = JSON.stringify(yield* parse(installerArgs(id)));
      expect(result).not.toContain("installer-parser-boundary");
      expect(result).toContain("ShowHelp");
    }
  }),
);

it("requires explicit approval before any installer work and uses the same nonblank ID shape", () => {
  for (const args of [["--join"], ...blankIds.map((id) => ["--join", "--coordinator", id])]) {
    const result = runInstallerContract(`setup_output() { exit 91; }\nmain "$@"`, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--coordinator");
    expect(result.stderr).toContain("Settings > Connections on your main machine");
  }
  const valid = runInstallerContract(
    "setup_output() { exit 91; }\nmain --join --coordinator ' approved main environment '",
    [],
  );
  expect(valid.status).toBe(91);
});

it("prints a shell-safe retry command with the approved coordinator when invitation creation fails", () => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "installer-enrollment-"));
  try {
    const result = runInstallerContract(
      `setup_output() {
  scratch="$TEST_SCRATCH"
  step() { :; }
  clear_line() { :; }
  denied() { return 1; }
  run_invite 1 denied
}
main "$@"`,
      ["--join", "--coordinator", "approved main's environment"],
      { TEST_SCRATCH: scratch },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `then run \`'/nonexistent-installer-contract-home/.local/bin/specwithcode' fleet invite --coordinator 'approved main'\\''s environment'\``,
    );
    expect(result.stderr).toContain("Settings > Connections on your main machine");
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
});
