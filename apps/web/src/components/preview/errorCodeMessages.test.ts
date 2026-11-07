import { describe, expect, it } from "vite-plus/test";

import { describePreviewError } from "./errorCodeMessages";

describe("describePreviewError", () => {
  it.each([
    ["ERR_NAME_NOT_RESOLVED", "DNS address could not be found"],
    ["ERR_NAME_RESOLUTION_FAILED", "DNS address could not be found"],
    ["ERR_CONNECTION_REFUSED", "Connection refused"],
    ["ERR_CONNECTION_RESET", "Connection was reset"],
    ["ERR_CONNECTION_CLOSED", "Connection was closed"],
    ["ERR_CONNECTION_TIMED_OUT", "Connection timed out"],
    ["ERR_INTERNET_DISCONNECTED", "No internet connection"],
    ["ERR_TIMED_OUT", "Connection timed out"],
    ["ERR_CERT_AUTHORITY_INVALID", "Certificate authority is not trusted"],
    ["ERR_CERT_COMMON_NAME_INVALID", "Certificate hostname mismatch"],
    ["ERR_CERT_DATE_INVALID", "Certificate is expired or not yet valid"],
    ["ERR_TOO_MANY_REDIRECTS", "Too many redirects"],
    ["ERR_ADDRESS_UNREACHABLE", "Server address is unreachable"],
    ["ERR_EMPTY_RESPONSE", "Server returned no data"],
    ["ERR_SSL_PROTOCOL_ERROR", "Secure connection failed"],
  ])("maps %s to a friendly message", (code, message) => {
    expect(describePreviewError(code)).toBe(message);
  });

  it.each(["ERR_UNKNOWN_ERROR", "The preview could not connect"])(
    "preserves the unknown description %s",
    (description) => {
      expect(describePreviewError(description)).toBe(description);
    },
  );

  it("uses a fallback for an empty description", () => {
    expect(describePreviewError("")).toBe("Network error");
  });
});
