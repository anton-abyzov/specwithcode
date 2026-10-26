import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { describe, expect, it } from "vite-plus/test";

import { NETWORK_BLOCKING_HINT } from "./network.ts";
import {
  isRpcTransportError,
  isTransportConnectionErrorMessage,
  sanitizeThreadErrorMessage,
  THIS_MACHINE_RPC_UNAVAILABLE_MESSAGE,
} from "./transport.ts";

describe("isTransportConnectionErrorMessage", () => {
  it("returns true for SocketCloseError", () => {
    expect(isTransportConnectionErrorMessage("SocketCloseError: connection reset")).toBe(true);
  });

  it("returns true for SocketOpenError", () => {
    expect(isTransportConnectionErrorMessage("SocketOpenError: ECONNREFUSED")).toBe(true);
  });

  it("returns true for socket read and write failures", () => {
    expect(
      isTransportConnectionErrorMessage("SocketReadError: An error occurred during Read"),
    ).toBe(true);
    expect(
      isTransportConnectionErrorMessage("SocketWriteError: An error occurred during Write"),
    ).toBe(true);
    // Case-sensitive: an ordinary sentence mentioning a read error is not a socket tag.
    expect(isTransportConnectionErrorMessage("socketreaderror in config")).toBe(false);
  });

  it("returns true for React Native disconnected socket errors", () => {
    expect(
      isTransportConnectionErrorMessage(
        "The operation couldn't be completed. Socket is not connected",
      ),
    ).toBe(true);
  });

  it("recognizes connection errors emitted by the Effect RPC session", () => {
    expect(isTransportConnectionErrorMessage("Test environment disconnected.")).toBe(true);
    expect(isTransportConnectionErrorMessage("Test environment stopped responding.")).toBe(true);
    expect(
      isTransportConnectionErrorMessage(
        "Test environment could not establish a WebSocket connection.",
      ),
    ).toBe(true);
    expect(isTransportConnectionErrorMessage("Test environment is not connected.")).toBe(true);
    // This machine's server without a session reads as busy, and stays as transient.
    expect(isTransportConnectionErrorMessage(THIS_MACHINE_RPC_UNAVAILABLE_MESSAGE)).toBe(true);
    expect(sanitizeThreadErrorMessage(THIS_MACHINE_RPC_UNAVAILABLE_MESSAGE)).toBeNull();
    expect(isTransportConnectionErrorMessage("ClientProtocolError: socket closed")).toBe(true);
  });

  it("recognizes relay connection errors that carry the network hint", () => {
    for (const sentence of [
      "Relay environment disconnected.",
      "Relay environment stopped responding.",
      "Relay environment could not establish a WebSocket connection.",
    ]) {
      expect(isTransportConnectionErrorMessage(`${sentence} ${NETWORK_BLOCKING_HINT}`)).toBe(true);
    }
    expect(
      isTransportConnectionErrorMessage(
        "Your ChatGPT connection expired or was disconnected. Sign in again.",
      ),
    ).toBe(false);
  });

  it("returns true for the Studio server WebSocket message", () => {
    expect(
      isTransportConnectionErrorMessage("Unable to connect to the Studio server WebSocket."),
    ).toBe(true);
  });

  it("returns true for ping timeout", () => {
    expect(isTransportConnectionErrorMessage("ping timeout")).toBe(true);
  });

  it("returns false for business logic errors", () => {
    expect(isTransportConnectionErrorMessage("Thread not found")).toBe(false);
    expect(isTransportConnectionErrorMessage("Invalid model selection")).toBe(false);
  });

  it("returns false for null, undefined, and empty strings", () => {
    expect(isTransportConnectionErrorMessage(null)).toBe(false);
    expect(isTransportConnectionErrorMessage(undefined)).toBe(false);
    expect(isTransportConnectionErrorMessage("")).toBe(false);
    expect(isTransportConnectionErrorMessage("   ")).toBe(false);
  });
});

describe("sanitizeThreadErrorMessage", () => {
  it("strips transport errors", () => {
    expect(sanitizeThreadErrorMessage("SocketCloseError: oops")).toBeNull();
  });

  it("preserves non-transport errors", () => {
    expect(sanitizeThreadErrorMessage("Thread not found")).toBe("Thread not found");
    expect(sanitizeThreadErrorMessage("Select a base branch before sending.")).toBe(
      "Select a base branch before sending.",
    );
  });

  it("returns null for null/undefined", () => {
    expect(sanitizeThreadErrorMessage(null)).toBeNull();
    expect(sanitizeThreadErrorMessage(undefined)).toBeNull();
  });
});

describe("isRpcTransportError", () => {
  const rpcError = (reason: RpcClientError.RpcClientError["reason"]) =>
    new RpcClientError.RpcClientError({ reason });

  it("matches every socket failure, including a ping timeout", () => {
    for (const reason of [
      new Socket.SocketReadError({ cause: new Error("ping timeout") }),
      new Socket.SocketWriteError({ cause: new Error("Broken pipe") }),
      new Socket.SocketCloseError({ code: 1006 }),
      new Socket.SocketOpenError({ kind: "Timeout", cause: new Error("timeout") }),
    ]) {
      expect(isRpcTransportError(rpcError(reason))).toBe(true);
    }
  });

  it("matches a socket failure wrapped in a ClientProtocolError message", () => {
    expect(
      isRpcTransportError({
        _tag: "ClientProtocolError",
        error: rpcError(new Socket.SocketReadError({ cause: new Error("lost") })),
      }),
    ).toBe(true);
  });

  it("does not match protocol defects or ordinary failures", () => {
    expect(
      isRpcTransportError(
        rpcError(
          new RpcClientError.RpcClientDefect({ message: "bad frame", cause: new Error("bad") }),
        ),
      ),
    ).toBe(false);
    expect(isRpcTransportError(new Error("SocketReadError: An error occurred during Read"))).toBe(
      false,
    );
    expect(isRpcTransportError({ _tag: "ClientProtocolError", error: new Error("x") })).toBe(false);
    expect(isRpcTransportError(null)).toBe(false);
  });
});
