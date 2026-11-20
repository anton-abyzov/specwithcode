import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderModel } from "@specweave-studio/contracts";

import { museCatalogDownloadArgs, museCliAccount, museReadiness } from "./MuseAccount.ts";

/** `muse usage --json` as muse 1.4.20 prints it for a signed-in subscription. */
const SIGNED_IN_1_4_20 = JSON.stringify({
  schemaVersion: 1,
  allowance: {
    tier: "Muse Code Max Usage",
    window: { usedPercent: 1, resetsAtMs: 1794866434000 },
    weekly: { usedPercent: 5, resetsAtMs: 1795392000000 },
    asOfMs: 1794849529792,
    source: "mint",
  },
  reason: null,
  hint: null,
});
/** The same command on a machine that is not signed in: exit 1, nothing on stdout. */
const SIGNED_OUT_1_4_20 = {
  exitCode: 1,
  stdout: "",
  stderr: "muse usage: not logged in: run `muse login` first\n",
};

const model = (slug: string): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: { optionDescriptors: [] },
});

describe("museCliAccount", () => {
  it("reads the plan and its allowance from muse 1.4.20", () => {
    const account = museCliAccount({ exitCode: 0, stdout: SIGNED_IN_1_4_20, stderr: "" }, 5);
    expect(account).toMatchObject({ signedIn: true, plan: "Muse Code Max Usage" });
    expect(account?.limits).toMatchObject({
      checkedAt: "2026-11-16T17:18:49.792Z",
      ordinaryUsageAllowed: true,
      windows: [
        { id: "window", kind: "session", usedPercent: 1 },
        { id: "weekly", kind: "weekly", usedPercent: 5 },
      ],
    });
  });

  it("still reads the shapes earlier versions printed", () => {
    const usage = {
      observedAtMs: 1700000000000,
      tier: "maximum",
      window: { usedPercent: 0, resetsAtMs: 1700000010000 },
      weekly: { usedPercent: 2, resetsAtMs: 1700000100000 },
    };
    for (const stdout of [JSON.stringify({ usage }), JSON.stringify(usage)]) {
      const account = museCliAccount({ exitCode: 0, stdout, stderr: "" }, 5);
      expect(account).toMatchObject({ signedIn: true, plan: "maximum" });
      expect(account?.limits?.windows).toHaveLength(2);
    }
  });

  it("is signed in without a plan when the account has no allowance to show", () => {
    const stdout = JSON.stringify({ schemaVersion: 1, allowance: null, reason: "no_plan" });
    expect(museCliAccount({ exitCode: 0, stdout, stderr: "" }, 5)).toEqual({ signedIn: true });
  });

  it("says signed out only when the command line says so", () => {
    expect(museCliAccount(SIGNED_OUT_1_4_20, 5)).toEqual({ signedIn: false });
    // A failure that is not about the sign-in says nothing either way.
    const offline = { exitCode: 1, stdout: "", stderr: "muse usage: network unreachable\n" };
    expect(museCliAccount(offline, 5)).toBeUndefined();
    expect(museCliAccount({ exitCode: 0, stdout: "usage: 5%", stderr: "" }, 5)).toBeUndefined();
    expect(museCliAccount({ exitCode: 0, stdout: "{}", stderr: "" }, 5)).toBeUndefined();
  });
});

describe("museReadiness", () => {
  const signedIn = museCliAccount({ exitCode: 0, stdout: SIGNED_IN_1_4_20, stderr: "" }, 5);

  it("is signed in with its plan when the host has no model list yet", () => {
    // A machine where Muse Code was just installed: the host lists nothing, the account answers.
    const row = museReadiness({
      models: [],
      limits: signedIn?.limits,
      account: signedIn,
      apiKey: false,
    });
    expect(row.auth).toEqual({
      status: "authenticated",
      type: "subscription",
      label: "Muse Code Max Usage",
    });
    expect(row.status).toBe("warning");
    expect(row.message).toBe(
      "Signed in to Muse Code, but its model list is not on this machine yet. Choose Check again to download it.",
    );
  });

  it("is ready with its plan once the models are listed", () => {
    const row = museReadiness({
      models: [model("muse-wonder-1.0")],
      limits: signedIn?.limits,
      account: signedIn,
      apiKey: false,
    });
    expect(row).toMatchObject({
      status: "ready",
      auth: { status: "authenticated", label: "Muse Code Max Usage" },
    });
  });

  it("is signed out when the command line says so, whatever list is still cached", () => {
    for (const models of [[], [model("muse-wonder-1.0")]]) {
      const row = museReadiness({
        models,
        limits: undefined,
        account: { signedIn: false },
        apiKey: false,
      });
      expect(row).toEqual({
        status: "error",
        auth: { status: "unauthenticated", type: "subscription" },
        message: "Muse Code is not signed in. Run `muse login` in a terminal on this machine.",
      });
    }
  });

  it("does not guess when neither the host nor the command line answered", () => {
    const row = museReadiness({ models: [], limits: undefined, account: undefined, apiKey: false });
    expect(row.auth).toEqual({ status: "unknown", type: "subscription" });
    expect(row.status).toBe("warning");
    expect(row.message).not.toMatch(/refresh/i);
  });

  it("keeps an API key on its own route, with no plan", () => {
    const row = museReadiness({
      models: [model("muse-spark-1.3")],
      limits: undefined,
      account: undefined,
      apiKey: true,
    });
    expect(row.auth).toEqual({ status: "authenticated", type: "api_key" });
  });
});

describe("museCatalogDownloadArgs", () => {
  it("asks for a model no account has, so no turn runs", () => {
    expect(museCatalogDownloadArgs.slice(0, 3)).toEqual([
      "exec",
      "--model",
      "specwithcode-model-list",
    ]);
  });
});
