import { describe, expect, it } from "vite-plus/test";

import { PRODUCT_VOCABULARY } from "./productVocabulary.ts";
import {
  acceptTranscript,
  contextualStrings,
  correctTranscript,
  decodeStoredVocabulary,
  encodeStoredVocabulary,
  formatVocabulary,
  judgeTranscript,
  looksSecret,
  parseVocabulary,
  productWords,
  wavPeak,
  wavSeconds,
  whisperPrompt,
  withProductVocabulary,
} from "./vocabulary.ts";

describe("vocabulary parsing", () => {
  it("reads terms, replacements and comments, and drops duplicates", () => {
    const { terms, refused } = parseVocabulary(
      "SpecWeave\n# note\n\n spec with code => SpecWithCode\nspecweave\n",
    );
    expect(terms).toEqual([
      { phrase: "SpecWeave" },
      { phrase: "spec with code", replacement: "SpecWithCode" },
    ]);
    expect(refused).toBe(0);
    expect(formatVocabulary(terms)).toBe("SpecWeave\nspec with code => SpecWithCode");
  });

  it.each([
    "sk-abcdefghijklmnop",
    `ghp_${"a1B2".repeat(9)}`,
    `AKIA${"IOSFODNN7EXAMPLE"}`,
    "eyJhbGciOiJIUzI1NiIsInR5cCI6",
    "someone@example.com",
    "+1 650 555 0100",
    "(415) 555-0132",
    "+1 (415) 555-0132",
    "abcDEF123xyz_QRStuv456_mnoPQR789",
    "password: hunter2",
    "https://user:pw@example.com/x",
    "d41d8cd98f00b204e9800998ecf8427e",
    "aB3dE5gH7jK9mN",
    "Xk29dLq7ZpTm41VbNc8RsYw3",
    "my key => sk-abcdefghijklmnop",
  ])("refuses a secret-like line without keeping it: %s", (line) => {
    const { terms, refused } = parseVocabulary(line);
    expect(terms).toEqual([]);
    expect(refused).toBe(1);
  });

  it.each([
    "SpecWeave",
    "SpecWithCode",
    "claude-sonnet-4-5-20250929",
    "PipeWire",
    "Anton Abyzov",
    "GPT-6.1-Sol",
    "kubernetes",
    "1.0.166",
    "EC2",
    "skaffold",
    "skeleton",
    "pkgbuild",
    "iPhone15ProMax",
    "MacBookPro16",
    "ASIA-PACIFIC",
    "Kubernetes-controller-manager",
    "0959-installed-chat-rename-acceptance",
    "x86_64-unknown-linux-gnu",
  ])("keeps an ordinary term: %s", (line) => {
    expect(looksSecret(line)).toBe(false);
  });

  it("refuses an overlong line and one with no letter or digit", () => {
    expect(parseVocabulary("x".repeat(81)).refused).toBe(1);
    expect(parseVocabulary("---").refused).toBe(1);
    expect(parseVocabulary("- => Z").refused).toBe(1);
    expect(parseVocabulary("word => ---").refused).toBe(1);
  });

  it("round-trips the stored file and refilters a hand-edited one", () => {
    const terms = [{ phrase: "Postiz" }, { phrase: "pasta", replacement: "Postiz" }];
    expect(decodeStoredVocabulary(encodeStoredVocabulary(terms))).toEqual(terms);
    expect(
      decodeStoredVocabulary('{"terms":[{"phrase":"sk-abcdefghijklmnop"},{"phrase":"Tauri"}]}'),
    ).toEqual([{ phrase: "Tauri" }]);
    expect(decodeStoredVocabulary("not json")).toEqual([]);
  });
});

describe("recognition hints", () => {
  it("keeps the first terms within Whisper's budget and never splits one", () => {
    const terms = Array.from({ length: 200 }, (_, index) => ({ phrase: `Termname${index}` }));
    const prompt = whisperPrompt(terms);
    expect(prompt.length).toBeLessThanOrEqual(501);
    expect(prompt.startsWith("Termname0, Termname1,")).toBe(true);
    expect(prompt.endsWith(".")).toBe(true);
    expect(prompt).toMatch(/Termname\d+\.$/);
  });

  it("hints the written form and is empty without terms", () => {
    expect(whisperPrompt([{ phrase: "pasta", replacement: "Postiz" }])).toBe("Postiz.");
    expect(whisperPrompt([])).toBe("");
  });

  it("caps Apple's contextual strings at 100", () => {
    const terms = Array.from({ length: 150 }, (_, index) => ({ phrase: `Term${index}` }));
    expect(contextualStrings(terms)).toHaveLength(100);
  });
});

