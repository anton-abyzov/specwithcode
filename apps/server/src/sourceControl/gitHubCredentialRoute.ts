/**
 * The receiving half of a GitHub sign-in copy: a fleet machine's management
 * token with settings write posts its token here over the tailnet, and this
 * server stores it as its saved Settings token with a note of where it came
 * from. Requests through a Connect address are refused. The reply carries the
 * time only; the token is never echoed, logged or put in an error.
 */
import {
  AuthSettingsWriteScope,
  REDACTED_SECRET_MARKER,
  TrimmedNonEmptyString,
} from "@specweave-studio/contracts";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { arrivedOverConnect } from "../auth/CredentialFailureLimiter.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  GITHUB_CREDENTIAL_PATH,
  REPLACED_TOKEN_SECRET,
  storeCopiedTokenPatch,
} from "./GitHubCredentialCopy.ts";
import { GITHUB_HOST, copiedNote } from "./gitHubCredentialState.ts";

const MAX_BODY_BYTES = 8_192;
const bounded = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));
const decodeBody = Schema.decodeUnknownOption(
  Schema.Struct({
    token: bounded(1024),
    login: bounded(255),
    from: bounded(255),
    replace: Schema.optionalKey(Schema.Boolean),
  }),
);
const encoder = new TextEncoder();

const refusal = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers: { "cache-control": "no-store" } });

export const routeLayer = HttpRouter.add(
  "POST",
  GITHUB_CREDENTIAL_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // A token is accepted over the tailnet only, never through the Connect relay.
    if (arrivedOverConnect(request)) return refusal(403, "tailnet_only");
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (Option.isNone(session)) return refusal(401, "unauthorized");
    if (!session.value.scopes.includes(AuthSettingsWriteScope)) return refusal(403, "forbidden");
    const body = yield* request.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
      Effect.option,
    );
    const input = Option.flatMap(body, decodeBody);
    if (Option.isNone(input)) return refusal(400, "invalid_request");
    const settings = yield* ServerSettings.ServerSettingsService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const at = DateTime.formatIso(yield* DateTime.now);
    const { replace, ...copy } = input.value;
    const stored = yield* Effect.gen(function* () {
      const current = (yield* settings.getSettings).github;
      const saved = current.tokens[GITHUB_HOST]?.trim() ?? "";
      const note = copiedNote(current);
      // A token saved by hand here is replaced only on an explicit request, and set
      // aside so Remove restores it. An unreadable one cannot be set aside.
      const handSaved = saved !== "" && note === undefined;
      if (handSaved && saved === REDACTED_SECRET_MARKER) return "unreadable" as const;
      if (handSaved && replace !== true) return "saved" as const;
      if (handSaved) yield* secrets.set(REPLACED_TOKEN_SECRET, encoder.encode(saved));
      yield* settings.updateSettings(
        storeCopiedTokenPatch(current, {
          ...copy,
          at,
          replacedSaved: handSaved || note?.replacedSaved === true,
        }),
      );
      return "stored" as const;
    }).pipe(Effect.exit);
    // The cause may hold the patch, so it is dropped.
    if (stored._tag === "Failure" || stored.value === "unreadable")
      return refusal(500, "internal_error");
    if (stored.value === "saved") return refusal(409, "saved_token");
    return HttpServerResponse.jsonUnsafe(
      { copiedAt: at },
      { headers: { "cache-control": "no-store" } },
    );
  }),
);
