import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses STUDIO_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { STUDIO_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when STUDIO_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { STUDIO_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { STUDIO_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("drops enables for features text generation keeps off", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs(
        "--enable plugins --enable=apps --enable connectors --enable hooks --enable=codex_hooks --enable web_search --disable plugins",
      ),
      ["--enable", "web_search", "--disable", "plugins"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });

  it("passes MCP server overrides through unchanged, so a server the user turned off stays off", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs(
        "-c mcp_servers.docs.enabled=false --config=mcp_servers.x.enabled=false --config model_verbosity=low",
      ),
      [
        "-c",
        "mcp_servers.docs.enabled=false",
        "--config=mcp_servers.x.enabled=false",
        "--config",
        "model_verbosity=low",
      ],
    );
  });
});
