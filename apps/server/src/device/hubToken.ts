/**
 * The device hub's session token.
 *
 * The hub listens on loopback, which every local process and every web page's
 * script can reach, and its routes boot, drive and record devices. Started with
 * `--require-token` it makes a random token, prints it once in its startup
 * link (`http://localhost:<port>/?token=<token>`) and refuses any request that
 * does not carry it. Only this server reads that output, and it sends the token
 * as a Bearer header on every hub call and socket. The token stays on the
 * server: clients reach the hub only through the proxy, and the hub's output is
 * logged with the token blanked.
 */
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Socket from "effect/socket/Socket";

/** The token in the hub's startup link; the hub makes it as base64url. */
const TOKEN_IN_LINK = /([?&]token=)([A-Za-z0-9_-]+)/g;

/** The token a hub output line announces, if it carries one. */
export const readHubToken = (line: string): string | undefined => {
  TOKEN_IN_LINK.lastIndex = 0;
  return TOKEN_IN_LINK.exec(line)?.[2];
};

/** The line with every token blanked, for logs. */
export const redactHubToken = (line: string): string => line.replace(TOKEN_IN_LINK, "$1<redacted>");

/** Headers that authorize a request to the hub. A hub started without a token needs none. */
export const hubAuthorization = (token: string | undefined): Record<string, string> =>
  token === undefined ? {} : { authorization: `Bearer ${token}` };

/** A client whose every request to the hub carries its token. */
export const withHubToken = (
  client: HttpClient.HttpClient,
  token: string | undefined,
): HttpClient.HttpClient =>
  token === undefined
    ? client
    : client.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(token)));

/**
 * Opens hub sockets with the token as a Bearer header on the upgrade. Node's
 * own WebSocket (the one the proxy used before) takes `headers` in an init
 * object in place of the protocol list, which the standard one cannot do.
 */
export const hubWebSocketConstructor = (token: string | undefined) =>
  Layer.succeed(Socket.WebSocketConstructor)((url, protocols) => {
    const init = {
      ...(protocols === undefined ? {} : { protocols }),
      headers: hubAuthorization(token),
    };
    return new globalThis.WebSocket(url, init as unknown as string[]);
  });
