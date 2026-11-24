import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Headers from "effect/http/Headers";

/** The app's proof that it owns this machine, sent once at token exchange; a secret. */
export const DESKTOP_OWNER_PROOF_HEADER = "x-specwithcode-desktop-proof";

export const layer = Layer.effect(
  Headers.CurrentRedactedNames,
  Effect.map(Headers.CurrentRedactedNames, (names) => [
    ...names,
    "dpop",
    DESKTOP_OWNER_PROOF_HEADER,
  ]),
);
