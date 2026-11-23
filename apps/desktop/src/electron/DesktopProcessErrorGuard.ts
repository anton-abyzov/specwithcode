// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Process-level socket and uncaught-exception guards run synchronously before the Effect runtime starts.
import * as NodeNet from "node:net";

import { isDesktopOffscreenTest } from "./DesktopOffscreen.ts";

const SET_TOS_GUARDED = Symbol.for("@specweave-studio/desktop/setTypeOfServiceGuarded");
const DEFAULT_MIN_LOG_INTERVAL_MS = 60_000;
const MAX_CAUSE_DEPTH = 8;

const RECOVERABLE_TOS_ERRNOS = new Set([
  "EINVAL",
  "EBADF",
  "ENOTCONN",
  "ENOPROTOOPT",
  "EOPNOTSUPP",
  "ENOTSUP",
  "ENOTSOCK",
  "EPIPE",
]);

const RECOVERABLE_NETWORK_ERRNOS = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENOTCONN",
  "EHOSTDOWN",
  "EPROTO",
  "ECANCELED",
  "ESOCKETTIMEDOUT",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "EPROTONOSUPPORT",
  "ENOPROTOOPT",
  "EOPNOTSUPP",
  "ENOTSUP",
]);

const SOCKET_CONTEXT_ERRNOS = new Set(["EINVAL", "EBADF", "ENOTSOCK"]);

const SOCKET_SYSCALLS = new Set([
  "setTypeOfService",
  "connect",
  "shutdown",
  "getsockopt",
  "setsockopt",
  "send",
  "recv",
  "getaddrinfo",
]);

const RECOVERABLE_TRANSPORT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_DESTROYED",
  "UND_ERR_CLOSED",
  "UND_ERR_ABORTED",
  "UND_ERR_RESPONSE_STATUS_CODE",
  "UND_ERR_INFO",
  "UND_ERR_RES_EXCEEDED_MAX_SIZE",
  "ERR_SOCKET_CLOSED",
  "ERR_SOCKET_CLOSED_BEFORE_CONNECTION",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "ERR_SOCKET_DGRAM_NOT_RUNNING",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_SESSION_ERROR",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_SOCKET_CLOSED",
  "ERR_HTTP2_PING_CANCEL",
  "ERR_HTTP2_INTERNAL_ERROR",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "ERR_TLS_RENEGOTIATION_DISABLED",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
  "ERR_SSL_TLSV1_ALERT_UNRECOGNIZED_NAME",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_BAD_RECORD_MAC",
  "ERR_SSL_UNEXPECTED_EOF_WHILE_READING",
  "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG",
  "ERR_SSL_HANDSHAKE_FAILURE",
]);

const NETWORK_STACK_PATTERN =
  /\b(?:node:net|node:tls|node:http|node:https|node:http2|node:dns|node:internal\/deps\/undici|setTypeOfService)\b/u;

const NETWORK_MESSAGE_PATTERNS = [
  /^socket hang up$/iu,
  /^Client network socket disconnected before secure TLS connection was established$/iu,
];

interface ErrorLike {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly syscall?: unknown;
  readonly stack?: unknown;
  readonly cause?: unknown;
  readonly errors?: unknown;
}

export interface SocketWithTypeOfService {
  setTypeOfService?: (this: NodeNet.Socket, tos: number) => NodeNet.Socket | void;
}

interface GuardedSetTypeOfService {
  (this: NodeNet.Socket, tos: number): NodeNet.Socket | void;
  [SET_TOS_GUARDED]?: true;
}

export interface ProcessEventTarget {
  on(
    event: "uncaughtException",
    listener: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void,
  ): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  off(
    event: "uncaughtException",
    listener: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void,
  ): unknown;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

export interface SocketSetTypeOfServiceGuardOptions {
  readonly socketPrototype?: SocketWithTypeOfService;
  readonly logWarning?: (message: string) => void;
  readonly now?: () => number;
  readonly minLogIntervalMs?: number;
}

export interface DesktopProcessErrorGuardOptions {
  readonly targetProcess?: ProcessEventTarget;
  readonly isOffscreenTest?: () => boolean;
  readonly socketPrototype?: SocketWithTypeOfService;
  readonly logWarning?: (message: string) => void;
  readonly logError?: (message: string) => void;
  readonly onFatalError?: (error: unknown, origin: string) => void;
  readonly now?: () => number;
  readonly minLogIntervalMs?: number;
}

function safeStderrWrite(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // Never let logging inside a process error guard throw again.
  }
}

function asErrorLike(value: unknown): ErrorLike | null {
  return typeof value === "object" && value !== null ? (value as ErrorLike) : null;
}

function stringProp(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeGetProp(target: ErrorLike, key: keyof ErrorLike): unknown {
  try {
    return Reflect.get(target, key);
  } catch {
    return undefined;
  }
}

function safeStringProp(target: ErrorLike, key: keyof ErrorLike): string | undefined {
  return stringProp(safeGetProp(target, key));
}

function safeToString(value: unknown): string {
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "[unstringifiable error]";
    }
  }
}

