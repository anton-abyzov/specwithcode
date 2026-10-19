import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";

const socketReadError = new RpcClientError.RpcClientError({
  reason: new Socket.SocketReadError({ cause: new Error("ping timeout") }),
});

describe("formatEnvironmentQueryError", () => {
  it("shows nothing when the socket under the request was lost", () => {
    expect(formatEnvironmentQueryError(Cause.fail(socketReadError))).toBeNull();
    expect(
      formatEnvironmentQueryError(
        Cause.fail(
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        ),
      ),
    ).toBeNull();
  });

  it("keeps the reason for a machine that is not connected or offline", () => {
    expect(
      formatEnvironmentQueryError(Cause.fail(new Error("Anton's MacBook is not connected."))),
    ).toBe("Anton's MacBook is not connected.");
    expect(
      formatEnvironmentQueryError(Cause.fail(new Error("Environment remote-1 is offline."))),
    ).toBe("Environment remote-1 is offline.");
    expect(
      formatEnvironmentQueryError(Cause.fail(new Error("Build box stopped responding."))),
    ).toBe("Build box stopped responding.");
  });

  it("keeps genuine failures visible", () => {
    expect(formatEnvironmentQueryError(Cause.fail(new Error("Repository not found.")))).toBe(
      "Repository not found.",
    );
    expect(formatEnvironmentQueryError(Cause.fail(new Error("  ")))).toBe(
      "The environment request failed.",
    );
    expect(
      formatEnvironmentQueryError(
        Cause.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: "Unexpected frame",
              cause: new Error("Unexpected frame"),
            }),
          }),
        ),
      ),
    ).toBe("RpcClientDefect: Unexpected frame");
  });
});

describe("useEnvironmentQuery", () => {
  it("keeps the failure for callers while hiding a transport error message", () => {
    const atom = Atom.make(AsyncResult.failure<string, unknown>(Cause.fail(socketReadError)));
    let view: ReturnType<typeof useEnvironmentQuery<string, unknown>> | null = null;
    function Probe() {
      view = useEnvironmentQuery(atom);
      return null;
    }

    renderToStaticMarkup(createElement(Probe));

    expect(view).not.toBeNull();
    expect(view!.error).toBeNull();
    expect(view!.failure).toBe(socketReadError);
    expect(view!.isSuccess).toBe(false);
  });
});