describe("product vocabulary", () => {
  const imported = parseVocabulary(
    "stdio\nEasyChamp\nclaude\ncodex\nspecwithcode\nspecweave\nmcp\nminisforum",
  ).terms;

  it("puts the product's words ahead of an imported list in the hint", () => {
    const prompt = whisperPrompt(withProductVocabulary(imported));
    expect(prompt.startsWith("SpecWithCode, SpecWeave, worktree, worktrees, increment,")).toBe(
      true,
    );
    expect(prompt.endsWith("stdio, EasyChamp, minisforum.")).toBe(true);
    expect(prompt).not.toMatch(/specwithcode|specweave|claude,|codex|mcp/);
  });

  it("fits every product word in the hint with a full imported list behind it", () => {
    const many = Array.from({ length: 352 }, (_, index) => ({ phrase: `Imported${index}` }));
    const prompt = whisperPrompt(withProductVocabulary(many));
    for (const word of productWords()) expect(prompt).toContain(word);
    expect(prompt).toContain("Imported0");
    expect(prompt.length).toBeLessThanOrEqual(501);
  });

  it("writes product names the way the product does, whatever was heard", () => {
    const terms = withProductVocabulary(imported);
    expect(
      correctTranscript(
        "Open the spec with code coordinator and start a thread in a work tree.",
        terms,
      ),
    ).toBe("Open the SpecWithCode coordinator and start a thread in a worktree.");
    expect(correctTranscript("ask claude to run spec weave verify in cloud code", terms)).toBe(
      "ask Claude to run SpecWeave verify in Claude Code",
    );
    expect(correctTranscript("install the v skill over mcp on git hub", terms)).toBe(
      "install the vskill over MCP on GitHub",
    );
  });

  it("only hints words that are also ordinary ones", () => {
    const terms = withProductVocabulary([]);
    const phrase = "move the cursor, tell a fable and increment the opus counter";
    expect(correctTranscript(phrase, terms)).toBe(phrase);
  });

  it("lets a line of the person's own win when it says something", () => {
    const respelled = withProductVocabulary(
      parseVocabulary("Specweave\ncloud code => Cloud Code").terms,
    );
    expect(correctTranscript("spec weave in cloud code", respelled)).toBe(
      "Specweave in Cloud Code",
    );
    expect(whisperPrompt(respelled).startsWith("SpecWithCode, Specweave,")).toBe(true);
    expect(respelled).toHaveLength(PRODUCT_VOCABULARY.length);
  });

  it("lists each built-in word once for the editor", () => {
    const words = productWords();
    expect(words).toContain("SpecWithCode");
    expect(words).toContain("worktree");
    expect(new Set(words.map((word) => word.toLowerCase())).size).toBe(words.length);
  });
});

