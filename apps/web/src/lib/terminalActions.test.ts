import { describe, expect, it } from "vite-plus/test";
import { safeTerminalUrl, terminalActions, terminalTextSegments } from "./terminalActions";

const GH_DEVICE = [
  "! First copy your one-time code: 3160-87C3",
  "Press Enter to open https://github.com/login/device in your browser...",
].join("\n");

describe("terminal links and codes", () => {
  it("finds the GitHub device code and its sign-in page, keeping every character", () => {
    const segments = terminalTextSegments(GH_DEVICE);
    expect(segments.map((segment) => segment.text).join("")).toBe(GH_DEVICE);
    expect(segments.filter((segment) => segment.kind !== "text")).toEqual([
      { kind: "code", text: "3160-87C3" },
      {
        kind: "url",
        text: "https://github.com/login/device",
        url: "https://github.com/login/device",
      },
    ]);
    expect(terminalActions(GH_DEVICE)).toEqual({
      links: ["https://github.com/login/device"],
      codes: ["3160-87C3"],
    });
  });

  it.each([
    ["see https://example.com/a.", "https://example.com/a"],
    ["(docs: https://example.com/a_(b))", "https://example.com/a_(b)"],
    ["(https://example.com/x)", "https://example.com/x"],
    ['url="https://example.com/q?a=1&b=2", next', "https://example.com/q?a=1&b=2"],
    ["␛[0mhttps://example.com/p␛[0m", "https://example.com/p"],
  ])("ends a URL where the text around it starts: %s", (line, url) => {
    expect(terminalTextSegments(line).find((segment) => segment.kind === "url")?.text).toBe(url);
  });

  it("links only well-formed http(s) URLs", () => {
    for (const line of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "data:text/html,<b>x</b>",
      "https://",
      "https://user:secret@example.com/",
    ]) {
      expect(terminalTextSegments(line).every((segment) => segment.kind === "text")).toBe(true);
    }
    expect(safeTerminalUrl("http://localhost:3000/cb")).toBe("http://localhost:3000/cb");
    expect(safeTerminalUrl("javascript:alert(1)")).toBeNull();
  });

  it("offers a code only on a line that talks about a code", () => {
    expect(terminalActions("Enter the code ABCD12345 to authenticate.").codes).toEqual([
      "ABCD12345",
    ]);
    expect(terminalActions("Your verification code is 482913").codes).toEqual(["482913"]);
    expect(terminalActions("commit 3160-87C3 merged").codes).toEqual([]);
    expect(terminalActions("exit code 127").codes).toEqual([]);
    expect(terminalActions("code: BUILD-PASSED").codes).toEqual([]);
  });

  it("buttons only links the output asks to open, newest copies, at most three", () => {
    const output = [
      "npm notice https://docs.npmjs.com/cli",
      ...["a", "b", "c", "d"].map((path) => `Open https://example.com/${path} in a browser`),
      "Open https://example.com/b again",
    ].join("\n");
    expect(terminalActions(output).links).toEqual([
      "https://example.com/c",
      "https://example.com/d",
      "https://example.com/b",
    ]);
  });

  it("leaves look-alikes alone: error names, ranges, UUIDs, plain words", () => {
    expect(terminalActions("Error code: READ-ONLY device").codes).toEqual([]);
    expect(terminalActions("device ports 8000-9000 code").codes).toEqual([]);
    expect(terminalActions("Device UUID 550E8400-E29B-41D4-A716-446655440000").codes).toEqual([]);
    expect(terminalActions("Error code ABCDEFG").codes).toEqual([]);
  });

  it("finds all-letter and mixed-case-keyword codes a sign-in asks for", () => {
    expect(
      terminalActions(
        "To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code HZQXWRTPL to authenticate.",
      ),
    ).toEqual({ links: ["https://microsoft.com/devicelogin"], codes: ["HZQXWRTPL"] });
    expect(terminalActions("First copy your one-time code: WDJB-MJHT").codes).toEqual([
      "WDJB-MJHT",
    ]);
    expect(terminalActions("Your Code: ABC123").codes).toEqual(["ABC123"]);
  });

  it("keeps non-ASCII paths and drops an escape remnant", () => {
    const find = (line: string) =>
      terminalTextSegments(line).find((segment) => segment.kind === "url")?.text;
    expect(find("open https://ru.wikipedia.org/wiki/Москва now")).toBe(
      "https://ru.wikipedia.org/wiki/Москва",
    );
    expect(find("open https://example.com/a[0m")).toBe("https://example.com/a");
  });

  it("never links a URL cut by the scan bound, and keeps every character of a huge output", () => {
    const huge = `${"x".repeat(199_990)} https://example.com/longpath\nmore https://example.com/b\n`;
    const segments = terminalTextSegments(huge);
    expect(segments.map((segment) => segment.text).join("")).toBe(huge);
    expect(segments.filter((segment) => segment.kind === "url")).toEqual([]);
    const tail = `${"y".repeat(250_000)}\nOpen https://example.com/device to sign in\n`;
    expect(terminalActions(tail).links).toEqual(["https://example.com/device"]);
    expect(terminalActions("z".repeat(250_000)).links).toEqual([]);
  });

  it("bounds the work on one long line", () => {
    const line = "visit https://a.b/c code ABCD-1234 ".repeat(6000);
    const started = performance.now();
    const segments = terminalTextSegments(line);
    expect(performance.now() - started).toBeLessThan(100);
    expect(segments.map((segment) => segment.text).join("")).toBe(line);
    expect(segments.filter((segment) => segment.kind !== "text").length).toBeLessThanOrEqual(50);
  });
});
