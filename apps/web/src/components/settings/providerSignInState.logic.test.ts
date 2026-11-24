import type { ProviderAuthState, ServerProvider } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProviderSignInState } from "./providerSignInState.logic";

const provider = (
  status: ServerProvider["auth"]["status"],
  installed = true,
): Pick<ServerProvider, "installed" | "auth"> => ({ installed, auth: { status } });
const auth = (phase: ProviderAuthState["phase"], patch: Partial<ProviderAuthState> = {}) =>
  ({
    instanceId: "gemini",
    phase,
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    ...patch,
  }) as ProviderAuthState;
const resolve = (
  p: Pick<ServerProvider, "installed" | "auth"> | undefined,
  a: ProviderAuthState | null,
  queryError: string | null = null,
) => resolveProviderSignInState({ provider: p, auth: a, queryError });

describe("provider sign-in state", () => {
  it("is ready only when the provider verified the sign-in", () => {
    expect(resolve(provider("authenticated"), auth("idle")).kind).toBe("ready");
    expect(resolve(provider("unknown"), auth("succeeded")).kind).toBe("ready");
    // Installed, or a finished browser page with nothing verified, is not ready.
    expect(resolve(provider("unknown"), auth("idle"))).toMatchObject({
      kind: "installed",
      signedIn: false,
      signedOut: false,
    });
    expect(resolve(provider("unauthenticated"), auth("succeeded"))).toMatchObject({
      kind: "installed",
      signedIn: false,
      signedOut: true,
    });
  });

  it("drops an earlier failure once a sign-in is verified", () => {
    const failed = auth("failed", { message: "Gemini CLI did not accept the sign-in: no project" });
    expect(resolve(provider("unknown"), failed)).toMatchObject({
      kind: "failed",
      failureMessage: "Gemini CLI did not accept the sign-in: no project",
      retryable: true,
    });
    expect(resolve(provider("authenticated"), failed)).toMatchObject({
      kind: "ready",
      signedIn: true,
      failureMessage: null,
      retryable: true,
    });
  });

  it("keeps checking and waiting apart from every settled state", () => {
    expect(resolve(provider("unknown"), auth("starting")).kind).toBe("checking");
    expect(resolve(provider("unknown"), auth("verifying")).kind).toBe("checking");
    expect(resolve(provider("authenticated"), auth("waiting"))).toMatchObject({
      kind: "waiting",
      active: true,
    });
  });

  it("calls an unread state unknown, never missing", () => {
    expect(resolve(undefined, null).kind).toBe("unknown");
    expect(resolve(provider("unknown", false), null, "m3 is not connected").kind).toBe("unknown");
    expect(resolve(provider("unknown", false), auth("idle")).kind).toBe("notInstalled");
    // A failed attempt on a missing program is still not installed.
    expect(resolve(provider("unknown", false), auth("failed"))).toMatchObject({
      kind: "failed",
      installed: false,
    });
    expect(resolve(provider("unknown"), auth("failed")).installed).toBe(true);
    expect(resolve(provider("unknown"), null, "offline").installed).toBe(false);
  });

  it("offers a plain retry unless the server says only setup can help", () => {
    expect(resolve(provider("unknown"), auth("failed", { retryable: false })).retryable).toBe(
      false,
    );
    // An older server sends no flag.
    expect(resolve(provider("unknown"), auth("failed")).retryable).toBe(true);
  });

  it("names a provider's refusal of a signed-in account instead of not signed in", () => {
    const refusedMessage = "Google accepted the sign-in, but no longer serves Gemini CLI.";
    expect(
      resolve(
        provider("unauthenticated"),
        auth("failed", {
          message: refusedMessage,
          retryable: false,
          refusal: "personal_account_unsupported",
        }),
      ),
    ).toMatchObject({
      kind: "refused",
      signedIn: false,
      installed: true,
      retryable: false,
      refusal: "personal_account_unsupported",
      failureMessage: refusedMessage,
    });
    // The status check alone reports it too, with its own message.
    expect(
      resolveProviderSignInState({
        provider: {
          installed: true,
          auth: { status: "unauthenticated", refusal: "personal_account_unsupported" },
          message: refusedMessage,
        },
        auth: auth("idle"),
        queryError: null,
      }),
    ).toMatchObject({ kind: "refused", failureMessage: refusedMessage });
    // A verified sign-in or a running one wins over an old refusal.
    expect(
      resolveProviderSignInState({
        provider: {
          installed: true,
          auth: { status: "authenticated", refusal: "personal_account_unsupported" },
        },
        auth: auth("idle"),
        queryError: null,
      }).kind,
    ).toBe("ready");
    expect(
      resolve(
        provider("unauthenticated"),
        auth("waiting", { refusal: "personal_account_unsupported" }),
      ).kind,
    ).toBe("waiting");
  });
});
