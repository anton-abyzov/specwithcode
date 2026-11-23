// @effect-diagnostics nodeBuiltinImport:off -- Regression tests construct real Node http/tls errors directly.
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  formatProcessErrorSummary,
  guardSocketSetTypeOfService,
  installDesktopProcessErrorGuards,
  isRecoverableNetworkError,
  isRecoverableSetTypeOfServiceError,
  type SocketWithTypeOfService,
} from "./DesktopProcessErrorGuard.ts";

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
    expect(isRecoverableNetworkError(makeErrnoError("write EPIPE", "EPIPE", "write"))).toBe(true);
    expect(isRecoverableNetworkError(makeErrnoError("connect ETIMEDOUT", "ETIMEDOUT"))).toBe(true);
    expect(isRecoverableNetworkError(makeErrnoError("getaddrinfo ENOTFOUND", "ENOTFOUND"))).toBe(
      true,
    );
    expect(isRecoverableNetworkError(makeErrnoError("socket closed", "UND_ERR_SOCKET"))).toBe(true);
    expect(isRecoverableNetworkError(makeErrnoError("closed", "ERR_SOCKET_CLOSED"))).toBe(true);
    expect(
      isRecoverableNetworkError(
        new TypeError("fetch failed", {
          cause: makeErrnoError("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED", "connect"),
        }),
      ),
    ).toBe(true);
    expect(isRecoverableNetworkError(new Error("socket hang up"))).toBe(true);

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
    expect(warnings[3]).toContain("3 similar errors suppressed");
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
