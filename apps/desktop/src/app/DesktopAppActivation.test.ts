// @effect-diagnostics nodeBuiltinImport:off -- This adapter test binds a real local socket or Windows named pipe and verifies its cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProjectId,
  ThreadId,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@specweave-studio/contracts";
import { resolveDesktopAppControlAddress } from "@specweave-studio/shared/desktopAppControl";
import { HostProcessPlatform, HostProcessUserId } from "@specweave-studio/shared/hostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, vi } from "vite-plus/test";

import {
  isActivationReadinessSender,
  startDesktopAppControlServer,
} from "./DesktopAppActivation.ts";

const openServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function makeTarget(stateDir: string, platform: NodeJS.Platform, userId: number | undefined) {
  return resolveDesktopAppControlAddress({
    stateDir,
    platform,
    tempDir: NodeOS.tmpdir(),
    userId,
    joinPath: NodePath.join,
  });
}

function request(requestId: string, platform: NodeJS.Platform): DesktopAppActivationRequest {
  return {
    version: 1,
    requestId,
    type: "open-workspace",
    workspaceRoot: NodePath.join(NodeOS.tmpdir(), "project"),
    platform: platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux",
  };
}

function startOkServer(target: ReturnType<typeof makeTarget>, userId: number | undefined) {
  return startDesktopAppControlServer({
    ...target,
    userId,
    handle: async (input) => ({
      version: 1,
      requestId: input.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    }),
    cancel: () => undefined,
    onReclaimError: () => undefined,
  }).then((server) => {
    openServers.push(server);
    return server;
  });
}

function exchange(address: string, payload: DesktopAppActivationRequest) {
  return new Promise<DesktopAppActivationResponse>((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as DesktopAppActivationResponse);
    });
  });
}

describe("isActivationReadinessSender", () => {
  it("counts only the main window's readiness reports", () => {
    expect(isActivationReadinessSender(1, 1)).toBe(true);
    // A project window runs the same client; its report must not register or
    // unregister the main window.
    expect(isActivationReadinessSender(1, 7)).toBe(false);
    expect(isActivationReadinessSender(null, 7)).toBe(false);
    expect(isActivationReadinessSender(1, undefined)).toBe(true);
    expect(isActivationReadinessSender(null, undefined)).toBe(true);
  });
});

describe("desktop app control server", () => {
  it.effect("roundtrips a request and removes its socket on shutdown", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "studio-app-control-test-"),
        );
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const received: DesktopAppActivationRequest[] = [];
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: async (input) => {
            received.push(input);
            return {
              version: 1,
              requestId: input.requestId,
              ok: true,
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
            };
          },
          cancel: () => undefined,
          onReclaimError: () => undefined,
        });
        openServers.push(server);

        const response = await exchange(target.address, request("request-1", platform));

        expect(received).toHaveLength(1);
        expect(response).toMatchObject({ ok: true, requestId: "request-1" });
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        if (target.directory !== null) {
          await expect(NodeFSP.stat(target.address)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("cancels a queued request when the client disconnects", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "studio-app-cancel-test-"),
        );
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const queued = Promise.withResolvers<void>();
        const canceled = Promise.withResolvers<string>();
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: () => {
            queued.resolve();
            return new Promise(() => undefined);
          },
          cancel: canceled.resolve,
          onReclaimError: () => undefined,
        });
        openServers.push(server);
        const socket = NodeNet.createConnection(target.address);
        try {
          await new Promise<void>((resolve, reject) => {
            socket.once("error", reject);
            socket.once("connect", () => {
              socket.write(
                `${JSON.stringify(request("request-canceled", platform))}\n`,
                (error) => {
                  if (error) reject(error);
                  else resolve();
                },
              );
            });
          });
          // A completed client write does not mean the server queued the request.
          await queued.promise;
          socket.destroy();
          await expect(canceled.promise).resolves.toBe("request-canceled");
        } finally {
          socket.destroy();
          await server.close();
          openServers.splice(openServers.indexOf(server), 1);
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      });
    }),
  );

  // Two desktop apps can share one state dir, such as nightly and a preview build.
  it.effect("keeps a newer app's socket when an older app on the same state dir quits", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "studio-app-takeover-test-"),
        );
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const older = await startOkServer(target, userId);
        await startOkServer(target, userId);

        await older.close();

        await expect(
          exchange(target.address, request("after-quit", platform)),
        ).resolves.toMatchObject({ ok: true, requestId: "after-quit" });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("binds its address again after the socket file is removed", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "studio-app-reclaim-test-"),
        );
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const server = await startOkServer(target, userId);

        await NodeFSP.unlink(target.address);
        await server.reclaim();

        await expect(
          exchange(target.address, request("reclaimed", platform)),
        ).resolves.toMatchObject({
          ok: true,
          requestId: "reclaimed",
        });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("routes post-listen server errors to onReclaimError instead of throwing uncaught", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "studio-app-error-test-"),
        );
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const reclaimErrors: unknown[] = [];
        let listeningServer: NodeNet.Server | undefined;
        const captureServer = (server: NodeNet.Server) => {
          listeningServer = server;
        };
        const originalListen = NodeNet.Server.prototype.listen;
        const listenSpy = vi.spyOn(NodeNet.Server.prototype, "listen").mockImplementation(function (
          this: NodeNet.Server,
          ...args: unknown[]
        ) {
          captureServer(this);
          return originalListen.apply(this, args as never);
        });
        try {
          const server = await startDesktopAppControlServer({
            ...target,
            userId,
            handle: async (input) => ({
              version: 1,
              requestId: input.requestId,
              ok: true,
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
            }),
            cancel: () => undefined,
            onReclaimError: (error) => reclaimErrors.push(error),
          });
          openServers.push(server);
        } finally {
          listenSpy.mockRestore();
        }

        expect(listeningServer).toBeDefined();
        const postListenError = new Error("post-listen socket error");
        expect(() => listeningServer!.emit("error", postListenError)).not.toThrow();
        expect(reclaimErrors).toContain(postListenError);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );
});
