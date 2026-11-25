import { describe, expect, it } from "vite-plus/test";

import {
  ARTIFACT_APP_LOOKALIKE_SUFFIX,
  ARTIFACT_APP_NAME_MAX,
  ARTIFACT_APP_RESERVED_NAMES,
  ARTIFACT_APP_UNTITLED,
  foldArtifactAppName,
  resolveArtifactAppName,
  sanitizeArtifactAppName,
} from "./ArtifactAppName.ts";

const codePoints = (value: string) => Array.from(value).length;

describe("sanitizeArtifactAppName", () => {
  it.each([
    ["Daily metrics", "Daily metrics"],
    ["  Daily   metrics \t ", "Daily metrics"],
    ["Sales/Revenue\\Q3", "Sales Revenue Q3"],
    ['a:b*c?d"e<f>g|h', "a b c d e f g h"],
    ["line\nbreak\rand\u0007bell", "line break and bell"],
    ["para\u2028graph\u2029end", "para graph end"],
    ["zero\u200Bwidth\u200Djoin", "zerowidthjoin"],
    ["bidi\u202Eoverride\u202C", "bidioverride"],
    ["...hidden", "hidden"],
    [". . .dots", "dots"],
    ["Report.app", "Report"],
    ["Report.APP", "Report"],
    ["x.app.app", "x"],
    ["x.app. ", "x"],
    ["trailing...", "trailing"],
    [".app", "app"],
    ["Untitled.app.", "Untitled"],
    ["", ARTIFACT_APP_UNTITLED],
    ["   ", ARTIFACT_APP_UNTITLED],
    ["///", ARTIFACT_APP_UNTITLED],
    ["\u200B", ARTIFACT_APP_UNTITLED],
    ["CON", "CON (Page)"],
    ["nul.txt", "nul (Page).txt"],
    ["Console", "Console"],
  ])("%j -> %j", (title, expected) => {
    expect(sanitizeArtifactAppName(title)).toBe(expected);
  });

  it("normalizes with NFKC before stripping, so fullwidth separators are caught", () => {
    expect(sanitizeArtifactAppName("ａ／ｂ：ｃ")).toBe("a b c");
    expect(sanitizeArtifactAppName("．．hidden")).toBe("hidden");
    expect(sanitizeArtifactAppName("Report．ａｐｐ")).toBe("Report");
    expect(sanitizeArtifactAppName("e\u0301")).toBe("é");
  });

  it("composes characters that invisible characters separated", () => {
    expect(sanitizeArtifactAppName("e\u200D\u0301")).toBe("\u00e9");
    expect(sanitizeArtifactAppName("e\uD800\u0301")).toBe("\u00e9");
  });

  it("drops lone surrogates", () => {
    expect(sanitizeArtifactAppName("a\uD800b\uDC00c")).toBe("abc");
  });

  it("caps at 64 code points without splitting a surrogate pair", () => {
    const emoji = "\u{1F600}";
    const name = sanitizeArtifactAppName(emoji.repeat(70));
    expect(codePoints(name)).toBe(ARTIFACT_APP_NAME_MAX);
    expect(name).toBe(emoji.repeat(64));
    expect(name.isWellFormed()).toBe(true);
    expect(sanitizeArtifactAppName(`${"a".repeat(63)}${emoji}${emoji}`)).toBe(
      `${"a".repeat(63)}${emoji}`,
    );
  });

  it("trims again after the cap when the cut lands on a space or dot", () => {
    expect(sanitizeArtifactAppName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
    expect(sanitizeArtifactAppName(`${"a".repeat(60)}.app.xyz`)).toBe("a".repeat(60));
  });

  it("is idempotent", () => {
    for (const title of [
      "x.app.app",
      " ..Hello / World.app. ",
      "CON",
      "nul.txt",
      `${"a".repeat(63)} b`,
      "\u{1F600}".repeat(70),
      "ａ／ｂ",
      "e\u200D\u0301",
      "e\uD800\u0301",
      "",
    ]) {
      const once = sanitizeArtifactAppName(title);
      expect(sanitizeArtifactAppName(once)).toBe(once);
    }
  });
});

describe("foldArtifactAppName", () => {
  it("folds case, spaces, punctuation and accents", () => {
    expect(foldArtifactAppName("Spec With-Code!")).toBe(foldArtifactAppName("specwithcode"));
    expect(foldArtifactAppName("Fïnder")).toBe(foldArtifactAppName("Finder"));
  });

  it("folds Cyrillic and Greek look-alikes", () => {
    // Cyrillic р, е, о, с; Greek ο, ρ, ν
    expect(foldArtifactAppName("SрeсWithCode")).toBe(foldArtifactAppName("SpecWithCode"));
    expect(foldArtifactAppName("Сlаudе")).toBe(foldArtifactAppName("Claude"));
    expect(foldArtifactAppName("Micrοsοft")).toBe(foldArtifactAppName("Microsoft"));
    expect(foldArtifactAppName("Аррlе")).toBe(foldArtifactAppName("Apple"));
    expect(foldArtifactAppName("Ѕafari")).toBe(foldArtifactAppName("Safari"));
    expect(foldArtifactAppName("іԁ")).toBe(foldArtifactAppName("id"));
  });

  it("folds digits and letter pairs that imitate letters", () => {
    expect(foldArtifactAppName("Micr0s0ft")).toBe(foldArtifactAppName("Microsoft"));
    expect(foldArtifactAppName("C1aude")).toBe(foldArtifactAppName("Claude"));
    expect(foldArtifactAppName("CIaude")).toBe(foldArtifactAppName("Claude"));
    expect(foldArtifactAppName("Terrninal")).toBe(foldArtifactAppName("Terminal"));
    expect(foldArtifactAppName("Ｗindows")).toBe(foldArtifactAppName("Windows"));
  });

  it("keeps different names apart", () => {
    expect(foldArtifactAppName("Sales report")).not.toBe(foldArtifactAppName("Sales reports"));
    expect(foldArtifactAppName("日报")).not.toBe(foldArtifactAppName("周报"));
  });
});

describe("resolveArtifactAppName", () => {
  it("keeps an ordinary name", () => {
    expect(resolveArtifactAppName({ title: "Morning dashboard", takenNames: [] })).toBe(
      "Morning dashboard",
    );
  });

  it("uses the look-alike suffix", () => {
    expect(ARTIFACT_APP_LOOKALIKE_SUFFIX).toBe(" (Page)");
  });

  it.each(ARTIFACT_APP_RESERVED_NAMES.map((name) => [name]))("marks %s as a page", (name) => {
    expect(resolveArtifactAppName({ title: name, takenNames: [] })).toBe(`${name} (Page)`);
  });

  it("marks look-alikes of reserved names", () => {
    expect(resolveArtifactAppName({ title: "SрecWithCode", takenNames: [] })).toBe(
      "SрecWithCode (Page)",
    );
    expect(resolveArtifactAppName({ title: "specwithcode", takenNames: [] })).toBe(
      "specwithcode (Page)",
    );
    expect(resolveArtifactAppName({ title: "Spec With Code.app", takenNames: [] })).toBe(
      "Spec With Code (Page)",
    );
    expect(resolveArtifactAppName({ title: "SYSTEM   SETTINGS", takenNames: [] })).toBe(
      "SYSTEM SETTINGS (Page)",
    );
    expect(resolveArtifactAppName({ title: "Fi\u0301nder", takenNames: [] })).toBe("Fínder (Page)");
  });

  it("adds caller reserved names to the built-in list", () => {
    const reservedNames = ["Slack"];
    expect(resolveArtifactAppName({ title: "Slаck", reservedNames, takenNames: [] })).toBe(
      "Slаck (Page)",
    );
    expect(resolveArtifactAppName({ title: "Claude", reservedNames, takenNames: [] })).toBe(
      "Claude (Page)",
    );
    expect(
      resolveArtifactAppName({ title: "Untitled", reservedNames: ["", "..."], takenNames: [] }),
    ).toBe("Untitled");
  });

  it("keeps the suffix when the name is at the length cap", () => {
    const lookalike = resolveArtifactAppName({
      title: "Claude",
      reservedNames: ["y".repeat(64)],
      takenNames: [],
    });
    expect(lookalike).toBe("Claude (Page)");
    const longReserved = "y".repeat(64);
    const marked = resolveArtifactAppName({
      title: longReserved,
      reservedNames: [longReserved],
      takenNames: [],
    });
    expect(marked).toBe(`${"y".repeat(57)} (Page)`);
    expect(codePoints(marked)).toBe(ARTIFACT_APP_NAME_MAX);
  });

  it("counts up from 2 to keep names unique, case-insensitively", () => {
    expect(resolveArtifactAppName({ title: "Board", takenNames: ["board"] })).toBe("Board 2");
    expect(resolveArtifactAppName({ title: "Board", takenNames: ["Board", "BOARD 2"] })).toBe(
      "Board 3",
    );
    expect(resolveArtifactAppName({ title: "Claude", takenNames: ["Claude (Page)"] })).toBe(
      "Claude (Page) 2",
    );
  });

  it("compares taken names composed", () => {
    expect(resolveArtifactAppName({ title: "Café", takenNames: ["Cafe\u0301"] })).toBe("Café 2");
  });

  it("keeps the counter when the name is at the length cap", () => {
    const name = "z".repeat(64);
    const resolved = resolveArtifactAppName({ title: name, takenNames: [name] });
    expect(resolved).toBe(`${"z".repeat(62)} 2`);
    expect(codePoints(resolved)).toBe(ARTIFACT_APP_NAME_MAX);
  });

  it("throws after 99", () => {
    const takenNames = ["Board", ...Array.from({ length: 98 }, (_, index) => `Board ${index + 2}`)];
    expect(() => resolveArtifactAppName({ title: "Board", takenNames })).toThrow(
      "No free app name",
    );
    expect(resolveArtifactAppName({ title: "Board", takenNames: takenNames.slice(0, -1) })).toBe(
      "Board 99",
    );
  });

  it("returns names that sanitize to themselves", () => {
    for (const title of [
      "Claude",
      "CON",
      "x".repeat(70),
      "Board",
      ".app",
      "e\u200D\u0301",
      "e\uD800\u0301",
    ]) {
      const resolved = resolveArtifactAppName({
        title,
        takenNames: [sanitizeArtifactAppName(title)],
      });
      expect(sanitizeArtifactAppName(resolved)).toBe(resolved);
    }
  });
});
