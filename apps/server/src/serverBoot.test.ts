// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - starts the real server as a child process.
/**
 * Starts the server from source in a new private home and waits until it is
 * ready. Every service a layer asks for is looked up while the runtime is
 * built, so a layer that was registered without something it needs ends the
 * start with "Service not found", which no typecheck reports. Nothing of the
 * machine's own is read or written: the home, the data folder and the provider
 * folders are all inside a temporary folder.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { HANDOFF_PEER_PREFIX } from "./handoff/handoffWire.ts";

const bin = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "bin.ts");

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

describe("server start", () => {
  // The child's PATH below is a POSIX one.
  it.skipIf(NodePath.sep !== "/")(
    "builds the whole runtime, with project sync and its peer paths, in a private home",
    async () => {
      const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-server-boot-"));
      NodeFS.mkdirSync(NodePath.join(state, "userdata"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(state, "userdata", "settings.json"),
        JSON.stringify({ providerInstances: {} }),
      );
      const port = await freePort();
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          bin,
          "serve",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--base-dir",
          state,
          "--no-browser",
        ],
        {
          cwd: state,
          env: {
            PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
            HOME: state,
            CODEX_HOME: NodePath.join(state, "codex"),
            CLAUDE_CONFIG_DIR: NodePath.join(state, "claude"),
            XDG_CONFIG_HOME: NodePath.join(state, "config"),
            XDG_CACHE_HOME: NodePath.join(state, "cache"),
            LANG: "en_US.UTF-8",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let log = "";
      let exited: number | null | undefined;
      child.stdout.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
      const ended = new Promise<void>((resolve) =>
        child.once("exit", (code) => {
          exited = code;
          resolve();
        }),
      );
      try {
        const ready = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 90_000);
          const look = () => {
            if (!/(?:^|\n)Token: \S+/.test(log)) return;
            clearTimeout(timer);
            resolve(true);
          };
          child.stdout.on("data", look);
          child.stderr.on("data", look);
          void ended.then(() => {
            clearTimeout(timer);
            resolve(false);
          });
        });
        const problems = log
          .split("\n")
          .filter((line) => line.includes("Service not found"))
          .join("\n");
        expect(problems).toBe("");
        expect(exited, log.slice(-2000)).toBeUndefined();
        expect(ready, log.slice(-2000)).toBe(true);
        // The running server knows the two peer paths of project sync: a caller without a
        // credential is turned away at the door, where an unknown path is not found.
        const post = (path: string) =>
          fetch(`http://127.0.0.1:${port}${HANDOFF_PEER_PREFIX}/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }).then((answer) => answer.status);
        expect(await post("extras-negotiate")).toBe(401);
        expect(await post("extras-replicate")).toBe(401);
        expect(await post("extras-something-else")).toBe(404);
        expect(log).not.toContain("Service not found");
        expect(exited).toBeUndefined();
      } finally {
        // Only the process this test started.
        if (exited === undefined && child.pid !== undefined) child.kill();
        await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 10_000))]);
        if (exited === undefined) child.kill("SIGKILL");
        NodeFS.rmSync(state, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