function hasTopNetworkStackFrame(stack: string | undefined): boolean {
  if (stack === undefined) return false;
  for (const line of stack.split("\n")) {
    if (/^\s+at\s+/u.test(line)) {
      return NETWORK_STACK_PATTERN.test(line);
    }
  }
  return false;
}

export function formatProcessErrorSummary(error: unknown): string {
  const err = asErrorLike(error);
  if (err === null) return safeToString(error);
  const name = safeStringProp(err, "name") ?? "Error";
  const message = safeStringProp(err, "message") ?? safeToString(error);
  const code = safeStringProp(err, "code");
  const syscall = safeStringProp(err, "syscall");
  const details = [code ? `code=${code}` : undefined, syscall ? `syscall=${syscall}` : undefined]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  return details.length > 0 ? `${name}: ${message} (${details})` : `${name}: ${message}`;
}

export function isRecoverableSetTypeOfServiceError(error: unknown): boolean {
  const err = asErrorLike(error);
  if (err === null) return false;
  const code = safeStringProp(err, "code");
  if (code !== undefined && RECOVERABLE_TOS_ERRNOS.has(code)) {
    return true;
  }
  const message = safeStringProp(err, "message");
  if (message !== undefined && /\bsetTypeOfService\b/u.test(message)) {
    for (const errno of RECOVERABLE_TOS_ERRNOS) {
      if (message.includes(errno)) return true;
    }
  }
  return false;
}

function isSingleErrorRecoverableNetwork(error: unknown): boolean {
  const err = asErrorLike(error);
  if (err === null) return false;

  const code = safeStringProp(err, "code");
  const syscall = safeStringProp(err, "syscall");
  const message = safeStringProp(err, "message");
  const stack = safeStringProp(err, "stack");
  const hasNetworkOrigin = hasTopNetworkStackFrame(stack);

  if (
    syscall === "setTypeOfService" ||
    (hasNetworkOrigin && isRecoverableSetTypeOfServiceError(error))
  ) {
    return true;
  }

  if (code !== undefined) {
    if (RECOVERABLE_NETWORK_ERRNOS.has(code) || RECOVERABLE_TRANSPORT_CODES.has(code)) {
      return true;
    }
    if (
      SOCKET_CONTEXT_ERRNOS.has(code) &&
      ((syscall !== undefined && SOCKET_SYSCALLS.has(syscall)) || hasNetworkOrigin)
    ) {
      return true;
    }
    if (
      (code === "ERR_STREAM_PREMATURE_CLOSE" ||
        code === "ERR_STREAM_DESTROYED" ||
        code === "ERR_STREAM_WRITE_AFTER_END") &&
      hasNetworkOrigin
    ) {
      return true;
    }
  }

  if (
    code === undefined &&
    message !== undefined &&
    NETWORK_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return true;
  }

  return false;
}

/**
 * Classifies transient socket, undici, TLS, DNS, and HTTP transport errors
 * that should be logged and recovered rather than crashing the desktop main
 * process with a blocking error dialog.
 */
