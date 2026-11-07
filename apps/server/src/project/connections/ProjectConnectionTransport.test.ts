// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, it, afterEach, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../../config.ts";
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
const layerAt = (baseDir: string | { readonly prefix: string }) =>
  Transport.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NodeServices.layer),
  );
const transportLayer = layerAt({ prefix: "studio-connection-transport-" });
const run = <A, E>(
  body: (service: Transport.ProjectConnectionTransport["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* Transport.ProjectConnectionTransport);
    }).pipe(Effect.provide(transportLayer)),
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

it("passes a stored token to the peer ahead of the environment and redacts it", async () => {
  const f = await fixture();
  vi.stubEnv(secretKey, "from-environment");
  const stored = { [secretKey]: "from-secret-store" };
  const config = { ...f.config, envKeys: [secretKey] };
  const tools = await run((s) => s.discover({ config, cwd: f.root, stored }));
  expect(tools[0]?.description).toBe("Synthetic echo 1 [redacted]");
  expect(JSON.stringify(tools)).not.toContain("from-secret-store");
  const result = await run((s) =>
    s.call({ config, cwd: f.root, stored, tool: tools[0]!, arguments: { value: "Hello" } }),
  );
  expect(result.content).not.toContain("from-secret-store");
  expect(JSON.parse(result.content).structuredContent.secret).toBe("[redacted]");
});

it("starts a process holding a stored token outside the project folder", async () => {
  const f = await fixture();
  const stored = { [secretKey]: "from-secret-store" };
  const config = { ...f.config, envKeys: [secretKey] };
  const state = path.join(f.root, "state");
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Transport.ProjectConnectionTransport;
      return yield* service.discover({ config, cwd: "/nonexistent-project-folder", stored });
    }).pipe(Effect.provide(layerAt(state))),
  );
  await f.stopped();
  const starts = await fs.readdir(path.join(state, "userdata", "secrets", "connection-start"));
  expect(starts).toEqual([]);
  // Without a stored token a process still starts in the project folder.
  await expect(
    run((s) => s.discover({ config: f.config, cwd: "/nonexistent-project-folder" })),
  ).rejects.toBeDefined();
});

const plant = async (folder: string, name: string, marker: string) => {
  const bin = path.join(folder, "node_modules", ".bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, name), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, {
    mode: 0o755,
  });
};

it.skipIf(process.platform === "win32")(
  "never runs a package planted in the project or temp folder when a token is stored",
  async () => {
    const f = await fixture();
    const scratch = await fs.mkdtemp(path.join(f.root, "tmp-"));
    const marker = path.join(scratch, "planted-ran");
    await plant(scratch, "synthetic-planted", marker);
    vi.stubEnv("TMPDIR", scratch);
    const config = {
      name: "Planted",
      command: "npx",
      args: ["--no-install", "synthetic-planted"],
      envKeys: [secretKey],
    };
    // An explicit state folder: the default test one would be created inside TMPDIR.
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* Transport.ProjectConnectionTransport;
          return yield* service.discover({
            config,
            cwd: scratch,
            stored: { [secretKey]: "value" },
          });
        }).pipe(Effect.provide(layerAt(path.join(f.root, "state")))),
      ),
    ).rejects.toBeDefined();
    await expect(fs.access(marker)).rejects.toBeDefined();
    // The control: from that same folder without a stored token, npx does run it.
    await expect(
      run((s) => s.discover({ config: { ...config, envKeys: [] }, cwd: scratch })),
    ).rejects.toBeDefined();
    await expect(fs.access(marker)).resolves.toBeUndefined();
  },
);

it.skipIf(process.platform === "win32")(
  "a preset's package form runs its own bin, not one planted above the secrets folder",
  async () => {
    const f = await fixture();
    const scratch = await fs.mkdtemp(path.join(f.root, "above-"));
    const planted = path.join(scratch, "planted-ran");
    const real = path.join(scratch, "real-ran");
    await plant(scratch, "synthetic-preset", planted);
    const pkg = path.join(scratch, "pkg");
    await fs.mkdir(pkg);
    await fs.writeFile(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "synthetic-preset", version: "1.0.0", bin: "cli.js" }),
    );
    await fs.writeFile(
      path.join(pkg, "cli.js"),
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(real)}, "");\nprocess.exit(1);\n`,
      { mode: 0o755 },
    );
    // npm's cache follows HOME; this keeps the install out of the real one.
    vi.stubEnv("HOME", scratch);
    const config = {
      name: "Preset",
      command: "npx",
      args: ["-y", `--package=file:${pkg}`, "synthetic-preset"],
      envKeys: [secretKey],
    };
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* Transport.ProjectConnectionTransport;
          return yield* service.discover({
            config,
            cwd: scratch,
            stored: { [secretKey]: "value" },
          });
        }).pipe(Effect.provide(layerAt(path.join(scratch, "state")))),
      ),
    ).rejects.toBeDefined();
    await expect(fs.access(real)).resolves.toBeUndefined();
    await expect(fs.access(planted)).rejects.toBeDefined();
  },
);

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
    }).pipe(Effect.provide(transportLayer)),
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