describe("transcript correction", () => {
  const terms = [
    { phrase: "SpecWeave" },
    { phrase: "PipeWire" },
    { phrase: "Postiz" },
    { phrase: "11 labs", replacement: "ElevenLabs" },
    { phrase: "AI" },
    { phrase: "ссылка", replacement: "URL" },
  ];

  it("restores casing and joins split forms", () => {
    expect(correctTranscript("merge the spec weave PR and check pipe-wire", terms)).toBe(
      "merge the SpecWeave PR and check PipeWire",
    );
    expect(correctTranscript("the postiz schedule", terms)).toBe("the Postiz schedule");
  });

  it("applies replacements, including Cyrillic ones", () => {
    expect(correctTranscript("with 11 labs narration", terms)).toBe("with ElevenLabs narration");
    expect(correctTranscript("дай ссылка сюда", terms)).toBe("дай URL сюда");
  });

  it("matches whole words only and leaves short case-only terms alone", () => {
    expect(correctTranscript("postizing and aid", terms)).toBe("postizing and aid");
    expect(correctTranscript("ai is here", terms)).toBe("ai is here");
  });

  it("keeps the sentence's capital for a lowercase term and still fixes other casing", () => {
    const lowercase = parseVocabulary(
      "kubernetes\nnpm\nwork tree => worktree\nbtw => by the way",
    ).terms;
    expect(correctTranscript("Kubernetes runs NPM and Npm", lowercase)).toBe(
      "Kubernetes runs npm and Npm",
    );
    expect(
      correctTranscript("Work tree is ready. Work tree two, then a Work Tree.", lowercase),
    ).toBe("Worktree is ready. Worktree two, then a worktree.");
    expect(correctTranscript("Btw it works, BTW", lowercase)).toBe(
      "By the way it works, by the way",
    );
  });

  it("stays quick on a phrase with the largest vocabulary", () => {
    const large = Array.from({ length: 2_000 }, (_, index) => ({
      phrase: `Productname${index}Service`,
    }));
    const phrase = "merge the release and check the service logs ".repeat(90);
    const started = performance.now();
    expect(correctTranscript(phrase, large)).toBe(phrase);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("never rewrites a written form with another term", () => {
    const chained = [
      { phrase: "pasta", replacement: "Postiz app" },
      { phrase: "postiz", replacement: "wrong" },
    ];
    expect(correctTranscript("the pasta", chained)).toBe("the Postiz app");
  });

  it("treats a term's regex characters literally and a $ in a replacement literally", () => {
    expect(correctTranscript("c++ and cxx", [{ phrase: "c++" }])).toBe("c++ and cxx");
    expect(correctTranscript("price", [{ phrase: "price", replacement: "$1 cost" }])).toBe(
      "$1 cost",
    );
  });
});

describe("silence", () => {
  function wav(sample: number): Uint8Array {
    const bytes = new Uint8Array(44 + 4);
    const view = new DataView(bytes.buffer);
    view.setInt16(44, sample, true);
    view.setInt16(46, -sample, true);
    return bytes;
  }

  it("measures the peak of the PCM data only", () => {
    expect(wavPeak(wav(0))).toBe(0);
    expect(wavPeak(wav(0x4000))).toBe(0.5);
  });

  it.each(["Thank you.", "you", "[BLANK_AUDIO]", "(music)", "...", "Спасибо."])(
    "drops %s on a silent recording",
    (text) => {
      expect(acceptTranscript(text, "", 0.001)).toBe("");
    },
  );

  it("reads the recording's length from its header", () => {
    const bytes = new Uint8Array(44 + 32_000);
    new DataView(bytes.buffer).setUint32(28, 32_000, true);
    expect(wavSeconds(bytes)).toBe(1);
    expect(wavSeconds(new Uint8Array(44))).toBe(0);
  });

  it("drops anything a recording with no speech level produced", () => {
    expect(
      judgeTranscript("I'm going to show you how to do it.", { prompt: "", peak: 0.01 }),
    ).toEqual({
      text: "",
      dropped: "quiet",
    });
  });

  it.each([
    "you",
    "You.",
    ".",
    "[BLANK_AUDIO]",
    "*music*",
    "Thanks for watching!",
    "We'll see you in the next video.",
    "Subtitles by the Amara.org community",
    "Please subscribe to my channel.",
    "Продолжение следует...",
  ])("drops %s at any level", (text) => {
    expect(judgeTranscript(text, { prompt: "", peak: 0.5 })).toEqual({
      text: "",
      dropped: "invented",
    });
  });

  it.each(["Subscribe to the event bus.", "See you at the review.", "You can merge it."])(
    "keeps a real phrase: %s",
    (text) => {
      expect(judgeTranscript(text, { prompt: "", peak: 0.5 }).text).toBe(text);
    },
  );

  it("drops another alphabet when a language was chosen, and allows Latin everywhere", () => {
    const georgian = "\u10da".repeat(8);
    expect(judgeTranscript(georgian, { prompt: "", peak: 0.5, language: "en" }).dropped).toBe(
      "script",
    );
    expect(judgeTranscript(georgian, { prompt: "", peak: 0.5, language: "ru" }).dropped).toBe(
      "script",
    );
    expect(judgeTranscript(georgian, { prompt: "", peak: 0.5 }).text).toBe(georgian);
    expect(judgeTranscript("merge в main", { prompt: "", peak: 0.5, language: "ru-RU" }).text).toBe(
      "merge в main",
    );
    expect(
      judgeTranscript("SpecWeave verify", { prompt: "", peak: 0.5, language: "ru" }).text,
    ).toBe("SpecWeave verify");
    expect(judgeTranscript("こんにちは", { prompt: "", peak: 0.5, language: "ja" }).text).toBe(
      "こんにちは",
    );
  });

  it("keeps the same words when they were really spoken", () => {
    expect(acceptTranscript("Thank you.", "", 0.4)).toBe("Thank you.");
  });

  it("keeps a spoken vocabulary term but drops its quiet echo", () => {
    expect(
      acceptTranscript("SpecWeave", "SpecWeave.", 0.5, parseVocabulary("SpecWeave").terms),
    ).toBe("SpecWeave");
    expect(acceptTranscript("SpecWeave", "SpecWeave.", 0.001)).toBe("");
    const phrase = "SpecWithCode coordinator";
    expect(acceptTranscript(phrase, `${phrase}, Postiz.`, 0.5, parseVocabulary(phrase).terms)).toBe(
      phrase,
    );
    for (const term of ["Hello, world", "Hello!", "Hello."]) {
      expect(acceptTranscript(term, `${term}.`, 0.5, parseVocabulary(term).terms)).toBe(term);
    }
  });

  it("drops a prompt echoed back, whatever the level", () => {
    expect(acceptTranscript(" SpecWeave, Postiz. ", "SpecWeave, Postiz.", 0.5)).toBe("");
  });
});
