// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Process-level socket and uncaught-exception guards run synchronously before the Effect runtime starts.
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import { isDesktopOffscreenTest } from "./DesktopOffscreen.ts";

const SET_TOS_GUARDED = Symbol.for("@specweave-studio/desktop/setTypeOfServiceGuarded");
const SOCKET_DESTROY_TRACKED = Symbol.for("@specweave-studio/desktop/socketDestroyTracked");
const TLS_ERROR_TRACKED = Symbol.for("@specweave-studio/desktop/tlsErrorTracked");
const DEFAULT_MIN_LOG_INTERVAL_MS = 60_000;
const MAX_CAUSE_DEPTH = 8;

const NETWORK_SOCKET_ERRORS = new WeakSet<object>();

const RECOVERABLE_TOS_MESSAGE_PATTERN =
  /^setTypeOfService\s+(?:EINVAL|EBADF|ENOTCONN|ENOPROTOOPT|EOPNOTSUPP|ENOTSUP|ENOTSOCK|EPIPE)$/u;

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
  "ESOCKETTIMEDOUT",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "EPROTONOSUPPORT",
  "ENOPROTOOPT",
]);

const SOCKET_CONTEXT_ERRNOS = new Set([
  "EINVAL",
  "EBADF",
  "ENOTSOCK",
  "EPIPE",
  "ETIMEDOUT",
  "ECANCELED",
  "EOPNOTSUPP",
  "ENOTSUP",
]);

const PROGRAMMING_ERROR_NAMES = new Set([
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
]);

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
  "UND_ERR_ABORTED",
  "UND_ERR_RESPONSE_STATUS_CODE",
  "UND_ERR_INFO",
  "UND_ERR_RES_EXCEEDED_MAX_SIZE",
  "ERR_SOCKET_CLOSED_BEFORE_CONNECTION",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
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
  "ERR_SSL_BAD_RECORD_MAC",
  "ERR_SSL_UNEXPECTED_EOF_WHILE_READING",
  "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG",
  "ERR_SSL_HANDSHAKE_FAILURE",
]);

const RECOVERABLE_TLS_PEER_VERIFY_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CRL_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
  "IP_ADDRESS_MISMATCH",
  "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
]);

const RECOVERABLE_TLS_ALERT_CODE_PATTERN =
  /^ERR_SSL_(?:SSLV3|TLSV1|TLSV1[0-3]|TLS1[0-3])_ALERT_[A-Z0-9_]+$/u;

const RECOVERABLE_HTTP_PARSER_CODE_PATTERN = /^HPE_[A-Z0-9_]+$/u;

const UNDICI_STACK_PATTERN = /\bnode:internal\/deps\/undici\b/u;

const NETWORK_STACK_PATTERN =
  /\b(?:node:net|node:tls|node:_tls_wrap|node:internal\/tls|node:http|node:_http_client|node:_http_common|node:_http_incoming|node:https|node:http2|node:dns|node:internal\/deps\/undici|setTypeOfService)\b/u;

const STREAM_BASE_WRAPPER_FRAME_PATTERN = /\bnode:internal\/stream_base_commons\b/u;

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
  exitCode?: number | string | null | undefined;
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
  readonly execArgv?: ReadonlyArray<string>;
  readonly nodeOptions?: string | undefined;
  readonly now?: () => number;
  readonly minLogIntervalMs?: number;
}

function parseUnhandledRejectionsMode(tokens: ReadonlyArray<string>): string | undefined {
  let mode: string | undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const rawFlag = tokens[i];
    if (rawFlag === undefined || rawFlag === "") continue;
    if (rawFlag === "--") break;
    const flag = rawFlag.replace(/^--unhandled_rejections(?==|$)/u, "--unhandled-rejections");
    if (flag === "--unhandled-rejections") {
      const next = tokens[i + 1];
      if (next !== undefined && next !== "") {
        mode = next;
        i += 1;
      }
      continue;
    }
    const match = /^--unhandled-rejections=(.+)$/u.exec(flag)?.[1];
    if (match !== undefined) {
      mode = match;
    }
  }
  return mode;
}

