import { describe, expect, it } from "vite-plus/test";

import { sameResource } from "./McpOAuth.ts";

const urls = { issuer: "http://127.0.0.1:3773", resource: "http://127.0.0.1:3773/mcp" };

// RFC 8707: a resource indicator must not include a fragment. A trailing "#"
// leaves URL.hash empty, so it has to be refused from the presented text.
describe("sameResource", () => {
  it("refuses a resource with a fragment, even an empty one", () => {
    expect(sameResource(urls, "http://127.0.0.1:3773/mcp#")).toBe(false);
    expect(sameResource(urls, "http://127.0.0.1:3773/mcp#x")).toBe(false);
  });

  it("still matches the exact resource, a trailing slash and an absent one", () => {
    expect(sameResource(urls, "http://127.0.0.1:3773/mcp")).toBe(true);
    expect(sameResource(urls, "http://127.0.0.1:3773/mcp/")).toBe(true);
    expect(sameResource(urls, undefined)).toBe(true);
    expect(sameResource(urls, "http://127.0.0.1:3773/other")).toBe(false);
  });
});
