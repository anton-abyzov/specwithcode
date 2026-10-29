import { describe, expect, it } from "vite-plus/test";
import { museSessionMcpServers } from "./museMcpServers.ts";

describe("Muse session MCP conversion", () => {
  it("converts stdio and http servers, keyed by name", () => {
    expect(
      museSessionMcpServers([
        {
          name: "studio-code",
          command: "/app/specweave-studio",
          args: ["acp-mcp-bridge"],
          env: [{ name: "TOKEN", value: "x" }],
        },
        {
          type: "http",
          name: "remote",
          url: "https://example.test/mcp",
          headers: [{ name: "Authorization", value: "Bearer y" }],
        },
      ]),
    ).toEqual({
      "studio-code": {
        transport: "stdio",
        command: "/app/specweave-studio",
        args: ["acp-mcp-bridge"],
        env: { TOKEN: "x" },
      },
      remote: {
        transport: "streamableHttp",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer y" },
      },
    });
  });

  it("skips ACP-transport servers and reports undefined when nothing converts", () => {
    expect(museSessionMcpServers(undefined)).toBeUndefined();
    expect(museSessionMcpServers([])).toBeUndefined();
    expect(
      museSessionMcpServers([{ type: "acp", name: "studio-code", serverId: "studio-code" }]),
    ).toBeUndefined();
  });
});