function tokenizeNodeOptions(input: string): Array<string> {
  const tokens: Array<string> = [];
  let current = "";
  let inToken = false;
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === "\\" && i + 1 < input.length) {
        current += input[i + 1]!;
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === " ") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }

    inToken = true;
    if (ch === '"') {
      inQuotes = true;
    } else {
      current += ch;
    }
  }

  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

type UnhandledRejectionsAction = "throw" | "warn-with-error-code" | "warn";

function resolveUnhandledRejectionsAction(
  execArgv: ReadonlyArray<string>,
  nodeOptions: string | undefined,
): UnhandledRejectionsAction {
  const envTokens = tokenizeNodeOptions(nodeOptions ?? "");
  const mode = parseUnhandledRejectionsMode(execArgv) ?? parseUnhandledRejectionsMode(envTokens);
  if (mode === "throw" || mode === "strict") {
    return "throw";
  }
  if (mode === "warn-with-error-code") {
    return "warn-with-error-code";
  }
  return "warn";
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

function hasTopStackFrameMatching(stack: string | undefined, pattern: RegExp): boolean {
  if (stack === undefined) return false;
  for (const line of stack.split("\n")) {
    if (/^\s+at\s+/u.test(line)) {
      if (STREAM_BASE_WRAPPER_FRAME_PATTERN.test(line)) {
        continue;
      }
      return pattern.test(line);
    }
  }
  return false;
}

function hasTopNetworkStackFrame(stack: string | undefined): boolean {
  return hasTopStackFrameMatching(stack, NETWORK_STACK_PATTERN);
}

function hasTopUndiciStackFrame(stack: string | undefined): boolean {
  return hasTopStackFrameMatching(stack, UNDICI_STACK_PATTERN);
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
  if (code !== undefined) {
    return RECOVERABLE_TOS_ERRNOS.has(code);
  }
  const message = safeStringProp(err, "message");
  return message !== undefined && RECOVERABLE_TOS_MESSAGE_PATTERN.test(message.trim());
}

function isSingleErrorRecoverableNetwork(error: unknown): boolean {
  const err = asErrorLike(error);
  if (err === null) return false;

  const name = safeStringProp(err, "name");
  const code = safeStringProp(err, "code");
  const syscall = safeStringProp(err, "syscall");
  const message = safeStringProp(err, "message");
  const stack = safeStringProp(err, "stack");
  const hasNetworkOrigin =
    hasTopNetworkStackFrame(stack) ||
    (typeof error === "object" && error !== null && NETWORK_SOCKET_ERRORS.has(error));

  if (
    (syscall === "setTypeOfService" && (code === undefined || RECOVERABLE_TOS_ERRNOS.has(code))) ||
    (hasNetworkOrigin && isRecoverableSetTypeOfServiceError(error))
  ) {
    return true;
  }

  if (code !== undefined) {
    if (RECOVERABLE_NETWORK_ERRNOS.has(code) || RECOVERABLE_TRANSPORT_CODES.has(code)) {
      return true;
    }
    if (
      (RECOVERABLE_TLS_PEER_VERIFY_CODES.has(code) ||
        RECOVERABLE_TLS_ALERT_CODE_PATTERN.test(code) ||
        RECOVERABLE_HTTP_PARSER_CODE_PATTERN.test(code) ||
        code === "UND_ERR_RES_CONTENT_LENGTH_MISMATCH") &&
      hasNetworkOrigin
    ) {
      return true;
    }
    if (
      SOCKET_CONTEXT_ERRNOS.has(code) &&
      ((syscall !== undefined && SOCKET_SYSCALLS.has(syscall)) || hasNetworkOrigin)
    ) {
      return true;
    }
    if (
      (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ERR_STREAM_DESTROYED") &&
      hasNetworkOrigin
    ) {
      return true;
    }
  }

  if (code === undefined && name === "HTTPParserError" && hasNetworkOrigin) {
    return true;
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

function hasDisqualifyingAggregateCause(
  err: ErrorLike,
  depth: number,
  visiting: Set<unknown>,
): boolean {
  const cause = safeGetProp(err, "cause");
  if (cause === undefined || cause === null) return false;
  if (visiting.has(cause)) return false;

  const causeErr = asErrorLike(cause);
  if (causeErr === null) return false;

  const nestedErrors = safeGetProp(causeErr, "errors");
  if (Array.isArray(nestedErrors) && nestedErrors.length > 0) {
    return !isRecoverableNetworkErrorNode(cause, depth + 1, visiting);
  }

  if (depth >= MAX_CAUSE_DEPTH) return false;

  visiting.add(cause);
  try {
    return hasDisqualifyingAggregateCause(causeErr, depth + 1, visiting);
  } finally {
    visiting.delete(cause);
  }
}

function canDelegateToCause(err: ErrorLike): boolean {
  if (safeStringProp(err, "code") !== undefined) return false;
  const name = safeStringProp(err, "name");
  if (name !== undefined && PROGRAMMING_ERROR_NAMES.has(name)) return false;
  if (name === "TypeError") {
    const message = safeStringProp(err, "message");
    if (message === "fetch failed") return true;
    if (message === "terminated") {
      return hasTopUndiciStackFrame(safeStringProp(err, "stack"));
    }
    return false;
  }
  return true;
}

function isRecoverableNetworkErrorNode(
  value: unknown,
  depth: number,
  visiting: Set<unknown>,
): boolean {
  if (value === null || value === undefined) return false;
  if (visiting.has(value)) return false;

  const err = asErrorLike(value);
  if (err === null) return false;

  visiting.add(value);
  try {
    const nestedErrors = safeGetProp(err, "errors");
    if (Array.isArray(nestedErrors) && nestedErrors.length > 0) {
      if (depth >= MAX_CAUSE_DEPTH) return false;
      for (let i = 0; i < nestedErrors.length; i += 1) {
        let nested: unknown;
        try {
          nested = nestedErrors[i];
        } catch {
          return false;
        }
        if (!isRecoverableNetworkErrorNode(nested, depth + 1, visiting)) {
          return false;
        }
      }
      return !hasDisqualifyingAggregateCause(err, depth, visiting);
    }

    if (isSingleErrorRecoverableNetwork(value)) {
      return !hasDisqualifyingAggregateCause(err, depth, visiting);
    }

    if (depth >= MAX_CAUSE_DEPTH) return false;
    if (!canDelegateToCause(err)) return false;

    const cause = safeGetProp(err, "cause");
    if (cause !== undefined && isRecoverableNetworkErrorNode(cause, depth + 1, visiting)) {
      return true;
    }

    return false;
  } finally {
    visiting.delete(value);
  }
}

/**
 * Classifies transient socket, undici, TLS, DNS, and HTTP transport errors
 * that should be logged and recovered rather than crashing the desktop main
 * process with a blocking error dialog.
 */
export function isRecoverableNetworkError(error: unknown): boolean {
  try {
    return isRecoverableNetworkErrorNode(error, 0, new Set<unknown>());
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

interface TrackedSocketDestroy {
  (this: NodeNet.Socket, error: Error | null, callback: (error?: Error | null) => void): void;
  [SOCKET_DESTROY_TRACKED]?: boolean;
}

interface SocketWithInternalHandle extends NodeNet.Socket {
  readonly _handle?: { readonly constructor?: { readonly name?: unknown } } | null;
  _destroy: TrackedSocketDestroy;
}

interface TrackedTlsError {
  (this: NodeTls.TLSSocket, error: Error): unknown;
  [TLS_ERROR_TRACKED]?: boolean;
}

interface TlsSocketWithInternalError extends NodeTls.TLSSocket {
  _tlsError?: TrackedTlsError;
}

function isNetworkSocketInstance(socket: SocketWithInternalHandle): boolean {
  if (socket instanceof NodeTls.TLSSocket) {
    return true;
  }
  const handleName = socket._handle?.constructor?.name;
  if (handleName === "TCP" || handleName === "TLSWrap") {
    return true;
  }
  return typeof socket.localPort === "number" || typeof socket.remotePort === "number";
}

function installNetworkSocketErrorTracker(): () => void {
  const disposers: Array<() => void> = [];

  const proto = NodeNet.Socket.prototype as SocketWithInternalHandle;
  const originalDestroy = proto._destroy;
  if (typeof originalDestroy === "function" && !originalDestroy[SOCKET_DESTROY_TRACKED]) {
    const wrappedDestroy: TrackedSocketDestroy = function trackedSocketDestroy(
      this: SocketWithInternalHandle,
      error: Error | null,
      callback: (error?: Error | null) => void,
    ): void {
      if (error !== null && typeof error === "object" && isNetworkSocketInstance(this)) {
        NETWORK_SOCKET_ERRORS.add(error);
      }
      return originalDestroy.call(this, error, callback);
    };
    wrappedDestroy[SOCKET_DESTROY_TRACKED] = true;
    proto._destroy = wrappedDestroy;
    disposers.push(() => {
      if (proto._destroy === wrappedDestroy) {
        proto._destroy = originalDestroy;
      }
    });
  }

  const tlsProto = NodeTls.TLSSocket.prototype as TlsSocketWithInternalError;
  const originalTlsError = tlsProto._tlsError;
  if (typeof originalTlsError === "function" && !originalTlsError[TLS_ERROR_TRACKED]) {
    const wrappedTlsError: TrackedTlsError = function trackedTlsError(
      this: NodeTls.TLSSocket,
      error: Error,
    ): unknown {
      if (error !== null && typeof error === "object") {
        NETWORK_SOCKET_ERRORS.add(error);
      }
      return originalTlsError.call(this, error);
    };
    wrappedTlsError[TLS_ERROR_TRACKED] = true;
    tlsProto._tlsError = wrappedTlsError;
    disposers.push(() => {
      if (tlsProto._tlsError === wrappedTlsError) {
        tlsProto._tlsError = originalTlsError;
      }
    });
  }

  return () => {
    for (const dispose of disposers) {
      dispose();
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
  const disposeSocketTracker = installNetworkSocketErrorTracker();

  const logUncaughtWarning = createRateLimitedLogger(logWarning, now, minLogIntervalMs);
  const logRejectionWarning = createRateLimitedLogger(logWarning, now, minLogIntervalMs);
  const unhandledRejectionsAction = resolveUnhandledRejectionsAction(
    options.execArgv ?? process.execArgv,
    "nodeOptions" in options ? options.nodeOptions : process.env["NODE_OPTIONS"],
  );
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
    if (unhandledRejectionsAction === "throw") {
      if (handlingFatal) return;
      handlingFatal = true;
      logError(
        `[desktop-process-guard] Fatal unhandledRejection: ${stack ?? formatProcessErrorSummary(reason)}`,
      );
      onFatalError(reason, "unhandledRejection");
      return;
    }
    if (unhandledRejectionsAction === "warn-with-error-code") {
      targetProcess.exitCode = 1;
    }
    logError(
      `[desktop-process-guard] Unhandled promise rejection: ${stack ?? formatProcessErrorSummary(reason)}`,
    );
  };

  targetProcess.on("uncaughtException", onUncaughtException);
  targetProcess.on("unhandledRejection", onUnhandledRejection);

  return () => {
    targetProcess.off("uncaughtException", onUncaughtException);
    targetProcess.off("unhandledRejection", onUnhandledRejection);
    disposeSocketTracker();
    disposeSetTos();
  };
}
