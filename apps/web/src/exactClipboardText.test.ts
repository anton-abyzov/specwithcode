import { describe, expect, it } from "vite-plus/test";

import { exactCopyText, exactPathListText, exactPathText } from "./exactClipboardText";

const PATH = "/Users/me/Downloads/cws/screenshot-1-overview.png";

function bytes(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

describe("exactCopyText", () => {
  it("drops the newline a code fence ends with", () => {
    expect(bytes(exactCopyText(`${PATH}\n`))).toEqual(bytes(PATH));
  });

  it("drops trailing whitespace and turns CRLF into LF", () => {
    expect(exactCopyText(`${PATH}\r\n${PATH} \t\r\n\r\n`)).toBe(`${PATH}\n${PATH}`);
  });

  it("removes invisible characters and turns lookalike spaces into spaces", () => {
    const dirty = `﻿/Users/me/My Files/a​.png⁠­`;
    expect(bytes(exactCopyText(dirty))).toEqual(bytes("/Users/me/My Files/a.png"));
  });

  it("keeps indentation, inner blank lines and emoji joiners", () => {
    expect(exactCopyText("\n  if (a) {\n\n    b();\n  }\n")).toBe("  if (a) {\n\n    b();\n  }");
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    expect(exactCopyText(family)).toBe(family);
  });
});

describe("exactPathText", () => {
  it("strips quotes, backticks and spaces around a path", () => {
    expect(exactPathText(`“${PATH}” `)).toBe(PATH);
    expect(exactPathText(`\`${PATH}\``)).toBe(PATH);
    expect(bytes(exactPathText(` '${PATH}'\n`))).toEqual(bytes(PATH));
  });

  it("removes zero-width joiners a path never holds", () => {
    expect(exactPathText(`/Users/me/a‍‌.png`)).toBe("/Users/me/a.png");
  });
});

describe("exactPathListText", () => {
  it("puts one exact path per line and drops empty lines", () => {
    expect(exactPathListText([` ${PATH} `, "", `${PATH} `])).toBe(`${PATH}\n${PATH}`);
  });
});
