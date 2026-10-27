import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as TestClock from "effect/testing/TestClock";

import {
  arrivedOverConnect,
  credentialLimiterKey,
  makeCredentialFailureLimiter,
} from "./CredentialFailureLimiter.ts";

const failures = (
  limiter: ReturnType<typeof makeCredentialFailureLimiter>,
  key: string,
  count: number,
) => Effect.forEach(Array.from({ length: count }), () => limiter.recordFailure(key));

const blocked = (limiter: ReturnType<typeof makeCredentialFailureLimiter>, key: string) =>
  limiter
    .gate(key)
    .pipe(
      Effect.as(false),
      Effect.catchTags({ CredentialRateLimited: () => Effect.succeed(true) }),
    );

it.effect("blocks a client after 30 failures in 10 minutes, and only that client", () =>
  Effect.gen(function* () {
    const limiter = makeCredentialFailureLimiter();
    yield* failures(limiter, "cf:203.0.113.1", 29);
    expect(yield* blocked(limiter, "cf:203.0.113.1")).toBe(false);
    yield* limiter.recordFailure("cf:203.0.113.1");
    const refused = yield* Effect.flip(limiter.gate("cf:203.0.113.1"));
    expect(refused.retryAfterSeconds).toBe(600);
    expect(yield* blocked(limiter, "cf:203.0.113.2")).toBe(false);

    // The block ends after 10 minutes; a client with no new failures is then clear.
    yield* TestClock.adjust("9 minutes");
    expect((yield* Effect.flip(limiter.gate("cf:203.0.113.1"))).retryAfterSeconds).toBe(60);
    yield* TestClock.adjust("1 minute");
    expect(yield* blocked(limiter, "cf:203.0.113.1")).toBe(false);
  }),
);

it.effect("forgets failures older than the window", () =>
  Effect.gen(function* () {
    const limiter = makeCredentialFailureLimiter();
    yield* failures(limiter, "peer:192.0.2.4", 29);
    yield* TestClock.adjust("10 minutes");
    yield* failures(limiter, "peer:192.0.2.4", 29);
    expect(yield* blocked(limiter, "peer:192.0.2.4")).toBe(false);
  }),
);

it.effect("never limits an exempt client, and caps how many clients it remembers", () =>
  Effect.gen(function* () {
    const limiter = makeCredentialFailureLimiter({ maxKeys: 2, limit: 2 });
    yield* Effect.forEach(Array.from({ length: 100 }), () => limiter.recordFailure(null));
    yield* limiter.gate(null);
    yield* limiter.recordFailure("a");
    yield* limiter.recordFailure("b");
    yield* limiter.recordFailure("c");
    // "a" was the oldest entry and was dropped to make room: its count restarts.
    yield* limiter.recordFailure("a");
    expect(yield* blocked(limiter, "a")).toBe(false);
  }),
);

it.effect("never drops a blocked client to make room, so flooding new keys cannot unblock it", () =>
  Effect.gen(function* () {
    const limiter = makeCredentialFailureLimiter({ maxKeys: 2, limit: 2 });
    yield* failures(limiter, "a", 2);
    expect(yield* blocked(limiter, "a")).toBe(true);
    yield* Effect.forEach(["b", "c", "d", "e"], (key) => limiter.recordFailure(key));
    expect(yield* blocked(limiter, "a")).toBe(true);
  }),
);

const request = (headers: Record<string, string>, remoteAddress?: string) =>
  HttpServerRequest.fromWeb(new Request("http://127.0.0.1/api/x", { headers })).modify({
    remoteAddress: Option.fromUndefinedOr(remoteAddress),
  });

it("keys tunnel traffic by Cloudflare's client address and exempts other loopback callers", () => {
  const managed = "prod-0123456789abcdef.spec-weave.com";
  expect(credentialLimiterKey(request({ host: managed, "cf-connecting-ip": "203.0.113.5" }))).toBe(
    "cf:203.0.113.5",
  );
  // A trailing dot or an explicit :443 still names the tunnel host.
  expect(arrivedOverConnect(request({ host: `${managed}.` }))).toBe(true);
  expect(arrivedOverConnect(request({ host: `${managed}:443` }))).toBe(true);
  expect(credentialLimiterKey(request({ host: managed }))).toBe("cf:unknown");
  // Cloudflare's own header marks tunnel traffic whatever the Host says.
  expect(
    credentialLimiterKey(request({ host: "localhost", "cf-connecting-ip": "203.0.113.6" })),
  ).toBe("cf:203.0.113.6");
  expect(arrivedOverConnect(request({ host: "m4.tail1234.ts.net" }))).toBe(false);
  expect(credentialLimiterKey(request({ host: "localhost:8319" }, "127.0.0.1"))).toBeNull();
  expect(credentialLimiterKey(request({ host: "m4.tail1234.ts.net" }, "::1"))).toBeNull();
  expect(credentialLimiterKey(request({ host: "192.168.1.5:8319" }, "192.168.1.9"))).toBe(
    "peer:192.168.1.9",
  );
  // Cloudflare's headers count only from the tunnel connector (loopback): any
  // other peer is keyed by its own address, whatever it claims.
  expect(
    credentialLimiterKey(
      request({ host: managed, "cf-connecting-ip": "203.0.113.7", "cf-ray": "x" }, "192.168.1.9"),
    ),
  ).toBe("peer:192.168.1.9");
  expect(
    credentialLimiterKey(
      request({ host: managed, "cf-connecting-ip": "203.0.113.7" }, "127.0.0.1"),
    ),
  ).toBe("cf:203.0.113.7");
  // One IPv6 client usually holds a whole /64.
  expect(
    credentialLimiterKey(
      request({ host: managed, "cf-connecting-ip": "2001:db8:1:2:aaaa::1" }, "127.0.0.1"),
    ),
  ).toBe("cf:2001:db8:1:2::/64");
  expect(credentialLimiterKey(request({ host: "x" }, "2001:0db8:0001:0002:ffff::9"))).toBe(
    "peer:2001:db8:1:2::/64",
  );
});
