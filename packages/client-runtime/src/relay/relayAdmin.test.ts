import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import * as RpcHttp from "../rpc/http.ts";
import * as RelayAdmin from "./relayAdmin.ts";

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: string | null;
}

function relayAdminTest(
  respond: (request: SeenRequest) => Response | Promise<Response>,
  relayUrl = "https://relay.example.test",
) {
  const seen: Array<SeenRequest> = [];
  const fetchFn = (async (input, init) => {
    const request = new Request(input, init);
    const record: SeenRequest = {
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: request.method === "GET" ? null : await request.text(),
    };
    seen.push(record);
    return respond(record);
  }) as typeof globalThis.fetch;
  return {
    seen,
    layer: RelayAdmin.layer({ relayUrl }).pipe(
      Layer.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
    ),
  };
}

const account = {
  userId: "user_a",
  email: "a@example.test",
  name: "A Person",
  founderNumber: 7,
  limit: { maxMachines: 10, source: "founder" },
  machineCount: 2,
  phoneCount: 1,
  firstSeenAt: "2026-11-01T00:00:00.000Z",
  lastSeenAt: "2026-11-10T00:00:00.000Z",
};

const run = <A, E>(
  test: ReturnType<typeof relayAdminTest>,
  use: (client: RelayAdmin.RelayAdminClientShape) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const client = yield* RelayAdmin.RelayAdminClient;
    return yield* use(client);
  }).pipe(Effect.provide(test.layer));

const FAILED_READS = {
  "a missing account": () =>
    Response.json(
      { _tag: "RelayAdminAccountNotFoundError", code: "account_not_found" },
      { status: 404 },
    ),
  "the empty 404 a non-owner gets": () => new Response(null, { status: 404 }),
  "a server error": () => new Response("boom", { status: 500 }),
  "a request that never arrives": () =>
    Promise.reject(new TypeError("fetch failed: relay.example.test")),
} satisfies Record<string, () => Response | Promise<Response>>;

