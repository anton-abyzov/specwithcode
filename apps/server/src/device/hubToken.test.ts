import { describe, expect, it } from "@effect/vitest";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as NetService from "@specweave-studio/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Socket from "effect/socket/Socket";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";
import { hubWebSocketConstructor, readHubToken, redactHubToken } from "./hubToken.ts";
import {
  IosSimulatorSetupSupport,
  type IosSimulatorSetup,
  type KeptCheck,
} from "./iosSimulatorSupport.ts";
import * as LocalDeviceHost from "./LocalDeviceHost.ts";

const TOKEN = "Zq3-_x9Yk0bW7cLr2Vh8nT4mQ1sD6fGj5aE0uIoPzXw";

describe("hub token in the hub's output", () => {
  // The lines the installed hub prints with --require-token, on loopback.
  const startup = [
    "Expo Device Hub ready",
    "",
    `  Local:   http://localhost:3400/?token=${TOKEN}`,
    "  Network: pass --host 0.0.0.0 to expose on your local network",
  ];

  it("reads the token from the startup link and only there", () => {
    expect(startup.map(readHubToken)).toEqual([undefined, undefined, TOKEN, undefined]);
    expect(readHubToken(`http://localhost:1/?a=1&token=${TOKEN}`)).toBe(TOKEN);
    expect(readHubToken("no token=here")).toBeUndefined();
  });

  it("blanks every token in a line, and leaves other lines alone", () => {
    expect(redactHubToken(startup[2]!)).toBe("  Local:   http://localhost:3400/?token=<redacted>");
    expect(redactHubToken(`?token=${TOKEN} and &token=${TOKEN}`)).toBe(
      "?token=<redacted> and &token=<redacted>",
    );
    expect(redactHubToken(startup[3]!)).toBe(startup[3]);
  });
});

/** Tests never spawn Xcode tools. */
const iosCheckNotYetAnswered: KeptCheck<IosSimulatorSetup> = {
  current: () => undefined,
  read: () => Promise.reject(new Error("Tests must not force the real iOS check")),
};

// A hub that gates as the real one does: with --require-token it makes a token,
// prints its link and refuses every route but /readyz without the Bearer token.
const FAKE_HUB = `import http from 'node:http'; import crypto from 'node:crypto';
const args=process.argv.slice(2), port=Number(args[args.indexOf('--port')+1]);
const token=args.includes('--require-token')?crypto.randomBytes(32).toString('base64url'):undefined;
http.createServer((req,res)=>{const path=new URL(req.url,'http://hub').pathname;
if(token&&path!=='/readyz'&&req.headers.authorization!=='Bearer '+token){res.statusCode=401;res.end('{"ok":false}');return;}
if(path==='/api/devices'){res.setHeader('content-type','application/json');res.end('{"simulators":[],"emulators":[]}');return;}
res.end('ok');}).listen(port,'127.0.0.1',()=>console.log('Expo Device Hub ready\\n\\n  Local:   http://localhost:'+port+(token?'/?token='+token:'')));`;

it.live("the local hub refuses callers without its token, and our calls carry it", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "win32") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcessEnvironment;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-hub-token-" });
    const installDir = path.join(baseDir, "tools/expo-device-hub", DEVICE_HUB_VERSION);
    const entryPath = path.join(installDir, "node_modules/expo-device-hub/dist/server/cli.mjs");
    yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
    yield* fs.writeFileString(path.join(installDir, ".install-complete"), DEVICE_HUB_VERSION);
    yield* fs.writeFileString(entryPath, FAKE_HUB);
    const logged: Array<string> = [];
    const capture = Logger.layer(
      [
        Logger.make(({ message, fiber }) => {
          logged.push(JSON.stringify([message, fiber.getRef(References.CurrentLogAnnotations)]));
        }),
      ],
      { mergeWithExisting: false },
    );
    const host = yield* LocalDeviceHost.make().pipe(
      Effect.provideService(IosSimulatorSetupSupport, iosCheckNotYetAnswered),
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(baseDir, baseDir),
          NetService.layer,
          ProcessRunner.layer,
          FetchHttpClient.layer,
        ),
      ),
      Effect.provideService(HostProcessEnvironment, { ...environment, HOME: baseDir }),
      Effect.provideService(HostProcessPlatform, "linux"),
    );
    yield* Effect.gen(function* () {
      const ready = yield* host.ensureReady(() => Effect.void);
      const token = ready.hub.token ?? "";
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Any other local process, or a web page, is refused.
      const direct = yield* Effect.promise(() => fetch(`${ready.hub.origin}/api/devices`));
      expect(direct.status).toBe(401);
      // The server's own hub calls are let through.
      expect((yield* ready.devices.list).devices).toEqual([]);
      // The hub's output reached the log, but never its token.
      const log = logged.join("\n");
      expect(log).toContain("token=<redacted>");
      expect(log).not.toContain(token);
    }).pipe(
      Effect.ensuring(host.stop),
      Effect.provide(capture),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("hub sockets carry the token on the upgrade", () =>
  Effect.gen(function* () {
    const hub = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new NodeWS.WebSocketServer({
            port: 0,
            verifyClient: ({ req }) => req.headers.authorization === `Bearer ${TOKEN}`,
          }),
      ),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    if (!hub.address())
      yield* Effect.promise(() => new Promise<void>((resolve) => hub.once("listening", resolve)));
    const address = hub.address();
    if (typeof address !== "object" || !address) throw new Error("Missing hub port");
    hub.on("connection", (socket) => socket.send("hello"));
    const url = `ws://127.0.0.1:${address.port}/api/devices/ws`;
    const firstFrame = (token: string | undefined) =>
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* Socket.makeWebSocket(url, { openTimeout: "5 seconds" });
          const { pull } = yield* socket.reader;
          const [frame] = yield* pull;
          return typeof frame === "string" ? frame : new TextDecoder().decode(frame);
        }),
      ).pipe(Effect.provide(hubWebSocketConstructor(token)), Effect.result);
    const accepted = yield* firstFrame(TOKEN);
    expect(accepted._tag === "Success" && accepted.success).toBe("hello");
    expect((yield* firstFrame(undefined))._tag).toBe("Failure");
  }).pipe(Effect.scoped),
);
