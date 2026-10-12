import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import {
  PAGE_TITLE_MAX_LENGTH,
  decodeHtmlEntities,
  describeLocalServerPage,
  extractHtmlTitle,
  isSpecWithCodeDocument,
  readBoundedText,
} from "./localServerPage.ts";

const encoder = new TextEncoder();

describe("extractHtmlTitle", () => {
  it("reads and trims the head title", () => {
    expect(extractHtmlTitle("<html><head><title>\n  My App \n</title></head></html>")).toBe(
      "My App",
    );
  });

  it("accepts attributes and mixed case tags", () => {
    expect(extractHtmlTitle('<HEAD><TITLE data-x="1">Dash</TITLE></HEAD>')).toBe("Dash");
  });

  it("decodes entities and collapses whitespace", () => {
    expect(extractHtmlTitle("<title>Tom &amp; Jerry&#39;s  &#x2014;\tAdmin</title>")).toBe(
      "Tom & Jerry's — Admin",
    );
  });

  it("ignores a body SVG title", () => {
    expect(
      extractHtmlTitle("<head></head><body><svg><title>Close icon</title></svg></body>"),
    ).toBeNull();
  });

  it("returns null for a missing or empty title", () => {
    expect(extractHtmlTitle("<html><head></head></html>")).toBeNull();
    expect(extractHtmlTitle("<title>   </title>")).toBeNull();
    expect(extractHtmlTitle("<title>unterminated")).toBeNull();
  });

  it("caps very long titles", () => {
    const title = extractHtmlTitle(`<title>${"a".repeat(500)}</title>`);
    expect(title).toHaveLength(PAGE_TITLE_MAX_LENGTH);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("strips control characters", () => {
    expect(extractHtmlTitle("<title>a\u0007b</title>")).toBe("a b");
  });
});

describe("decodeHtmlEntities", () => {
  it("leaves unknown and invalid references alone", () => {
    expect(decodeHtmlEntities("&bogus; &#0; &#xD800; &lt;ok&gt;")).toBe(
      "&bogus; &#0; &#xD800; <ok>",
    );
  });
});

describe("isSpecWithCodeDocument", () => {
  it("recognises the application-name marker", () => {
    expect(
      isSpecWithCodeDocument('<meta content="SpecWithCode" name="application-name">', null),
    ).toBe(true);
  });

  it("recognises older builds by title and boot script", () => {
    const html = '<script>const K = "studio:themes:v1";</script><title>SpecWithCode</title>';
    expect(isSpecWithCodeDocument(html, "SpecWithCode")).toBe(true);
  });

  it("does not trust the title alone", () => {
    expect(isSpecWithCodeDocument("<title>SpecWithCode</title>", "SpecWithCode")).toBe(false);
    expect(describeLocalServerPage("<title>Other Dev Server (Alpha)</title>")).toEqual({
      title: "Other Dev Server (Alpha)",
      specWithCode: false,
    });
  });
});

describe("readBoundedText", () => {
  effectIt.effect("stops after the byte limit", () =>
    Effect.gen(function* () {
      let pulled = 0;
      const chunks = Stream.fromIterable(
        Array.from({ length: 10 }, (_, index) => encoder.encode(String(index).repeat(4))),
      ).pipe(Stream.tap(() => Effect.sync(() => (pulled += 1))));
      const text = yield* readBoundedText(chunks, 10);
      expect(text).toBe("0000111122");
      expect(pulled).toBe(3);
    }),
  );

  effectIt.effect("returns the whole body when it is short", () =>
    Effect.gen(function* () {
      const text = yield* readBoundedText(Stream.make(encoder.encode("<title>x</title>")));
      expect(text).toBe("<title>x</title>");
    }),
  );
});
