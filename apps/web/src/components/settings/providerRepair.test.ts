import { describe, expect, it } from "vite-plus/test";

import { isVolatileCommandPath, providerRepairAdvice } from "./providerRepair";

describe("providerRepairAdvice", () => {
  it("leads with reinstall for a broken npm install", () => {
    const advice = providerRepairAdvice(
      "Codex stopped as it started (exit code 1): Error: Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex@latest.",
    );
    expect(advice.likely).toBe("reinstall");
    expect(advice.order).toEqual(["reinstall", "signIn", "pickBinary"]);
  });

  it("leads with sign in for an expired or missing sign-in", () => {
    expect(
      providerRepairAdvice("Codex app-server provider probe failed: token_expired.").likely,
    ).toBe("signIn");
    expect(
      providerRepairAdvice("Codex CLI is not authenticated. Run `codex login` and try again.")
        .likely,
    ).toBe("signIn");
    expect(providerRepairAdvice("HTTP 401 Unauthorized").likely).toBe("signIn");
  });

  it("leads with picking the command when it cannot be started", () => {
    expect(
      providerRepairAdvice(
        "Could not start Codex CLI (`/run/user/1000/fnm_multishells/1_2/bin/codex`). Make sure the configured executable exists and can be run.",
      ).likely,
    ).toBe("pickBinary");
    expect(providerRepairAdvice("spawn codex ENOENT").likely).toBe("pickBinary");
  });

  it("still offers every way out when the words say nothing useful", () => {
    const advice = providerRepairAdvice("Codex App Server process exited with code 1");
    expect(advice.likely).toBeNull();
    expect(advice.order).toEqual(["signIn", "reinstall", "pickBinary"]);
    expect(providerRepairAdvice(undefined).order).toHaveLength(3);
  });
});

describe("isVolatileCommandPath", () => {
  it("flags per-shell and temp folders only", () => {
    expect(
      isVolatileCommandPath("/run/user/1000/fnm_multishells/665561_1795096049920/bin/codex"),
    ).toBe(true);
    expect(
      isVolatileCommandPath("C:\\Users\\me\\AppData\\Local\\fnm_multishells\\1\\codex.cmd"),
    ).toBe(true);
    expect(isVolatileCommandPath("/tmp/x/codex")).toBe(true);
    expect(isVolatileCommandPath("/home/me/.local/share/fnm/aliases/default/bin/codex")).toBe(
      false,
    );
    expect(isVolatileCommandPath("/usr/local/bin/codex")).toBe(false);
    expect(isVolatileCommandPath(null)).toBe(false);
  });
});
