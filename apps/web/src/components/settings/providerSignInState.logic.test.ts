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
  });

  it("offers a plain retry unless the server says only setup can help", () => {
    expect(resolve(provider("unknown"), auth("failed", { retryable: false })).retryable).toBe(
      false,
    );
    // An older server sends no flag.
    expect(resolve(provider("unknown"), auth("failed")).retryable).toBe(true);
  });
});
