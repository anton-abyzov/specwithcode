// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off -- Regression tests construct real Node http/https/tls/net/dgram/crypto/child_process/fetch errors directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeDgram from "node:dgram";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  formatProcessErrorSummary,
  guardSocketSetTypeOfService,
  installDesktopProcessErrorGuards,
  isRecoverableNetworkError,
  isRecoverableSetTypeOfServiceError,
  type ProcessEventTarget,
  type SocketWithTypeOfService,
} from "./DesktopProcessErrorGuard.ts";

function makeSelfSignedCertificate(): { cert: string; key: string } {
  const derLen = (len: number): Buffer => {
    if (len < 0x80) return Buffer.from([len]);
    const bytes: number[] = [];
    let n = len;
    while (n > 0) {
      bytes.unshift(n & 0xff);
      n >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  };
  const derTag = (tag: number, content: Buffer): Buffer =>
    Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
  const derSeq = (...items: Buffer[]): Buffer => derTag(0x30, Buffer.concat(items));
  const derSet = (...items: Buffer[]): Buffer => derTag(0x31, Buffer.concat(items));
  const derInt = (buf: Buffer): Buffer =>
    derTag(0x02, (buf[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
  const derBitString = (buf: Buffer): Buffer =>
    derTag(0x03, Buffer.concat([Buffer.from([0]), buf]));
  const derOid = (bytes: number[]): Buffer => derTag(0x06, Buffer.from(bytes));
  const derUtf8 = (str: string): Buffer => derTag(0x0c, Buffer.from(str, "utf8"));
  const derUtcTime = (str: string): Buffer => derTag(0x17, Buffer.from(str, "ascii"));

  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const algId = derSeq(derOid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
  const name = derSeq(derSet(derSeq(derOid([0x55, 0x04, 0x03]), derUtf8("127.0.0.1"))));
  const validity = derSeq(derUtcTime("250101000000Z"), derUtcTime("350101000000Z"));
  const tbs = derSeq(derInt(Buffer.from([1])), algId, name, validity, name, spki);
  const sig = NodeCrypto.sign("sha256", tbs, privateKey);
  const certDer = derSeq(tbs, algId, derBitString(sig));
  const pemLines = certDer.toString("base64").match(/.{1,64}/gu) ?? [];
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${pemLines.join("\n")}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function makeErrnoError(message: string, code: string, syscall?: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  if (syscall !== undefined) {
    error.syscall = syscall;
  }
  return error;
}

describe("guardSocketSetTypeOfService", () => {
  it("suppresses recoverable socket errnos, preserves chaining return value, rate-limits warnings, and delegates normal calls", () => {
    const calls: number[] = [];
    let shouldFailWith: Error | null = null;
    const fakeSocket = {} as NodeNet.Socket;
    const proto: { setTypeOfService: (this: NodeNet.Socket, tos: number) => NodeNet.Socket } = {
      setTypeOfService(this: NodeNet.Socket, tos: number) {
        calls.push(tos);
        if (shouldFailWith !== null) {
          throw shouldFailWith;
        }
        return this;
      },
    };
    const warnings: string[] = [];
    let currentTime = 1_000;

    const dispose = guardSocketSetTypeOfService({
      socketPrototype: proto,
      logWarning: (message) => warnings.push(message),
      now: () => currentTime,
      minLogIntervalMs: 60_000,
    });

    // Normal calls pass through unchanged and preserve socket chaining.
    expect(proto.setTypeOfService.call(fakeSocket, 0)).toBe(fakeSocket);
    expect(calls).toEqual([0]);
    expect(warnings).toHaveLength(0);

    // Exact macOS undici crash: setTypeOfService EINVAL does not throw and returns this.
    shouldFailWith = makeErrnoError("setTypeOfService EINVAL", "EINVAL", "setTypeOfService");
    expect(proto.setTypeOfService.call(fakeSocket, 0)).toBe(fakeSocket);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("setTypeOfService(0)");
    expect(warnings[0]).toContain("EINVAL");

    // ENOTSUP, EPIPE, and EBADF are also suppressed inline within the rate-limit window.
    currentTime += 10_000;
    shouldFailWith = makeErrnoError("setTypeOfService ENOTSUP", "ENOTSUP", "setTypeOfService");
    expect(proto.setTypeOfService.call(fakeSocket, 0)).toBe(fakeSocket);
    shouldFailWith = makeErrnoError("setTypeOfService EPIPE", "EPIPE", "setTypeOfService");
    expect(proto.setTypeOfService.call(fakeSocket, 0)).toBe(fakeSocket);
    shouldFailWith = makeErrnoError("setTypeOfService EBADF", "EBADF", "setTypeOfService");
    expect(proto.setTypeOfService.call(fakeSocket, 0)).toBe(fakeSocket);
    expect(warnings).toHaveLength(1);

    currentTime += 60_000;
    expect(proto.setTypeOfService.call(fakeSocket, 0)).toBe(fakeSocket);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("3 similar errors suppressed");

    // Non-socket programming errors (e.g. invalid argument type) still throw.
    shouldFailWith = makeErrnoError(
      'The "tos" argument must be of type number',
      "ERR_INVALID_ARG_TYPE",
    );
    expect(() => proto.setTypeOfService.call(fakeSocket, 0)).toThrow("must be of type number");

    // Idempotent second install is a no-op; dispose restores original method.
    const secondDispose = guardSocketSetTypeOfService({ socketPrototype: proto });
    secondDispose();
    dispose();
    shouldFailWith = makeErrnoError("setTypeOfService EINVAL", "EINVAL", "setTypeOfService");
    expect(() => proto.setTypeOfService.call(fakeSocket, 0)).toThrow("setTypeOfService EINVAL");
  });
});

describe("isRecoverableNetworkError", () => {
  it("recognizes setTypeOfService EINVAL and undici/socket/TLS/DNS errors", () => {
    expect(
      isRecoverableSetTypeOfServiceError(
        makeErrnoError("setTypeOfService EINVAL", "EINVAL", "setTypeOfService"),
      ),
    ).toBe(true);
    expect(
      isRecoverableNetworkError(
        makeErrnoError("setTypeOfService EINVAL", "EINVAL", "setTypeOfService"),
      ),
    ).toBe(true);
    expect(isRecoverableNetworkError(makeErrnoError("read ECONNRESET", "ECONNRESET", "read"))).toBe(
      true,
    );
    const socketEpipe = makeErrnoError("write EPIPE", "EPIPE", "write");
    socketEpipe.stack = "Error: write EPIPE\n    at Socket._writeGeneric (node:net:950:19)";
    expect(isRecoverableNetworkError(socketEpipe)).toBe(true);
    expect(
      isRecoverableNetworkError(makeErrnoError("connect ETIMEDOUT", "ETIMEDOUT", "connect")),
    ).toBe(true);
    const socketReadTimeout = makeErrnoError("read ETIMEDOUT", "ETIMEDOUT", "read");
    socketReadTimeout.stack = "Error: read ETIMEDOUT\n    at Socket._read (node:net:812:19)";
    expect(isRecoverableNetworkError(socketReadTimeout)).toBe(true);
    expect(
      isRecoverableNetworkError(
        makeErrnoError("spawnSync /bin/sleep ETIMEDOUT", "ETIMEDOUT", "spawnSync /bin/sleep"),
      ),
    ).toBe(false);
    expect(isRecoverableNetworkError(makeErrnoError("getaddrinfo ENOTFOUND", "ENOTFOUND"))).toBe(
      true,
    );
    expect(isRecoverableNetworkError(makeErrnoError("socket closed", "UND_ERR_SOCKET"))).toBe(true);
    expect(
      isRecoverableNetworkError(
        makeErrnoError("socket connect timeout", "ERR_SOCKET_CONNECTION_TIMEOUT"),
      ),
    ).toBe(true);
    expect(
      isRecoverableNetworkError(
        makeErrnoError(
          "Socket closed before the connection was established",
          "ERR_SOCKET_CLOSED_BEFORE_CONNECTION",
        ),
      ),
    ).toBe(true);
    expect(isRecoverableNetworkError(makeErrnoError("closed", "ERR_SOCKET_CLOSED"))).toBe(false);
    expect(isRecoverableNetworkError(makeErrnoError("closed", "UND_ERR_CLOSED"))).toBe(false);
    expect(isRecoverableNetworkError(makeErrnoError("destroyed", "UND_ERR_DESTROYED"))).toBe(false);
    expect(
      isRecoverableNetworkError(
        new TypeError("fetch failed", {
          cause: makeErrnoError("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED", "connect"),
        }),
      ),
    ).toBe(true);
    expect(isRecoverableNetworkError(new Error("socket hang up"))).toBe(true);
    expect(
      isRecoverableNetworkError(
        new AggregateError([
          makeErrnoError("connect ECONNREFUSED ::1:80", "ECONNREFUSED", "connect"),
          makeErrnoError("connect ECONNREFUSED 127.0.0.1:80", "ECONNREFUSED", "connect"),
        ]),
      ),
    ).toBe(true);
    expect(
      isRecoverableNetworkError(
        new TypeError("fetch failed", {
          cause: new AggregateError([
            makeErrnoError("connect ECONNREFUSED ::1:80", "ECONNREFUSED", "connect"),
            makeErrnoError("connect ECONNREFUSED 127.0.0.1:80", "ECONNREFUSED", "connect"),
          ]),
        }),
      ),
    ).toBe(true);

    // EINVAL with an undici/net stack frame is recoverable, but unrelated EINVAL is not.
    const undiciEinval = makeErrnoError("EINVAL", "EINVAL");
    undiciEinval.stack =
      "Error: EINVAL\n    at Socket.setTypeOfService (node:net:913:13)\n    at writeH1 (node:internal/deps/undici/undici:8021:16)";
    expect(isRecoverableNetworkError(undiciEinval)).toBe(true);
  });

  it("does not misclassify fatal non-network programming or filesystem errors", () => {
    expect(isRecoverableNetworkError(new TypeError("Cannot read properties of undefined"))).toBe(
      false,
    );
    expect(isRecoverableNetworkError(new RangeError("Maximum call stack size exceeded"))).toBe(
      false,
    );
    const fsEinval = makeErrnoError("EINVAL: invalid argument, open '/bad'", "EINVAL", "open");
    fsEinval.stack = "Error: EINVAL\n    at Object.openSync (node:fs:581:18)";
    expect(isRecoverableNetworkError(fsEinval)).toBe(false);

    // Filesystem read/write EBADF must NOT be misclassified even inside a TCP callback stack.
    const fsReadEbadf = makeErrnoError("EBADF: bad file descriptor, read", "EBADF", "read");
    fsReadEbadf.stack =
      "Error: EBADF\n    at Object.readSync (node:fs:750:18)\n    at TCP.onconnection (node:net:2302:8)";
    expect(isRecoverableNetworkError(fsReadEbadf)).toBe(false);

    const fsWriteEbadf = makeErrnoError("EBADF: bad file descriptor, write", "EBADF", "write");
    fsWriteEbadf.stack = "Error: EBADF\n    at Object.writeSync (node:fs:910:18)";
    expect(isRecoverableNetworkError(fsWriteEbadf)).toBe(false);

    // Filesystem/FIFO EPIPE must NOT be misclassified as a transient network error.
    const fsWriteEpipe = makeErrnoError("EPIPE: broken pipe, write", "EPIPE", "write");
    fsWriteEpipe.stack =
      "Error: EPIPE: broken pipe, write\n    at Object.writeSync (node:fs:910:18)";
    expect(isRecoverableNetworkError(fsWriteEpipe)).toBe(false);

    // Explicit programming errors with a recoverable network cause must NOT recover.
    const networkCause = makeErrnoError(
      "connect ECONNREFUSED 127.0.0.1:80",
      "ECONNREFUSED",
      "connect",
    );
    const rangeWithNetworkCause = Object.assign(new RangeError("Invalid buffer size"), {
      code: "ERR_OUT_OF_RANGE",
      cause: networkCause,
    });
    expect(isRecoverableNetworkError(rangeWithNetworkCause)).toBe(false);
    expect(
      isRecoverableNetworkError(
        new TypeError("Cannot read properties of undefined", { cause: networkCause }),
      ),
    ).toBe(false);

    // HTTP / undici programming errors (including headers named "setTypeOfService"
    // or "socket hang up") must NOT be misclassified as transient transport failures.
    for (const [headerName, headerValue] of [
      ["x-review", undefined],
      ["setTypeOfService", undefined],
      ["socket hang up", "a"],
    ] as const) {
      let headerError: unknown;
      try {
        new NodeHttp.ServerResponse({ method: "GET" } as NodeHttp.IncomingMessage).setHeader(
          headerName,
          headerValue as unknown as string,
        );
      } catch (error) {
        headerError = error;
      }
      expect(headerError).toBeDefined();
      expect(isRecoverableNetworkError(headerError)).toBe(false);
    }
    expect(
      isRecoverableNetworkError(makeErrnoError("invalid argument", "UND_ERR_INVALID_ARG")),
    ).toBe(false);

    // Local TLS configuration errors (ERR_SSL_NO_CIPHER_MATCH) must NOT be misclassified.
    let tlsConfigError: unknown;
    try {
      NodeTls.createSecureContext({ ciphers: "not-a-cipher" });
    } catch (error) {
      tlsConfigError = error;
    }
    expect(tlsConfigError).toBeDefined();
    expect(isRecoverableNetworkError(tlsConfigError)).toBe(false);

    // Bare "fetch failed" without a recoverable network cause must NOT bypass classification.
    expect(isRecoverableNetworkError(new TypeError("fetch failed"))).toBe(false);
    expect(
      isRecoverableNetworkError(
        new TypeError("fetch failed", { cause: new TypeError("Invalid URL") }),
      ),
    ).toBe(false);

    // Mixed or empty AggregateError must NOT let a recoverable network member mask a fatal error.
    expect(
      isRecoverableNetworkError(
        new AggregateError([
          makeErrnoError("connect ECONNREFUSED 127.0.0.1:80", "ECONNREFUSED", "connect"),
          new TypeError("Cannot read properties of undefined"),
        ]),
      ),
    ).toBe(false);
    expect(isRecoverableNetworkError(new AggregateError([]))).toBe(false);

    expect(isRecoverableNetworkError(null)).toBe(false);
  });

  it("handles cyclic cause chains without looping", () => {
    const a = new Error("outer") as Error & { cause?: unknown };
    const b = new Error("inner") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isRecoverableNetworkError(a)).toBe(false);
  });
});

describe("installDesktopProcessErrorGuards", () => {
  it("recovers from non-fatal network uncaughtException and unhandledRejection without exiting", () => {
    const fakeProcess = new NodeEvents.EventEmitter();
    const warnings: string[] = [];
    const errors: string[] = [];
    const onFatalError = vi.fn();
    let currentTime = 1_000;
    const proto: SocketWithTypeOfService = {
      setTypeOfService() {
        throw makeErrnoError("setTypeOfService EINVAL", "EINVAL", "setTypeOfService");
      },
    };

    const dispose = installDesktopProcessErrorGuards({
      targetProcess: fakeProcess,
      isOffscreenTest: () => false,
      socketPrototype: proto,
      logWarning: (message) => warnings.push(message),
      logError: (message) => errors.push(message),
      onFatalError,
      now: () => currentTime,
      minLogIntervalMs: 60_000,
    });

    // Guarded setTypeOfService recovers inline.
    expect(() => proto.setTypeOfService?.call({} as NodeNet.Socket, 0)).not.toThrow();

    // Escaped network uncaughtException recovers and rate-limits repeated warnings.
    for (let i = 0; i < 4; i += 1) {
      fakeProcess.emit(
        "uncaughtException",
        makeErrnoError("setTypeOfService EINVAL", "EINVAL", "setTypeOfService"),
        "uncaughtException",
      );
    }
    fakeProcess.emit(
      "uncaughtException",
      makeErrnoError("Socket connection timeout", "ERR_SOCKET_CONNECTION_TIMEOUT"),
      "uncaughtException",
    );
    expect(onFatalError).not.toHaveBeenCalled();

    // Network unhandledRejection recovers and rate-limits repeated warnings.
    for (let i = 0; i < 4; i += 1) {
      fakeProcess.emit(
        "unhandledRejection",
        new TypeError("fetch failed", {
          cause: makeErrnoError("read ECONNRESET", "ECONNRESET", "read"),
        }),
      );
    }
    expect(onFatalError).not.toHaveBeenCalled();
    // 1 warning from setTypeOfService + 1 from uncaughtException + 1 from unhandledRejection.
    expect(warnings).toHaveLength(3);
    expect(errors).toHaveLength(0);

    // After the rate-limit window, suppressed counts are reported on each hook.
    currentTime += 60_000;
    fakeProcess.emit(
      "uncaughtException",
      makeErrnoError("setTypeOfService EINVAL", "EINVAL", "setTypeOfService"),
      "uncaughtException",
    );
    fakeProcess.emit(
      "unhandledRejection",
      new TypeError("fetch failed", {
        cause: makeErrnoError("read ECONNRESET", "ECONNRESET", "read"),
      }),
    );
    expect(warnings).toHaveLength(5);
    expect(warnings[3]).toContain("4 similar errors suppressed");
    expect(warnings[4]).toContain("3 similar errors suppressed");

    // Non-network unhandledRejection logs an error without crashing the desktop app,
    // including null-prototype rejection reasons and objects with throwing getters.
    fakeProcess.emit("unhandledRejection", new Error("unexpected rejection"));
    expect(() => fakeProcess.emit("unhandledRejection", Object.create(null))).not.toThrow();
    const throwingGetterRejection = {
      get code(): string {
        throw new Error("code getter threw");
      },
      get stack(): string {
        throw new Error("stack getter threw");
      },
      get cause(): unknown {
        throw new Error("cause getter threw");
      },
    };
    expect(() => fakeProcess.emit("unhandledRejection", throwingGetterRejection)).not.toThrow();
    const nestedThrowingErrors: unknown[] = [];
    Object.defineProperty(nestedThrowingErrors, 0, {
      enumerable: true,
      get() {
        throw new Error("nested error getter threw");
      },
    });
    expect(() =>
      fakeProcess.emit("unhandledRejection", { errors: nestedThrowingErrors }),
    ).not.toThrow();
    expect(onFatalError).not.toHaveBeenCalled();
    expect(errors).toHaveLength(4);

    // Fatal non-network uncaughtException logs and invokes onFatalError once.
    const fatal = new TypeError("Cannot read properties of null");
    fakeProcess.emit("uncaughtException", fatal, "uncaughtException");
    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(onFatalError).toHaveBeenCalledWith(fatal, "uncaughtException");
    expect(errors).toHaveLength(5);

    dispose();
    expect(fakeProcess.listenerCount("uncaughtException")).toBe(0);
    expect(fakeProcess.listenerCount("unhandledRejection")).toBe(0);
  });

  it("escalates mixed AggregateError uncaughtException directly and behind network wrappers", () => {
    const makeMixedAggregate = () =>
      new AggregateError([
        makeErrnoError("connect ECONNREFUSED 127.0.0.1:80", "ECONNREFUSED", "connect"),
        new TypeError("Cannot read properties of undefined"),
      ]);

    const cases: unknown[] = [
      makeMixedAggregate(),
      new Error("socket hang up", { cause: makeMixedAggregate() }),
      new AggregateError(
        [makeErrnoError("connect ECONNREFUSED 127.0.0.1:80", "ECONNREFUSED", "connect")],
        "outer network aggregate",
        { cause: makeMixedAggregate() },
      ),
      Object.assign(new RangeError("Invalid buffer size"), {
        code: "ERR_OUT_OF_RANGE",
        cause: makeErrnoError("connect ECONNREFUSED 127.0.0.1:80", "ECONNREFUSED", "connect"),
      }),
      Object.assign(makeErrnoError("EPIPE: broken pipe, write", "EPIPE", "write"), {
        stack: "Error: EPIPE: broken pipe, write\n    at Object.writeSync (node:fs:910:18)",
      }),
      Object.assign(new Error("Not running"), { code: "ERR_SOCKET_DGRAM_NOT_RUNNING" }),
      Object.assign(
        new TypeError(
          "The \"tos\" argument must be of type number. Received type string ('setTypeOfService EINVAL')",
        ),
        { code: "ERR_INVALID_ARG_TYPE" },
      ),
    ];

    for (const fatalCandidate of cases) {
      const fakeProcess = new NodeEvents.EventEmitter();
      const warnings: string[] = [];
      const errors: string[] = [];
      const onFatalError = vi.fn();

      const dispose = installDesktopProcessErrorGuards({
        targetProcess: fakeProcess,
        isOffscreenTest: () => false,
        socketPrototype: {},
        logWarning: (message) => warnings.push(message),
        logError: (message) => errors.push(message),
        onFatalError,
      });

      fakeProcess.emit("uncaughtException", fatalCandidate, "uncaughtException");
      expect(onFatalError).toHaveBeenCalledTimes(1);
      expect(onFatalError).toHaveBeenCalledWith(fatalCandidate, "uncaughtException");
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);

      dispose();
    }
  });

  it("rethrows setTypeOfService ERR_INVALID_ARG_TYPE even when invalid input mentions setTypeOfService EINVAL", () => {
    const warnings: string[] = [];
    const argTypeError = Object.assign(
      new TypeError(
        "The \"tos\" argument must be of type number. Received type string ('setTypeOfService EINVAL')",
      ),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
    const proto: SocketWithTypeOfService = {
      setTypeOfService() {
        throw argTypeError;
      },
    };
    const dispose = guardSocketSetTypeOfService({
      socketPrototype: proto,
      logWarning: (message) => warnings.push(message),
    });
    try {
      expect(() =>
        proto.setTypeOfService?.call(
          {} as NodeNet.Socket,
          "setTypeOfService EINVAL" as unknown as number,
        ),
      ).toThrow(argTypeError);
      expect(isRecoverableSetTypeOfServiceError(argTypeError)).toBe(false);
      expect(warnings).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("treats real closed UDP socket ERR_SOCKET_DGRAM_NOT_RUNNING as fatal", async () => {
    const udp = NodeDgram.createSocket("udp4");
    await new Promise<void>((resolve) => udp.close(resolve));
    let caught: unknown;
    try {
      udp.send(Buffer.from("x"), 9, "127.0.0.1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as NodeJS.ErrnoException).code).toBe("ERR_SOCKET_DGRAM_NOT_RUNNING");
    expect(isRecoverableNetworkError(caught)).toBe(false);
  });

  it("recovers real TCP socket write EPIPE while escalating subprocess stdin pipe write EPIPE", async () => {
    const fakeProcess = new NodeEvents.EventEmitter();
    const warnings: string[] = [];
    const errors: string[] = [];
    const onFatalError = vi.fn();

    const dispose = installDesktopProcessErrorGuards({
      targetProcess: fakeProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      logWarning: (message) => warnings.push(message),
      logError: (message) => errors.push(message),
      onFatalError,
    });

    try {
      // 1. Real subprocess stdin pipe EPIPE must escalate as fatal.
      const pipeError = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.exit(0)"], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for pipe EPIPE")),
          5000,
        );
        child.stdin.once("error", (err: NodeJS.ErrnoException) => {
          clearTimeout(timeout);
          resolve(err);
        });
        child.stdin.write(Buffer.alloc(1024 * 1024));
      });

      // Windows reports a write to a closed child pipe as EOF.
      expect(pipeError.code).toBe(process.platform === "win32" ? "EOF" : "EPIPE");
      expect(isRecoverableNetworkError(pipeError)).toBe(false);
      fakeProcess.emit("uncaughtException", pipeError, "uncaughtException");
      expect(onFatalError).toHaveBeenCalledTimes(1);
      expect(onFatalError).toHaveBeenCalledWith(pipeError, "uncaughtException");

      // 2. Real loopback TCP socket write EPIPE must recover without invoking onFatalError.
      const tcpError = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        let client: NodeNet.Socket | undefined;
        let writer: ReturnType<typeof setInterval> | undefined;
        let settled = false;

        const server = NodeNet.createServer((socket) => {
          socket.destroy();
        });

        const cleanup = () => {
          clearTimeout(timeout);
          if (writer !== undefined) {
            clearInterval(writer);
            writer = undefined;
          }
          client?.destroy();
          server.close();
        };

        const finish = (
          outcome: { ok: true; value: NodeJS.ErrnoException } | { ok: false; err: Error },
        ) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (outcome.ok) {
            resolve(outcome.value);
          } else {
            reject(outcome.err);
          }
        };

        const timeout = setTimeout(
          () => finish({ ok: false, err: new Error("Timed out waiting for TCP EPIPE") }),
          5000,
        );

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            finish({ ok: false, err: new Error("Unexpected server address") });
            return;
          }
          // allowHalfOpen keeps the client writable after peer FIN so writing triggers EPIPE.
          client = NodeNet.createConnection({
            host: "127.0.0.1",
            port: address.port,
            allowHalfOpen: true,
          });
          client.once("error", (err: NodeJS.ErrnoException) => {
            finish({ ok: true, value: err });
          });
          client.once("end", () => {
            const writeChunk = () => {
              if (client && !client.destroyed) {
                client.write(Buffer.alloc(64 * 1024));
              }
            };
            writeChunk();
            writer = setInterval(writeChunk, 5);
          });
        });
      });

      // Windows reports a write to a socket the peer closed as ECONNABORTED or ECONNRESET.
      expect(process.platform === "win32" ? ["ECONNABORTED", "ECONNRESET", "EPIPE"] : ["EPIPE"]).toContain(tcpError.code);
      expect(isRecoverableNetworkError(tcpError)).toBe(true);
      fakeProcess.emit("uncaughtException", tcpError, "uncaughtException");
      expect(onFatalError).toHaveBeenCalledTimes(1);
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      dispose();
    }
  });

  it("escalates local TCP ERR_STREAM_WRITE_AFTER_END as fatal", async () => {
    const fakeProcess = new NodeEvents.EventEmitter();
    const warnings: string[] = [];
    const errors: string[] = [];
    const onFatalError = vi.fn();

    const dispose = installDesktopProcessErrorGuards({
      targetProcess: fakeProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      logWarning: (message) => warnings.push(message),
      logError: (message) => errors.push(message),
      onFatalError,
    });

    try {
      const writeAfterEndError = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        let client: NodeNet.Socket | undefined;
        let serverSocket: NodeNet.Socket | undefined;
        let settled = false;

        const server = NodeNet.createServer((socket) => {
          serverSocket = socket;
          socket.resume();
        });

        const cleanup = () => {
          clearTimeout(timeout);
          client?.destroy();
          serverSocket?.destroy();
          server.close();
        };

        const finish = (
          outcome: { ok: true; value: NodeJS.ErrnoException } | { ok: false; err: Error },
        ) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (outcome.ok) {
            resolve(outcome.value);
          } else {
            reject(outcome.err);
          }
        };

        const timeout = setTimeout(
          () =>
            finish({ ok: false, err: new Error("Timed out waiting for write-after-end error") }),
          5000,
        );

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            finish({ ok: false, err: new Error("Unexpected server address") });
            return;
          }
          client = NodeNet.connect(address.port, "127.0.0.1", () => {
            client?.once("error", (err: NodeJS.ErrnoException) => {
              finish({ ok: true, value: err });
            });
            client?.end();
            client?.write("after-end");
          });
        });
      });

      expect(writeAfterEndError.code).toBe("ERR_STREAM_WRITE_AFTER_END");
      expect(isRecoverableNetworkError(writeAfterEndError)).toBe(false);
      fakeProcess.emit("uncaughtException", writeAfterEndError, "uncaughtException");
      expect(onFatalError).toHaveBeenCalledTimes(1);
      expect(onFatalError).toHaveBeenCalledWith(writeAfterEndError, "uncaughtException");
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("escalates writing to an unopened net.Socket (ERR_SOCKET_CLOSED) as fatal", async () => {
    const fakeProcess = new NodeEvents.EventEmitter();
    const warnings: string[] = [];
    const errors: string[] = [];
    const onFatalError = vi.fn();

    const dispose = installDesktopProcessErrorGuards({
      targetProcess: fakeProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      logWarning: (message) => warnings.push(message),
      logError: (message) => errors.push(message),
      onFatalError,
    });

    try {
      const unopenedSocket = new NodeNet.Socket();
      const socketClosedError = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for ERR_SOCKET_CLOSED")),
          5000,
        );
        unopenedSocket.once("error", (err: NodeJS.ErrnoException) => {
          clearTimeout(timeout);
          resolve(err);
        });
        unopenedSocket.write("never-connected");
      });
      unopenedSocket.destroy();

      expect(socketClosedError.code).toBe("ERR_SOCKET_CLOSED");
      expect(isRecoverableNetworkError(socketClosedError)).toBe(false);
      fakeProcess.emit("uncaughtException", socketClosedError, "uncaughtException");
      expect(onFatalError).toHaveBeenCalledTimes(1);
      expect(onFatalError).toHaveBeenCalledWith(socketClosedError, "uncaughtException");
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("escalates local subprocess ETIMEDOUT as fatal while recovering network ETIMEDOUT", () => {
    const fakeProcess = new NodeEvents.EventEmitter();
    const warnings: string[] = [];
    const errors: string[] = [];
    const onFatalError = vi.fn();

    const dispose = installDesktopProcessErrorGuards({
      targetProcess: fakeProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      logWarning: (message) => warnings.push(message),
      logError: (message) => errors.push(message),
      onFatalError,
    });

    try {
      const networkTimeout = makeErrnoError("connect ETIMEDOUT", "ETIMEDOUT", "connect");
      fakeProcess.emit("uncaughtException", networkTimeout, "uncaughtException");
      expect(onFatalError).not.toHaveBeenCalled();
      expect(warnings).toHaveLength(1);

      let subprocessError: NodeJS.ErrnoException | undefined;
      try {
        NodeChildProcess.execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
          timeout: 50,
          stdio: "ignore",
        });
      } catch (error) {
        subprocessError = error as NodeJS.ErrnoException;
      }

      expect(subprocessError?.code).toBe("ETIMEDOUT");
      expect(isRecoverableNetworkError(subprocessError)).toBe(false);
      fakeProcess.emit("uncaughtException", subprocessError, "uncaughtException");
      expect(onFatalError).toHaveBeenCalledTimes(1);
      expect(onFatalError).toHaveBeenCalledWith(subprocessError, "uncaughtException");
      expect(errors).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("preserves --unhandled-rejections=throw for non-network rejections while recovering network rejections", () => {
    const fakeProcess = new NodeEvents.EventEmitter();
    const warnings: string[] = [];
    const errors: string[] = [];
    const onFatalError = vi.fn();

    const dispose = installDesktopProcessErrorGuards({
      targetProcess: fakeProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      execArgv: ["--unhandled-rejections=throw"],
      nodeOptions: undefined,
      logWarning: (message) => warnings.push(message),
      logError: (message) => errors.push(message),
      onFatalError,
    });

    try {
      fakeProcess.emit(
        "unhandledRejection",
        new TypeError("fetch failed", {
          cause: makeErrnoError("read ECONNRESET", "ECONNRESET", "read"),
        }),
      );
      expect(onFatalError).not.toHaveBeenCalled();
      expect(warnings).toHaveLength(1);

      const fatalRejection = new TypeError("Cannot read properties of undefined (reading 'foo')");
      fakeProcess.emit("unhandledRejection", fatalRejection);
      expect(onFatalError).toHaveBeenCalledTimes(1);
      expect(onFatalError).toHaveBeenCalledWith(fatalRejection, "unhandledRejection");
      expect(errors).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("parses space-separated --unhandled-rejections flags and honors CLI overrides over NODE_OPTIONS", () => {
    const fatalProcess = new NodeEvents.EventEmitter();
    const onFatalThrow = vi.fn();
    const disposeThrow = installDesktopProcessErrorGuards({
      targetProcess: fatalProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      execArgv: ["--unhandled-rejections", "throw"],
      nodeOptions: undefined,
      logWarning: () => undefined,
      logError: () => undefined,
      onFatalError: onFatalThrow,
    });

    try {
      const fatalRejection = new TypeError("space-separated throw");
      fatalProcess.emit("unhandledRejection", fatalRejection);
      expect(onFatalThrow).toHaveBeenCalledTimes(1);
      expect(onFatalThrow).toHaveBeenCalledWith(fatalRejection, "unhandledRejection");
    } finally {
      disposeThrow();
    }

    const warnProcess = new NodeEvents.EventEmitter();
    const onFatalWarn = vi.fn();
    const disposeWarn = installDesktopProcessErrorGuards({
      targetProcess: warnProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      execArgv: ["--unhandled-rejections", "warn"],
      nodeOptions: "--unhandled-rejections=throw",
      logWarning: () => undefined,
      logError: () => undefined,
      onFatalError: onFatalWarn,
    });

    try {
      warnProcess.emit("unhandledRejection", new TypeError("cli warn overrides env throw"));
      expect(onFatalWarn).not.toHaveBeenCalled();
    } finally {
      disposeWarn();
    }

    const quotedThrowProcess = new NodeEvents.EventEmitter();
    const onFatalQuotedThrow = vi.fn();
    const disposeQuotedThrow = installDesktopProcessErrorGuards({
      targetProcess: quotedThrowProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      execArgv: [],
      nodeOptions: '--unhandled-rejections="throw"',
      logWarning: () => undefined,
      logError: () => undefined,
      onFatalError: onFatalQuotedThrow,
    });

    try {
      const fatalRejection = new TypeError("quoted NODE_OPTIONS throw");
      quotedThrowProcess.emit("unhandledRejection", fatalRejection);
      expect(onFatalQuotedThrow).toHaveBeenCalledTimes(1);
      expect(onFatalQuotedThrow).toHaveBeenCalledWith(fatalRejection, "unhandledRejection");
    } finally {
      disposeQuotedThrow();
    }

    const quotedWarnProcess = new NodeEvents.EventEmitter();
    const onFatalQuotedWarn = vi.fn();
    const disposeQuotedWarn = installDesktopProcessErrorGuards({
      targetProcess: quotedWarnProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      execArgv: [],
      nodeOptions: '--unhandled-rejections=throw "--unhandled-rejections=warn"',
      logWarning: () => undefined,
      logError: () => undefined,
      onFatalError: onFatalQuotedWarn,
    });

    try {
      quotedWarnProcess.emit("unhandledRejection", new TypeError("quoted NODE_OPTIONS warn"));
      expect(onFatalQuotedWarn).not.toHaveBeenCalled();
    } finally {
      disposeQuotedWarn();
    }
  });

  it("recovers canceled pending TCP connection (ERR_SOCKET_CLOSED_BEFORE_CONNECTION)", async () => {
    const fakeProcess = new NodeEvents.EventEmitter();
    const warnings: string[] = [];
    const onFatalError = vi.fn();

    const dispose = installDesktopProcessErrorGuards({
      targetProcess: fakeProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      logWarning: (message) => warnings.push(message),
      logError: () => undefined,
      onFatalError,
    });

    try {
      const preConnectError = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        let client: NodeNet.Socket | undefined;
        let settled = false;
        const server = NodeNet.createServer((socket) => {
          socket.destroy();
        });

        const finish = (
          outcome: { ok: true; value: NodeJS.ErrnoException } | { ok: false; err: Error },
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          client?.destroy();
          server.close();
          if (outcome.ok) {
            resolve(outcome.value);
          } else {
            reject(outcome.err);
          }
        };

        const timeout = setTimeout(
          () =>
            finish({
              ok: false,
              err: new Error("Timed out waiting for ERR_SOCKET_CLOSED_BEFORE_CONNECTION"),
            }),
          5000,
        );

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            finish({ ok: false, err: new Error("Unexpected server address") });
            return;
          }
          client = NodeNet.connect(address.port, "127.0.0.1");
          client.on("error", () => undefined);
          client.write("pending-write", (err) => {
            if (err) {
              finish({ ok: true, value: err as NodeJS.ErrnoException });
            }
          });
          client.destroy();
        });
      });

      expect(preConnectError.code).toBe("ERR_SOCKET_CLOSED_BEFORE_CONNECTION");
      expect(isRecoverableNetworkError(preConnectError)).toBe(true);
      fakeProcess.emit("uncaughtException", preConnectError, "uncaughtException");
      expect(onFatalError).not.toHaveBeenCalled();
      expect(warnings).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("recovers TLS peer disconnect with queued write (write ECANCELED)", async () => {
    const fakeProcess = new NodeEvents.EventEmitter();
    const warnings: string[] = [];
    const onFatalError = vi.fn();

    const dispose = installDesktopProcessErrorGuards({
      targetProcess: fakeProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      logWarning: (message) => warnings.push(message),
      logError: () => undefined,
      onFatalError,
    });

    try {
      const tlsWriteError = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        let client: NodeTls.TLSSocket | undefined;
        let settled = false;
        const server = NodeNet.createServer((socket) => {
          socket.destroy();
        });

        const finish = (
          outcome: { ok: true; value: NodeJS.ErrnoException } | { ok: false; err: Error },
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          client?.destroy();
          server.close();
          if (outcome.ok) {
            resolve(outcome.value);
          } else {
            reject(outcome.err);
          }
        };

        const timeout = setTimeout(
          () =>
            finish({
              ok: false,
              err: new Error("Timed out waiting for TLS peer-close write error"),
            }),
          5000,
        );

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            finish({ ok: false, err: new Error("Unexpected server address") });
            return;
          }
          client = NodeTls.connect({
            host: "127.0.0.1",
            port: address.port,
            rejectUnauthorized: false,
          });
          client.on("error", () => undefined);
          client.write("queued-before-handshake", (err) => {
            if (err) {
              finish({ ok: true, value: err as NodeJS.ErrnoException });
            }
          });
        });
      });

      expect(tlsWriteError.code).toBe("ECANCELED");
      expect(isRecoverableNetworkError(tlsWriteError)).toBe(true);
      fakeProcess.emit("uncaughtException", tlsWriteError, "uncaughtException");
      expect(onFatalError).not.toHaveBeenCalled();
      expect(warnings).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("does not split tabs in NODE_OPTIONS and honors warn-with-error-code deferred exit status", () => {
    const tabThrowProcess = new NodeEvents.EventEmitter();
    const onFatalTabThrow = vi.fn();
    const disposeTabThrow = installDesktopProcessErrorGuards({
      targetProcess: tabThrowProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      execArgv: [],
      nodeOptions: "--unhandled-rejections=throw --title=worker\t--unhandled-rejections=warn",
      logWarning: () => undefined,
      logError: () => undefined,
      onFatalError: onFatalTabThrow,
    });

    try {
      const fatalRejection = new TypeError("tab inside title must not switch throw to warn");
      tabThrowProcess.emit("unhandledRejection", fatalRejection);
      expect(onFatalTabThrow).toHaveBeenCalledTimes(1);
      expect(onFatalTabThrow).toHaveBeenCalledWith(fatalRejection, "unhandledRejection");
    } finally {
      disposeTabThrow();
    }

    const tabWarnProcess = new NodeEvents.EventEmitter();
    const onFatalTabWarn = vi.fn();
    const disposeTabWarn = installDesktopProcessErrorGuards({
      targetProcess: tabWarnProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      execArgv: [],
      nodeOptions: "--unhandled-rejections=warn --title=worker\t--unhandled-rejections=throw",
      logWarning: () => undefined,
      logError: () => undefined,
      onFatalError: onFatalTabWarn,
    });

    try {
      tabWarnProcess.emit(
        "unhandledRejection",
        new TypeError("tab inside title must not switch warn to throw"),
      );
      expect(onFatalTabWarn).not.toHaveBeenCalled();
    } finally {
      disposeTabWarn();
    }

    const warnExitProcess = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter &
      ProcessEventTarget;
    const onFatalWarnExit = vi.fn();
    const errors: string[] = [];
    const warnings: string[] = [];
    const disposeWarnExit = installDesktopProcessErrorGuards({
      targetProcess: warnExitProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      execArgv: [],
      nodeOptions: "--unhandled-rejections=warn-with-error-code",
      logWarning: (message) => warnings.push(message),
      logError: (message) => errors.push(message),
      onFatalError: onFatalWarnExit,
    });

    try {
      warnExitProcess.emit(
        "unhandledRejection",
        new TypeError("fetch failed", {
          cause: makeErrnoError("read ECONNRESET", "ECONNRESET", "read"),
        }),
      );
      expect(warnExitProcess.exitCode).toBeUndefined();
      expect(onFatalWarnExit).not.toHaveBeenCalled();
      expect(warnings).toHaveLength(1);

      warnExitProcess.emit("unhandledRejection", new TypeError("non-network rejection"));
      expect(onFatalWarnExit).not.toHaveBeenCalled();
      expect(warnExitProcess.exitCode).toBe(1);
      expect(errors).toHaveLength(1);

      // Node unconditionally replaces an existing non-zero exitCode with 1 in warn-with-error-code mode.
      warnExitProcess.exitCode = 7;
      warnExitProcess.emit("unhandledRejection", new TypeError("overrides existing exitCode"));
      expect(onFatalWarnExit).not.toHaveBeenCalled();
      expect(warnExitProcess.exitCode).toBe(1);
      expect(errors).toHaveLength(2);
    } finally {
      disposeWarnExit();
    }
  });

  it("recovers TLS peer certificate trust failures while keeping invalid local TLS config fatal", async () => {
    const fakeProcess = new NodeEvents.EventEmitter();
    const warnings: string[] = [];
    const errors: string[] = [];
    const onFatalError = vi.fn();

    const dispose = installDesktopProcessErrorGuards({
      targetProcess: fakeProcess,
      isOffscreenTest: () => false,
      socketPrototype: {},
      logWarning: (message) => warnings.push(message),
      logError: (message) => errors.push(message),
      onFatalError,
    });

    const { cert, key } = makeSelfSignedCertificate();
    const server = NodeHttps.createServer({ cert, key }, (_req, res) => {
      res.end("ok");
    });

    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Unexpected HTTPS server address"));
            return;
          }
          resolve(address.port);
        });
      });

      const httpsTrustError = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for HTTPS self-signed cert error")),
          5000,
        );
        const req = NodeHttps.get(`https://127.0.0.1:${port}/`);
        req.once("error", (err: NodeJS.ErrnoException) => {
          clearTimeout(timeout);
          resolve(err);
        });
      });

      expect(httpsTrustError.code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
      expect(isRecoverableNetworkError(httpsTrustError)).toBe(true);
      fakeProcess.emit("uncaughtException", httpsTrustError, "uncaughtException");
      expect(onFatalError).not.toHaveBeenCalled();

      let fetchTrustError: unknown;
      try {
        await fetch(`https://127.0.0.1:${port}/`);
      } catch (err) {
        fetchTrustError = err;
      }

      expect(fetchTrustError).toBeInstanceOf(TypeError);
      expect(isRecoverableNetworkError(fetchTrustError)).toBe(true);
      fakeProcess.emit("uncaughtException", fetchTrustError, "uncaughtException");
      expect(onFatalError).not.toHaveBeenCalled();

      // Real mTLS peer alert (peer requires a client certificate) must recover.
      const mtlsServer = NodeHttps.createServer(
        { cert, key, ca: cert, requestCert: true, rejectUnauthorized: true },
        (_req, res) => {
          res.end("ok");
        },
      );
      try {
        const mtlsPort = await new Promise<number>((resolve, reject) => {
          mtlsServer.once("error", reject);
          mtlsServer.listen(0, "127.0.0.1", () => {
            const address = mtlsServer.address();
            if (address === null || typeof address === "string") {
              reject(new Error("Unexpected mTLS server address"));
              return;
            }
            resolve(address.port);
          });
        });

        const mtlsAlertError = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Timed out waiting for mTLS peer alert error")),
            5000,
          );
          const req = NodeHttps.request(
            {
              host: "127.0.0.1",
              port: mtlsPort,
              path: "/",
              ca: cert,
              checkServerIdentity: () => undefined,
            },
            (res) => {
              res.resume();
            },
          );
          req.once("error", (err: NodeJS.ErrnoException) => {
            clearTimeout(timeout);
            resolve(err);
          });
          req.end();
        });

        expect(mtlsAlertError.code).toMatch(/^ERR_SSL_TLSV13?_ALERT_CERTIFICATE_REQUIRED$/u);
        expect(isRecoverableNetworkError(mtlsAlertError)).toBe(true);
        fakeProcess.emit("uncaughtException", mtlsAlertError, "uncaughtException");
        expect(onFatalError).not.toHaveBeenCalled();
      } finally {
        mtlsServer.close();
      }

      // Synthetic certificate, alert, HTTP parser, and undici body errors without provenance must stay fatal.
      const nonTlsCertError = makeErrnoError("synthetic cert error", "DEPTH_ZERO_SELF_SIGNED_CERT");
      expect(isRecoverableNetworkError(nonTlsCertError)).toBe(false);
      for (const syntheticCode of [
        "ERR_SSL_TLSV1_ALERT_CERTIFICATE_REQUIRED",
        "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
        "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
        "ERR_SSL_TLSV1_ALERT_UNRECOGNIZED_NAME",
        "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
        "HPE_HEADER_OVERFLOW",
        "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
      ]) {
        expect(isRecoverableNetworkError(makeErrnoError("synthetic error", syntheticCode))).toBe(
          false,
        );
      }
      const syntheticHttpParserError = new Error("Response does not match HTTP/1.1");
      syntheticHttpParserError.name = "HTTPParserError";
      expect(isRecoverableNetworkError(syntheticHttpParserError)).toBe(false);
      const syntheticTerminated = new TypeError("terminated", {
        cause: makeErrnoError("synthetic reset", "ECONNRESET"),
      });
      expect(isRecoverableNetworkError(syntheticTerminated)).toBe(false);

      // Real loopback fetch mid-body disconnects (fixed-length and chunked) must recover even under strict rejection mode.
      const truncatedServer = NodeNet.createServer((socket) => {
        socket.once("data", (chunk) => {
          const reqText = chunk.toString("utf8");
          if (reqText.startsWith("GET /chunked ")) {
            socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\nhello");
            return;
          }
          socket.end("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nhello");
        });
      });
      try {
        const truncatedPort = await new Promise<number>((resolve, reject) => {
          truncatedServer.once("error", reject);
          truncatedServer.listen(0, "127.0.0.1", () => {
            const address = truncatedServer.address();
            if (address === null || typeof address === "string") {
              reject(new Error("Unexpected truncated HTTP server address"));
              return;
            }
            resolve(address.port);
          });
        });

        for (const path of ["/fixed", "/chunked"]) {
          const response = await fetch(`http://127.0.0.1:${truncatedPort}${path}`);
          expect(response.status).toBe(200);
          let bodyError: unknown;
          try {
            await response.text();
          } catch (error) {
            bodyError = error;
          }
          expect(bodyError).toBeInstanceOf(TypeError);
          expect(isRecoverableNetworkError(bodyError)).toBe(true);
          fakeProcess.emit("unhandledRejection", bodyError, Promise.resolve());
          expect(onFatalError).not.toHaveBeenCalled();
        }
      } finally {
        truncatedServer.close();
      }

      // Real loopback HTTP response parser failure (HPE_HEADER_OVERFLOW) must recover.
      const overflowServer = NodeNet.createServer((socket) => {
        socket.end(`HTTP/1.1 200 OK\r\nX-Pad: ${"a".repeat(2048)}\r\nContent-Length: 2\r\n\r\nok`);
      });
      try {
        const overflowPort = await new Promise<number>((resolve, reject) => {
          overflowServer.once("error", reject);
          overflowServer.listen(0, "127.0.0.1", () => {
            const address = overflowServer.address();
            if (address === null || typeof address === "string") {
              reject(new Error("Unexpected HTTP overflow server address"));
              return;
            }
            resolve(address.port);
          });
        });

        const parserError = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Timed out waiting for HTTP header overflow error")),
            5000,
          );
          const req = NodeHttp.request(
            {
              host: "127.0.0.1",
              port: overflowPort,
              path: "/",
              maxHeaderSize: 256,
            },
            (res) => {
              res.resume();
            },
          );
          req.once("error", (err: NodeJS.ErrnoException) => {
            clearTimeout(timeout);
            resolve(err);
          });
          req.end();
        });

        expect(parserError.code).toBe("HPE_HEADER_OVERFLOW");
        expect(isRecoverableNetworkError(parserError)).toBe(true);
        fakeProcess.emit("uncaughtException", parserError, "uncaughtException");
        expect(onFatalError).not.toHaveBeenCalled();
      } finally {
        overflowServer.close();
      }

      // Invalid local TLS configuration must stay fatal.
      let localConfigError: unknown;
      try {
        NodeTls.createSecureContext({ cert: "not-a-valid-pem" });
      } catch (err) {
        localConfigError = err;
      }
      expect(localConfigError).toBeDefined();
      expect(isRecoverableNetworkError(localConfigError)).toBe(false);
      fakeProcess.emit("uncaughtException", localConfigError, "uncaughtException");
      expect(onFatalError).toHaveBeenCalledTimes(1);
      expect(onFatalError).toHaveBeenCalledWith(localConfigError, "uncaughtException");
      expect(errors).toHaveLength(1);
    } finally {
      server.close();
      dispose();
    }
  });

  it("skips installing guards in offscreen test mode", () => {
    const fakeProcess = new NodeEvents.EventEmitter();
    const original = vi.fn();
    const proto = { setTypeOfService: original };

    const dispose = installDesktopProcessErrorGuards({
      targetProcess: fakeProcess,
      isOffscreenTest: () => true,
      socketPrototype: proto,
    });

    expect(fakeProcess.listenerCount("uncaughtException")).toBe(0);
    expect(fakeProcess.listenerCount("unhandledRejection")).toBe(0);
    expect(proto.setTypeOfService).toBe(original);
    dispose();
  });

  it("formats process error summaries cleanly", () => {
    expect(
      formatProcessErrorSummary(
        makeErrnoError("setTypeOfService EINVAL", "EINVAL", "setTypeOfService"),
      ),
    ).toBe("Error: setTypeOfService EINVAL (code=EINVAL syscall=setTypeOfService)");
    expect(formatProcessErrorSummary("plain failure")).toBe("plain failure");
  });
});
