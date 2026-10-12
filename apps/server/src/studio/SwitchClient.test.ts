import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { SwitchClient, SwitchFetch, layer } from "./SwitchClient.ts";

const run = <A, E>(effect: Effect.Effect<A, E, SwitchClient>, fake: typeof fetch) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provideService(SwitchFetch, fake)));
describe("fixed local Switch transport", () => {
  it("uses only fixed URLs and reconstructed whitelisted mutation fields", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return Response.json({ accounts: [] }); }) as typeof fetch;
    await run(Effect.gen(function* () { const client = yield* SwitchClient; yield* client.read; yield* client.refresh; yield* client.policy({ mode: "reset-first", preferredProvider: "codex" }); yield* client.select({ id: null }); }), fake);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:8318/api/state", "http://127.0.0.1:8318/api/refresh", "http://127.0.0.1:8318/api/policy", "http://127.0.0.1:8318/api/select"]);
    expect(calls.map((c) => c.init.body)).toEqual([undefined, "{}", '{"mode":"reset-first","preferredProvider":"codex"}', '{"id":null}']);
    expect(calls.every((c) => c.init.redirect === "error" && c.init.credentials === "omit")).toBe(true);
    expect(calls[1]!.init.headers).toMatchObject({ origin: "http://127.0.0.1:8318" });
  });
  it.each([
    ["raw upstream error", () => new Response("synthetic-secret-private-error", { status: 500 }), "switch-unavailable"],
    ["busy refresh", () => Response.json({ error: "synthetic-private" }, { status: 409 }), "switch-busy"],
    ["non-JSON", () => new Response("synthetic-private"), "switch-invalid-response"],
    ["oversized response", () => new Response("x".repeat(131073), { headers: { "content-type": "application/json" } }), "switch-invalid-response"],
    ["malformed JSON", () => new Response("{synthetic-private", { headers: { "content-type": "application/json" } }), "switch-invalid-response"],
  ])("sanitizes %s", async (_name, response, category) => {
    const failure = await run(Effect.flatMap(SwitchClient, (client) => client.read).pipe(Effect.flip), (async () => response()) as typeof fetch);
    expect(failure.category).toBe(category);
    expect(JSON.stringify(failure)).not.toContain("synthetic-private");
    expect(failure.message).not.toContain("synthetic");
  });
});
