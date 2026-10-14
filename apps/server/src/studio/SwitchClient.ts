import { parseJson, stringifyJson } from "../json.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { StudioCapacityPolicyInput, StudioCapacitySelectInput } from "@specweave-studio/contracts/studio";

const SWITCH_ORIGIN = "http://127.0.0.1:8318";
const MAX_RESPONSE_BYTES = 128 * 1024;
export class SwitchRequestError extends Schema.TaggedError<SwitchRequestError>()("SwitchRequestError", {
  category: Schema.Literals(["switch-unavailable", "switch-timeout", "switch-invalid-response", "switch-busy"]),
}) {
  override get message() { return "The local subscription capacity service could not answer."; }
}

/** External transport dependency only; tests never contact a native provider. */
export const SwitchFetch = Context.Reference<typeof fetch>("studio/capacity/SwitchFetch", {
  defaultValue: () => fetch,
});

export class SwitchClient extends Context.Service<SwitchClient, {
  readonly read: Effect.Effect<unknown, SwitchRequestError>;
  readonly refresh: Effect.Effect<unknown, SwitchRequestError>;
  readonly policy: (input: StudioCapacityPolicyInput) => Effect.Effect<unknown, SwitchRequestError>;
  readonly select: (input: StudioCapacitySelectInput) => Effect.Effect<unknown, SwitchRequestError>;
}>()("specweave-studio/studio/SwitchClient") {}

const make = Effect.gen(function* () {
  const requestFetch = yield* SwitchFetch;
  const request = (path: "/api/state" | "/api/refresh" | "/api/policy" | "/api/select", body?: object) =>
    Effect.tryPromise({
      try: async (signal) => {
        const timeout = AbortSignal.timeout(path === "/api/refresh" ? 40000 : body === undefined ? 3000 : 5000);
        const response = await requestFetch(`${SWITCH_ORIGIN}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            accept: "application/json",
            ...(body === undefined
              ? {}
              : { "content-type": "application/json", origin: SWITCH_ORIGIN }),
          },
          ...(body === undefined ? {} : { body: stringifyJson(body) }),
          signal: AbortSignal.any([signal, timeout]),
          redirect: "error",
          credentials: "omit",
        }).catch(() => {
          throw new SwitchRequestError({
            category: timeout.aborted ? "switch-timeout" : "switch-unavailable",
          });
        });
        if (response.status === 409) throw new SwitchRequestError({ category: "switch-busy" });
        if (!response.ok) throw new SwitchRequestError({ category: "switch-unavailable" });
        if (!response.headers.get("content-type")?.toLowerCase().includes("application/json"))
          throw new SwitchRequestError({ category: "switch-invalid-response" });
        const declared = Number(response.headers.get("content-length"));
        if (declared > MAX_RESPONSE_BYTES || !response.body) {
          await response.body?.cancel();
          throw new SwitchRequestError({ category: "switch-invalid-response" });
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              throw new SwitchRequestError({ category: "switch-invalid-response" });
            }
            chunks.push(next.value);
          }
        } catch (cause) {
          if (Schema.is(SwitchRequestError)(cause)) throw cause;
          throw new SwitchRequestError({
            category: timeout.aborted ? "switch-timeout" : "switch-unavailable",
          });
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          return parseJson(new TextDecoder().decode(bytes)) as unknown;
        } catch {
          throw new SwitchRequestError({ category: "switch-invalid-response" });
        }
      },
      catch: (cause) =>
        Schema.is(SwitchRequestError)(cause)
          ? cause
          : new SwitchRequestError({ category: "switch-unavailable" }),
    });
  return SwitchClient.of({
    read: request("/api/state"),
    refresh: request("/api/refresh", {}),
    policy: (input) =>
      request("/api/policy", {
        mode: input.mode,
        ...(input.preferredProvider === undefined
          ? {}
          : { preferredProvider: input.preferredProvider }),
      }),
    select: (input) => request("/api/select", { id: input.id }),
  });
});
export const layer = Layer.effect(SwitchClient, make);
