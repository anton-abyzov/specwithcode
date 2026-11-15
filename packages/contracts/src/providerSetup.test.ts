import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderAuthResponse, ProviderAuthState } from "./providerSetup.ts";

const decodeResponse = Schema.decodeUnknownSync(ProviderAuthResponse);
const decodeState = Schema.decodeUnknownSync(ProviderAuthState);

describe("provider credential responses", () => {
  it("accepts the advertised field limit and rejects oversized or invalid fields", () => {
    const values = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`field_${i}`, "value"]),
    );
    expect(decodeResponse({ type: "credentials", values })).toEqual({
      type: "credentials",
      values,
    });
    expect(() =>
      decodeResponse({ type: "credentials", values: { ...values, extra: "value" } }),
    ).toThrow();
    expect(() => decodeResponse({ type: "credentials", values: { "": "value" } })).toThrow();
    expect(() =>
      decodeResponse({ type: "credentials", values: { token: "x".repeat(16_385) } }),
    ).toThrow();
  });
});

describe("provider auth state", () => {
  it("drops auth variants from newer servers instead of rejecting the state", () => {
    const method = { id: "browser", name: "Browser", description: null, type: "agent" };
    expect(
      decodeState({
        instanceId: "cursor",
        phase: "waiting",
        flowId: null,
        authorizationUrl: null,
        expiresAt: null,
        message: null,
        methods: [method, { ...method, id: "passkey", type: "passkey" }],
        interaction: { type: "passkey", id: "passkey" },
        credentialOwner: "keychain",
      }),
    ).toEqual({
      instanceId: "cursor",
      phase: "waiting",
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: null,
      methods: [method],
    });
  });

  it("decodes only http and https sign-in links and drops the rest without failing the state", () => {
    const state = {
      instanceId: "cursor",
      phase: "waiting",
      flowId: "flow",
      authorizationUrl: null,
      expiresAt: null,
      message: null,
    };
    const script = "javascript:alert(document.domain)";
    expect(
      decodeState({
        ...state,
        interaction: { type: "browser", id: "b", url: script, requiresConsent: true },
      }),
    ).toEqual(state);
    expect(
      decodeState({
        ...state,
        interaction: { type: "deviceCode", id: "d", url: script, userCode: "ABCD" },
      }),
    ).toEqual(state);
    expect(
      decodeState({
        ...state,
        interaction: {
          type: "terminal",
          id: "t",
          output: "",
          deviceCode: { url: "data:text/html,<script>1</script>", userCode: "ABCD" },
        },
      }).interaction,
    ).toEqual({ type: "terminal", id: "t", output: "" });
    expect(decodeState({ ...state, authorizationUrl: script })).toEqual(state);
    expect(decodeState({ ...state, authorizationUrl: "file:///etc/passwd" })).toEqual(state);
    expect(
      decodeState({ ...state, authorizationUrl: "https://example.com/login" }).authorizationUrl,
    ).toBe("https://example.com/login");
    expect(
      decodeState({
        ...state,
        interaction: {
          type: "browser",
          id: "b",
          url: "http://127.0.0.1:4000/cb",
          requiresConsent: false,
        },
      }).interaction,
    ).toEqual({
      type: "browser",
      id: "b",
      url: "http://127.0.0.1:4000/cb",
      requiresConsent: false,
    });
  });
});