export function isRecoverableNetworkError(error: unknown): boolean {
  try {
    const visited = new Set<unknown>();
    const queue: Array<{ readonly value: unknown; readonly depth: number }> = [
      { value: error, depth: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.value === null || current.value === undefined) continue;
      if (visited.has(current.value)) continue;
      visited.add(current.value);

      if (isSingleErrorRecoverableNetwork(current.value)) {
        return true;
      }

      if (current.depth >= MAX_CAUSE_DEPTH) continue;
      const err = asErrorLike(current.value);
      if (err === null) continue;

      const cause = safeGetProp(err, "cause");
      if (cause !== undefined) {
        queue.push({ value: cause, depth: current.depth + 1 });
      }
      const nestedErrors = safeGetProp(err, "errors");
      if (Array.isArray(nestedErrors)) {
        for (let i = 0; i < nestedErrors.length; i += 1) {
          try {
            queue.push({ value: nestedErrors[i], depth: current.depth + 1 });
          } catch {
            // Ignore hostile array element getters.
          }
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

function createRateLimitedLogger(
  logWarning: (message: string) => void,
  now: () => number,
  minLogIntervalMs: number,
): (formatMessage: (suppressedSuffix: string) => string) => void {
  let lastLoggedAt = -Infinity;
  let suppressedSinceLastLog = 0;

  return (formatMessage) => {
    const timestamp = now();
    if (timestamp - lastLoggedAt >= minLogIntervalMs) {
      const suffix =
        suppressedSinceLastLog > 0 ? ` (${suppressedSinceLastLog} similar errors suppressed)` : "";
      suppressedSinceLastLog = 0;
      lastLoggedAt = timestamp;
      logWarning(formatMessage(suffix));
    } else {
      suppressedSinceLastLog += 1;
    }
  };
}

/**
 * Node 24.21 / undici 7.29 calls `Socket.prototype.setTypeOfService(0)` before
 * every HTTP/1.1 write without catching synchronous errno throws on macOS/Linux
 * (such as `EINVAL` on a closing/reset socket or `EBADF` while connecting).
 * Node already treats TOS as best-effort on Windows; mirror that on all
 * platforms so a best-effort setsockopt hint can never crash the main process.
 */
export function guardSocketSetTypeOfService(
  options: SocketSetTypeOfServiceGuardOptions = {},
): () => void {
  const proto = options.socketPrototype ?? (NodeNet.Socket.prototype as SocketWithTypeOfService);
  const original = proto.setTypeOfService as GuardedSetTypeOfService | undefined;
  if (typeof original !== "function" || original[SET_TOS_GUARDED]) {
    return () => undefined;
  }

  const logWarning = options.logWarning ?? safeStderrWrite;
  const now = options.now ?? (() => Date.now());
  const minLogIntervalMs = options.minLogIntervalMs ?? DEFAULT_MIN_LOG_INTERVAL_MS;
  const logRateLimited = createRateLimitedLogger(logWarning, now, minLogIntervalMs);

  const wrapped: GuardedSetTypeOfService = function guardedSetTypeOfService(
    this: NodeNet.Socket,
    tos: number,
  ): NodeNet.Socket | void {
    try {
      return original.call(this, tos);
    } catch (error) {
      if (!isRecoverableSetTypeOfServiceError(error)) {
        throw error;
      }
      logRateLimited(
        (suffix) =>
          `[desktop-process-guard] Ignored best-effort socket.setTypeOfService(${tos}) failure: ${formatProcessErrorSummary(error)}${suffix}`,
      );
      return this;
    }
  };
  wrapped[SET_TOS_GUARDED] = true;
  proto.setTypeOfService = wrapped;

  return () => {
    if (proto.setTypeOfService === wrapped) {
      proto.setTypeOfService = original;
    }
  };
}

/**
 * Installs main-process guards for `setTypeOfService`, `uncaughtException`, and
 * `unhandledRejection`. Skipped in offscreen test mode so unattended desktop
 * tests keep their fail-fast `DesktopOffscreen` assertions.
 */
export function installDesktopProcessErrorGuards(
  options: DesktopProcessErrorGuardOptions = {},
): () => void {
  const checkOffscreen = options.isOffscreenTest ?? isDesktopOffscreenTest;
  if (checkOffscreen()) {
    return () => undefined;
  }

  const targetProcess: ProcessEventTarget = options.targetProcess ?? process;
  const logWarning = options.logWarning ?? safeStderrWrite;
  const logError = options.logError ?? safeStderrWrite;
  const now = options.now ?? (() => Date.now());
  const minLogIntervalMs = options.minLogIntervalMs ?? DEFAULT_MIN_LOG_INTERVAL_MS;
  const onFatalError =
    options.onFatalError ??
    (() => {
      process.exitCode = 1;
      process.exit(1);
    });

  const disposeSetTos = guardSocketSetTypeOfService({
    ...(options.socketPrototype !== undefined ? { socketPrototype: options.socketPrototype } : {}),
    logWarning,
    now,
    minLogIntervalMs,
  });

  const logUncaughtWarning = createRateLimitedLogger(logWarning, now, minLogIntervalMs);
  const logRejectionWarning = createRateLimitedLogger(logWarning, now, minLogIntervalMs);
  let handlingFatal = false;

  const onUncaughtException = (
    error: unknown,
    origin: NodeJS.UncaughtExceptionOrigin = "uncaughtException",
  ) => {
    if (isRecoverableNetworkError(error)) {
      logUncaughtWarning(
        (suffix) =>
          `[desktop-process-guard] Recovered from non-fatal network ${origin}: ${formatProcessErrorSummary(error)}${suffix}`,
      );
      return;
    }
    if (handlingFatal) return;
    handlingFatal = true;
    const err = asErrorLike(error);
    const stack = err !== null ? safeStringProp(err, "stack") : undefined;
    logError(
      `[desktop-process-guard] Fatal ${origin}: ${stack ?? formatProcessErrorSummary(error)}`,
    );
    onFatalError(error, origin);
  };

  const onUnhandledRejection = (reason: unknown) => {
    if (isRecoverableNetworkError(reason)) {
      logRejectionWarning(
        (suffix) =>
          `[desktop-process-guard] Recovered from non-fatal network unhandledRejection: ${formatProcessErrorSummary(reason)}${suffix}`,
      );
      return;
    }
    const err = asErrorLike(reason);
    const stack = err !== null ? safeStringProp(err, "stack") : undefined;
    logError(
      `[desktop-process-guard] Unhandled promise rejection: ${stack ?? formatProcessErrorSummary(reason)}`,
    );
  };

  targetProcess.on("uncaughtException", onUncaughtException);
  targetProcess.on("unhandledRejection", onUnhandledRejection);

  return () => {
    targetProcess.off("uncaughtException", onUncaughtException);
    targetProcess.off("unhandledRejection", onUnhandledRejection);
    disposeSetTos();
  };
}
