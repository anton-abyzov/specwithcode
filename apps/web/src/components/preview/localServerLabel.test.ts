import { describe, expect, it } from "vite-plus/test";

import {
  arrangeLocalServers,
  describeLocalServer,
  friendlyProcessName,
  isCurrentAppServer,
} from "./localServerLabel";

const base = { port: 5173, processName: "node" as string | null };

describe("friendlyProcessName", () => {
  it("maps common runtimes and tunnels", () => {
    expect(friendlyProcessName("node")).toBe("Node server");
    expect(friendlyProcessName("python3")).toBe("Python server");
    expect(friendlyProcessName("Python3.12")).toBe("Python server");
    expect(friendlyProcessName("ssh")).toBe("SSH tunnel");
  });

  it("returns null for unknown or missing names", () => {
    expect(friendlyProcessName("devd")).toBeNull();
    expect(friendlyProcessName(null)).toBeNull();
    expect(friendlyProcessName("  ")).toBeNull();
  });
});

describe("describeLocalServer", () => {
  it("prefers the page title", () => {
    expect(describeLocalServer({ ...base, pageTitle: "Ads Dashboard" })).toEqual({
      title: "Ads Dashboard",
      description: "localhost:5173 · node",
      hoverText: "Ads Dashboard — localhost:5173 · node",
    });
  });

  it("falls back to a friendly process name", () => {
    expect(describeLocalServer({ ...base, port: 18319, processName: "ssh" }).title).toBe(
      "SSH tunnel",
    );
  });

  it("never headlines an unknown process name; it stays on the second line", () => {
    expect(describeLocalServer({ ...base, port: 3773, processName: "devd" })).toEqual({
      title: "Local server",
      description: "localhost:3773 · devd",
      hoverText: "Local server — localhost:3773 · devd",
    });
  });

  it("says Local server when nothing is known", () => {
    expect(describeLocalServer({ port: 3000, processName: null })).toEqual({
      title: "Local server",
      description: "localhost:3000",
      hoverText: "Local server — localhost:3000",
    });
  });

  it("labels SpecWithCode pages as SpecWithCode", () => {
    expect(
      describeLocalServer({
        port: 28319,
        processName: "ssh",
        pageTitle: "Something else",
        specWithCode: true,
      }).title,
    ).toBe("SpecWithCode");
  });
});

describe("isCurrentAppServer / arrangeLocalServers", () => {
  const here = { hostname: "localhost", port: "8319", protocol: "http:" };

  it("matches only a SpecWithCode server on this page's loopback port", () => {
    expect(isCurrentAppServer({ port: 8319, specWithCode: true }, here)).toBe(true);
    expect(isCurrentAppServer({ port: 8319 }, here)).toBe(false);
    expect(isCurrentAppServer({ port: 8318, specWithCode: true }, here)).toBe(false);
    expect(
      isCurrentAppServer(
        { port: 8319, specWithCode: true },
        { hostname: "studio.example.com", port: "8319", protocol: "https:" },
      ),
    ).toBe(false);
    expect(
      isCurrentAppServer(
        { port: 8319, specWithCode: true },
        { hostname: "", port: "", protocol: "file:" },
      ),
    ).toBe(false);
  });

  it("hides this app and moves other SpecWithCode servers last", () => {
    const servers = [
      { port: 8318, specWithCode: true as const },
      { port: 8319, specWithCode: true as const },
      { port: 5173 },
      { port: 8233 },
    ];
    expect(arrangeLocalServers(servers, here).map((server) => server.port)).toEqual([
      5173, 8233, 8318,
    ]);
    expect(arrangeLocalServers(servers, null).map((server) => server.port)).toEqual([
      5173, 8233, 8318, 8319,
    ]);
  });
});
