import { describe, expect, it } from "vite-plus/test";

import { parseXml, XML_LIMITS, XmlRefused } from "./xml.ts";

/** Milliseconds `run` takes, whether it returns or throws. */
const timed = (run: () => unknown) => {
  const start = performance.now();
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  return { ms: performance.now() - start, thrown };
};

describe("parseXml (1051 T-06)", () => {
  it("reads attributes in either quote style, with spaces around the equals sign", () => {
    const element = parseXml(`<a:off x="1" y = '2' name="a &amp; b" xmlns:a="urn:a"/>`);
    expect(element.name).toBe("a:off");
    expect({ ...element.attrs }).toEqual({ x: "1", y: "2", name: "a & b", "xmlns:a": "urn:a" });
  });

  it("treats a stray run inside a tag as broken markup, not as attributes", () => {
    expect(() => parseXml(`<a x="1" junk/>`)).toThrow("Broken attribute.");
    expect(() => parseXml(`<a x=1/>`)).toThrow("Broken attribute.");
    expect(() => parseXml(`<a x="1/>`)).toThrow();
  });

  it("fails a 1 MB run without an equals sign inside a tag in well under a second", () => {
    const hostile = `<a ${"b".repeat(1_000_000)}/>`;
    const { ms, thrown } = timed(() => parseXml(hostile));
    expect(thrown).toBeInstanceOf(Error);
    expect(ms).toBeLessThan(250);
    const spaced = timed(() => parseXml(`<a ${"b ".repeat(500_000)}/>`));
    expect(spaced.thrown).toBeInstanceOf(Error);
    expect(spaced.ms).toBeLessThan(250);
  });

  it("refuses a tag longer than 1 MB without scanning the rest of the part", () => {
    const hostile = `<a ${"b".repeat(XML_LIMITS.tagChars)}${" x".repeat(4 * 1024 * 1024)}/>`;
    const { ms, thrown } = timed(() => parseXml(hostile));
    expect(thrown).toBeInstanceOf(XmlRefused);
    expect((thrown as Error).message).toBe(
      "An XML part has a tag longer than 1 MB, which is not allowed.",
    );
    expect(ms).toBeLessThan(250);
  });

  it("refuses a part over 16 MB before reading it", () => {
    const { ms, thrown } = timed(() => parseXml(`<a>${"x".repeat(XML_LIMITS.partChars)}</a>`));
    expect(thrown).toMatchObject({
      message: "An XML part is larger than 16 MB, the import limit.",
      tooLarge: true,
    });
    expect(ms).toBeLessThan(250);
  });

  it("refuses a part with more than 500,000 elements and reads one at the limit", () => {
    const at = parseXml(`<r>${"<a/>".repeat(XML_LIMITS.elements - 1)}</r>`);
    expect(at.children).toHaveLength(XML_LIMITS.elements - 1);
    expect(() => parseXml(`<r>${"<a/>".repeat(XML_LIMITS.elements)}</r>`)).toThrow(
      new XmlRefused("An XML part has more than 500,000 elements, the import limit.", true),
    );
  });

  it("refuses elements nested more than 256 deep and reads them at 256", () => {
    const nested = (depth: number) => `${"<a>".repeat(depth)}${"</a>".repeat(depth)}`;
    expect(parseXml(nested(XML_LIMITS.depth)).name).toBe("a");
    expect(() => parseXml(nested(XML_LIMITS.depth + 1))).toThrow(
      "An XML part nests elements more than 256 deep, the import limit.",
    );
    expect(() => parseXml(`${"<a>".repeat(XML_LIMITS.depth)}<b/>${"</a>".repeat(256)}`)).toThrow(
      XmlRefused,
    );
  });

  it("counts elements across parts against a shared budget", () => {
    const budget = { elements: 10, used: 0 };
    parseXml("<r><a/><a/><a/><a/></r>", budget);
    expect(budget.used).toBe(5);
    parseXml("<r><a/><a/><a/></r>", budget);
    expect(() => parseXml("<r/>", budget)).not.toThrow();
    expect(budget.used).toBe(10);
    expect(() => parseXml("<r><a/></r>", budget)).toThrow(
      "The file's XML parts hold more than 10 elements in all, the import limit.",
    );
  });
});
