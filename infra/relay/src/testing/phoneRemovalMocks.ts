import * as Layer from "effect/Layer";

import * as PhoneRemovals from "../agentActivity/PhoneRemovals.ts";
import * as ClerkSessions from "../auth/ClerkSessions.ts";
import * as ClientKeyRevocations from "../environments/ClientKeyRevocations.ts";

/** Phone-removal services for handler tests that never reach them. */
export const layerPhoneRemovalsUnused = Layer.mergeAll(
  Layer.mock(PhoneRemovals.PhoneRemovals, {}),
  Layer.mock(ClerkSessions.ClerkSessions, {}),
  Layer.mock(ClientKeyRevocations.ClientKeyRevocations, {}),
);
