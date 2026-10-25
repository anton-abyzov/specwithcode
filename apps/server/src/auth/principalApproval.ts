import type { AuthPrincipal } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

export interface PrincipalApproval {
  readonly principal?: AuthPrincipal;
  readonly principalGeneration?: number | undefined;
}

/** Copy identity and its approval generation together; never refresh a delegated approval. */
export const principalApproval = (approval: PrincipalApproval): PrincipalApproval =>
  approval.principal
    ? { principal: approval.principal, principalGeneration: approval.principalGeneration }
    : {};

/** OAuth registers for the lifetime of its service; revocation also has a durable SQL guard. */
export function principalRevocations() {
  const listeners = new Set<(principal: AuthPrincipal) => Effect.Effect<void>>();
  return {
    listen: (listener: (principal: AuthPrincipal) => Effect.Effect<void>) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    notify: (principal: AuthPrincipal) =>
      Effect.forEach([...listeners], (listener) => listener(principal), { discard: true }),
  };
}
