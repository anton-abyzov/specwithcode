import { expect, it, afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Transport from "./ProjectConnectionTransport.ts";
import { stdioFixture, secretKey, excludedKey } from "./stdioFixture.testkit.ts";

type Fixture = Awaited<ReturnType<typeof stdioFixture>>;
const fixtures: Fixture[] = [];
const fixture = async () => {
  const f = await stdioFixture();
  fixtures.push(f);
  return f;
};
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.dispose();
  vi.unstubAllEnvs();
});
const run = <A, E>(
  body: (service: Transport.ProjectConnectionTransport["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* Transport.ProjectConnectionTransport);
    }).pipe(Effect.provide(Transport.layer)),
  );

it("discovers and calls an owned stdio peer, then closes every process without inheriting arbitrary environment", async () => {
  const f = await fixture();
  vi.stubEnv(excludedKey, "synthetic-unselected");
  const tools = await run((s) => s.discover({ config: f.config, cwd: f.root }));
  expect(tools.map((t) => t.name)).toEqual(["echo"]);
  await f.stopped();
  const result = await run((s) =>
    s.call({ config: f.config, cwd: f.root, tool: tools[0]!, arguments: { value: "Hello" } }),
  );
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content)).toEqual({
    content: [{ type: "text", text: "Hello" }],
    structuredContent: { echo: "Hello", secret: null, unselected: null },
  });
  await f.stopped();
  expect((await f.events()).filter((e) => e.method === "tools/call")).toHaveLength(1);
});

it.each(['quoted"credential', "back\\slash", "line\nbreak", "xy"])(
  "redacts decoded descriptions, schemas and call results for env value %j",
  async (secret) => {
    const f = await fixture();
    vi.stubEnv(secretKey, secret);
    const config = { ...f.config, envKeys: [secretKey] };
    const tools = await run((s) => s.discover({ config, cwd: f.root }));
    expect(tools[0]?.description).toBe("Synthetic echo 1 [redacted]");
    expect(tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: { value: { type: "string", description: "[redacted]" } },
      required: ["value"],
    });
    const result = await run((s) =>
      s.call({ config, cwd: f.root, tool: tools[0]!, arguments: { value: "Hello" } }),
    );
    expect(JSON.parse(result.content)).toEqual({
      content: [{ type: "text", text: "[redacted]" }],
      structuredContent: { echo: "Hello", secret: "[redacted]", unselected: null },
    });
    await f.stopped();
  },
);

it("refuses changed tool definitions before dispatching the external call", async () => {
  const f = await fixture();
  const [tool] = await run((s) => s.discover({ config: f.config, cwd: f.root }));
  await f.configure({ version: 2 });
  const failure = await run((s) =>
    s
      .call({ config: f.config, cwd: f.root, tool: tool!, arguments: { value: "not sent" } })
      .pipe(Effect.flip),
  );
  expect(failure.reason).toBe("changed");
  expect((await f.events()).some((e) => e.method === "tools/call")).toBe(false);
  await f.stopped();
});

it("refuses secret-bearing tool identifiers without returning them", async () => {
  const f = await fixture();
  vi.stubEnv(secretKey, "private-tool-name");
  await f.configure({ secretName: true });
  const failure = await run((s) =>
    s.discover({ config: { ...f.config, envKeys: [secretKey] }, cwd: f.root }).pipe(Effect.flip),
  );
  expect(failure.reason).toBe("unavailable");
  expect(JSON.stringify(failure)).not.toContain("private-tool-name");
  await f.stopped();
});

it("returns a generic error for a missing executable or missing selected env variable", async () => {
  const f = await fixture();
  vi.stubEnv(secretKey, undefined);
  for (const config of [
    { ...f.config, command: f.root + "/missing-executable" },
    { ...f.config, envKeys: [secretKey] },
  ]) {
    const failure = await run((s) => s.discover({ config, cwd: f.root }).pipe(Effect.flip));
    expect(failure.reason).toBe("unavailable");
    expect(JSON.stringify(failure)).not.toContain(f.root);
  }
  expect(await f.events()).toEqual([]);
});

it("closes the owned process before cancelling an in-flight call returns", async () => {
  const f = await fixture();
  const [tool] = await run((s) => s.discover({ config: f.config, cwd: f.root }));
  await f.configure({ hang: true });
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      const service = yield* Transport.ProjectConnectionTransport;
      return yield* service.call({
        config: f.config,
        cwd: f.root,
        tool: tool!,
        arguments: { value: "hang" },
      });
    }).pipe(Effect.provide(Transport.layer)),
  );
  await f.waitForCall();
  await Effect.runPromise(Fiber.interrupt(fiber));
  // On Windows a child that is still running holds its working folder open.
  await f.exited();
  expect((await f.events()).filter((e) => e.method === "tools/call")).toHaveLength(1);
});

it("closes the owned process before a failed handshake returns", async () => {
  const f = await fixture();
  await f.configure({ badInit: true });
  const failure = await run((s) => s.discover({ config: f.config, cwd: f.root }).pipe(Effect.flip));
  expect(failure.reason).toBe("unavailable");
  await f.exited();
  expect((await f.events()).some((e) => e.type === "start")).toBe(true);
});