describe("RelayAdminClient", () => {
  it.effect("reads 200 from /v1/admin/me as an owner and sends the Clerk token as bearer", () => {
    const test = relayAdminTest(() => Response.json({ userId: "user_owner" }));
    return Effect.gen(function* () {
      const owner = yield* run(test, (client) => client.isOwner({ clerkToken: "clerk-token" }));
      expect(owner).toBe(true);
      expect(test.seen).toEqual([
        {
          method: "GET",
          url: "https://relay.example.test/v1/admin/me",
          authorization: "Bearer clerk-token",
          body: null,
        },
      ]);
    });
  });

  it.effect("reads the relay's empty 404 as not an owner", () => {
    const test = relayAdminTest(() => new Response(null, { status: 404 }));
    return Effect.gen(function* () {
      expect(yield* run(test, (client) => client.isOwner({ clerkToken: "t" }))).toBe(false);
    });
  });

  it.effect("does not call a relay outage 'not an owner'", () => {
    const test = relayAdminTest(() => new Response("oops", { status: 500 }));
    return Effect.gen(function* () {
      const error = yield* run(test, (client) => client.isOwner({ clerkToken: "t" })).pipe(
        Effect.flip,
      );
      expect(error.kind).toBe("failed");
      expect(error.status).toBe(500);
    });
  });

  it.effect("reports a request that never reached the relay as a network failure", () => {
    const test = relayAdminTest(() => Promise.reject(new TypeError("Failed to fetch")));
    return Effect.gen(function* () {
      const error = yield* run(test, (client) => client.overview({ clerkToken: "t" })).pipe(
        Effect.flip,
      );
      expect(error.kind).toBe("network");
    });
  });

  it.effect("pages the account list with the cursor in the URL", () => {
    const test = relayAdminTest(() =>
      Response.json({
        accounts: [account],
        nextCursor: null,
        identities: "read",
        searchTruncated: false,
      }),
    );
    return Effect.gen(function* () {
      const page = yield* run(test, (client) =>
        client.listAccounts({ clerkToken: "t", cursor: "next-1" }),
      );
      expect(page.accounts[0]?.email).toBe("a@example.test");
      expect(test.seen[0]?.url).toBe("https://relay.example.test/v1/admin/accounts?cursor=next-1");
      yield* run(test, (client) => client.listAccounts({ clerkToken: "t" }));
      expect(test.seen[1]?.url).toBe("https://relay.example.test/v1/admin/accounts");
    });
  });

  it.effect("sends a search in the request body, never in the URL", () => {
    const test = relayAdminTest(() =>
      Response.json({
        accounts: [],
        nextCursor: null,
        identities: "read",
        searchTruncated: true,
      }),
    );
    return Effect.gen(function* () {
      const page = yield* run(test, (client) =>
        client.searchAccounts({ clerkToken: "t", query: "person@example.test" }),
      );
      expect(page.searchTruncated).toBe(true);
      expect(test.seen[0]?.method).toBe("POST");
      expect(test.seen[0]?.url).toBe("https://relay.example.test/v1/admin/accounts/search");
      expect(test.seen[0]?.url).not.toContain("person");
      expect(test.seen[0]?.body).toBe('{"query":"person@example.test"}');
    });
  });

  it.effect("tells a missing account from a caller who is no longer an owner", () => {
    const missing = relayAdminTest(() =>
      Response.json(
        { _tag: "RelayAdminAccountNotFoundError", code: "account_not_found" },
        { status: 404 },
      ),
    );
    const hidden = relayAdminTest(() => new Response(null, { status: 404 }));
    return Effect.gen(function* () {
      const notFound = yield* run(missing, (client) =>
        client.account({ clerkToken: "t", userId: "user_gone" }),
      ).pipe(Effect.flip);
      expect(notFound.kind).toBe("account_not_found");
      expect(missing.seen[0]?.url).toBe("https://relay.example.test/v1/admin/accounts/user_gone");
      const notOwner = yield* run(hidden, (client) =>
        client.account({ clerkToken: "t", userId: "user_a" }),
      ).pipe(Effect.flip);
      expect(notOwner.kind).toBe("not_owner");
    });
  });

  it.effect("keeps the relay's trace id when it could not read its data", () => {
    const test = relayAdminTest(() =>
      Response.json(
        {
          _tag: "RelayAdminUnavailableError",
          code: "admin_unavailable",
          reason: "persistence_failed",
          traceId: "trace-503",
        },
        { status: 503 },
      ),
    );
    return Effect.gen(function* () {
      const error = yield* run(test, (client) => client.overview({ clerkToken: "t" })).pipe(
        Effect.flip,
      );
      expect(error.kind).toBe("unavailable");
      expect(error.traceId).toBe("trace-503");
    });
  });

  it.effect("makes no request when Connect is not set up", () => {
    const test = relayAdminTest(() => Response.json({ userId: "x" }), "http://relay.invalid");
    return Effect.gen(function* () {
      expect(yield* run(test, (client) => client.isOwner({ clerkToken: "t" }))).toBe(false);
      const error = yield* run(test, (client) => client.overview({ clerkToken: "t" })).pipe(
        Effect.flip,
      );
      expect(error.kind).toBe("failed");
      expect(test.seen).toEqual([]);
    });
  });

  // A failed span is exported with its error and every cause, so the error
  // itself must not name the request either.
  it.effect.each(Object.keys(FAILED_READS) as Array<keyof typeof FAILED_READS>)(
    "puts no URL and no account id into any tracing span for %s",
    (failure) => {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const test = relayAdminTest(FAILED_READS[failure]);
      return Effect.gen(function* () {
        const error = yield* run(test, (client) =>
          client.account({ clerkToken: "clerk-token", userId: "user_someone_else" }),
        ).pipe(Effect.flip, Effect.provideService(Tracer.Tracer, tracer));
        expect(test.seen).toHaveLength(1);
        expect(spans.map((span) => span.name)).toContain("clientRuntime.relayAdmin.account");
        const recorded = [
          ...spans.flatMap((span) => [
            span.name,
            ...span.attributes.keys(),
            ...span.attributes.values(),
            ...(span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
              ? Cause.prettyErrors(span.status.exit.cause, { includeCauseInStack: true }).flatMap(
                  (pretty) => [pretty.message, pretty.stack ?? ""],
                )
              : []),
          ]),
          error.message,
          Object.keys(error).join(","),
        ]
          .map(String)
          .join("\n");
        expect(recorded).not.toContain("user_someone_else");
        expect(recorded).not.toContain("/v1/admin");
        expect(recorded).not.toContain("relay.example.test");
        expect(recorded).not.toContain("clerk-token");
        expect("cause" in error).toBe(false);
      });
    },
  );

  it.effect("gives up after 20 seconds and says it timed out", () => {
    const test = relayAdminTest(() => new Promise<Response>(() => undefined));
    return Effect.gen(function* () {
      const pending = yield* run(test, (client) => client.overview({ clerkToken: "t" })).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(19));
      expect(pending.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(Duration.seconds(1));
      const error = yield* Fiber.join(pending);
      expect(error.kind).toBe("timeout");
      expect(error.status).toBeNull();
    });
  });
});
