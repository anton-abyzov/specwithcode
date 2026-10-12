import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "@effect/vitest";

import { resolveBuiltInGoogleClient } from "./googleBuiltInClient.ts";

const ID = "123456-abcdefgh.apps.googleusercontent.com";
const SECRET = "GOCSPX-build-time-secret";
const NONE = { clientId: "", clientSecret: "" };

describe("resolveBuiltInGoogleClient", () => {
  it("uses the build-time client", () => {
    const client = resolveBuiltInGoogleClient({}, { clientId: ` ${ID} `, clientSecret: SECRET });
    expect(client?.clientId).toBe(ID);
    expect(Redacted.value(client!.clientSecret)).toBe(SECRET);
  });

  it("lets a runtime pair override the build-time one", () => {
    const client = resolveBuiltInGoogleClient(
      {
        STUDIO_GOOGLE_OAUTH_CLIENT_ID: "999999-runtimeclient.apps.googleusercontent.com",
        STUDIO_GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-runtime-secret",
      },
      { clientId: ID, clientSecret: SECRET },
    );
    expect(client?.clientId).toBe("999999-runtimeclient.apps.googleusercontent.com");
  });

  it("treats a missing, half or malformed pair as no client", () => {
    expect(resolveBuiltInGoogleClient({}, NONE)).toBeNull();
    // A runtime id without its secret does not fall back to the build-time secret.
    expect(
      resolveBuiltInGoogleClient(
        { STUDIO_GOOGLE_OAUTH_CLIENT_ID: ID },
        { clientId: ID, clientSecret: SECRET },
      ),
    ).toBeNull();
    expect(
      resolveBuiltInGoogleClient({}, { clientId: "not-a-client", clientSecret: SECRET }),
    ).toBeNull();
  });

  it("keeps the secret out of logs", () => {
    const client = resolveBuiltInGoogleClient({}, { clientId: ID, clientSecret: SECRET });
    expect(JSON.stringify(client)).not.toContain(SECRET);
    expect(String(client?.clientSecret)).not.toContain(SECRET);
  });
});
