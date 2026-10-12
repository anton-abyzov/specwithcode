import { ManagedRelay } from "@specweave-studio/client-runtime/relay";
import {
  environmentEndpointUrl,
  executeAuthenticatedEnvironmentHttpRequest,
  RemoteEnvironmentAuthorization,
} from "@specweave-studio/client-runtime/studio";
import type {
  StudioCapacityPolicyInput,
  StudioCapacitySelectInput,
} from "@specweave-studio/contracts/studio";
import type { PreparedConnection } from "@specweave-studio/client-runtime/connection";
import * as Effect from "effect/Effect";

export type CapacityOperation =
  | { readonly kind: "read" }
  | { readonly kind: "refresh" }
  | { readonly kind: "policy"; readonly input: StudioCapacityPolicyInput }
  | { readonly kind: "select"; readonly input: StudioCapacitySelectInput };

const operationPath = (op: CapacityOperation) =>
  `/api/studio/capacity${op.kind === "read" ? "" : `/${op.kind}`}`;

export function requestCapacity(prepared: PreparedConnection, operation: CapacityOperation) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "studio",
      method: operation.kind === "read" ? "GET" : "POST",
      url: (base) => environmentEndpointUrl(base, operationPath(operation)),
      timeoutMs: operation.kind === "refresh" ? 55_000 : 8_000,
      request: ({ client, headers }) => {
        switch (operation.kind) {
          case "read":
            return client.capacity({ headers });
          case "refresh":
            return client.refreshCapacity({ headers, payload: {} });
          case "policy":
            return client.setCapacityPolicy({ headers, payload: operation.input });
          case "select":
            return client.selectCapacityAccount({ headers, payload: operation.input });
        }
      },
    });
  });
}
